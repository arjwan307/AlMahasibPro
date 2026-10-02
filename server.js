import 'dotenv/config';
import { createApp } from './apps/api/src/app.js';
import { normalizeUsername } from './apps/api/src/lib/http.js';
import { hashPassword } from './apps/api/src/lib/security.js';
import { MemoryStore } from './apps/api/src/store/memory-store.js';
import { MongoStore } from './apps/api/src/store/mongo-store.js';

const port = Number(process.env.PORT || 5000);
const useMemory = process.env.DATA_STORE === 'memory';
if (!useMemory && !process.env.MONGODB_URI) {
  throw new Error('MONGODB_URI is required. Use DATA_STORE=memory only for local demonstrations and tests.');
}

const store = useMemory ? new MemoryStore() : await MongoStore.create(process.env.MONGODB_URI);
if (process.env.PLATFORM_ADMIN_PASSWORD) {
  await store.seedPlatformAdmin({
    username: normalizeUsername(process.env.PLATFORM_ADMIN_USERNAME || 'platform_admin'),
    displayName: process.env.PLATFORM_ADMIN_NAME || 'مدير المنصة',
    passwordHash: await hashPassword(process.env.PLATFORM_ADMIN_PASSWORD)
  });
}
const allowedOrigins = (process.env.ALLOWED_ORIGINS || `http://localhost:${port},http://127.0.0.1:${port}`)
  .split(',').map((origin) => origin.trim()).filter(Boolean);
const app = createApp({
  store,
  sessionDays: Number(process.env.SESSION_DAYS || 14),
  secureCookies: process.env.NODE_ENV === 'production',
  allowedOrigins
});

const server = app.listen(port, () => {
  console.log(`AlMahasib Pro API listening on http://localhost:${port} (${useMemory ? 'memory' : 'mongodb'})`);
});

async function shutdown(signal) {
  console.log(`${signal}: shutting down`);
  server.close(async () => {
    await store.close();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
