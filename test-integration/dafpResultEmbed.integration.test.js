const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

// Resultado DAFP público: o BotGhost monta o Embed ("RESULTADO DA PROVA")
// e o botão "VERIFICAR NOTA" com os campos SEPARADOS do claim. O clique no
// botão é 100% BotGhost/Discord: nenhuma rota do site participa. Aqui fica
// travado o contrato do claim (campos individuais, cargos, devolução da
// Role base, ACK com o messageId da mensagem montada pelo BotGhost), a
// separação TCEL × DAFP e a ausência de qualquer rota de "verificar nota".

let db;
let M;
const envRef = { current: null };
let api;

const STUDENT = '700000000000000101';
const EVALUATOR = '700000000000000202';
const DAFP_CHANNEL = '600000000000000009';
const BASE = '810000000000000001'; // Bombeiros Militares da Fluxo
const MERIT = '810000000000000002'; // Mérito em Proficiência
const ROLE_CAP = '810000000000000004'; // Aprovado Prova Capitão

before(async () => {
  db = await H.setupDb();
  M = {
    Exam: require('../models/Exam'),
    ExamAttempt: require('../models/ExamAttempt'),
    Notification: require('../models/IntegrationNotification'),
    lifecycle: require('../lib/examLifecycle'),
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
  const e = await H.seedExam({ name: 'Capitão', questions: 10, points: 1 });
  await M.Exam.updateOne({ _id: e._id }, { $set: { slug: 'capitao', group: 'DAFP', autoApproval: true, passingScore: 7, approvedRoleId: ROLE_CAP } });
});
afterEach(async () => { await api.close(); });

let seq = 0;
async function dafpResult(correct, student = STUDENT) {
  seq += 1;
  const r = await api.call('POST', '/dafp/rooms', {
    ...H.dafpActorFields(), student, studentDisplayName: 'Recruta Lima', supervisorDiscordId: EVALUATOR, supervisorDisplayName: 'Cap Souza',
    examSlug: 'capitao', idempotencyKey: `embed-${seq}`,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const { attempt } = await M.lifecycle.startOrResumeAttempt(r.body.data.roomId);
  const doc = await M.ExamAttempt.findById(attempt._id);
  doc.snapshot.forEach((q, i) => { q.selectedKey = i < correct ? q.correctKey : (q.correctKey === 'A' ? 'B' : 'A'); q.isCorrect = i < correct; });
  await doc.save();
  await M.lifecycle.finalizeAttempt(doc, 'manual');
  return { roomId: r.body.data.roomId, attempt };
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

// Tudo o que o BotGhost usa para montar o Embed, cada um num campo próprio
// (texto simples, nunca precisa "recortar" de outra string).
const EMBED_FIELDS = [
  'notificationActionType', 'publishMessage', 'action', 'channelId', 'messageId', 'leaseToken',
  'examId', 'examSlug', 'examName', 'examGroup',
  'studentDiscordId', 'studentMention', 'studentDisplayName', 'studentAvatarUrl',
  'supervisorDiscordId', 'supervisorMention', 'supervisorDisplayName',
  'score', 'maxScore', 'scoreText', 'resultStatus', 'passed', 'perfectScore', 'passingScore', 'finishedAt', 'finishedAtText', 'finishReason',
  ...[1, 2, 3].flatMap((i) => ['Enabled', 'Type', 'RoleId', 'MemberDiscordId'].map((f) => `roleAction${i}${f}`)),
];

function assertEmbedFields(d) {
  for (const k of EMBED_FIELDS) assert.equal(typeof d[k], 'string', `campo ${k} presente e separado`);
  assert.equal(d.notificationActionType, 'DAFP_FINISHED');
  assert.equal(d.publishMessage, 'true');
  assert.equal(d.action, 'send');
  assert.equal(d.channelId, DAFP_CHANNEL);
  assert.equal(d.messageId, '');
  assert.ok(d.leaseToken.length > 10);
  assert.equal(d.examName, 'Capitão');
  assert.equal(d.examSlug, 'capitao');
  assert.equal(d.examGroup, 'DAFP');
  assert.match(d.examId, /^[a-f0-9]{24}$/);
  assert.equal(d.studentDiscordId, STUDENT);
  assert.equal(d.studentMention, `<@${STUDENT}>`, 'aluno por menção (ID), não só o nome');
  assert.equal(d.studentDisplayName, 'Recruta Lima');
  assert.equal(d.supervisorDiscordId, EVALUATOR);
  assert.equal(d.supervisorMention, `<@${EVALUATOR}>`, 'avaliador por menção (ID), não só o nome');
  assert.equal(d.supervisorDisplayName, 'Cap Souza');
  assert.equal(d.maxScore, '10');
  assert.equal(d.passingScore, '7');
  assert.match(d.finishedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(d.finishedAtText);
  assert.equal(d.finishReason, 'FINALIZADA_PELO_ALUNO');
}

test('1: TCEL — claim do resultado TCEL exatamente como antes (sem campos DAFP, mesma mensagem)', async () => {
  const tcel = await H.seedExam({ name: 'Prova Tcel' });
  await M.Exam.updateOne({ _id: tcel._id }, { $set: { slug: 'tcel', group: 'TCEL' } });
  const r = await api.call('POST', '/rooms', { ...H.actorFields(), student: '700000000000000909', idempotencyKey: 'tcel-embed-1' });
  assert.equal(r.status, 201);
  await H.takeExam(r.body.data.roomId, 4);
  const attempt = await M.ExamAttempt.findOne({ roomId: r.body.data.roomId }).lean();
  const { d } = await claimKey(`result:${attempt._id}`);
  assert.equal(d.notificationActionType, 'TCEL_RESULT');
  assert.equal(d.templateKey, 'result_finished');
  assert.equal(d.publishMessage, 'true');
  assert.equal(d.message.content, 'Prova finalizada: <@700000000000000909> — Nota: 80 / 100 — Prova: Prova Tcel');
  // Contrato do claim TCEL: exatamente estes campos.
  assert.deepEqual(Object.keys(d).sort(), [
    'action', 'applyRole', 'channelId', 'discordBodyJson', 'displayText', 'keepComponents', 'kind', 'leaseToken', 'leaseUntil', 'memberDiscordId',
    'message', 'messageId', 'native', 'notificationActionType', 'notificationId', 'publishMessage', 'renderedRevision',
    ...[1, 2, 3].flatMap((i) => ['Enabled', 'MemberDiscordId', 'RoleId', 'Type'].map((f) => `roleAction${i}${f}`)),
    'roleActions', 'roleActionsPhase', 'roleId', 'templateKey',
  ].sort());
  assert.deepEqual(slots(d), ['-', '-', '-']);
  for (const k of ['examGroup', 'studentMention', 'supervisorMention', 'resultStatus', 'perfectScore']) assert.equal(d[k], undefined, `TCEL sem ${k}`);
});

test('2: DAFP aprovado — claim entrega separadamente prova, avaliador, aluno, nota, status e cargos', async () => {
  const { attempt } = await dafpResult(8);
  const { c, d } = await claimKey(`result:${attempt._id}`);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assertEmbedFields(d);
  assert.equal(d.score, '8');
  assert.equal(d.scoreText, '8/10');
  assert.equal(d.resultStatus, 'APROVADO');
  assert.equal(d.passed, 'true');
  assert.equal(d.perfectScore, 'false');
  assert.deepEqual(slots(d), [`ADD ${BASE} ${STUDENT}`, `ADD ${ROLE_CAP} ${STUDENT}`, '-']);
});

test('3: DAFP reprovado — mesmos campos, resultStatus REPROVADO, só devolve a Role base', async () => {
  const { attempt } = await dafpResult(5);
  const { d } = await claimKey(`result:${attempt._id}`);
  assertEmbedFields(d);
  assert.equal(d.score, '5');
  assert.equal(d.resultStatus, 'REPROVADO');
  assert.equal(d.passed, 'false');
  assert.deepEqual(slots(d), [`ADD ${BASE} ${STUDENT}`, '-', '-']);
});

test('4: DAFP gabaritado — perfectScore true e as três ações de cargo', async () => {
  const { attempt } = await dafpResult(10);
  const { d } = await claimKey(`result:${attempt._id}`);
  assertEmbedFields(d);
  assert.equal(d.score, '10');
  assert.equal(d.resultStatus, 'APROVADO');
  assert.equal(d.perfectScore, 'true');
  assert.deepEqual(slots(d), [`ADD ${BASE} ${STUDENT}`, `ADD ${ROLE_CAP} ${STUDENT}`, `ADD ${MERIT} ${STUDENT}`]);
});

test('5: dafp_base_restore — publishMessage false, sem mensagem/Embed, só o ADD da Role base', async () => {
  const { attempt } = await dafpResult(8);
  const { c, d } = await claimKey(`dafp_restore:${attempt._id}`);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(d.kind, 'dafp_base_restore');
  assert.equal(d.notificationActionType, 'DAFP_FINISHED');
  assert.equal(d.publishMessage, 'false');
  assert.equal(d.action, 'none');
  assert.equal(d.channelId, '');
  assert.equal(d.templateKey, '');
  assert.deepEqual(d.message.embeds, []);
  assert.deepEqual(slots(d), [`ADD ${BASE} ${STUDENT}`, '-', '-']);
  const a = await api.call('POST', `/notifications/${c.body.data.notificationId}/ack`, { leaseToken: d.leaseToken, outcome: 'delivered' });
  assert.equal(a.body.code, 'acked', 'confirmado sem messageId');
});

test('6: separação — DAFP fora das rotas TCEL; TCEL fora de /dafp/results', async () => {
  const tcel = await H.seedExam({ name: 'Prova Tcel' });
  await M.Exam.updateOne({ _id: tcel._id }, { $set: { slug: 'tcel', group: 'TCEL' } });
  const r = await api.call('POST', '/rooms', { ...H.actorFields(), student: '700000000000000909', idempotencyKey: 'tcel-embed-6' });
  await H.takeExam(r.body.data.roomId, 3);
  const { attempt } = await dafpResult(8);

  const tcelList = (await api.call('GET', '/results', H.actorFields())).body.data;
  assert.equal(tcelList.total, '1');
  assert.equal(tcelList.items[0].discordUserId, '700000000000000909');
  assert.ok(!JSON.stringify(tcelList).includes(String(attempt._id)), 'resultado DAFP não aparece no TCEL');
  const cands = (await api.call('GET', '/promotion-candidates', H.actorFields())).body.data;
  assert.equal(cands.total, '1', 'promoção TCEL só vê o TCEL');

  const dafpList = (await api.call('GET', '/dafp/results', H.dafpActorFields())).body.data;
  assert.equal(dafpList.total, '1');
  assert.equal(dafpList.items[0].attemptId, String(attempt._id));
  assert.equal(dafpList.items[0].examGroup, 'DAFP');
  assert.equal(dafpList.items[0].examSlug, 'capitao');
  assert.equal(dafpList.items[0].examName, 'Capitão');
  assert.ok(!JSON.stringify(dafpList).includes('700000000000000909'), 'resultado TCEL não aparece no DAFP');
});

test('7: publicação — ACK com o messageId da mensagem montada pelo BotGhost é aceito (uma vez)', async () => {
  const { roomId, attempt } = await dafpResult(8);
  const { n, d } = await claimKey(`result:${attempt._id}`);
  const body = { leaseToken: d.leaseToken, outcome: 'delivered', messageId: '910000000000000077', channelId: DAFP_CHANNEL };
  const a = await api.call('POST', `/notifications/${n._id}/ack`, body);
  assert.equal(a.status, 200);
  assert.equal(a.body.code, 'acked');
  assert.equal(a.body.data.messageId, '910000000000000077');
  assert.equal((await api.call('POST', `/notifications/${n._id}/ack`, body)).body.code, 'already_acked');
  assert.equal((await api.call('POST', `/notifications/${n._id}/claim`, {})).body.code, 'already_delivered');
  const saved = await M.ExamAttempt.findById(attempt._id).lean();
  assert.equal(saved.discordSync.messageId, '910000000000000077');
  assert.equal(saved.discordSync.channelId, DAFP_CHANNEL);
  const s = (await api.call('GET', `/dafp/sessions/${roomId}`, H.dafpActorFields())).body.data;
  assert.equal(s.resultPublished, 'true');
});

test('8: VERIFICAR NOTA não depende do site — nenhuma rota de conferência; nada pendente depois da publicação', async () => {
  const { createIntegrationRouter } = require('../botghost/routes');
  const router = createIntegrationRouter({ getEnv: () => envRef.current, getPublicBaseUrl: () => 'https://provas.example.com' });
  const routes = router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
  assert.ok(routes.length > 20);
  for (const r of routes) assert.doesNotMatch(r, /verif|confer|check|button|botao|interaction|clique/i, `rota inesperada: ${r}`);
  // As únicas rotas que tocam um resultado DAFP publicado são as de leitura e a fila.
  assert.deepEqual(routes.filter((r) => /dafp|notifications/.test(r)).sort(), [
    'GET /dafp/exams', 'GET /dafp/exams/:ref', 'GET /dafp/results', 'GET /dafp/sessions/:id',
    'POST /dafp/rooms', 'POST /dafp/rooms/:id/regenerate-links', 'POST /dafp/rooms/prepare',
    'POST /notifications/:id/ack', 'POST /notifications/:id/claim',
  ].sort());

  // Depois de publicado e confirmado, o ciclo do resultado termina no site:
  // nada fica na fila esperando o BotGhost (o clique não gera claim/ack).
  const { attempt } = await dafpResult(10);
  for (const key of [`dafp_started:${attempt._id}`, `dafp_restore:${attempt._id}`, `result:${attempt._id}`]) {
    const n = await M.Notification.findOne({ key });
    if (!n || n.status === 'cancelled') continue;
    const { d } = await claimKey(key);
    const extra = d.publishMessage === 'true' ? { messageId: '910000000000000088', channelId: DAFP_CHANNEL } : {};
    await api.call('POST', `/notifications/${n._id}/ack`, { leaseToken: d.leaseToken, outcome: 'delivered', ...extra });
  }
  const open = await M.Notification.countDocuments({ attemptId: attempt._id, status: { $nin: ['delivered', 'cancelled'] } });
  assert.equal(open, 0, 'nenhum aviso pendente para este resultado');
});
