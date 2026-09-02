const test = require('node:test');
const assert = require('node:assert/strict');
const { generateToken, hashToken, timingSafeEqualHex } = require('../lib/tokens');

test('generateToken produz valores longos e não repetidos', () => {
  const a = generateToken();
  const b = generateToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 32);
});

test('hashToken é determinístico e sensível a qualquer diferença no token', () => {
  const raw = generateToken();
  assert.equal(hashToken(raw), hashToken(raw));
  assert.notEqual(hashToken(raw), hashToken(`${raw}x`));
});

test('timingSafeEqualHex compara hashes corretamente', () => {
  const h1 = hashToken('a');
  const h2 = hashToken('a');
  const h3 = hashToken('b');
  assert.equal(timingSafeEqualHex(h1, h2), true);
  assert.equal(timingSafeEqualHex(h1, h3), false);
});
