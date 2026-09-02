const SecurityLog = require('../models/SecurityLog');

const REDACT_KEYS = new Set(['password', 'passwordHash', 'token', 'rawToken', 'secret', 'credential']);

function sanitizeMeta(meta) {
  if (!meta || typeof meta !== 'object') return meta ?? null;
  const clean = {};
  for (const [key, value] of Object.entries(meta)) {
    clean[key] = REDACT_KEYS.has(key) ? '[redacted]' : value;
  }
  return clean;
}

async function logSecurityEvent(type, { meta, ip } = {}) {
  try {
    await SecurityLog.create({ type, meta: sanitizeMeta(meta), ip: ip || null });
  } catch (err) {
    console.error('[security-log] falha ao gravar evento', type, err.message);
  }
}

module.exports = { logSecurityEvent };
