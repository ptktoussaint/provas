const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

// Avisos de resultado pelo webhook do BotGhost: fila durável, disparo,
// reserva (claim), confirmação (ack), falhas, ambiguidade e reinício.

let db;
let M;
const envRef = { current: null };
let api;
let hook;

before(async () => {
  db = await H.setupDb();
  M = {
    Room: require('../models/Room'),
    ExamAttempt: require('../models/ExamAttempt'),
    Notification: require('../models/IntegrationNotification'),
    IntegrationRequest: require('../models/IntegrationRequest'),
    results: require('../lib/results'),
    notifications: require('../botghost/notifications'),
    Dispatcher: require('../botghost/dispatcher').NotificationDispatcher,
    idempotency: require('../botghost/idempotency'),
  };
});
after(async () => { await db.teardown(); });

beforeEach(async () => {
  await db.reset();
  envRef.current = H.testEnv();
  await H.saveDefaultConfig();
  api = await H.startApi(envRef);
  hook = H.fakeWebhook();
});
afterEach(async () => { await api.close(); });

function dispatcher() {
  const d = new M.Dispatcher({ getEnv: () => envRef.current, gapMs: 0, fetchImpl: hook.fetchImpl, log: H.silentLog });
  d.stopped = false;
  return d;
}

async function finishedFor(student, correct = 4, key = `interacao-${student.slice(-4)}`, reason = 'manual') {
  if (!(await require('../models/Exam').countDocuments())) await H.seedExam();
  const r = await api.call('POST', '/rooms', { ...H.actorFields(), student, studentDisplayName: 'Recruta Teste', idempotencyKey: key });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return H.takeExam(r.body.data.roomId, correct, reason);
}

const claim = (id) => api.call('POST', `/notifications/${id}/claim`, {});
const ack = (id, body) => api.call('POST', `/notifications/${id}/ack`, body);

test('prova finalizada: nota salva primeiro, aviso na fila, webhook oficial, claim → envio → ack com ID real', async () => {
  const attempt = await finishedFor('700000000000000001', 4);
  assert.equal(attempt.status, 'finished');
  assert.equal(attempt.score, 80);
  const n = await M.Notification.findOne({ key: `result:${attempt._id}` }).lean();
  assert.equal(n.status, 'pending');

  const d = dispatcher();
  assert.equal(await d.tick(), 1);
  assert.equal(hook.calls.length, 1);
  assert.equal(hook.calls[0].url, H.WEBHOOK_URL);
  assert.equal(hook.calls[0].init.headers.Authorization, 'chave-do-modulo-webhooks');
  const vars = Object.fromEntries(hook.calls[0].body.variables.map((v) => [v.variable, v.value]));
  assert.equal(vars['{tcel_notification_id}'], String(n._id));
  // O webhook só leva o ID — nunca nota, nome ou link.
  assert.ok(!JSON.stringify(hook.calls[0].body).includes('80'));
  assert.equal((await M.Notification.findById(n._id)).status, 'dispatched', '200 do webhook não é entrega');

  const c = await claim(n._id);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.data.action, 'send');
  assert.equal(c.body.data.channelId, H.RESULTS);
  assert.equal(c.body.data.message.content, 'Prova finalizada: <@700000000000000001> — Nota: 80 / 100 — Prova: Prova TCEL');
  assert.deepEqual(c.body.data.message.allowed_mentions.parse, []);
  JSON.parse(c.body.data.discordBodyJson);

  const bad = await ack(n._id, { leaseToken: 'outro', outcome: 'delivered', messageId: '1400000000000000001' });
  assert.equal(bad.body.code, 'lease_mismatch');
  const ok = await ack(n._id, { leaseToken: c.body.data.leaseToken, outcome: 'delivered', messageId: '1400000000000000001', channelId: H.RESULTS });
  assert.equal(ok.body.code, 'acked');
  const again = await ack(n._id, { leaseToken: c.body.data.leaseToken, outcome: 'delivered', messageId: '1400000000000000001' });
  assert.equal(again.body.code, 'already_acked', 'callback repetido não duplica');
  const synced = await M.ExamAttempt.findById(attempt._id).lean();
  assert.equal(synced.discordSync.messageId, '1400000000000000001');
  assert.equal((await claim(n._id)).body.code, 'already_delivered');
  assert.equal(await d.tick(), 0);
});

test('reserva concorrente: só um executor recebe o conteúdo', async () => {
  const attempt = await finishedFor('700000000000000001');
  const n = await M.Notification.findOne({ attemptId: attempt._id });
  const [a, b] = await Promise.all([claim(n._id), claim(n._id)]);
  const codes = [a.body.code, b.body.code].sort();
  assert.deepEqual(codes, ['already_claimed', 'claimed']);
});

test('prova oral lançada e resultado excluído: a mesma mensagem é editada, versão atual, sem novo ping', async () => {
  const attempt = await finishedFor('700000000000000001');
  const n = await M.Notification.findOne({ attemptId: attempt._id });
  const c1 = await claim(n._id);
  // Pontos da prova oral lançados ENQUANTO está reservada: depois do ack,
  // agenda nova edição. A soma pode passar de 100.
  await M.results.setOralScore({ attemptId: String(attempt._id), oralScore: 30, actor: 'admin:teste' });
  await ack(n._id, { leaseToken: c1.body.data.leaseToken, outcome: 'delivered', messageId: '1400000000000000002' });
  const after = await M.Notification.findById(n._id).lean();
  assert.equal(after.status, 'pending');

  const c2 = await claim(n._id);
  assert.equal(c2.body.data.action, 'edit');
  assert.equal(c2.body.data.messageId, '1400000000000000002');
  assert.equal(c2.body.data.templateKey, 'result_updated');
  assert.equal(c2.body.data.message.content, 'Prova finalizada: <@700000000000000001> — Prova (80) + Prova Oral (30) = 110 — Prova: Prova TCEL');
  assert.ok(!/ajustada/i.test(JSON.stringify(c2.body.data.message)));
  assert.deepEqual(c2.body.data.message.allowed_mentions.parse, []);
  await ack(n._id, { leaseToken: c2.body.data.leaseToken, outcome: 'delivered', messageId: '1400000000000000002' });

  await M.results.softDeleteResult({ attemptId: String(attempt._id), reason: 'anulada', actor: 'admin:teste' });
  const c3 = await claim(n._id);
  assert.equal(c3.body.data.templateKey, 'result_removed');
  assert.equal(c3.body.data.action, 'edit');
  assert.ok(!JSON.stringify(c3.body.data.message).includes('110'));
});

test('resultado excluído antes de publicar: nada aparece no canal', async () => {
  const attempt = await finishedFor('700000000000000001');
  await M.results.softDeleteResult({ attemptId: String(attempt._id), reason: 'erro de cadastro', actor: 'admin:teste' });
  const n = await M.Notification.findOne({ attemptId: attempt._id }).lean();
  assert.equal(n.status, 'cancelled');
  assert.equal((await claim(n._id)).body.code, 'cancelled');
});

test('tempo esgotado finaliza, salva a nota e agenda o aviso', async () => {
  const attempt = await finishedFor('700000000000000001', 2, 'interacao-t001', 'timeout');
  assert.equal(attempt.status, 'finished_timeout');
  const n = await M.Notification.findOne({ attemptId: attempt._id });
  const c = await claim(n._id);
  assert.match(c.body.data.message.content, /Nota: 40 \/ 100/);
});

test('falha do webhook: nota intacta, nova tentativa com espera; 401 para de tentar; rede cai e volta', async () => {
  const attempt = await finishedFor('700000000000000001');
  const n = await M.Notification.findOne({ attemptId: attempt._id });
  hook.state.respond = () => ({ status: 500 });
  const d = dispatcher();
  await d.tick();
  let cur = await M.Notification.findById(n._id).lean();
  assert.equal(cur.status, 'pending');
  assert.ok(cur.nextDispatchAt > new Date());
  assert.match(cur.lastError, /500/);
  assert.equal((await M.ExamAttempt.findById(attempt._id)).score, 80);

  hook.state.respond = () => new Error('ECONNRESET');
  await M.Notification.updateOne({ _id: n._id }, { $set: { nextDispatchAt: new Date() } });
  await d.tick();
  cur = await M.Notification.findById(n._id).lean();
  assert.equal(cur.status, 'pending');
  assert.match(cur.lastError, /rede/);

  hook.state.respond = () => ({ status: 429, headers: { 'retry-after': '30' } });
  await M.Notification.updateOne({ _id: n._id }, { $set: { nextDispatchAt: new Date() } });
  await d.tick();
  cur = await M.Notification.findById(n._id).lean();
  assert.ok(cur.nextDispatchAt.getTime() - Date.now() > 25000);

  hook.state.respond = () => ({ status: 401 });
  await M.Notification.updateOne({ _id: n._id }, { $set: { nextDispatchAt: new Date() } });
  await d.tick();
  cur = await M.Notification.findById(n._id).lean();
  assert.equal(cur.status, 'failed');
  assert.match(cur.lastError, /API Key/);
  assert.ok(!cur.lastError.includes('chave-do-modulo'), 'erro não expõe a chave');

  // Reprocessar pelo admin volta para a fila.
  hook.state.respond = () => ({ status: 200 });
  await M.notifications.adminRetry(n._id, 'admin:teste');
  await d.tick();
  assert.equal((await M.Notification.findById(n._id)).status, 'dispatched');
});

test('avisos desligados: nada é disparado, mas a fila guarda tudo', async () => {
  envRef.current = H.testEnv({ notificationsEnabled: false });
  await finishedFor('700000000000000001');
  assert.equal(await dispatcher().tick(), 0);
  assert.equal(hook.calls.length, 0);
  assert.equal(await M.Notification.countDocuments({ status: 'pending' }), 1);
});

test('envio sem confirmação vira ambíguo (nunca reenviado às cegas); ack atrasado resolve', async () => {
  const attempt = await finishedFor('700000000000000001');
  const n = await M.Notification.findOne({ attemptId: attempt._id });
  const c = await claim(n._id);
  await M.notifications.expireLeases(new Date(Date.now() + M.notifications.LEASE_MS + 1000));
  assert.equal((await M.Notification.findById(n._id)).status, 'ambiguous');
  assert.equal(await dispatcher().tick(), 0);
  assert.equal((await claim(n._id)).body.code, 'ambiguous_needs_review');
  const late = await ack(n._id, { leaseToken: c.body.data.leaseToken, outcome: 'delivered', messageId: '1400000000000000003' });
  assert.equal(late.body.code, 'acked');
  const done = await M.Notification.findById(n._id).lean();
  assert.equal(done.status, 'delivered');
  assert.ok(done.history.some((h) => h.event === 'late_ack_resolved'));
});

test('admin resolve ambíguo: "já publicada" com ID, ou reenviar explicitamente', async () => {
  const a1 = await finishedFor('700000000000000001');
  const a2 = await finishedFor('700000000000000002');
  for (const a of [a1, a2]) {
    const n = await M.Notification.findOne({ attemptId: a._id });
    await claim(n._id);
  }
  await M.notifications.expireLeases(new Date(Date.now() + M.notifications.LEASE_MS + 1000));
  const n1 = await M.Notification.findOne({ attemptId: a1._id });
  const n2 = await M.Notification.findOne({ attemptId: a2._id });
  await M.notifications.adminResolveAmbiguous(n1._id, { mode: 'delivered', messageId: '1400000000000000004' }, 'admin:teste');
  assert.equal((await M.Notification.findById(n1._id)).status, 'delivered');
  assert.equal((await M.ExamAttempt.findById(a1._id)).discordSync.messageId, '1400000000000000004');
  await M.notifications.adminResolveAmbiguous(n2._id, { mode: 'resend' }, 'admin:teste');
  assert.equal((await M.Notification.findById(n2._id)).status, 'pending');
});

test('reinício do site: disparado e nunca reservado volta para a fila; edição vencida é refeita', async () => {
  const attempt = await finishedFor('700000000000000001');
  const n = await M.Notification.findOne({ attemptId: attempt._id });
  await dispatcher().tick();
  assert.equal((await M.Notification.findById(n._id)).status, 'dispatched');
  // "Reinício": outro despachante, horas depois.
  await M.notifications.expireLeases(new Date(Date.now() + M.notifications.DISPATCH_CLAIM_TIMEOUT_MS + 1000));
  const back = await M.Notification.findById(n._id).lean();
  assert.equal(back.status, 'pending');
  await M.Notification.updateOne({ _id: n._id }, { $set: { nextDispatchAt: new Date() } });
  await dispatcher().tick();
  assert.equal(hook.calls.length, 2);

  // Edição com reserva vencida: seguro refazer (mesma mensagem).
  const c = await claim(n._id);
  await ack(n._id, { leaseToken: c.body.data.leaseToken, outcome: 'delivered', messageId: '1400000000000000005' });
  await M.results.adjustScore({ attemptId: String(attempt._id), score: 95, reason: 'revisão', actor: 'admin:teste' });
  await claim(n._id);
  await M.notifications.expireLeases(new Date(Date.now() + M.notifications.LEASE_MS + 1000));
  assert.equal((await M.Notification.findById(n._id)).status, 'pending');
});

test('reconciliação cria o aviso que faltou (processo caiu entre salvar a nota e criar o aviso)', async () => {
  const attempt = await finishedFor('700000000000000001');
  await M.Notification.deleteMany({});
  assert.equal(await dispatcher().reconcile(), 1);
  assert.equal(await M.Notification.countDocuments({ attemptId: attempt._id }), 1);
  assert.equal(await dispatcher().reconcile(), 0);
});

test('idempotência: pedido preso em processamento, falha libera a chave, pedido velho é assumido', async () => {
  await H.seedExam();
  const body = { ...H.actorFields(), student: '700000000000000001', studentDisplayName: 'Recruta', idempotencyKey: 'interacao-9001' };
  const payloadHash = M.idempotency.canonicalHash({ studentDiscordId: '700000000000000001', examId: null, studentDisplayName: 'Recruta' });
  await M.IntegrationRequest.create({ scopeKey: `rooms:${H.OPERATOR}:interacao-9001`, route: 'rooms', actorDiscordId: H.OPERATOR, payloadHash });
  const busy = await api.call('POST', '/rooms', body);
  assert.equal(busy.body.code, 'request_in_progress');
  await M.IntegrationRequest.updateOne({}, { $set: { createdAt: new Date(Date.now() - M.idempotency.STALE_PROCESSING_MS - 1000) } });
  const taken = await api.call('POST', '/rooms', body);
  assert.equal(taken.status, 201, JSON.stringify(taken.body));

  // Falha no meio (sem prova apta) não "queima" a chave.
  await require('../models/Question').updateMany({}, { $set: { active: false } });
  const fail = await api.call('POST', '/rooms', { ...body, student: '700000000000000002', idempotencyKey: 'interacao-9002' });
  assert.equal(fail.body.code, 'no_eligible_exam');
  assert.equal(await M.IntegrationRequest.countDocuments({ scopeKey: /interacao-9002/ }), 0);
});

test('teste de modelo e atualização do painel viram avisos com canal de teste / mensagem registrada', async () => {
  const t = await M.notifications.createTemplateTest('result_finished', 'admin:teste');
  const c = await claim(t._id);
  assert.equal(c.body.data.channelId, H.TEST_CHANNEL);
  assert.deepEqual(c.body.data.message.allowed_mentions.parse, []);
  assert.ok(!JSON.stringify(c.body.data.message.allowed_mentions).match(/\d{17}/), 'teste nunca pinga');

  await assert.rejects(() => M.notifications.createPanelUpdate('admin:teste'), /painel registrado/);
  const reg = await api.call('POST', '/panel/register', { ...H.actorFields(), panelChannelId: H.PANEL, panelMessageId: '1400000000000000009' });
  assert.equal(reg.body.code, 'panel_registered');
  const p = await M.notifications.createPanelUpdate('admin:teste');
  const pc = await claim(p._id);
  assert.equal(pc.body.data.action, 'edit');
  assert.equal(pc.body.data.messageId, '1400000000000000009');
  assert.equal(pc.body.data.keepComponents, 'true');
});
