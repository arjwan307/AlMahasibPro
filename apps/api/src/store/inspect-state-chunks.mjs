// Run only while all writers/deploys are stopped. Default is read-only.
import { MongoClient } from 'mongodb';
import { createHash } from 'node:crypto';
import { serialize, deserialize } from 'node:v8';
import { gzipSync, gunzipSync } from 'node:zlib';
import { writeFile, readFile } from 'node:fs/promises';
const apply=process.argv.includes('--apply');
if(apply&&!process.argv.includes('--writers-stopped'))throw Error('Stop every writer and confirm with --writers-stopped');
if(!process.env.MONGODB_URI)throw Error('MONGODB_URI is required');
const client=new MongoClient(process.env.MONGODB_URI);
try{
await client.connect();const db=client.db(process.env.MONGODB_DB||'AlMahasibPro');
const state=db.collection('_app_state'),chunks=db.collection('_app_state_chunks');
const primary=await state.findOne({_id:'primary'});
if(!primary||!['chunks-v1','chunks-v2-gzip'].includes(primary.storageFormat)||!primary.chunkIds?.length)throw Error('Unrecognized primary: refusing cleanup');
const active=new Set(primary.chunkIds),all=await chunks.find({}).toArray();
const byId=new Map(all.map(x=>[x._id,x]));
for(const id of active){const x=byId.get(id);if(!x)throw Error('Missing active chunk');const bytes=Buffer.isBuffer(x.data)?x.data:Buffer.from(x.data.buffer);if(createHash('sha256').update(bytes).digest('hex')!==id)throw Error('Corrupt active chunk')}
const payload=Buffer.concat(primary.chunkIds.map(id=>{const x=byId.get(id).data;return Buffer.isBuffer(x)?x:Buffer.from(x.buffer)}));
deserialize(primary.storageFormat==='chunks-v2-gzip'?gunzipSync(payload):payload);
const orphanIds=all.filter(x=>!active.has(x._id)).map(x=>x._id);
console.log(JSON.stringify({active:active.size,orphan:orphanIds.length,mode:apply?'backup-and-clean':'read-only'}));
if(apply){
const filename='mongo-chunks-backup-'+Date.now()+'.v8.gz';
// Store all bytes, including orphan records, so deletion is recoverable.
const backup={primary,chunks:all.map(x=>({...x,data:Buffer.isBuffer(x.data)?x.data:Buffer.from(x.data.buffer)}))};
const archive=gzipSync(serialize(backup));await writeFile(filename,archive,{flag:'wx',mode:0o600});
const saved=await readFile(filename);if(!saved.equals(archive))throw Error('Backup verification failed');deserialize(gunzipSync(saved));
const current=await state.findOne({_id:'primary'});
if(!serialize(current).equals(serialize(primary)))throw Error('Primary changed: cleanup cancelled');
if(orphanIds.length)await chunks.deleteMany({_id:{$in:orphanIds}});
console.log(JSON.stringify({backup:filename,removedOrphans:orphanIds.length}));
}
}finally{await client.close()}
