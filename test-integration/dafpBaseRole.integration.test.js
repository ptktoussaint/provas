const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

// Proteção da Role base do DAFP (estado desejado): fora de uma prova DAFP
// EFETIVAMENTE em andamento o aluno precisa ter a Role base. Saiu de "em
// andamento" por qualquer motivo → aviso próprio de devolução
// (dafp_base_restore) que não depende da mensagem nem do resultado, com
// estado persistente na tentativa e reconciliação que nunca deixa a
// devolução sumir.

let db;
let M;
const envRef = { current: null };
let api;

const STUDENT = '700000000000000101';
const EVALUATOR = '700000000000000202';
const DAFP_CHANNEL = '600000000000000009';
const BASE = '810000000000000001'; // Bombeiros Militares da Fluxo
const MERIT = '810000000000000002'; // Mérito em Proficiência
const ROLE_ASP = '810000000000000003'; // Aprovado Prova Aspirante

before(async () => {
  db = await H.setupDb();
  M = {
    Exam: require('../models/Exam'),
    Room: require('../models/Room'),
    ExamAttempt: require('../models/ExamAttempt'),
    Notification: require('../models/IntegrationNotification'),
    lifecycle: require('../lib/examLifecycle'),
    results: require('../lib/results'),
    notifications: require('../botghost/notifications'),
    NotificationDispatcher: require('../botghost/dispatcher').NotificationDispatcher,
  };
});
after(async () => { await db.teardown(); });

beforeEach(async () => {
  await db.reset();
  envRef.current = H.testEnv();
  await H.saveDefaultConfig({
    operatorIds: { generate: H.OPERATOR, results: H.OPERATOR, promote: H.OPERATOR, dafp: H.OPERATOR },
    dafp: { resultChannelId: DAFP_CHANNEL, baseRoleId: BASE, perfectScoreRoleId: MERIT },
  });
  require('../botghost/configStore').invalidate();
  api = await H.startApi(envRef);
  await dafpExam('Aspirante', 'aspirante');
  await dafpExam('Major', 'major');
});
afterEach(async () => { await api.close(); });

async function dafpExam(name, slug) {
  const e = await H.seedExam({ name, questions: 10, points: 1 });
  await M.Exam.updateOne({ _id: e._id }, { $set: { slug, group: 'DAFP', autoApproval: true, passingScore: 7, approvedRoleId: ROLE_ASP } });
}

let seq = 0;
async function createRoom(examSlug = 'aspirante', student = STUDENT) {
  seq += 1;
  const r = await api.call('POST', '/dafp/rooms', {
    ...H.actorFields(), student, supervisorDiscordId: EVALUATOR, examSlug, idempotencyKey: `base-${seq}`,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data.roomId;
}

async function start(roomId) {
  return (await M.lifecycle.startOrResumeAttempt(roomId)).attempt;
}

async function answer(attemptId, correct) {
  const doc = await M.ExamAttempt.findById(attemptId);
  doc.snapshot.forEach((q, i) => { q.selectedKey = i < correct ? q.correctKey : (q.correctKey === 'A' ? 'B' : 'A'); q.isCorrect = i < correct; });
  await doc.save();
  return doc;
}

async function claimKey(key) {
  const n = await M.Notification.findOne({ key });
  assert.ok(n, `aviso ${key} existe`);
  const c = await api.call('POST', `/notifications/${n._id}/claim`, {});
  return { n, c, d: c.body.data };
}

function slots(d) {
  return [1, 2, 3].map((i) => (d[`roleAction${i}Enabled`] === 'true' ? `${d[`roleAction${i}Type`]} ${d[`roleAction${i}RoleId`]} ${d[`roleAction${i}MemberDiscordId`]}` : '-'));
}

async function ack(n, d, extra = {}) {
  return api.call('POST', `/notifications/${n._id}/ack`, { leaseToken: d.leaseToken, outcome: 'delivered', ...extra });
}

async function state(attemptId) {
  return (await M.ExamAttempt.findById(attemptId).lean()).dafpBaseRole || {};
}

// Início completo: remoção reservada e confirmada pelo BotGhost.
async function startAndRemove(roomId) {
  const attempt = await start(roomId);
  const st = await claimKey(`dafp_started:${attempt._id}`);
  assert.equal(st.c.status, 200, JSON.stringify(st.c.body));
  assert.equal((await ack(st.n, st.d)).body.code, 'acked');
  return attempt;
}

// Devolução pela fila: reserva, confere que é SÓ o ADD da Role base, confirma.
async function expectRestore(attemptId, member = STUDENT) {
  const r = await claimKey(`dafp_restore:${attemptId}`);
  assert.equal(r.c.status, 200, JSON.stringify(r.c.body));
  assert.equal(r.d.kind, 'dafp_base_restore');
  assert.equal(r.d.notificationActionType, 'DAFP_FINISHED');
  assert.equal(r.d.publishMessage, 'false');
  assert.equal(r.d.action, 'none');
  assert.equal(r.d.roleActionsPhase, 'FINISH');
  assert.deepEqual(slots(r.d), [`ADD ${BASE} ${member}`, '-', '-']);
  assert.deepEqual(r.d.roleActions, [{ action: 'ADD', roleId: BASE, memberDiscordId: member }]);
  assert.equal(r.d.dafpBaseRoleState, 'DEVOLUCAO_PENDENTE');
  assert.equal((await ack(r.n, r.d)).body.code, 'acked');
  const s = await state(attemptId);
  assert.ok(s.restoreConfirmedAt, 'devolução confirmada na tentativa');
  assert.equal(s.restoreConfirmedVia, 'dafp_base_restore');
  return r;
}

function fakeIo() {
  return { to: () => ({ emit() {} }) };
}

async function waitFor(fn, ms = 4000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

test('A: professor cria a sala e o aluno não inicia — a Role base NÃO é removida', async () => {
  const roomId = await createRoom();
  assert.equal(await M.Notification.countDocuments(), 0, 'nenhum aviso de cargo');
  const s = (await api.call('GET', `/dafp/sessions/${roomId}`, H.actorFields())).body.data;
  assert.equal(s.sessionStatus, 'CRIADA');
  assert.equal(s.dafpBaseRoleState, '');
  assert.equal(s.roleAction1Enabled, 'false');
  // A reconciliação também não cria nada para sala não iniciada.
  const dispatcher = new M.NotificationDispatcher({ getEnv: () => envRef.current, log: H.silentLog });
  assert.equal(await dispatcher.reconcile(), 0);
  assert.equal(await M.Notification.countDocuments(), 0);
});

test('B: aluno inicia — exatamente UMA ação REMOVE da Role base; estado persistido', async () => {
  const roomId = await createRoom();
  const attempt = await start(roomId);
  assert.equal(await M.Notification.countDocuments(), 1);
  let s = await state(attempt._id);
  assert.ok(s.suspendedAt, 'entrou em andamento com a Role base');
  assert.ok(s.removeRequestedAt, 'remoção pedida');
  assert.equal(s.removeConfirmedAt, null);
  assert.equal(s.releasedAt, null);

  const { n, c, d } = await claimKey(`dafp_started:${attempt._id}`);
  assert.equal(c.status, 200);
  assert.equal(d.notificationActionType, 'DAFP_STARTED');
  assert.equal(d.publishMessage, 'false');
  assert.equal(d.roleActionsPhase, 'START');
  assert.deepEqual(slots(d), [`REMOVE ${BASE} ${STUDENT}`, '-', '-']);
  assert.equal(d.dafpBaseRoleState, 'SUSPENSA');
  assert.equal((await ack(n, d)).body.code, 'acked');
  s = await state(attempt._id);
  assert.ok(s.removeConfirmedAt, 'BotGhost confirmou a remoção');
  const sess = (await api.call('GET', `/dafp/sessions/${roomId}`, H.actorFields())).body.data;
  assert.equal(sess.sessionStatus, 'EM_ANDAMENTO');
  assert.equal(sess.dafpBaseRoleState, 'SUSPENSA');
});

test('C: refresh/reconexão — nenhuma remoção nova e nenhuma devolução indevida', async () => {
  const roomId = await createRoom();
  const attempt = await startAndRemove(roomId);
  // Recarregar, reconectar e clicar de novo: é a mesma tentativa.
  const again = await Promise.all([start(roomId), start(roomId), start(roomId)]);
  for (const a of again) assert.equal(String(a._id), String(attempt._id));
  const dispatcher = new M.NotificationDispatcher({ getEnv: () => envRef.current, log: H.silentLog });
  await dispatcher.reconcile();
  assert.equal(await M.Notification.countDocuments({ kind: 'dafp_started' }), 1);
  assert.equal(await M.Notification.countDocuments({ kind: 'dafp_base_restore' }), 0, 'desconexão não é encerramento');
  assert.equal((await M.ExamAttempt.findById(attempt._id).lean()).status, 'in_progress');
});

test('D: aluno finaliza normalmente — ADD da Role base (aviso próprio + resultado)', async () => {
  const roomId = await createRoom();
  const attempt = await startAndRemove(roomId);
  const doc = await answer(attempt._id, 8);
  const fin = await M.lifecycle.finalizeAttempt(doc, 'manual');
  assert.equal(fin.outcome.resultStatus, 'APROVADO');
  assert.ok((await state(attempt._id)).releasedAt, 'saiu de em andamento');
  assert.ok((await state(attempt._id)).restoreRequestedAt, 'devolução pedida');
  await expectRestore(attempt._id);
  // O resultado continua com as ações da atualização anterior (ADD base é
  // repetido — seguro — mais o cargo de aprovado).
  const r = await claimKey(`result:${attempt._id}`);
  assert.deepEqual(slots(r.d), [`ADD ${BASE} ${STUDENT}`, `ADD ${ROLE_ASP} ${STUDENT}`, '-']);
  assert.equal(r.d.dafpBaseRoleState, 'DEVOLVIDA');
  assert.equal((await ack(r.n, r.d, { messageId: '910000000000000001' })).body.code, 'acked');
});

test('E: tempo da prova acaba (varredura do servidor) — ADD da Role base', async () => {
  const roomId = await createRoom();
  const attempt = await startAndRemove(roomId);
  await answer(attempt._id, 3);
  await M.ExamAttempt.updateOne({ _id: attempt._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const sweep = M.lifecycle.startExpirySweep(fakeIo(), 30);
  try {
    assert.ok(await waitFor(async () => M.Notification.exists({ key: `dafp_restore:${attempt._id}` })), 'varredura finalizou');
  } finally {
    clearInterval(sweep);
  }
  const done = await M.ExamAttempt.findById(attempt._id).lean();
  assert.equal(done.status, 'finished_timeout');
  assert.equal(done.outcome.finishReason, 'TEMPO_ESGOTADO');
  await expectRestore(attempt._id);
});

test('F: admin encerra a prova em andamento — ADD da Role base, sem aprovado nem Mérito', async () => {
  const roomId = await createRoom();
  const attempt = await startAndRemove(roomId);
  await answer(attempt._id, 10);
  // Mesmo caminho da rota do admin "Encerrar sala".
  await M.Room.updateOne({ _id: roomId }, { $set: { status: 'closed' } });
  const closed = await M.lifecycle.finalizeAttempt(await M.ExamAttempt.findById(attempt._id), 'admin_closed');
  assert.equal(closed.outcome.finishReason, 'ENCERRADA_PELO_ADMIN');
  assert.equal(closed.outcome.resultStatus, 'NAO_APLICAVEL', 'cancelamento não vira aprovado/reprovado');
  assert.equal(closed.outcome.perfectScore, false);
  await expectRestore(attempt._id);
  const r = await claimKey(`result:${attempt._id}`);
  assert.deepEqual(slots(r.d), [`ADD ${BASE} ${STUDENT}`, '-', '-']);
});

test('G: prova cancelada depois de iniciada (resultado excluído/invalidado) — ADD da Role base, sem mensagem', async () => {
  const roomId = await createRoom();
  const attempt = await startAndRemove(roomId);
  await answer(attempt._id, 10);
  await M.results.softDeleteResult({ attemptId: String(attempt._id), reason: 'prova cancelada', actor: 'admin:t' });
  const cur = await M.ExamAttempt.findById(attempt._id).lean();
  assert.equal(cur.outcome.resultStatus, null, 'nenhum resultado acadêmico decidido');
  assert.equal(await M.Notification.countDocuments({ key: `result:${attempt._id}` }), 0, 'nada é publicado');
  await expectRestore(attempt._id);
  // A varredura finalizando a tentativa excluída depois não gera mais nada.
  await M.lifecycle.finalizeAttempt(await M.ExamAttempt.findById(attempt._id), 'timeout');
  assert.equal(await M.Notification.countDocuments({ attemptId: attempt._id }), 2, 'remoção + devolução');
  // Aluno recebe a sala de volta e inicia de novo: nova remoção (nova tentativa).
  const second = await start(roomId);
  assert.notEqual(String(second._id), String(attempt._id));
  assert.equal(await M.Notification.countDocuments({ key: `dafp_started:${second._id}` }), 1);
});

test('H: abandono — desconexão não encerra; o fim definitivo (tempo esgotado) devolve a Role; sem reprovação automática', async () => {
  const roomId = await createRoom();
  const attempt = await startAndRemove(roomId);
  // Respondeu 8 e sumiu (fechou a aba / caiu a internet). Nada muda até o
  // servidor decidir o fim definitivo pelo prazo da própria prova.
  await answer(attempt._id, 8);
  const sweep = M.lifecycle.startExpirySweep(fakeIo(), 30);
  try {
    await new Promise((r) => setTimeout(r, 120));
    assert.equal((await M.ExamAttempt.findById(attempt._id).lean()).status, 'in_progress', 'ainda no prazo: continua em andamento');
    assert.equal(await M.Notification.countDocuments({ kind: 'dafp_base_restore' }), 0);
    await M.ExamAttempt.updateOne({ _id: attempt._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.ok(await waitFor(async () => M.Notification.exists({ key: `dafp_restore:${attempt._id}` })));
  } finally {
    clearInterval(sweep);
  }
  const done = await M.ExamAttempt.findById(attempt._id).lean();
  assert.equal(done.outcome.finishReason, 'TEMPO_ESGOTADO');
  assert.equal(done.outcome.resultStatus, 'APROVADO', 'corrige o que foi respondido: abandono não é reprovação automática');
  await expectRestore(attempt._id);
});

test('I: BotGhost/Discord falha na devolução — prova continua encerrada; devolução fica registrada e é refeita', async () => {
  const hook = H.fakeWebhook();
  hook.state.respond = () => ({ status: 503, body: 'offline' });
  const dispatcher = new M.NotificationDispatcher({ getEnv: () => envRef.current, fetchImpl: hook.fetchImpl, gapMs: 0, log: H.silentLog });
  const roomId = await createRoom();
  const attempt = await startAndRemove(roomId);
  await M.lifecycle.finalizeAttempt(await answer(attempt._id, 5), 'manual');

  // Webhook fora do ar: o aviso volta para a fila com o erro registrado.
  dispatcher.stopped = false;
  await dispatcher.tick();
  dispatcher.stopped = true;
  let n = await M.Notification.findOne({ key: `dafp_restore:${attempt._id}` }).lean();
  assert.equal(n.status, 'pending');
  assert.match(n.lastError, /503|offline/);

  // Discord recusa (ex.: bot sem permissão) até esgotar as tentativas.
  for (let i = 0; i < 6; i += 1) {
    await M.Notification.updateOne({ _id: n._id }, { $set: { status: 'pending' } });
    const r = await claimKey(`dafp_restore:${attempt._id}`);
    assert.equal(r.c.status, 200);
    await api.call('POST', `/notifications/${n._id}/ack`, { leaseToken: r.d.leaseToken, outcome: 'failed', error: 'Discord indisponível' });
  }
  n = await M.Notification.findById(n._id).lean();
  assert.equal(n.status, 'failed');
  const doc = await M.ExamAttempt.findById(attempt._id).lean();
  assert.equal(doc.status, 'finished', 'prova continua encerrada');
  assert.equal(doc.outcome.resultStatus, 'REPROVADO');
  assert.equal(doc.dafpBaseRole.restoreConfirmedAt, null, 'devolução NÃO confirmada');
  const sess = (await api.call('GET', `/dafp/sessions/${roomId}`, H.actorFields())).body.data;
  assert.equal(sess.dafpBaseRoleState, 'DEVOLUCAO_PENDENTE');

  // Reconciliação: recoloca na fila sozinha (não depende do admin).
  assert.ok(await dispatcher.reconcileDafpRoles() >= 1);
  assert.equal((await M.Notification.findById(n._id).lean()).status, 'pending');
  // Site reiniciou e o aviso sumiu: é recriado.
  await M.Notification.deleteOne({ _id: n._id });
  await dispatcher.reconcileDafpRoles();
  assert.equal(await M.Notification.countDocuments({ key: `dafp_restore:${attempt._id}` }), 1);
  await expectRestore(attempt._id);
  // Confirmada: a reconciliação para de agir.
  assert.equal(await dispatcher.reconcileDafpRoles(), 0);
  assert.equal((await api.call('GET', `/dafp/sessions/${roomId}`, H.actorFields())).body.data.dafpBaseRoleState, 'DEVOLVIDA');
});

test('J: processamento duplicado — sem inversão de estado nem inconsistência', async () => {
  const dispatcher = new M.NotificationDispatcher({ getEnv: () => envRef.current, log: H.silentLog });

  // 1. Encerramentos simultâneos + chamadas repetidas → UM aviso de devolução.
  const roomId = await createRoom();
  const attempt = await startAndRemove(roomId);
  const stale = await answer(attempt._id, 6);
  await Promise.all([
    M.lifecycle.finalizeAttempt(stale, 'manual'),
    M.lifecycle.finalizeAttempt(stale, 'timeout'),
    M.lifecycle.finalizeAttempt(stale, 'admin_closed'),
  ]);
  const fresh = await M.ExamAttempt.findById(attempt._id);
  await Promise.all([M.notifications.ensureBaseRoleRestore(fresh), M.notifications.ensureBaseRoleRestore(fresh), dispatcher.reconcile()]);
  assert.equal(await M.Notification.countDocuments({ kind: 'dafp_base_restore', attemptId: attempt._id }), 1);

  // 2. Webhook repetido para a remoção do início depois do fim: nunca
  //    remove de novo (o aluno ficaria sem a Role).
  const startN = await M.Notification.findOne({ key: `dafp_started:${attempt._id}` });
  await M.Notification.updateOne({ _id: startN._id }, { $set: { status: 'pending' } });
  const late = await api.call('POST', `/notifications/${startN._id}/claim`, {});
  assert.equal(late.status, 410);

  // 3. Resultado entregue primeiro (com o ADD base): o aviso próprio que
  //    ainda nem saiu é cancelado; ack repetido não muda nada.
  const r = await claimKey(`result:${attempt._id}`);
  assert.equal(r.d.roleAction1Type, 'ADD');
  assert.equal((await ack(r.n, r.d, { messageId: '910000000000000003' })).body.code, 'acked');
  assert.equal((await ack(r.n, r.d, { messageId: '910000000000000003' })).body.code, 'already_acked');
  assert.equal((await M.Notification.findOne({ key: `dafp_restore:${attempt._id}` })).status, 'cancelled');
  assert.equal((await state(attempt._id)).restoreConfirmedVia, 'result');
  assert.equal(await dispatcher.reconcileDafpRoles(), 0, 'confirmada: nada a refazer');

  // 4. Remoção confirmada FORA da reserva (venceu e a prova terminou no
  //    meio): a devolução é pedida de novo.
  const room2 = await createRoom('aspirante', '700000000000000777');
  const a2 = await start(room2);
  const st2 = await claimKey(`dafp_started:${a2._id}`);
  await M.Notification.updateOne({ _id: st2.n._id }, { $set: { 'lease.until': new Date(Date.now() - 1000) } });
  await M.notifications.expireLeases();
  await M.lifecycle.finalizeAttempt(await M.ExamAttempt.findById(a2._id), 'manual');
  assert.equal((await M.Notification.findById(st2.n._id)).status, 'cancelled', 'remoção não executada é cancelada');
  await expectRestore(a2._id, '700000000000000777');
  const lateAck = await ack(st2.n, st2.d);
  assert.equal(lateAck.body.code, 'lease_mismatch');
  assert.equal((await state(a2._id)).restoreConfirmedAt, null, 'devolução reaberta');
  await expectRestore(a2._id, '700000000000000777');

  // 5. Mesmo aluno com duas provas DAFP: terminar uma enquanto a outra está
  //    em andamento NÃO devolve a Role (estado desejado = ausente).
  const student = '700000000000000888';
  const ra = await createRoom('aspirante', student);
  const rb = await createRoom('major', student);
  const pa = await startAndRemove(ra);
  const pb = await startAndRemove(rb);
  await M.lifecycle.finalizeAttempt(await answer(pa._id, 8), 'manual');
  assert.equal(await M.Notification.countDocuments({ key: `dafp_restore:${pa._id}` }), 0, 'outra prova em andamento');
  const ra1 = await claimKey(`result:${pa._id}`);
  assert.deepEqual(slots(ra1.d), ['-', `ADD ${ROLE_ASP} ${student}`, '-'], 'sem ADD base; aprovado continua');
  await ack(ra1.n, ra1.d, { messageId: '910000000000000004' });
  await M.lifecycle.finalizeAttempt(await answer(pb._id, 2), 'manual');
  await expectRestore(pb._id, student);

  // 6. Nova prova do aluno enquanto uma devolução está com o BotGhost: a
  //    remoção espera (nunca executa ao mesmo tempo que a devolução).
  const rc = await createRoom('aspirante', '700000000000000999');
  const pc = await startAndRemove(rc);
  await M.lifecycle.finalizeAttempt(pc, 'manual');
  const inflight = await claimKey(`dafp_restore:${pc._id}`);
  assert.equal(inflight.c.status, 200);
  const rd = await createRoom('major', '700000000000000999');
  const pd = await start(rd);
  const wait = await claimKey(`dafp_started:${pd._id}`);
  assert.equal(wait.c.status, 409);
  assert.equal(wait.c.body.code, 'not_ready');
  await ack(inflight.n, inflight.d);
  await M.Notification.updateOne({ _id: wait.n._id }, { $set: { status: 'pending' } });
  const ok = await claimKey(`dafp_started:${pd._id}`);
  assert.equal(ok.c.status, 200);
  assert.equal(ok.d.roleAction1Type, 'REMOVE');
});

test('K: TCEL — nenhuma alteração (sem remoção, sem devolução, sem estado de Role)', async () => {
  const tcel = await H.seedExam({ name: 'Prova Tcel' });
  await M.Exam.updateOne({ _id: tcel._id }, { $set: { slug: 'tcel', group: 'TCEL' } });
  const r = await api.call('POST', '/rooms', { ...H.actorFields(), student: '700000000000000909', idempotencyKey: 'tcel-base-1' });
  assert.equal(r.status, 201);
  const attempt = await start(r.body.data.roomId);
  await M.lifecycle.finalizeAttempt(await answer(attempt._id, 4), 'manual');
  const done = await M.ExamAttempt.findById(attempt._id);
  assert.equal(done.dafpBaseRoleRemovedId, null);
  assert.equal(done.dafpBaseRole.suspendedAt, null);
  assert.equal(done.dafpBaseRole.releasedAt, null);
  assert.equal(await M.notifications.ensureBaseRoleRestore(done), null);
  const dispatcher = new M.NotificationDispatcher({ getEnv: () => envRef.current, log: H.silentLog });
  await dispatcher.reconcile();
  assert.equal(await M.Notification.countDocuments({ kind: { $in: ['dafp_started', 'dafp_base_restore'] } }), 0);
  const { d } = await claimKey(`result:${attempt._id}`);
  assert.equal(d.notificationActionType, 'TCEL_RESULT');
  assert.equal(d.templateKey, 'result_finished');
  assert.deepEqual(slots(d), ['-', '-', '-']);
  assert.equal(d.dafpBaseRoleState, undefined, 'claim TCEL sem campos DAFP');
  assert.equal(d.message.content, 'Prova finalizada: <@700000000000000909> — Nota: 80 / 100 — Prova: Prova Tcel');
});
