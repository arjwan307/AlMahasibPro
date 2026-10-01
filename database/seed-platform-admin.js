import 'dotenv/config';
import { normalizeUsername } from '../apps/api/src/lib/http.js';
import { hashPassword } from '../apps/api/src/lib/security.js';
import { PostgresStore } from '../apps/api/src/store/postgres-store.js';

for (const variable of ['DATABASE_URL', 'PLATFORM_ADMIN_USERNAME', 'PLATFORM_ADMIN_PASSWORD']) {
  if (!process.env[variable]) throw new Error(`${variable} is required`);
}

const store = new PostgresStore(process.env.DATABASE_URL);
try {
  const user = await store.seedPlatformAdmin({
    username: normalizeUsername(process.env.PLATFORM_ADMIN_USERNAME),
    displayName: process.env.PLATFORM_ADMIN_NAME || 'مدير المنصة',
    passwordHash: await hashPassword(process.env.PLATFORM_ADMIN_PASSWORD)
  });
  console.log(`Platform administrator ready: ${user.username}`);
} finally {
  await store.close();
}

