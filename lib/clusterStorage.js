const { mongoose } = require('../config/db');

// Consumo TOTAL do cluster do Atlas (todos os bancos, não só o deste site),
// pelo comando oficial `atlasSize` dos clusters Free (M0) e Flex: o campo
// atlasSize = dados + índices de TODOS os bancos, que é o que conta para o
// limite de 512 MB do plano gratuito. Sem esse comando (falta de permissão,
// cluster pago, banco local) o quadro mostra a falha — NUNCA zero nem o
// tamanho só deste banco no lugar do total.
// Documentação: https://www.mongodb.com/docs/atlas/free-tier-commands/

const MB = 1024 * 1024; // mesma base (1 MB = 1.048.576 bytes) para uso e limite
const DEFAULT_LIMIT_MB = 512;
const CACHE_MS = 5 * 60 * 1000;
const MANUAL_REFRESH_MIN_MS = 30 * 1000;

const LEVELS = [
  { min: 95, level: 'critical', label: 'Crítico' },
  { min: 85, level: 'high', label: 'Alto' },
  { min: 70, level: 'warning', label: 'Atenção' },
  { min: 0, level: 'normal', label: 'Normal' },
];

function limitBytes() {
  const raw = Number(process.env.ATLAS_STORAGE_LIMIT_MB);
  const mb = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LIMIT_MB;
  return Math.round(mb * MB);
}

function levelFor(percent) {
  return LEVELS.find((l) => percent >= l.min);
}

function toNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v.toNumber === 'function') return v.toNumber();
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Testes injetam um executor falso (o banco em memória não tem atlasSize).
async function defaultRunner(cmd) {
  const db = mongoose.connection.db;
  try {
    return await db.command(cmd);
  } catch (err) {
    // Alguns usuários só podem rodar comandos de cluster no banco admin.
    try { return await db.admin().command(cmd); } catch (_) { throw err; }
  }
}
let runCommand = defaultRunner;
function setCommandRunner(fn) { runCommand = fn || defaultRunner; cache = null; lastManual = 0; }

let cache = null;
let lastManual = 0;

const GUIDANCE = [
  'O comando "atlasSize" só existe em clusters Atlas Free (M0) e Flex. Em cluster pago (M10+), confira o uso em Atlas → Cluster → Metrics.',
  'Confira em Atlas → Database Access se o usuário usado no MONGODB_URI tem permissão de leitura do cluster (ex.: papel "Atlas admin" ou "Read and write to any database").',
  'Se mudou algo no Atlas, clique em "Atualizar armazenamento" de novo.',
];

function buildResult(raw, now) {
  const used = toNumber(raw && raw.atlasSize);
  if (!(raw && Number(raw.ok) === 1) || used == null || used < 0) {
    const err = new Error('Resposta sem o campo atlasSize.');
    err.code = 'invalid_response';
    throw err;
  }
  const totals = raw.totals || {};
  const limit = limitBytes();
  const percent = +((used / limit) * 100).toFixed(2);
  const lv = levelFor(percent);
  return {
    ok: true,
    scope: 'cluster',
    usedBytes: used,
    dataBytes: toNumber(totals.dataSize),
    indexBytes: toNumber(totals.indexSize),
    storageBytes: toNumber(totals.storageSize),
    databases: toNumber(totals.numDatabases),
    limitBytes: limit,
    remainingBytes: Math.max(0, limit - used),
    percent,
    level: lv.level,
    levelLabel: lv.label,
    unit: 'MB',
    unitBytes: MB,
    checkedAt: now.toISOString(),
  };
}

async function getClusterStorage({ force = false, now = new Date() } = {}) {
  const t = now.getTime();
  if (force) {
    if (t - lastManual < MANUAL_REFRESH_MIN_MS && cache) {
      return { ...cache.value, cached: true, throttled: true, retryInSeconds: Math.ceil((MANUAL_REFRESH_MIN_MS - (t - lastManual)) / 1000) };
    }
    lastManual = t;
  } else if (cache && t - cache.at < CACHE_MS) {
    return { ...cache.value, cached: true };
  }
  let value;
  try {
    value = buildResult(await runCommand({ atlasSize: 1 }), now);
  } catch (err) {
    // Só o tipo do erro (nunca a URI, usuário ou mensagem crua do driver).
    const code = err && (err.codeName || err.code) ? String(err.codeName || err.code) : 'unknown';
    value = {
      ok: false,
      scope: 'cluster',
      message: 'Não foi possível consultar o consumo total',
      errorCode: code.slice(0, 60),
      guidance: GUIDANCE,
      limitBytes: limitBytes(),
      checkedAt: now.toISOString(),
    };
  }
  cache = { at: t, value };
  return { ...value, cached: false };
}

function invalidate() { cache = null; }

module.exports = { getClusterStorage, invalidate, setCommandRunner, levelFor, limitBytes, MB, CACHE_MS, MANUAL_REFRESH_MIN_MS };
