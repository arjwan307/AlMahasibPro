import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { MongoClient } from 'mongodb';

function cacheBinaries() {
  const dirs = [
    join(process.env.USERPROFILE || '', '.cache', 'mongodb-binaries'),
    join(process.env.LOCALAPPDATA || '', 'mongodb-binaries'),
    join(process.env.HOME || '', '.cache', 'mongodb-binaries'),
    join(process.cwd(), 'node_modules', '.cache', 'mongodb-memory-server')
  ];
  const found = [];
  for (const dir of dirs) {
    try {
      for (const name of readdirSync(dir)) if (/^mongod(\.exe)?$/.test(name) || /^mongod-.*\.exe$/.test(name)) found.push(join(dir, name));
    } catch {}
  }
  return found;
}

export function resolveMongodBinary() {
  if (process.env.MONGOD_BINARY && existsSync(process.env.MONGOD_BINARY)) return process.env.MONGOD_BINARY;
  return cacheBinaries().sort().at(-1) || null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitReady(uri, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 1000, connectTimeoutMS: 1000 });
    try {
      await client.connect();
      await client.db('admin').command({ ping: 1 });
      await client.close();
      return;
    } catch (error) {
      lastError = error;
      await client.close().catch(() => {});
    }
    await delay(250);
  }
  throw new Error('MongoDB did not become ready: ' + (lastError?.message || 'timeout'));
}

export function randomDbName(prefix = 'almahasib_test') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// Returns a real, isolated MongoDB endpoint. It prefers an explicit
// TEST_MONGODB_URI (a dedicated test database/cluster), otherwise it boots an
// ephemeral mongod from an available binary on a private temp dbpath. Returns
// null when no test service and no local binary are available.
export async function startTestMongo() {
  const external = process.env.TEST_MONGODB_URI;
  if (external) return { uri: external, dbName: randomDbName(), managed: false, stop: async () => {} };

  const binary = resolveMongodBinary();
  if (!binary) return null;

  const port = await freePort();
  const dbpath = mkdtempSync(join(tmpdir(), 'almahasib-mongo-'));
  const child = spawn(binary, ['--dbpath', dbpath, '--port', String(port), '--bind_ip', '127.0.0.1', '--quiet'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.stdout.on('data', () => {});
  let exited = false;
  child.on('exit', () => { exited = true; });

  const uri = `mongodb://127.0.0.1:${port}`;
  try {
    await waitReady(uri);
  } catch (error) {
    if (!exited) child.kill();
    if (!exited) await once(child, 'exit').catch(() => {});
    rmSync(dbpath, { recursive: true, force: true });
    throw new Error(error.message + (stderr ? ' | mongod: ' + stderr.trim().slice(0, 500) : ''));
  }

  const stop = async () => {
    if (!exited) {
      child.kill();
      await Promise.race([once(child, 'exit'), delay(5000)]).catch(() => {});
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      try { rmSync(dbpath, { recursive: true, force: true }); return; } catch { await delay(200); }
    }
  };
  return { uri, dbName: randomDbName(), managed: true, binary, dir: dbpath, stop };
}
