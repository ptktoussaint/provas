const { mongoose } = require('../config/db');

// Relatório de uso do banco (aba Segurança & Auditoria). SOMENTE LEITURA:
// só contagens, tamanhos e datas — nunca conteúdo de documentos (nada de
// respostas, nomes ou IDs), e nunca altera/apaga nada.

// Limite de armazenamento do cluster gratuito do Atlas (M0).
const ATLAS_FREE_LIMIT_BYTES = 512 * 1024 * 1024;

// Campo de data usado para idade e ritmo de crescimento de cada coleção.
const DATE_FIELDS = {
  examevents: 'at',
  securitylogs: 'at',
  examattempts: 'createdAt',
  rooms: 'createdAt',
  sessions: 'expires',
  integrationnotifications: 'createdAt',
  integrationrequests: 'createdAt',
  promotions: 'createdAt',
  promotiondrafts: 'createdAt',
  questions: 'createdAt',
  exams: 'createdAt',
  messagetemplates: 'createdAt',
  users: 'createdAt',
  settings: 'createdAt',
  integrationconfigs: 'createdAt',
};

// Coleções que já se limpam sozinhas (índice TTL existente no código).
const SELF_EXPIRING = {
  sessions: 'sessões de login expiram sozinhas (8 h)',
  integrationrequests: 'chaves de repetição do BotGhost expiram sozinhas (7 dias)',
};

const DAY = 24 * 60 * 60 * 1000;

// Ritmo de crescimento a partir do período coberto pelos registros. Com
// menos de 30 dias ou de 30 registros a estimativa é marcada como amostra
// pequena (pode errar muito).
function estimateGrowth({ count, avgObjSize, indexSize, oldest, newest, now = new Date() }) {
  if (!count || !oldest) return { docsPerMonth: null, bytesPerMonth: null, smallSample: true, spanDays: 0 };
  const end = newest && newest > now ? now : (newest || now);
  const spanDays = Math.max(1, (new Date(end) - new Date(oldest)) / DAY);
  // Período mínimo de 30 dias: poucos registros de hoje não viram "30 por
  // mês" (a amostra pequena continua sinalizada).
  const docsPerMonth = (count / Math.max(30, spanDays)) * 30;
  const perDoc = (avgObjSize || 0) + (count ? (indexSize || 0) / count : 0);
  return {
    docsPerMonth: Math.round(docsPerMonth),
    bytesPerMonth: Math.round(docsPerMonth * perDoc),
    smallSample: spanDays < 30 || count < 30,
    spanDays: Math.round(spanDays),
  };
}

async function collectionStats(db, name) {
  try {
    const [s] = await db.collection(name).aggregate([{ $collStats: { storageStats: {} } }]).toArray();
    const st = s && s.storageStats;
    if (st) return { count: st.count, size: st.size, storageSize: st.storageSize, indexSize: st.totalIndexSize, avgObjSize: st.avgObjSize || 0, nindexes: st.nindexes, method: 'collStats' };
  } catch (_) { /* plano sem $collStats: tenta o comando */ }
  try {
    const st = await db.command({ collStats: name });
    return { count: st.count, size: st.size, storageSize: st.storageSize, indexSize: st.totalIndexSize, avgObjSize: st.avgObjSize || 0, nindexes: st.nindexes, method: 'collStats' };
  } catch (_) { /* último recurso: estimativa por amostra */ }
  const count = await db.collection(name).estimatedDocumentCount();
  let avg = 0;
  if (count) {
    const sample = await db.collection(name).aggregate([{ $sample: { size: 50 } }, { $project: { _id: 0, s: { $bsonSize: '$$ROOT' } } }]).toArray();
    avg = sample.length ? sample.reduce((a, b) => a + b.s, 0) / sample.length : 0;
  }
  return { count, size: Math.round(count * avg), storageSize: null, indexSize: null, avgObjSize: Math.round(avg), nindexes: null, method: 'amostra' };
}

async function dateRange(db, name, field) {
  const coll = db.collection(name);
  const proj = { projection: { _id: 0, [field]: 1 } };
  const [first] = await coll.find({ [field]: { $type: 'date' } }, proj).sort({ [field]: 1 }).limit(1).toArray();
  const [last] = await coll.find({ [field]: { $type: 'date' } }, proj).sort({ [field]: -1 }).limit(1).toArray();
  return { oldest: first ? first[field] : null, newest: last ? last[field] : null };
}

// Registros por mês nos últimos 6 meses (só contagens).
async function monthlyCounts(db, name, field, now = new Date()) {
  const since = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const rows = await db.collection(name).aggregate([
    { $match: { [field]: { $gte: since } } },
    { $group: { _id: { y: { $year: `$${field}` }, m: { $month: `$${field}` } }, n: { $sum: 1 } } },
  ]).toArray();
  const out = [];
  for (let i = 5; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const row = rows.find((r) => r._id.y === d.getFullYear() && r._id.m === d.getMonth() + 1);
    out.push({ month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, count: row ? row.n : 0 });
  }
  return out;
}

async function buildStorageReport({ now = new Date() } = {}) {
  const db = mongoose.connection.db;
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith('system.')).sort();
  const collections = [];
  for (const name of names) {
    const stats = await collectionStats(db, name);
    const field = DATE_FIELDS[name] || 'createdAt';
    const range = stats.count ? await dateRange(db, name, field) : { oldest: null, newest: null };
    const months = stats.count && range.oldest ? await monthlyCounts(db, name, field, now) : [];
    const growth = SELF_EXPIRING[name]
      ? { docsPerMonth: null, bytesPerMonth: 0, smallSample: false, spanDays: null, selfExpiring: SELF_EXPIRING[name] }
      : estimateGrowth({ ...stats, ...range, now });
    collections.push({ name, dateField: field, ...stats, ...range, months, growth });
  }
  let db0 = null;
  try { db0 = await db.command({ dbStats: 1 }); } catch (_) { /* soma das coleções */ }
  const sum = (k) => collections.reduce((a, c) => a + (c[k] || 0), 0);
  const dataSize = db0 ? db0.dataSize : sum('size');
  const indexSize = db0 ? db0.indexSize : sum('indexSize');
  const storageSize = db0 ? db0.storageSize : sum('storageSize');
  const used = dataSize + indexSize;
  const bytesPerMonth = collections.reduce((a, c) => a + (c.growth.bytesPerMonth || 0), 0);
  return {
    generatedAt: now.toISOString(),
    totals: {
      dataSize,
      indexSize,
      storageSize,
      used,
      limit: ATLAS_FREE_LIMIT_BYTES,
      usedPercent: +((used / ATLAS_FREE_LIMIT_BYTES) * 100).toFixed(2),
      bytesPerMonth,
      monthsUntilFull: bytesPerMonth > 0 ? Math.floor((ATLAS_FREE_LIMIT_BYTES - used) / bytesPerMonth) : null,
      smallSample: collections.some((c) => c.count && c.growth.smallSample && !c.growth.selfExpiring),
    },
    collections,
  };
}

module.exports = { buildStorageReport, estimateGrowth, ATLAS_FREE_LIMIT_BYTES, DATE_FIELDS };
