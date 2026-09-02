const crypto = require('crypto');

// Tokens de acesso (aluno/fiscal) são strings aleatórias de alta entropia,
// geradas e verificadas com timing-safe compare. Só o hash é persistido —
// ver models/Room.js.
function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function timingSafeEqualHex(a, b) {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { generateToken, hashToken, timingSafeEqualHex };
