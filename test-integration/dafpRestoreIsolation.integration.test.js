const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

// Bug real: com uma prova DAFP em andamento (Role base removida e ACK
// "delivered"), o site continuava disparando dafp_base_restore. Eram avisos
// de tentativas ANTERIORES já encerradas que o BotGhost reservava e nunca
// confirmava: cada reserva vencida voltava para a fila na hora, sem contar
// tentativa — webhook a cada ~2 minutos, para sempre. Aqui fica travado:
// - a tentativa em andamento nunca ganha aviso de devolução nem recebe ADD;
// - avisos de outras tentativas ficam isolados (attemptId) e não disparam
//   enquanto o aluno está em prova; os de outros alunos param de repetir;
// - quando o aluno termina, devoluções antigas dele são dadas como cumpridas.

let db;
let M;
const envRef = { current: null };
let api;
let hook;
let dispatcher;

const X = '700000000000000111';
const Y = '700000000000000222';
const BASE = '810000000000000001';

before(async () => {
  db = await H.setupDb();
  M = {
    Exam: require('../models/Exam'),
    Room: require('../models/Room'),
    ExamAttempt: require('../models/ExamAttempt'),
    Notification: require('../models/IntegrationNotification'),
    lifecycle: require('../lib/examLifecycle'),
    NotificationDispatcher: require('../botghost/dispatcher').NotificationDispatcher,
  };
});
after(async () => { await db.teardown(); });

beforeEach(async () => {
  await db.reset();
  envRef.current = H.testEnv();
  await H.saveDefaultConfig({ dafp: { resultChannelId: '600000000000000009', baseRoleId: BASE } });
  require('../botghost/configStore').invalidate();
  api = await H.startApi(envRef);
  const e = await H.seedExam({ name: 'Capitão', questions: 5, points: 2 });
  await M.Exam.updateOne({ _id: e._id }, { $set: { slug: 'capitao', group: 'DAFP' } });
  hook = H.fakeWebhook();
  dispatcher = new M.NotificationDispatcher({ getEnv: () => envRef.current, fetchImpl: hook.fetchImpl, gapMs: 0, log: H.silentLog });
  dispatcher.stopped = false;
});
afterEach(async () => { await api.close(); });

let seq = 0;
async function startExam(student) {
  seq += 1;
  const r = await api.call('POST', '/dafp/rooms', { ...H.dafpActorFields(), student, supervisorDiscordId: '700000000000000202', examSlug: 'capitao', idempotencyKey: `isol-${seq}` });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return (await M.lifecycle.startOrResumeAttempt(r.body.data.roomId)).attempt;
}

async function endExam(attempt) {
  await M.lifecycle.finalizeAttempt(await M.ExamAttempt.findById(attempt._id), 'admin_closed');
  await M.Room.updateOne({ _id: attempt.roomId }, { $set: { status: 'closed' } });
}

// BotGhost como estava no teste real: reserva tudo, mas só confirma o
// DAFP_STARTED (o ramo DAFP_FINISHED ainda não confirma). Devolve o que viu.
async function botghostOnlyStart({ ackFinish = false } = {}) {
  const seen = [];
  for (const c of hook.calls.splice(0)) {
    const id = c.body.variables[0].value;
    const kind = c.body.variables[1].value;
    const r = await api.call('POST', `/notifications/${id}/claim`, {});
    const d = r.body.data || {};
    seen.push({ id, kind, status: r.status, code: r.body.code, attemptId: d.attemptId, action1: d.roleAction1Type || '' });
    if (r.status !== 200) continue;
    if (d.notificationActionType === 'DAFP_STARTED' || (ackFinish && d.publishMessage === 'false')) {
      await api.call('POST', `/notifications/${id}/ack`, { leaseToken: d.leaseToken, outcome: 'delivered' });
    }
  }
  return seen;
}

// "Passa o tempo": reservas vencem e as esperas acabam.
async function timePasses() {
  await M.Notification.updateMany({ status: 'claimed' }, { $set: { 'lease.until': new Date(Date.now() - 1000) } });
  await require('../botghost/notifications').expireLeases();
  await M.Notification.updateMany({ status: 'pending' }, { $set: { nextDispatchAt: new Date(Date.now() - 1000) } });
}

test('BUG: prova em andamento com a Role removida — nenhum dafp_base_restore dela; avisos antigos não ficam repetindo', async () => {
  // Testes anteriores: X e Y fizeram provas que terminaram; o BotGhost
  // reservou as devoluções e nunca confirmou.
  for (const st of [X, Y]) {
    const a = await startExam(st);
    await dispatcher.tick(); await botghostOnlyStart();
    await endExam(a);
  }
  await dispatcher.tick(); await botghostOnlyStart();

  // X inicia uma prova nova: remoção reservada e confirmada.
  const cur = await startExam(X);
  const restoresDuringExam = [];
  for (let round = 0; round < 25; round += 1) {
    await timePasses();
    await dispatcher.reconcile();
    await dispatcher.tick();
    const seen = await botghostOnlyStart();
    for (const s of seen) if (s.kind === 'dafp_base_restore') restoresDuringExam.push(s);
    // Nenhum claim devolveu ADD para a tentativa em andamento.
    assert.ok(!seen.some((s) => s.attemptId === String(cur._id) && s.action1 === 'ADD'), `rodada ${round}: ADD para a tentativa em andamento`);
  }
  const doc = await M.ExamAttempt.findById(cur._id).lean();
  assert.equal(doc.status, 'in_progress');
  assert.ok(doc.dafpBaseRole.removeConfirmedAt, 'remoção confirmada');
  assert.equal(doc.dafpBaseRole.releasedAt, null, 'não foi marcada como encerrada');
  assert.equal(doc.dafpBaseRole.restoreRequestedAt, null, 'nenhuma devolução pedida');
  assert.equal(await M.Notification.countDocuments({ kind: 'dafp_base_restore', attemptId: cur._id }), 0, 'nenhum aviso de devolução da tentativa atual');

  // Avisos antigos isolados por tentativa: o de X (em prova) não dispara;
  // o de Y para depois das tentativas (fica "com falha", não repete).
  assert.ok(restoresDuringExam.every((s) => s.attemptId !== String(cur._id)), 'toda devolução vista é de outra tentativa');
  const xOld = await M.ExamAttempt.findOne({ discordUserId: X, _id: { $ne: cur._id } }).lean();
  const yOld = await M.ExamAttempt.findOne({ discordUserId: Y }).lean();
  const xOldN = await M.Notification.findOne({ key: `dafp_restore:${xOld._id}` }).lean();
  const yOldN = await M.Notification.findOne({ key: `dafp_restore:${yOld._id}` }).lean();
  assert.equal(restoresDuringExam.filter((s) => s.id === String(xOldN._id)).length, 0, 'devolução antiga de X não disparou com X em prova');
  assert.equal(xOldN.status, 'cancelled');
  assert.ok(xOldN.history.some((h) => h.event === 'held_not_dispatched'));
  assert.ok(restoresDuringExam.filter((s) => s.id === String(yOldN._id)).length <= 6, 'devolução de Y não repete sem limite');
  assert.equal(yOldN.status, 'failed');
  assert.match(yOldN.lastError, /nunca confirmou/);
});

test('aviso de devolução criado indevidamente para tentativa em andamento: webhook não dispara e o claim nunca devolve ADD', async () => {
  const cur = await startExam(X);
  await dispatcher.tick(); await botghostOnlyStart();
  // Simula um aviso criado indevidamente (dados antigos/bug anterior).
  const bad = await M.Notification.create({ kind: 'dafp_base_restore', key: `dafp_restore:${cur._id}`, attemptId: cur._id, payload: { baseRoleId: BASE, memberDiscordId: X } });
  const claim = await api.call('POST', `/notifications/${bad._id}/claim`, {});
  assert.equal(claim.status, 410);
  assert.equal(claim.body.code, 'nothing_to_do');
  assert.equal(claim.body.data.roleAction1Type, undefined, 'sem ação de cargo');
  // Recolocado na fila: o despacho não dispara o webhook.
  await M.Notification.updateOne({ _id: bad._id }, { $set: { status: 'pending', nextDispatchAt: new Date(0) } });
  hook.calls.length = 0;
  await dispatcher.tick();
  assert.equal(hook.calls.filter((c) => c.body.variables[0].value === String(bad._id)).length, 0);
  const n = await M.Notification.findById(bad._id).lean();
  assert.equal(n.status, 'cancelled');
  assert.match(n.history.at(-1).detail, /ainda está em andamento/);
  // Reconciliação não mexe (a tentativa está em andamento).
  await dispatcher.reconcile();
  assert.equal((await M.Notification.findById(bad._id).lean()).status, 'cancelled');
});

test('ACK da remoção atrasado ou ausente não vira motivo para devolver', async () => {
  const cur = await startExam(X);
  await dispatcher.tick();
  const [c] = hook.calls.splice(0);
  const claim = await api.call('POST', `/notifications/${c.body.variables[0].value}/claim`, {});
  assert.equal(claim.status, 200);
  // BotGhost não confirma; a reserva vence várias vezes.
  for (let i = 0; i < 4; i += 1) {
    await timePasses();
    await dispatcher.reconcile();
    await dispatcher.tick();
    hook.calls.length = 0;
  }
  assert.equal(await M.Notification.countDocuments({ kind: 'dafp_base_restore' }), 0);
  const doc = await M.ExamAttempt.findById(cur._id).lean();
  assert.equal(doc.dafpBaseRole.removeConfirmedAt, null);
  assert.equal(doc.dafpBaseRole.releasedAt, null);
});

test('quando o aluno termina, a devolução nova confirma as antigas dele (superseded) e nada antigo volta à fila', async () => {
  const first = await startExam(X);
  await dispatcher.tick(); await botghostOnlyStart();
  await endExam(first);
  await dispatcher.tick(); await botghostOnlyStart(); // devolução antiga reservada, sem ack
  const cur = await startExam(X);
  await timePasses(); await dispatcher.tick(); await botghostOnlyStart();
  await endExam(cur);
  await timePasses();
  await dispatcher.tick();
  const seen = await botghostOnlyStart({ ackFinish: true });
  assert.ok(seen.some((s) => s.kind === 'dafp_base_restore' && s.attemptId === String(cur._id) && s.action1 === 'ADD'), 'devolução da prova que terminou');
  const oldDoc = await M.ExamAttempt.findById(first._id).lean();
  assert.ok(oldDoc.dafpBaseRole.restoreConfirmedAt);
  assert.equal(oldDoc.dafpBaseRole.restoreConfirmedVia, 'superseded');
  assert.equal((await M.Notification.findOne({ key: `dafp_restore:${first._id}` }).lean()).status, 'cancelled');
  assert.equal(await dispatcher.reconcileDafpRoles(), 0, 'nada a refazer');
});

test('duas provas simultâneas do mesmo aluno continuam: a Role só volta quando a última termina', async () => {
  const a = await startExam(X);
  const e2 = await H.seedExam({ name: 'Major', questions: 5, points: 2 });
  await M.Exam.updateOne({ _id: e2._id }, { $set: { slug: 'major', group: 'DAFP' } });
  const r = await api.call('POST', '/dafp/rooms', { ...H.dafpActorFields(), student: X, supervisorDiscordId: '700000000000000202', examSlug: 'major', idempotencyKey: 'isol-major-1' });
  const b = (await M.lifecycle.startOrResumeAttempt(r.body.data.roomId)).attempt;
  await dispatcher.tick(); await botghostOnlyStart();
  await endExam(a);
  await timePasses(); await dispatcher.reconcile(); await dispatcher.tick();
  const seen = await botghostOnlyStart({ ackFinish: true });
  assert.ok(!seen.some((s) => s.action1 === 'ADD'), 'b ainda em andamento: nenhum ADD');
  await endExam(b);
  await timePasses(); await dispatcher.reconcile(); await dispatcher.tick();
  const after = await botghostOnlyStart({ ackFinish: true });
  assert.ok(after.some((s) => s.kind === 'dafp_base_restore' && s.action1 === 'ADD'), 'última terminou: ADD');
  const docs = await M.ExamAttempt.find({ _id: { $in: [a._id, b._id] } }).lean();
  assert.ok(docs.every((d) => d.dafpBaseRole.restoreConfirmedAt), 'as duas quitadas');
});
