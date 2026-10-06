import { DatabaseSync } from 'node:sqlite';
import { serialize, deserialize } from 'node:v8';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
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
    for (const row of this.sqlite.prepare('SELECT field,data FROM domain_state').all()) {
      if (fields.includes(row.field)) this[row.field] = deserialize(Buffer.from(row.data));
    }
    this.queue = Promise.resolve();
    const scope = new AsyncLocalStorage();
    const snapshot = () => fields.map(key => [key, serialize(this[key])]);
    const restore = rows => { for (const [key, bytes] of rows) this[key] = deserialize(bytes); };
    const write = this.sqlite.prepare('INSERT INTO domain_state(field,data) VALUES (?,?) ON CONFLICT(field) DO UPDATE SET data=excluded.data');
    for (const name of Object.getOwnPropertyNames(MemoryStore.prototype)) {
      if (name === 'constructor' || name === 'close' || typeof this[name] !== 'function') continue;
      const method = this[name].bind(this);
      this[name] = (...args) => {
        if (scope.getStore()) return method(...args);
        const task = this.queue.then(() => scope.run(true, async () => {
          const before = snapshot();
          try {
            const result = await method(...args);
            const after = snapshot();
            const changed = after.filter(([key, bytes], index) => !bytes.equals(before[index][1]));
            if (changed.length) {
              this.sqlite.exec('BEGIN IMMEDIATE');
              for (const [key, bytes] of changed) write.run(key, bytes);
              this.sqlite.exec('COMMIT');
            }
            return result;
          } catch (error) {
            if (this.sqlite.isTransaction) this.sqlite.exec('ROLLBACK');
            restore(before); throw error;
          }
        }));
        this.queue = task.catch(() => {});
        return task;
      };
    }
  }
  async exportBackup() {
    const task = this.queue.then(() => {
      const filename = this.filename + '.' + randomUUID() + '.backup';
      try { this.sqlite.prepare('VACUUM INTO ?').run(filename); return readFileSync(filename); }
      finally { try { unlinkSync(filename); } catch {} }
    });
    this.queue = task.catch(() => {}); return task;
  }
  async close() { await this.queue; this.sqlite.close(); }
}
