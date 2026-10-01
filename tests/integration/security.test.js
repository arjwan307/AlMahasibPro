import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPassword, payloadHash, verifyPassword } from '../../apps/api/src/lib/security.js';

test('password hashes are salted scrypt values and verify safely', async () => {
  const first = await hashPassword('A-Strong-Password-123');
  const second = await hashPassword('A-Strong-Password-123');
  assert.notEqual(first, second);
  assert.equal(await verifyPassword('A-Strong-Password-123', first), true);
  assert.equal(await verifyPassword('wrong-password', first), false);
});

test('payload hashing is stable across object key order', () => {
  assert.equal(payloadHash({ amount: '10', currency: 'IQD' }), payloadHash({ currency: 'IQD', amount: '10' }));
});

