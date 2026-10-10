import { DatabaseSync } from 'node:sqlite';
import { serialize, deserialize } from 'node:v8';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
    this.sqlite = new DatabaseSync(filename);
    this.sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS domain_state (field TEXT PRIMARY KEY, data BLOB NOT NULL) STRICT;');
    const fields = Object.keys(this).filter(key => this[key] instanceof Map || Array.isArray(this[key]) || key === 'changeSequence');
    // Persist every ERP domain map, including newly introduced chartAccounts, automatically.
    for (const row of this.sqlite.prepare('SELECT field,data FROM domain_state').all()) {
      if (fields.includes(row.field)) this[row.field] = deserialize(Buffer.from(row.data));
    }
    this.queue = Promise.resolve();
    const scope = new AsyncLocalStorage();
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
          if(!this.importingCloudSnapshot)for(const [id,row] of this.journalEntries)if(!previousJournals.has(id))this.assertFinancialPeriod(row.companyId,row.occurredAt);
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
    const task=this.queue.then(()=>{
      if(!this.companies.has(companyId))throw Error('الشركة غير موجودة');
      const filename=this.filename+'.'+randomUUID()+'.company-backup';let database;
      try{
        database=new DatabaseSync(filename);
        database.exec('CREATE TABLE domain_state (field TEXT PRIMARY KEY,data BLOB NOT NULL) STRICT;');
        const write=database.prepare('INSERT INTO domain_state(field,data) VALUES (?,?)');
        const knownIds=new Set();
        for(const value of Object.values(this))if(value instanceof Map)for(const [id,row] of value)if(row?.companyId===companyId)knownIds.add(String(id));
        for(const [field,value] of Object.entries(this)){
          let filtered;
          if(value instanceof Map){
            filtered=new Map([...value].filter(([id,row])=>field==='sessions'?false:field==='companies'?id===companyId:row?.companyId===companyId||(field==='salesSettings'&&!row?.companyId&&knownIds.has(String(id).split(':').at(-1)))).map(([id,row])=>[id,structuredClone(row)]));
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
    });
    this.queue=task.catch(()=>{});return task;
  }
  async importCloudSnapshot(bytes, companyId, {initial = false} = {}) {
    const filename = this.filename + '.' + randomUUID() + '.incoming';
    const {writeFileSync} = await import('node:fs');
    writeFileSync(filename,bytes);
    let incoming;
    try {
      incoming = new DatabaseSync(filename,{readOnly:true});
      if(incoming.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw Error('النسخة السحابية غير سليمة');
      const rows=incoming.prepare('SELECT field,data FROM domain_state').all();
      const companies=deserialize(Buffer.from(rows.find(x=>x.field==='companies')?.data||[]));
      if(!(companies instanceof Map)||companies.size!==1||!companies.has(companyId))throw Error('النسخة لا تخص الشركة المحددة');
      return await this.transaction(()=>{
        if(!initial&&[...this.desktopCommands.values()].some(x=>x.local&&x.status!=='acknowledged'))return false;
        // A verified backup restores historical postings; it does not post new transactions.
        this.importingCloudSnapshot=true;
        for(const row of rows){
          if(['sessions','desktopCommands','desktopIdMappings'].includes(row.field))continue;
          if(this[row.field] instanceof Map||Array.isArray(this[row.field])||row.field==='changeSequence')this[row.field]=deserialize(Buffer.from(row.data));
        }
        if(initial){this.sessions.clear();this.desktopCommands.clear();this.desktopIdMappings.clear();}
        return true;
      });
    } finally {this.importingCloudSnapshot=false;incoming?.close();try{unlinkSync(filename);}catch{}}
  }
  async close() { await this.queue; this.sqlite.close(); }
}
