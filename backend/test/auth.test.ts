import assert from 'node:assert/strict';
import test from 'node:test';
import { createToken, hashPassword, tokenHash, verifyPassword } from '../src/auth.js';

test('password hashes are salted and verifiable', () => {
  const first = hashPassword('a sufficiently long password');
  const second = hashPassword('a sufficiently long password');
  assert.notEqual(first, second);
  assert.equal(verifyPassword('a sufficiently long password', first), true);
  assert.equal(verifyPassword('wrong password', first), false);
});

test('session tokens are random and stored as keyed hashes', () => {
  const token = createToken();
  assert.ok(token.length >= 40);
  assert.notEqual(tokenHash(token, 'a'.repeat(32)), tokenHash(token, 'b'.repeat(32)));
});

