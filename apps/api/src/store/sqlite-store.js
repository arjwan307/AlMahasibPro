import { tenantScope } from '../lib/tenant-scope.js';
import { DatabaseSync } from 'node:sqlite';
import { serialize, deserialize } from 'node:v8';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { dirname, join, basename } from 'node:path';
import { MemoryStore } from './memory-store.js';

// Reuse the audited accounting engine; every successful domain mutation is
// committed to SQLite before its HTTP response. Serialize callers and restore
// the in-process state if the database rejects a transaction.
export class SQLiteStore extends MemoryStore {
  constructor(filename) {
    super();
    mkdirSync(dirname(filename), { recursive: true });
    this.filename = filename;
    this.backupExtension = 'sqlite';
    this.sqlite = new DatabaseSync(filename);
    this.sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS domain_state (field TEXT PRIMARY KEY, data BLOB NOT NULL) STRICT;');
    const fields = Object.keys(this).filter(key => this[key] instanceof Map || Array.isArray(this[key]) || key === 'changeSequence');
    // Persist every ERP domain map, including newly introduced chartAccounts, automatically.
    for (const row of this.sqlite.prepare('SELECT field,data FROM domain_state').all()) {
      if (fields.includes(row.field)) this[row.field] = deserialize(Buffer.from(row.data));
    }
    this.queue = Promise.resolve();
    const scope = new AsyncLocalStorage();
    this.transactionScope = scope;
    const snapshot = () => fields.map(key => [key, serialize(this[key])]);
    const restore = rows => { for (const [key, bytes] of rows) this[key] = deserialize(bytes); };
    const write = this.sqlite.prepare('INSERT INTO domain_state(field,data) VALUES (?,?) ON CONFLICT(field) DO UPDATE SET data=excluded.data');
    this.transaction = callback => {
      if (scope.getStore()) return Promise.resolve().then(callback);
      const task = this.queue.then(() => scope.run(true, async () => {
        const before = snapshot();
        this.auditStateBefore=new Map(before.map(([key,bytes])=>[key,deserialize(bytes)]));
        try {
          const result = await callback();
          // Check every newly persisted financial posting, including module routes.
          const previousJournals=deserialize(before.find(([key])=>key==='journalEntries')[1]);
          if(!this.importingCloudSnapshot)for(const [id,row] of this.journalEntries)if(!previousJournals.has(id)){this.assertFinancialPeriod(row.companyId,row.occurredAt,row.id);this.assertJournalSession(row);}
          const changed = snapshot().filter(([key, bytes], index) => !bytes.equals(before[index][1]));
          if (changed.length) {
            this.sqlite.exec('BEGIN IMMEDIATE');
            for (const [key, bytes] of changed) write.run(key, bytes);
            this.sqlite.exec('COMMIT');
          }
          return result;
        } catch (error) {
          if (this.sqlite.isTransaction) this.sqlite.exec('ROLLBACK');
          restore(before); throw error;
        } finally { this.auditStateBefore=null;this.importingCloudSnapshot=false; }
      }));
      this.queue = task.catch(() => {});
      return task;
    };
    for (const name of Object.getOwnPropertyNames(MemoryStore.prototype)) {
      if (name === 'constructor' || name === 'close' || typeof this[name] !== 'function') continue;
      if (name === 'isCompanyTombstoned' || name === 'companyDeletionTombstone' || name === 'listCompanyDeletions') continue;
      const method = this[name].bind(this);
      this[name] = (...args) => scope.getStore() ? method(...args) : this.transaction(() => method(...args));
    }
  }
  async mergeFrom(source, product = 'retail') {
    const migrationKey = 'system:migration:legacy-retail-v1';
    if (this.salesSettings.has(migrationKey)) return false;
    const task = this.queue.then(async () => {
      const fields = Object.keys(this).filter(key => this[key] instanceof Map || Array.isArray(this[key]) || key === 'changeSequence');
      const before = fields.map(key => [key, serialize(this[key])]);
      try {
        for (const key of fields) {
          if (key === 'changeSequence') { this.changeSequence = Math.max(this.changeSequence || 0, source.changeSequence || 0); continue; }
          const incoming = source[key];
          if (this[key] instanceof Map && incoming instanceof Map) {
            for (const [id, original] of incoming) {
              const value = structuredClone(original);
              if (key === 'companies') {
                value.product = product;
                const base = product;
                let code = base, suffix = 2;
                while ([...this.companies.values()].some(company => company.code === code)) code = base + '-' + suffix++;
                value.code = code;
              }
              if (!this[key].has(id)) this[key].set(id, value);
            }
          } else if (Array.isArray(this[key]) && Array.isArray(incoming)) this[key].push(...structuredClone(incoming));
        }
        this.salesSettings.set(migrationKey, { completedAt: new Date().toISOString(), product });
        const after = fields.map(key => [key, serialize(this[key])]);
        this.sqlite.exec('BEGIN IMMEDIATE');
        const write = this.sqlite.prepare('INSERT INTO domain_state(field,data) VALUES (?,?) ON CONFLICT(field) DO UPDATE SET data=excluded.data');
        for (const [key, bytes] of after) write.run(key, bytes);
        this.sqlite.exec('COMMIT');
        return true;
      } catch (error) {
        if (this.sqlite.isTransaction) this.sqlite.exec('ROLLBACK');
        for (const [key, bytes] of before) this[key] = deserialize(bytes);
        throw error;
      }
    });
    this.queue = task.catch(() => {});
    return task;
  }
  async exportBackup() {
    const task = this.queue.then(() => {
      const filename = this.filename + '.' + randomUUID() + '.backup';
      try { this.sqlite.prepare('VACUUM INTO ?').run(filename); return readFileSync(filename); }
      finally { try { unlinkSync(filename); } catch {} }
    });
    this.queue = task.catch(() => {}); return task;
  }
  async exportCompanyBackup(companyId) {
    const create=()=>{
      if(!this.companies.has(companyId))throw Error('الشركة غير موجودة');
      const filename=this.filename+'.'+randomUUID()+'.company-backup';let database;
      try{
        database=new DatabaseSync(filename);
        database.exec('CREATE TABLE domain_state (field TEXT PRIMARY KEY,data BLOB NOT NULL) STRICT;');
        const write=database.prepare('INSERT INTO domain_state(field,data) VALUES (?,?)');
        const belongs=tenantScope(this,companyId);
        const knownIds=new Set();
        for(const value of Object.values(this))if(value instanceof Map)for(const [id,row] of value)if(row?.companyId===companyId)knownIds.add(String(id));
        for(const [field,value] of Object.entries(this)){
          let filtered;
          if(value instanceof Map){
            filtered=new Map([...value].filter(([id,row])=>field!=='sessions' && belongs(field,id,row)).map(([id,row])=>[id,structuredClone(row)]));
            if(field==='salesSettings')for(const row of filtered.values())if(Array.isArray(row.photos))row.photos=row.photos.map(photo=>{
              if(photo.data)return photo;
              if(!photo.filename||basename(photo.filename)!==photo.filename)throw Error('مسار صورة غير صالح');
              const data=readFileSync(join(dirname(this.filename),'item-photos',photo.filename));
              return {id:photo.id,mime:photo.mime,data:'data:'+photo.mime+';base64,'+data.toString('base64')};
            });
          }else if(Array.isArray(value))filtered=structuredClone(value.filter(row=>row?.companyId===companyId));
          else if(field==='changeSequence')filtered=value;
          else continue;
          write.run(field,serialize(filtered));
        }
        database.close();database=null;return readFileSync(filename);
      }finally{database?.close();try{unlinkSync(filename);}catch{}}
    };
    if(this.transactionScope.getStore())return create();
    const task=this.queue.then(create);this.queue=task.catch(()=>{});return task;
  }
  async importCloudSnapshot(bytes, companyId, {initial = false, discardPending = false} = {}) {
    if (this.deletedCompanies?.has(companyId) && !(initial && this.deletedCompanies.get(companyId).localOnly)) throw new Error('تم حذف الشركة نهائيًا؛ لا يمكن استيراد نسخة سحابية قديمة');
    const filename = this.filename + '.' + randomUUID() + '.incoming';
    const {writeFileSync} = await import('node:fs');
    const magic=Buffer.from('AlMahasibProMongoBackup\n');
    const buffer=Buffer.from(bytes);
    if(buffer.subarray(0,magic.length).equals(magic)) {
      const header=magic.length+1+32;
      if(buffer.length<=header||buffer[magic.length]!==1)throw Error('إصدار النسخة الاحتياطية غير مدعوم');
      const payload=buffer.subarray(header);
      if(!createHash('sha256').update(payload).digest().equals(buffer.subarray(magic.length+1,header)))throw Error('النسخة الاحتياطية تالفة');
      const state=deserialize(payload);
      if(!state||typeof state!=='object'||Array.isArray(state))throw Error('النسخة الاحتياطية غير سليمة');
      // Convert the verified portable envelope into domain_state rows, then use
      // the same tenant validation, pending-command guard and transaction below.
      let converted;
      try {
        converted=new DatabaseSync(filename);
        converted.exec('CREATE TABLE domain_state (field TEXT PRIMARY KEY,data BLOB NOT NULL) STRICT;');
        const write=converted.prepare('INSERT INTO domain_state(field,data) VALUES (?,?)');
        for(const [field,value] of Object.entries(state)) {
          if(this[field] instanceof Map) {
            if(!Array.isArray(value)||value.some(entry=>!Array.isArray(entry)||entry.length!==2))throw Error('النسخة الاحتياطية غير سليمة');
            const map=new Map(value);if(map.size!==value.length)throw Error('معرف مكرر في النسخة الاحتياطية');
            write.run(field,serialize(map));
          }else if(Array.isArray(this[field])) {
            if(!Array.isArray(value))throw Error('النسخة الاحتياطية غير سليمة');
            write.run(field,serialize(value));
          }else if(field==='changeSequence') {
            if(!Number.isSafeInteger(value)||value<0)throw Error('تسلسل النسخة غير صالح');
            write.run(field,serialize(value));
          }
        }
      }catch(error){converted?.close();try{unlinkSync(filename);}catch{}throw error;}
      converted.close();
    }else writeFileSync(filename,buffer);
    let incoming;
    try {
      incoming = new DatabaseSync(filename,{readOnly:true});
      if(incoming.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw Error('النسخة السحابية غير سليمة');
      const rows=incoming.prepare('SELECT field,data FROM domain_state').all();
      const companies=deserialize(Buffer.from(rows.find(x=>x.field==='companies')?.data||[]));
      if(!(companies instanceof Map)||companies.size!==1||!companies.has(companyId))throw Error('النسخة لا تخص الشركة المحددة');
      return await this.transaction(async()=>{
        // Recheck under the write lock: deletion may have committed while bytes were validated.
        if(this.deletedCompanies.has(companyId) && !(initial && this.deletedCompanies.get(companyId).localOnly))throw Error('تم حذف الشركة نهائيًا');
        if(!discardPending&&[...this.desktopCommands.values()].some(x=>x.companyId===companyId&&x.local&&x.status!=='acknowledged'))return false;
        const state=Object.fromEntries(rows.map(row=>[row.field,deserialize(Buffer.from(row.data))]));
        const incomingScope=tenantScope(state,companyId), localScope=tenantScope(this,companyId);
        for(const [field,value] of Object.entries(state)) {
          if(['sessions','desktopCommands','desktopIdMappings','deletedCompanies'].includes(field))continue;
          if(value instanceof Map)for(const [id,row] of value)if(!incomingScope(field,id,row)||row?.platformAdmin)throw Error('النسخة تحتوي بيانات خارج الشركة');
          if(Array.isArray(value)&&value.some(row=>row?.companyId!==companyId))throw Error('النسخة تحتوي بيانات خارج الشركة');
        }
        this.importingCloudSnapshot=true;
        for(const [field,value] of Object.entries(state)) {
          if(['sessions','desktopCommands','desktopIdMappings','deletedCompanies','deletedAccounts','ownershipTransfers','auditStateBefore'].includes(field))continue;
          if(this[field] instanceof Map && value instanceof Map) {
            for(const [id,row] of this[field])if(localScope(field,id,row))this[field].delete(id);
            for(const [id,row] of value){if(this[field].has(id))throw Error('تعارض معرف مع شركة أخرى');this[field].set(id,row);}
          }else if(Array.isArray(this[field])&&Array.isArray(value))this[field]=[...this[field].filter(row=>row?.companyId!==companyId),...value];
          else if(field==='changeSequence')this.changeSequence=Math.max(this.changeSequence,Number(value)||0);
        }
        if(state.deletedAccounts instanceof Map)for(const [id,row] of state.deletedAccounts) {
          if(row.companyId!==companyId)throw Error('علامة حذف حساب خارج الشركة');
          if(!this.deletedAccounts.has(id))this.deletedAccounts.set(id,row);
        }
        const incomingTransfer=state.ownershipTransfers?.get(companyId),currentTransfer=this.ownershipTransfers.get(companyId);
        if(incomingTransfer&&(!currentTransfer||incomingTransfer.revision>currentTransfer.revision))this.ownershipTransfers.set(companyId,incomingTransfer);
        const transfer=this.ownershipTransfers.get(companyId);
        if(transfer){
          if(this.users.get(transfer.newOwnerId)?.companyId!==companyId)throw Error('النسخة أقدم من نقل الملكية ولا تحتوي المالك الحالي');
          this.companies.get(companyId).ownerUserId=transfer.newOwnerId;
        }
        await this.enforceAccountDeletions(companyId);
        if(initial){
          for(const field of ['sessions','desktopCommands','desktopIdMappings'])for(const [id,row] of this[field])if(localScope(field,id,row))this[field].delete(id);
          if(this.deletedCompanies.get(companyId)?.localOnly)this.deletedCompanies.delete(companyId);
        }
        return true;
      });
    } finally {this.importingCloudSnapshot=false;incoming?.close();try{unlinkSync(filename);}catch{}}
  }
  async close() { await this.queue; this.sqlite.close(); }
  async verifyBackup(target) {
    const file = typeof target === 'string' ? target : null;
    if (!file) throw new Error('النسخة الاحتياطية غير سليمة');
    const check = new DatabaseSync(file, { readOnly: true });
    try { if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw Error('النسخة الاحتياطية غير سليمة'); }
    finally { check.close(); }
    return true;
  }
}
