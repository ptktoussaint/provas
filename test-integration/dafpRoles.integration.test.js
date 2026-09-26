const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

// Ciclo de cargos do DAFP: Role base sai no INÍCIO real da prova e volta no
// fim (sempre); cargo de aprovado só aprovado; Mérito em Proficiência só com
// nota máxima. Tudo pela fila (webhook → claim → ação → ack), idempotente,
// e sem tocar no TCEL.

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
  };
});
after(async () => { await db.teardown(); });

beforeEach(async () => {
  await db.reset();
  envRef.current = H.testEnv();
  await H.saveDefaultConfig({
    operatorIds: { generate: H.OPERATOR, results: H.OPERATOR, promote: H.OPERATOR },
    dafp: { resultChannelId: DAFP_CHANNEL, baseRoleId: BASE, perfectScoreRoleId: MERIT },
  });
  require('../botghost/configStore').invalidate();
  api = await H.startApi(envRef);
  await dafpExam('Aspirante', 'aspirante', { auto: true });
  await dafpExam('Major', 'major', { auto: false });
});
afterEach(async () => { await api.close(); });

async function dafpExam(name, slug, { auto }) {
  const e = await H.seedExam({ name, questions: 10, points: 1 });
  await M.Exam.updateOne({ _id: e._id }, { $set: { slug, group: 'DAFP', autoApproval: auto, passingScore: auto ? 7 : null, approvedRoleId: auto ? ROLE_ASP : null, failedRoleId: '810000000000000099' } });
}

let seq = 0;
async function createRoom(examSlug, student = STUDENT) {
  seq += 1;
  const r = await api.call('POST', '/dafp/rooms', {
    ...H.dafpActorFields(), student, supervisorDiscordId: EVALUATOR, examSlug, idempotencyKey: `roles-${seq}`,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data.roomId;
}

async function start(roomId) {
  return (await M.lifecycle.startOrResumeAttempt(roomId)).attempt;
}

async function answerAndFinish(attempt, correct, reason = 'manual') {
  const doc = await M.ExamAttempt.findById(attempt._id);
  doc.snapshot.forEach((q, i) => { q.selectedKey = i < correct ? q.correctKey : (q.correctKey === 'A' ? 'B' : 'A'); q.isCorrect = i < correct; });
  await doc.save();
  return M.lifecycle.finalizeAttempt(doc, reason);
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

test('1-3: criar sala não mexe em cargo; iniciar gera UMA remoção da Role base; refresh/reconexão não repetem', async () => {
  const roomId = await createRoom('aspirante');
  assert.equal(await M.Notification.countDocuments(), 0, 'sala criada: nenhuma ação de cargo');
  const s0 = (await api.call('GET', `/dafp/sessions/${roomId}`, H.dafpActorFields())).body.data;
  assert.equal(s0.sessionStatus, 'CRIADA');
  assert.equal(s0.roleActionsPhase, '');
  assert.equal(s0.roleAction1Enabled, 'false');
  assert.equal(s0.dafpBaseRoleId, BASE);
  assert.equal(s0.dafpPerfectScoreRoleId, MERIT);

  const attempt = await start(roomId);
  assert.equal(attempt.dafpBaseRoleRemovedId, BASE);
  // Refresh / reconexão / cliques repetidos no início.
  await Promise.all([start(roomId), start(roomId), start(roomId)]);
  assert.equal(await M.Notification.countDocuments({ kind: 'dafp_started' }), 1);
  assert.equal(await M.Notification.countDocuments(), 1);

  const s1 = (await api.call('GET', `/dafp/sessions/${roomId}`, H.dafpActorFields())).body.data;
  assert.equal(s1.sessionStatus, 'EM_ANDAMENTO');
  assert.equal(s1.roleActionsPhase, 'START');
  assert.deepEqual(slots(s1), [`REMOVE ${BASE} ${STUDENT}`, '-', '-']);

  const { n, c, d } = await claimKey(`dafp_started:${attempt._id}`);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(d.kind, 'dafp_started');
  assert.equal(d.notificationActionType, 'DAFP_STARTED');
  assert.equal(d.publishMessage, 'false');
  assert.equal(d.action, 'none');
  assert.equal(d.channelId, '');
  assert.equal(d.roleActionsPhase, 'START');
  assert.deepEqual(slots(d), [`REMOVE ${BASE} ${STUDENT}`, '-', '-']);
  assert.deepEqual(d.roleActions, [{ action: 'REMOVE', roleId: BASE, memberDiscordId: STUDENT }]);
  assert.equal(d.sessionId, roomId);
  assert.equal(d.studentDiscordId, STUDENT);
  assert.equal(d.applyRole, 'false');
  // Ack sem messageId (nada foi publicado); repetir o ack não duplica.
  const a1 = await ack(n, d);
  assert.equal(a1.body.code, 'acked', JSON.stringify(a1.body));
  assert.equal((await ack(n, d)).body.code, 'already_acked');
  assert.equal((await api.call('POST', `/notifications/${n._id}/claim`, {})).body.code, 'already_delivered');
});

test('4-6: reprovado só devolve a base; aprovado + cargo da prova; gabarito + Mérito', async () => {
  const cases = [
    { correct: 6, status: 'REPROVADO', perfect: 'false', expected: [`ADD ${BASE} ${STUDENT}`, '-', '-'], legacy: ['false', ''] },
    { correct: 8, status: 'APROVADO', perfect: 'false', expected: [`ADD ${BASE} ${STUDENT}`, `ADD ${ROLE_ASP} ${STUDENT}`, '-'], legacy: ['true', ROLE_ASP] },
    { correct: 10, status: 'APROVADO', perfect: 'true', expected: [`ADD ${BASE} ${STUDENT}`, `ADD ${ROLE_ASP} ${STUDENT}`, `ADD ${MERIT} ${STUDENT}`], legacy: ['true', ROLE_ASP] },
  ];
  for (const k of cases) {
    const student = `70000000000000${String(1000 + k.correct)}`;
    const roomId = await createRoom('aspirante', student);
    const attempt = await start(roomId);
    const st = await claimKey(`dafp_started:${attempt._id}`);
    await ack(st.n, st.d);
    const fin = await answerAndFinish(attempt, k.correct);
    assert.equal(fin.outcome.resultStatus, k.status);
    assert.equal(fin.outcome.perfectScore, k.perfect === 'true');

    const { n, c, d } = await claimKey(`result:${attempt._id}`);
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(d.notificationActionType, 'DAFP_FINISHED');
    assert.equal(d.publishMessage, 'true');
    assert.equal(d.action, 'send');
    assert.equal(d.templateKey, 'dafp_result');
    assert.equal(d.channelId, DAFP_CHANNEL);
    assert.equal(d.resultStatus, k.status);
    assert.equal(d.perfectScore, k.perfect);
    assert.equal(d.scoreText, `${k.correct}/10`);
    assert.equal(d.roleActionsPhase, 'FINISH');
    const expected = k.expected.map((x) => x.replace(STUDENT, student));
    assert.deepEqual(slots(d), expected, `${k.correct}/10`);
    assert.equal(d.roleActions.length, expected.filter((x) => x !== '-').length);
    // Campos legados continuam (cargo de aprovado).
    assert.deepEqual([d.applyRole, d.roleId, d.memberDiscordId], [k.legacy[0], k.legacy[1], student]);
    // Mensagem publicada normalmente.
    assert.equal(d.message.embeds[0].title, 'RESULTADO DA PROVA');
    assert.equal((await ack(n, d, { messageId: '910000000000000001', channelId: DAFP_CHANNEL })).body.code, 'acked');

    const s = (await api.call('GET', `/dafp/sessions/${roomId}`, H.dafpActorFields())).body.data;
    assert.equal(s.perfectScore, k.perfect);
    assert.equal(s.finishReason, 'FINALIZADA_PELO_ALUNO');
    assert.deepEqual(slots(s), expected);

    // Edição posterior (ex.: prova oral lançada) edita a mensagem e NÃO
    // repete nenhuma ação de cargo.
    await M.results.setOralScore({ attemptId: String(attempt._id), oralScore: 1, actor: 'admin:t' });
    const edit = await claimKey(`result:${attempt._id}`);
    assert.equal(edit.d.action, 'edit');
    assert.deepEqual(slots(edit.d), ['-', '-', '-']);
    assert.equal(edit.d.applyRole, 'false');
    await ack(edit.n, edit.d, { messageId: '910000000000000001' });
  }
  const list = (await api.call('GET', '/dafp/results', { ...H.dafpActorFields(), pageSize: '1' })).body.data;
  assert.equal(list.resultPerfectScore, 'true', 'o mais recente é o 10/10');
});

test('7-8: sem aprovação automática — gabarito ganha só base + Mérito; sem gabarito só a base', async () => {
  for (const [correct, expected, perfect] of [
    [10, [`ADD ${BASE} ${STUDENT}`, '-', `ADD ${MERIT} ${STUDENT}`], 'true'],
    [5, [`ADD ${BASE} ${STUDENT}`, '-', '-'], 'false'],
  ]) {
    await db.reset();
    await H.saveDefaultConfig({ operatorIds: { generate: H.OPERATOR, results: H.OPERATOR, promote: H.OPERATOR }, dafp: { resultChannelId: DAFP_CHANNEL, baseRoleId: BASE, perfectScoreRoleId: MERIT } });
    require('../botghost/configStore').invalidate();
    await dafpExam('Major', 'major', { auto: false });
    const roomId = await createRoom('major');
    const attempt = await start(roomId);
    await answerAndFinish(attempt, correct);
    const { d } = await claimKey(`result:${attempt._id}`);
    assert.equal(d.resultStatus, 'NAO_APLICAVEL');
    assert.equal(d.perfectScore, perfect);
    assert.deepEqual(slots(d), expected, `${correct}/10`);
    assert.equal(d.failedRoleId, '', 'cargo de reprovado antigo (gravado na prova) não é usado');
  }
});

test('9: iniciada e encerrada pelo admin — só devolve a Role base; excluída em andamento também devolve, sem mensagem', async () => {
  // Encerramento da sala pelo admin (mesma chamada da rota do admin).
  const roomId = await createRoom('aspirante');
  const attempt = await start(roomId);
  const doc = await M.ExamAttempt.findById(attempt._id);
  doc.snapshot.forEach((q) => { q.selectedKey = q.correctKey; q.isCorrect = true; });
  await doc.save();
  const closed = await M.lifecycle.finalizeAttempt(doc, 'admin_closed');
  assert.equal(closed.outcome.finishReason, 'ENCERRADA_PELO_ADMIN');
  assert.equal(closed.outcome.resultStatus, 'NAO_APLICAVEL', 'cancelamento: sem aprovação');
  assert.equal(closed.outcome.perfectScore, false, 'sem Mérito em cancelamento');
  // A remoção do início ainda não tinha sido executada: foi cancelada.
  assert.equal((await M.Notification.findOne({ key: `dafp_started:${attempt._id}` })).status, 'cancelled');
  const { d } = await claimKey(`result:${attempt._id}`);
  assert.deepEqual(slots(d), [`ADD ${BASE} ${STUDENT}`, '-', '-']);
  assert.equal(d.finishReason, 'ENCERRADA_PELO_ADMIN');

  // Resultado excluído com a prova em andamento: devolve a base SEM publicar
  // (aviso próprio de devolução; o resultado não é publicado).
  const room2 = await createRoom('aspirante', '700000000000000555');
  const at2 = await start(room2);
  const st = await claimKey(`dafp_started:${at2._id}`);
  await ack(st.n, st.d);
  await M.results.softDeleteResult({ attemptId: String(at2._id), reason: 'cancelada', actor: 'admin:t' });
  assert.equal(await M.Notification.countDocuments({ key: `result:${at2._id}` }), 0, 'nada a publicar');
  const del = await claimKey(`dafp_restore:${at2._id}`);
  assert.equal(del.c.status, 200, JSON.stringify(del.c.body));
  assert.equal(del.d.notificationActionType, 'DAFP_FINISHED');
  assert.equal(del.d.publishMessage, 'false');
  assert.equal(del.d.action, 'none');
  assert.deepEqual(slots(del.d), [`ADD ${BASE} 700000000000000555`, '-', '-']);
  assert.equal((await ack(del.n, del.d)).body.code, 'acked');
  // A varredura de expiração finalizando a tentativa excluída depois não
  // gera outra ação.
  await M.lifecycle.finalizeAttempt(await M.ExamAttempt.findById(at2._id), 'timeout');
  assert.equal((await M.Notification.findOne({ key: `dafp_restore:${at2._id}` })).status, 'delivered');
  assert.equal(await M.Notification.countDocuments({ attemptId: at2._id }), 2, 'início + devolução, nada mais');
});

test('10: finalização duplicada não duplica ações; fim espera a remoção do início que está com o BotGhost', async () => {
  const roomId = await createRoom('aspirante');
  const attempt = await start(roomId);
  // O BotGhost reservou a remoção do início e ainda não confirmou.
  const st = await claimKey(`dafp_started:${attempt._id}`);
  const stale = await M.ExamAttempt.findById(attempt._id);
  stale.snapshot.forEach((q) => { q.selectedKey = q.correctKey; q.isCorrect = true; });
  await stale.save();
  await Promise.all([
    M.lifecycle.finalizeAttempt(stale, 'manual'),
    M.lifecycle.finalizeAttempt(stale, 'timeout'),
    M.lifecycle.finalizeAttempt(await M.ExamAttempt.findById(attempt._id), 'admin_closed'),
  ]);
  assert.equal((await M.ExamAttempt.findById(attempt._id).lean()).revision, 1);
  assert.equal(await M.Notification.countDocuments({ attemptId: attempt._id, kind: 'result' }), 1);
  assert.equal(await M.Notification.countDocuments({ attemptId: attempt._id, kind: 'dafp_started' }), 1);

  // Devolução não pode passar na frente da remoção em andamento.
  const early = await claimKey(`result:${attempt._id}`);
  assert.equal(early.c.status, 409);
  assert.equal(early.c.body.code, 'not_ready');
  await ack(st.n, st.d);
  await M.Notification.updateOne({ _id: early.n._id }, { $set: { status: 'pending' } });
  const fin = await claimKey(`result:${attempt._id}`);
  assert.equal(fin.c.status, 200);
  assert.equal(fin.d.roleAction1Type, 'ADD');
  assert.equal((await ack(fin.n, fin.d, { messageId: '910000000000000002' })).body.code, 'acked');
  assert.equal((await api.call('POST', `/notifications/${fin.n._id}/claim`, {})).body.code, 'already_delivered');
});

test('11: TCEL intacto — sem aviso de início, sem cargos, mesma mensagem', async () => {
  const tcel = await H.seedExam({ name: 'Prova Tcel' });
  await M.Exam.updateOne({ _id: tcel._id }, { $set: { slug: 'tcel', group: 'TCEL' } });
  const r = await api.call('POST', '/rooms', { ...H.actorFields(), student: '700000000000000909', idempotencyKey: 'tcel-roles-1' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.examName, 'Prova Tcel');
  assert.equal(r.body.data.dafpBaseRoleId, undefined, 'resposta TCEL sem campos DAFP');
  const attempt = await start(r.body.data.roomId);
  assert.equal(attempt.dafpBaseRoleRemovedId, null);
  assert.equal(await M.Notification.countDocuments({ kind: 'dafp_started' }), 0);
  await answerAndFinish(attempt, 4);
  const done = await M.ExamAttempt.findById(attempt._id).lean();
  assert.equal(done.outcome.baseRoleId, null);
  assert.equal(done.outcome.perfectScoreRoleId, null);
  const { d } = await claimKey(`result:${attempt._id}`);
  assert.equal(d.templateKey, 'result_finished');
  assert.equal(d.notificationActionType, 'TCEL_RESULT');
  assert.equal(d.publishMessage, 'true');
  assert.deepEqual(slots(d), ['-', '-', '-']);
  assert.equal(d.applyRole, 'false');
  assert.equal(d.message.content, 'Prova finalizada: <@700000000000000909> — Nota: 80 / 100 — Prova: Prova Tcel');
});

test('12: falha do BotGhost/Discord — prova segue iniciada/finalizada; falha registrada e reprocessável', async () => {
  const roomId = await createRoom('aspirante');
  const attempt = await start(roomId);
  const st = await claimKey(`dafp_started:${attempt._id}`);
  const fail = await api.call('POST', `/notifications/${st.n._id}/ack`, { leaseToken: st.d.leaseToken, outcome: 'failed', error: 'Missing Permissions: cargo acima do bot' });
  assert.equal(fail.body.code, 'will_retry');
  let n = await M.Notification.findById(st.n._id).lean();
  assert.equal(n.status, 'pending');
  assert.match(n.lastError, /Missing Permissions/);
  assert.equal((await M.ExamAttempt.findById(attempt._id).lean()).status, 'in_progress', 'prova continua');

  // Reservas vencidas de "só cargos" voltam para a fila (refazer é seguro).
  const again = await claimKey(`dafp_started:${attempt._id}`);
  await M.Notification.updateOne({ _id: st.n._id }, { $set: { 'lease.until': new Date(Date.now() - 1000) } });
  await M.notifications.expireLeases();
  assert.equal((await M.Notification.findById(st.n._id).lean()).status, 'pending');
  assert.ok(again.d.leaseToken);

  // Fim: a remoção pendente é cancelada (a devolução cobre) e a falha no
  // envio do resultado não desfaz nota/aprovação.
  const fin = await answerAndFinish(attempt, 8);
  assert.equal((await M.Notification.findById(st.n._id).lean()).status, 'cancelled');
  const r = await claimKey(`result:${attempt._id}`);
  const rf = await api.call('POST', `/notifications/${r.n._id}/ack`, { leaseToken: r.d.leaseToken, outcome: 'failed', error: 'Discord indisponível' });
  assert.equal(rf.body.code, 'will_retry');
  n = await M.Notification.findById(r.n._id).lean();
  assert.match(n.lastError, /Discord indisponível/);
  const doc = await M.ExamAttempt.findById(fin._id).lean();
  assert.equal(doc.status, 'finished');
  assert.equal(doc.outcome.resultStatus, 'APROVADO');
  // Tentativas esgotadas → "failed" → reprocessável pelo admin; as ações de
  // cargo continuam valendo na nova reserva.
  await M.Notification.updateOne({ _id: r.n._id }, { $set: { status: 'failed' } });
  await M.notifications.adminRetry(r.n._id, 'admin:t');
  const retry = await claimKey(`result:${attempt._id}`);
  assert.deepEqual(slots(retry.d), [`ADD ${BASE} ${STUDENT}`, `ADD ${ROLE_ASP} ${STUDENT}`, '-']);
});

test('rede de segurança: aviso de início ou de devolução que faltou é recriado pela reconciliação', async () => {
  const { NotificationDispatcher } = require('../botghost/dispatcher');
  const dispatcher = new NotificationDispatcher({ getEnv: () => envRef.current, log: H.silentLog });
  const roomId = await createRoom('aspirante');
  const attempt = await start(roomId);
  // Simula o site caindo entre criar a tentativa e o aviso de início.
  await M.Notification.deleteMany({});
  await dispatcher.reconcile();
  assert.equal(await M.Notification.countDocuments({ key: `dafp_started:${attempt._id}` }), 1);
  await dispatcher.reconcile();
  assert.equal(await M.Notification.countDocuments({ key: `dafp_started:${attempt._id}` }), 1, 'sem duplicar');

  // Excluída em andamento e o aviso de devolução se perdeu.
  await M.results.softDeleteResult({ attemptId: String(attempt._id), reason: 'cancelada', actor: 'admin:t' });
  await M.Notification.deleteMany({ key: `dafp_restore:${attempt._id}` });
  await dispatcher.reconcile();
  const { d } = await claimKey(`dafp_restore:${attempt._id}`);
  assert.deepEqual(slots(d), [`ADD ${BASE} ${STUDENT}`, '-', '-']);
  assert.equal(d.publishMessage, 'false');
});
