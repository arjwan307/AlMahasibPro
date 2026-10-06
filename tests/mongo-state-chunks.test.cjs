const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {serialize,deserialize}=require('node:v8'),{createHash}=require('node:crypto');
const {gzipSync,gunzipSync}=require('node:zlib');
const source=fs.readFileSync(__dirname+'/../apps/api/src/store/mongo-store.js','utf8');
const fields=vm.runInNewContext(source.match(/const MAP_FIELDS = (\[[\s\S]*?\]);/)[1]);
const methods=vm.runInNewContext(source.match(/const WRITE_METHODS = (\[[\s\S]*?\]);/)[1]);
class MemoryStore{constructor(){for(const name of fields)this[name]=new Map();this.changes=[];this.audit=[];this.serverOutbox=[];this.changeSequence=0}}
for(const name of methods)MemoryStore.prototype[name]=async function(){this.changeSequence++;return this.changeSequence};
const copy=x=>x==null?x:deserialize(serialize(x));
const rows=new Map([['primary',{_id:'primary',companies:[['company',{name:'old company'}]],changes:[{payload:'x'.repeat(19*1024*1024)}],changeSequence:7}]]),chunks=new Map();let fail=false;
const db={collection(name){return name==='_app_state'?{findOne:async()=>copy(rows.get('primary')),replaceOne:async(_,doc)=>{if(fail){fail=false;throw Error('temporary write failure')}rows.set('primary',copy(doc))}}:{findOne:async q=>copy(chunks.get(q._id)),updateOne:async(q,update)=>{if(!chunks.has(q._id))chunks.set(q._id,copy({_id:q._id,...update.$setOnInsert}))}}}};
class MongoClient{async connect(){}db(){return db}async close(){}}
const context={MongoClient,MemoryStore,serialize,deserialize,createHash,gzipSync,gunzipSync,Buffer,structuredClone,process};vm.createContext(context);vm.runInContext(source.replace(/^import .*;\n/gm,'').replace('export class MongoStore','class MongoStore')+';globalThis.Store=MongoStore',context);
(async()=>{const store=await context.Store.create('fake');assert.equal(store.companies.get('company').name,'old company');assert.equal(store.changes[0].payload.length,19*1024*1024);
fail=true;await assert.rejects(store.createSession(),/temporary write failure/);assert.equal(rows.get('primary').storageFormat,undefined);
await store.createSession();assert.equal(rows.get('primary').storageFormat,'chunks-v2-gzip');assert(rows.get('primary').chunkIds.length>=1);assert(serialize(rows.get('primary')).length<10000);assert([...chunks.values()].every(x=>x.data.length<=2*1024*1024));assert([...chunks.values()].reduce((n,x)=>n+x.data.length,0)<1024*1024);
const loaded=await context.Store.create('fake');assert.equal(loaded.companies.get('company').name,'old company');assert.equal(loaded.changes[0].payload,store.changes[0].payload);assert.equal(loaded.changeSequence,store.changeSequence);
const n=chunks.size;await loaded.seedPlatformAdmin();assert(chunks.size<=n+1);
console.log('PASS: legacy >19MB state migrates to bounded chunks; failed writes preserve old state and next write recovers; restart restores all records and reuses unchanged chunks');})().catch(e=>{console.error(e);process.exitCode=1});
