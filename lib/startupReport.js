const { mongoose } = require('../config/db');

// Relatório de inicialização (SOMENTE LEITURA) para os Logs do Render.
// Serve para conferir, logo depois de um deploy ou de trocar de serviço, que
// o site abriu o banco certo e o que ainda depende do serviço antigo. Mostra
// só contagens e nomes de campos — nunca valores, URLs, tokens, nomes de
// alunos ou a URI do banco. Não altera nada.

const COUNTS = [
  ['exams', 'provas'],
  ['questions', 'questões'],
  ['examattempts', 'tentativas'],
  ['rooms', 'salas'],
  ['users', 'acessos admin'],
];

// Arquivos enviados pelo painel ficam no disco temporário do Render
// (public/uploads): somem a cada deploy e não existem num serviço novo.
const UPLOAD_FIELDS = [
  ['settings', 'logoUrl'],
  ['settings', 'introVideoUrl'],
  ['settings', 'theme.backgroundImageUrl'],
  ['exams', 'imageUrl'],
  ['exams', 'introVideoUrl'],
];

async function count(db, name, filter = {}) {
  try { return await db.collection(name).countDocuments(filter); } catch (_) { return null; }
}

async function buildStartupReport({ publicBaseUrl } = {}) {
  const db = mongoose.connection.db;
  const counts = {};
  for (const [name] of COUNTS) counts[name] = await count(db, name);

  const uploads = [];
  for (const [coll, field] of UPLOAD_FIELDS) {
    const n = await count(db, coll, { [field]: { $regex: '^/uploads/' } });
    if (n) uploads.push({ field: `${coll}.${field}`, count: n });
  }

  // Endereço *.onrender.com diferente do atual gravado em configurações ou
  // modelos de mensagem (ex.: imagem servida pelo serviço antigo).
  const currentHost = (() => { try { return new URL(publicBaseUrl).host; } catch (_) { return ''; } })();
  const oldHosts = [];
  for (const coll of ['settings', 'exams', 'messagetemplates', 'integrationconfigs']) {
    try {
      const docs = await db.collection(coll).find({}).project({ _id: 0 }).limit(500).toArray();
      let n = 0;
      for (const d of docs) {
        const hosts = JSON.stringify(d).match(/https?:\/\/[a-z0-9.-]+\.onrender\.com/gi) || [];
        if (hosts.some((h) => new URL(h).host !== currentHost)) n += 1;
      }
      if (n) oldHosts.push({ collection: coll, count: n });
    } catch (_) { /* coleção ausente */ }
  }

  const queue = {};
  try {
    for (const r of await db.collection('integrationnotifications').aggregate([
      { $match: { status: { $in: ['pending', 'dispatched', 'claimed', 'ambiguous', 'failed'] } } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]).toArray()) queue[r._id] = r.n;
  } catch (_) { /* sem fila */ }

  const inProgress = await count(db, 'examattempts', { status: 'in_progress' });
  return { dbName: mongoose.connection.name, counts, uploads, oldHosts, queue, inProgress };
}

async function logStartupReport({ publicBaseUrl, log = console } = {}) {
  const r = await buildStartupReport({ publicBaseUrl });
  const c = COUNTS.map(([k, label]) => `${label}: ${r.counts[k] == null ? '?' : r.counts[k]}`).join(', ');
  log.log(`[inicio] banco "${r.dbName}" — ${c}`);
  if (!r.counts.users && !r.counts.exams) {
    log.warn('[inicio] ⚠ BANCO VAZIO: nenhuma prova e nenhum acesso admin. Se você esperava os dados existentes, PARE e confira MONGODB_URI/MONGODB_DB_NAME antes de usar o painel (não crie administrador).');
  }
  if (r.inProgress) log.log(`[inicio] ${r.inProgress} prova(s) "em andamento" no banco: as que já passaram do prazo serão finalizadas por tempo esgotado.`);
  const q = Object.entries(r.queue).map(([k, n]) => `${k}: ${n}`).join(', ');
  if (q) log.log(`[inicio] fila de avisos do BotGhost em aberto — ${q} (confira na aba Integração antes de ligar BOTGHOST_NOTIFICATIONS_ENABLED).`);
  for (const u of r.uploads) log.warn(`[inicio] ${u.count} registro(s) em ${u.field} apontam para /uploads/ (arquivo do disco do serviço antigo, não existe mais): reenvie ou troque por link no painel.`);
  for (const h of r.oldHosts) log.warn(`[inicio] ${h.count} registro(s) em ${h.collection} citam um endereço *.onrender.com diferente do atual: confira no painel.`);
  return r;
}

module.exports = { buildStartupReport, logStartupReport };
