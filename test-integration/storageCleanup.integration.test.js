const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

// Quadro do cluster (atlasSize) e "Limpar armazenamento" com dados
// controlados. Nenhum dado real: banco em memória.

let db;
let M;
let mongoose;
let site;

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date();
const C = new Date(NOW.getTime() - 30 * DAY); // corte de "mais de 1 mês"
const at = (days) => new Date(C.getTime() + days * DAY); // relativo ao corte

before(async () => {
  db = await H.setupDb();
  mongoose = db.mongoose;
  M = {
    Exam: require('../models/Exam'),
    Room: require('../models/Room'),
    ExamAttempt: require('../models/ExamAttempt'),
    ExamEvent: require('../models/ExamEvent'),
    SecurityLog: require('../models/SecurityLog'),
    Notification: require('../models/IntegrationNotification'),
    Promotion: require('../models/Promotion'),
    StorageCleanup: require('../models/StorageCleanup'),
    HistoryCounter: require('../models/HistoryCounter'),
    IntegrationConfig: require('../models/IntegrationConfig'),
    cleanup: require('../lib/storageCleanup'),
    cluster: require('../lib/clusterStorage'),
    liveState: require('../lib/liveState'),
  };
});
after(async () => { await db.teardown(); });
beforeEach(async () => {
  await db.reset();
  await mongoose.connection.client.db('outro_projeto').dropDatabase();
  M.cluster.setCommandRunner(null);
  site = await H.startSite();
});
afterEach(async () => { await site.close(); });

let exam;
let seq = 0;
async function room(fields) {
  seq += 1;
  const doc = { examId: exam._id, roomLabel: `Sala ${seq}`, studentName: `Aluno ${seq}`, studentTokenHash: `hash-${seq}-${Math.random()}`, proctorTokens: [], status: 'finished', currentAttemptId: null, endedAt: null, createdAt: at(-60), updatedAt: at(-60), ...fields };
  const { insertedId } = await M.Room.collection.insertOne(doc);
  return insertedId;
}
async function attempt(roomId, fields) {
  const doc = {
    roomId, examId: exam._id, studentName: 'Aluno', status: 'finished', startedAt: at(-61), expiresAt: at(-60), finishedAt: at(-60),
    durationMinutes: 60, pointsPerQuestion: 10, snapshot: [{ order: 1, questionId: exam._id, text: 'q', options: [], correctKey: 'A', selectedKey: 'A', isCorrect: true }],
    score: 10, deletedAt: null, createdAt: at(-61), updatedAt: at(-60), ...fields,
  };
  const { insertedId } = await M.ExamAttempt.collection.insertOne(doc);
  await M.Room.collection.updateOne({ _id: roomId }, { $set: { currentAttemptId: insertedId } });
  return insertedId;
}
async function finishedPair(finishedAt, roomFields = {}, attemptFields = {}) {
  const r = await room({ endedAt: finishedAt, updatedAt: finishedAt, ...roomFields });
  const a = await attempt(r, { finishedAt, ...attemptFields });
  return { r, a };
}
async function notification(attemptId, fields) {
  seq += 1;
  return M.Notification.create({ kind: 'result', key: `k-${seq}`, attemptId, status: 'delivered', message: { channelId: '600000000000000002', messageId: '1300000000000000001', deliveredAt: at(-59) }, ...fields });
}
async function event(roomId, attemptId, when) {
  await M.ExamEvent.collection.insertOne({ roomId, attemptId, actor: 'student', type: 'answer_submitted', at: when });
}

async function seedScenario() {
  exam = await H.seedExam({ name: 'Prova Capitão', questions: 2 });
  await H.saveDefaultConfig();
  await require('../botghost/configStore').setPanelMessage('600000000000000001', '1300000000000000099');
  const s = {};
  s.A = await finishedPair(at(-10));                                          // antigo → sai
  await notification(s.A.a);
  await event(s.A.r, s.A.a, at(-10));
  await event(s.A.r, s.A.a, at(-9));
  s.B = await finishedPair(at(5));                                            // recente → fica
  await notification(s.B.a);
  s.Cx = await finishedPair(C);                                               // exatamente no corte → fica
  s.D = { r: await room({ status: 'active', createdAt: at(-20), updatedAt: at(-20) }) }; // em andamento
  s.D.a = await attempt(s.D.r, { status: 'in_progress', startedAt: at(-20), finishedAt: null, expiresAt: at(-19) });
  s.E = await finishedPair(null, { endedAt: null, updatedAt: at(-10) }, { finishedAt: null }); // sem data de conclusão
  s.F = await finishedPair(at(-10));                                          // usada em promoção
  await M.Promotion.collection.insertOne({ guildId: H.GUILD, discordUserId: '700000000000000001', draftId: new mongoose.Types.ObjectId(), attemptId: s.F.a, operatorId: H.OPERATOR, nomeRP: 'x', idRP: '1', nickname: 'x', status: 'completed', createdAt: at(-9) });
  await event(s.F.r, s.F.a, at(-10));
  s.G = await finishedPair(at(-10));                                          // aviso pendente
  await notification(s.G.a, { status: 'pending', message: {} });
  s.H = await finishedPair(at(-10), { examGroup: 'DAFP' }, { examGroup: 'DAFP', dafpBaseRoleRemovedId: '820000000000000009', dafpBaseRole: { restoreConfirmedAt: null } });
  s.I = await finishedPair(at(-10), { examGroup: 'DAFP' }, { examGroup: 'DAFP', dafpBaseRoleRemovedId: '820000000000000009', dafpBaseRole: { restoreConfirmedAt: at(-9) } });
  await notification(s.I.a, { kind: 'dafp_base_restore', message: {} });
  s.J = { r: await room({ status: 'pending', updatedAt: at(-40) }) };         // abandonada (nunca iniciada)
  await event(s.J.r, null, at(-40));
  s.K = { r: await room({ status: 'pending', updatedAt: at(-40) }) };         // abandonada, mas alguém conectado agora
  await event(s.K.r, null, at(-40));
  M.liveState.patch(String(s.K.r), { roomLabel: 'K', studentName: 'K', studentOnline: true });
  s.L = { r: await room({ status: 'closed', endedAt: null, updatedAt: at(-5) }) }; // antiga sem endedAt → updatedAt
  s.N = await finishedPair(at(-3), { endedAt: at(2), updatedAt: at(2) });     // tentativa antiga, sala encerrada depois do corte
  s.O = await finishedPair(at(-10), { status: 'pending', endedAt: null, currentAttemptId: null, updatedAt: at(-10) }, { deletedAt: at(-9) }); // nota excluída (lógica)
  await M.Room.collection.updateOne({ _id: s.O.r }, { $set: { currentAttemptId: null } });
  await event(new mongoose.Types.ObjectId(), null, at(-50));                 // evento órfão antigo
  await event(s.B.r, s.B.a, at(6));                                           // evento recente
  await M.SecurityLog.collection.insertMany([
    { type: 'admin_login_success', meta: {}, at: at(-10) },
    { type: 'admin_login_success', meta: {}, at: C },
    { type: 'admin_login_success', meta: {}, at: at(3) },
    { type: 'storage_cleanup_executed', meta: {}, at: at(-10) },
  ]);
  // Outro projeto no MESMO cluster: nunca é tocado.
  await mongoose.connection.client.db('outro_projeto').collection('examattempts').insertMany([{ finishedAt: at(-300), status: 'finished' }, { at: at(-300) }]);
  return s;
}

async function counts() {
  const out = {};
  for (const c of await mongoose.connection.db.listCollections().toArray()) {
    if (c.name === 'storagecleanups') continue;
    out[c.name] = await mongoose.connection.db.collection(c.name).countDocuments();
  }
  out.outro = await mongoose.connection.client.db('outro_projeto').collection('examattempts').countDocuments();
  return out;
}

const admin = { id: 'admin-1', username: 'dono' };
const exists = async (model, id) => Boolean(await model.collection.findOne({ _id: id }));

test('prévia (30 dias): conta elegíveis e preservados por motivo, corte fixo no servidor e NADA apagado', async () => {
  await seedScenario();
  const before = await counts();
  const p = await M.cleanup.createPreview({ days: 30, admin, now: NOW });
  assert.deepEqual(await counts(), before, 'simulação não apaga nada');
  assert.equal(new Date(p.cutoff).getTime(), C.getTime());
  assert.deepEqual(p.preview.counts, { attempts: 3, notifications: 2, rooms: 5, examEvents: 4, securityLogs: 1 });
  assert.deepEqual(p.preview.preserved, {
    attemptsInProgress: 1,
    attemptsNoDate: 1,
    attemptsPromotion: 1,
    attemptsPendingNotification: 1,
    attemptsDafpRole: 1,
    attemptsRoomKept: 1,
    roomsActive: 1,
    roomsWithAttempts: 4,
    roomsOnline: 1,
    examEventsLinked: 2,
    securityLogsCleanup: 1,
  });
  assert.ok(p.preview.estimatedBytes > 0, 'estimativa de dados');
  // 60 e 90 dias: corte mais antigo → menos elegíveis.
  const p90 = await M.cleanup.createPreview({ days: 90, admin, now: NOW });
  assert.equal(p90.preview.counts.attempts, 0);
  await assert.rejects(M.cleanup.createPreview({ days: 45, admin, now: NOW }), /Período inválido/);
});

test('execução: apaga só o elegível, mantém dependências, protegidos, outro banco e o total acumulado', async () => {
  const s = await seedScenario();
  const protectedBefore = {};
  for (const name of ['exams', 'questions', 'integrationconfigs', 'promotions', 'users', 'settings', 'messagetemplates']) {
    protectedBefore[name] = await mongoose.connection.db.collection(name).countDocuments();
  }
  const panelBefore = (await M.IntegrationConfig.findOne({ singleton: 'main' }).lean()).panelMessage;
  const p = await M.cleanup.createPreview({ days: 30, admin, now: NOW });
  const { promise } = await M.cleanup.startCleanup({ previewId: p.id, cutoff: p.cutoff, admin, now: NOW });
  const result = await promise;
  assert.deepEqual(result.deleted, { attempts: 3, notifications: 2, rooms: 5, examEvents: 4, securityLogs: 1 });
  assert.deepEqual(result.failures, []);

  // Apagados (com dependências).
  for (const id of [s.A.a, s.I.a, s.O.a]) assert.equal(await exists(M.ExamAttempt, id), false);
  for (const id of [s.A.r, s.I.r, s.O.r, s.J.r, s.L.r]) assert.equal(await exists(M.Room, id), false);
  assert.equal(await M.Notification.countDocuments({ attemptId: { $in: [s.A.a, s.I.a] } }), 0);
  assert.equal(await M.ExamEvent.countDocuments({ attemptId: s.A.a }), 0);

  // Preservados.
  for (const id of [s.B.a, s.Cx.a, s.D.a, s.E.a, s.F.a, s.G.a, s.H.a, s.N.a]) assert.ok(await exists(M.ExamAttempt, id), String(id));
  for (const id of [s.B.r, s.Cx.r, s.D.r, s.E.r, s.F.r, s.G.r, s.H.r, s.K.r, s.N.r]) assert.ok(await exists(M.Room, id), String(id));
  assert.equal(await M.Notification.countDocuments({ attemptId: { $in: [s.B.a, s.G.a] } }), 2, 'avisos de tentativas mantidas e pendentes ficam');
  assert.equal(await M.ExamEvent.countDocuments({ attemptId: s.F.a }), 1, 'histórico de tentativa mantida fica');
  assert.equal(await M.ExamEvent.countDocuments({ roomId: s.K.r }), 1);
  assert.equal(await M.ExamEvent.countDocuments({ at: { $gte: C } }), 1, 'evento recente fica');
  // Sem referências quebradas: nenhuma sala mantida aponta para tentativa apagada.
  for (const r of await M.Room.find({ currentAttemptId: { $ne: null } }).lean()) assert.ok(await exists(M.ExamAttempt, r.currentAttemptId));
  for (const a of await M.ExamAttempt.find().lean()) assert.ok(await exists(M.Room, a.roomId), 'toda tentativa mantida tem sala');

  // Logs: o exatamente-no-corte, o recente e o da limpeza antiga ficam; nova auditoria criada.
  assert.equal(await M.SecurityLog.countDocuments({ type: 'admin_login_success' }), 2);
  assert.equal(await M.SecurityLog.countDocuments({ type: 'storage_cleanup_executed' }), 2);
  const audit = await M.SecurityLog.findOne({ type: 'storage_cleanup_executed', 'meta.runId': p.id }).lean();
  assert.equal(audit.meta.by, 'dono');
  assert.equal(audit.meta.days, 30);
  assert.equal(audit.meta.cutoff, C.toISOString());
  assert.deepEqual(audit.meta.deleted, result.deleted);

  // Nada protegido mudou; outro banco intacto.
  for (const [name, n] of Object.entries(protectedBefore)) assert.equal(await mongoose.connection.db.collection(name).countDocuments(), n, name);
  assert.deepEqual((await M.IntegrationConfig.findOne({ singleton: 'main' }).lean()).panelMessage, panelBefore, 'painel do Discord intacto');
  assert.equal(await mongoose.connection.client.db('outro_projeto').collection('examattempts').countDocuments(), 2);

  // "Provas finalizadas" não diminui: A e I contam (O já era nota excluída).
  assert.equal(await M.HistoryCounter.get(M.cleanup.FINISHED_COUNTER_KEY), 2);
  const run = await M.cleanup.getRun(p.id);
  assert.equal(run.status, 'done');
  assert.equal(await M.StorageCleanup.countDocuments({ lockKey: 'global' }), 0, 'trava liberada');
});

test('dashboard: total de provas finalizadas é o mesmo antes e depois da limpeza', async () => {
  await H.seedAdmin('dono', 'senha-do-dono-123', 'primary');
  const call = site.client();
  assert.equal((await call('POST', '/api/admin/login', { username: 'dono', password: 'senha-do-dono-123' })).status, 200);
  await seedScenario();
  const before = (await call('GET', '/api/admin/dashboard')).body.dashboard.examsFinished;
  const p = await M.cleanup.createPreview({ days: 30, admin, now: NOW });
  await (await M.cleanup.startCleanup({ previewId: p.id, cutoff: p.cutoff, admin, now: NOW })).promise;
  assert.equal((await call('GET', '/api/admin/dashboard')).body.dashboard.examsFinished, before);
});

test('confirmação presa à prévia: corte diferente, outro admin, vencida, reutilizada e limpeza simultânea são recusados', async () => {
  await seedScenario();
  const p = await M.cleanup.createPreview({ days: 30, admin, now: NOW });
  await assert.rejects(M.cleanup.startCleanup({ previewId: p.id, cutoff: new Date(C.getTime() - 1).toISOString(), admin, now: NOW }), (e) => e.status === 409);
  await assert.rejects(M.cleanup.startCleanup({ previewId: p.id, cutoff: p.cutoff, admin: { id: 'outro', username: 'x' }, now: NOW }), (e) => e.status === 403);
  await assert.rejects(M.cleanup.startCleanup({ previewId: p.id, cutoff: p.cutoff, admin, now: new Date(NOW.getTime() + 11 * 60 * 1000) }), (e) => e.status === 410);
  await assert.rejects(M.cleanup.startCleanup({ previewId: 'nao-existe', cutoff: p.cutoff, admin, now: NOW }), (e) => e.status === 409);
  // Outra limpeza em andamento (inclusive de outro processo): trava global.
  const other = await M.StorageCleanup.create({ status: 'running', days: 30, cutoff: C, createdBy: 'x', expiresAt: NOW, lockKey: 'global' });
  await assert.rejects(M.cleanup.startCleanup({ previewId: p.id, cutoff: p.cutoff, admin, now: NOW }), (e) => e.status === 409);
  assert.equal((await M.StorageCleanup.findById(p.id).lean()).status, 'preview', 'prévia segue utilizável');
  await M.StorageCleanup.deleteOne({ _id: other._id });
  const { promise } = await M.cleanup.startCleanup({ previewId: p.id, cutoff: p.cutoff, admin, now: NOW });
  const p2 = await M.cleanup.createPreview({ days: 30, admin, now: NOW });
  await assert.rejects(M.cleanup.startCleanup({ previewId: p2.id, cutoff: p2.cutoff, admin, now: NOW }), (e) => e.status === 409, 'duas limpezas ao mesmo tempo');
  await promise;
  await assert.rejects(M.cleanup.startCleanup({ previewId: p.id, cutoff: p.cutoff, admin, now: NOW }), (e) => e.status === 409, 'prévia já usada');
  // Reinício no meio: execução marcada como interrompida e trava solta.
  await M.StorageCleanup.create({ status: 'running', days: 30, cutoff: C, createdBy: 'x', expiresAt: NOW, lockKey: 'global' });
  await M.cleanup.recoverInterruptedRuns();
  assert.equal(await M.StorageCleanup.countDocuments({ lockKey: 'global' }), 0);
  assert.equal(await M.StorageCleanup.countDocuments({ status: 'interrupted' }), 1);
});

test('revalidação na execução: o que ganhou pendência depois da prévia é preservado', async () => {
  const s = await seedScenario();
  const p = await M.cleanup.createPreview({ days: 30, admin, now: NOW });
  // Depois da prévia: aviso novo pendente para I e alguém entra na sala J.
  await notification(s.I.a, { kind: 'result', status: 'pending', message: {} });
  M.liveState.patch(String(s.J.r), { roomLabel: 'J', studentName: 'J', studentOnline: true });
  const result = await (await M.cleanup.startCleanup({ previewId: p.id, cutoff: p.cutoff, admin, now: NOW })).promise;
  assert.ok(await exists(M.ExamAttempt, s.I.a), 'I ganhou aviso pendente');
  assert.ok(await exists(M.Room, s.I.r), 'sala de I continua (tentativa mantida)');
  assert.ok(await exists(M.Room, s.J.r), 'J tem alguém conectado');
  assert.equal(result.deleted.attempts, 2);
  assert.equal(result.previewCounts.attempts, 3, 'prévia contava I');
  assert.equal(result.preserved.attemptsPendingNotification, 2, 'G e agora I');
  assert.equal(result.preserved.roomsOnline, 2, 'K e agora J');
  assert.equal(await M.Notification.countDocuments({ attemptId: s.I.a }), 2, 'avisos de I intactos');
  M.liveState.removeRoom(String(s.J.r));
  M.liveState.removeRoom(String(s.K.r));
});

test('quadro do cluster: usa atlasSize (total de TODOS os bancos), faixas de situação, cache e limite de atualização', async () => {
  let calls = 0;
  const MB = 1024 * 1024;
  M.cluster.setCommandRunner(async (cmd) => {
    calls += 1;
    assert.deepEqual(cmd, { atlasSize: 1 });
    return { ok: 1, totals: { dataSize: 300 * MB, indexSize: 100 * MB, storageSize: 250 * MB, numDatabases: 4 }, atlasSize: 400 * MB };
  });
  const s = await M.cluster.getClusterStorage({ now: NOW });
  assert.equal(s.ok, true);
  assert.equal(s.usedBytes, 400 * MB, 'total do cluster, não o banco deste site');
  assert.equal(s.databases, 4);
  assert.equal(s.limitBytes, 512 * MB);
  assert.equal(s.remainingBytes, 112 * MB);
  assert.equal(s.percent, 78.13);
  assert.equal(s.level, 'warning');
  assert.equal(s.checkedAt, NOW.toISOString());
  // Cache de 5 minutos; atualização manual limitada a cada 30 s.
  assert.equal((await M.cluster.getClusterStorage({ now: new Date(NOW.getTime() + 60e3) })).cached, true);
  assert.equal(calls, 1);
  const forced = await M.cluster.getClusterStorage({ force: true, now: new Date(NOW.getTime() + 61e3) });
  assert.equal(forced.cached, false);
  const throttled = await M.cluster.getClusterStorage({ force: true, now: new Date(NOW.getTime() + 70e3) });
  assert.equal(throttled.throttled, true);
  assert.equal(calls, 2);
  assert.equal((await M.cluster.getClusterStorage({ now: new Date(NOW.getTime() + 62e3 + 5 * 60e3) })).cached, false);
  // Faixas.
  assert.deepEqual([69.99, 70, 84.99, 85, 94.99, 95, 120].map((p) => M.cluster.levelFor(p).level), ['normal', 'warning', 'warning', 'high', 'high', 'critical', 'critical']);
  // Limite ajustável.
  process.env.ATLAS_STORAGE_LIMIT_MB = '1024';
  M.cluster.invalidate();
  const big = await M.cluster.getClusterStorage({ now: NOW });
  assert.equal(big.limitBytes, 1024 * MB);
  assert.equal(big.level, 'normal');
  delete process.env.ATLAS_STORAGE_LIMIT_MB;
});

test('falha na consulta: "Não foi possível consultar o consumo total", sem zero nem consumo parcial, sem segredo', async () => {
  M.cluster.setCommandRunner(async () => { throw Object.assign(new Error('not authorized on admin mongodb+srv://usuario:senha123@cluster0'), { codeName: 'Unauthorized' }); });
  const s = await M.cluster.getClusterStorage({ now: NOW });
  assert.equal(s.ok, false);
  assert.equal(s.message, 'Não foi possível consultar o consumo total');
  assert.equal(s.errorCode, 'Unauthorized');
  for (const k of ['usedBytes', 'percent', 'remainingBytes', 'dataBytes']) assert.equal(k in s, false, k);
  assert.ok(!JSON.stringify(s).includes('senha123'));
  assert.ok(s.guidance.length >= 2);
  // Resposta sem atlasSize também é falha (nunca vira zero).
  M.cluster.setCommandRunner(async () => ({ ok: 1, totals: { dataSize: 10 } }));
  assert.equal((await M.cluster.getClusterStorage({ now: NOW })).ok, false);
  // Banco sem o comando (este de teste, como um cluster pago): falha honesta.
  M.cluster.setCommandRunner(null);
  const real = await M.cluster.getClusterStorage({ now: NOW });
  assert.equal(real.ok, false);
  assert.equal('usedBytes' in real, false);
});

test('API: principal consulta e limpa pelo painel; conta restrita é barrada antes de qualquer dado', async () => {
  await H.seedAdmin('dono', 'senha-do-dono-123', 'primary');
  await H.seedAdmin('restrito', 'senha-restrito-123', 'restricted');
  const owner = site.client();
  await owner('POST', '/api/admin/login', { username: 'dono', password: 'senha-do-dono-123' });
  const restricted = site.client();
  await restricted('POST', '/api/admin/login', { username: 'restrito', password: 'senha-restrito-123' });
  M.cluster.setCommandRunner(async () => ({ ok: 1, totals: { numDatabases: 2 }, atlasSize: 1000 }));
  await seedScenario();
  const before = await counts();

  assert.equal((await restricted('GET', '/api/admin/storage/cluster')).status, 403);
  assert.equal((await restricted('POST', '/api/admin/storage/cleanup/preview', { days: 30 })).status, 403);

  const cl = await owner('GET', '/api/admin/storage/cluster');
  assert.equal(cl.body.storage.usedBytes, 1000);
  const prev = await owner('POST', '/api/admin/storage/cleanup/preview', { days: 30 });
  assert.equal(prev.status, 200);
  assert.deepEqual(await counts(), before);
  // Conta restrita não confirma prévia alheia (nem chega à validação).
  const denied = await restricted('POST', '/api/admin/storage/cleanup/execute', { previewId: prev.body.preview.id, cutoff: prev.body.preview.cutoff });
  assert.equal(denied.status, 403);
  assert.equal((await M.StorageCleanup.findById(prev.body.preview.id).lean()).status, 'preview');
  const ex = await owner('POST', '/api/admin/storage/cleanup/execute', { previewId: prev.body.preview.id, cutoff: prev.body.preview.cutoff });
  assert.equal(ex.status, 202, JSON.stringify(ex.body));
  let run;
  for (let i = 0; i < 100; i += 1) {
    run = (await owner('GET', `/api/admin/storage/cleanup/runs/${ex.body.run.id}`)).body.run;
    if (run.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(run.status, 'done');
  assert.ok(run.result.deleted.attempts >= 1);
  const current = await owner('GET', '/api/admin/storage/cleanup/current');
  assert.equal(current.body.run, null);
  assert.equal(current.body.history[0].id, ex.body.run.id);
});

test('depois da limpeza, mensagens já publicadas no Discord continuam funcionando (consulta do bot e edição da mesma mensagem)', async () => {
  const envRef = { current: H.testEnv() };
  await H.saveDefaultConfig();
  const api = await H.startApi(envRef);
  try {
    // Resultado real e recente, publicado no canal (claim → ack com ID real).
    exam = await H.seedExam();
    const r = await api.call('POST', '/rooms', { ...H.actorFields(), student: '700000000000000001', studentDisplayName: 'Recruta', idempotencyKey: 'interacao-limpeza-1' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const recent = await H.takeExam(r.body.data.roomId, 4);
    const n = await M.Notification.findOne({ attemptId: recent._id });
    const c1 = await api.call('POST', `/notifications/${n._id}/claim`, {});
    await api.call('POST', `/notifications/${n._id}/ack`, { leaseToken: c1.body.data.leaseToken, outcome: 'delivered', messageId: '1400000000000000002' });
    // Histórico antigo de outro aluno, já publicado há muito tempo.
    const old = await finishedPair(at(-20));
    await notification(old.a);

    const p = await M.cleanup.createPreview({ days: 30, admin, now: NOW });
    assert.equal(p.preview.counts.attempts, 1);
    await (await M.cleanup.startCleanup({ previewId: p.id, cutoff: p.cutoff, admin, now: NOW })).promise;
    assert.equal(await exists(M.ExamAttempt, old.a), false);

    // O bot ainda consulta o resultado recente…
    const res = await api.call('GET', '/results', { ...H.actorFields(), student: '700000000000000001' });
    assert.equal(res.body.data.items[0].attemptId, String(recent._id));
    // …e uma mudança de nota EDITA a mesma mensagem já publicada.
    await require('../lib/results').setOralScore({ attemptId: String(recent._id), oralScore: 10, actor: 'admin:t' });
    const c2 = await api.call('POST', `/notifications/${n._id}/claim`, {});
    assert.equal(c2.body.data.action, 'edit');
    assert.equal(c2.body.data.messageId, '1400000000000000002');
  } finally {
    await api.close();
  }
});
