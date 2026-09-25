const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

// API do BotGhost de ponta a ponta (HTTP real num Express de teste + Mongo
// em memória): autenticação, operador, idempotência, salas, resultados.

let db;
let M;
const envRef = { current: null };
let api;

before(async () => {
  db = await H.setupDb();
  M = {
    Room: require('../models/Room'),
    ExamAttempt: require('../models/ExamAttempt'),
    IntegrationRequest: require('../models/IntegrationRequest'),
    results: require('../lib/results'),
    tokens: require('../lib/tokens'),
  };
});
after(async () => { await db.teardown(); });

beforeEach(async () => {
  await db.reset();
  envRef.current = H.testEnv();
  await H.saveDefaultConfig();
  api = await H.startApi(envRef);
});
afterEach(async () => { await api.close(); });

async function createRoom(student, key, extra = {}) {
  return api.call('POST', '/rooms', { ...H.actorFields(), student, studentDisplayName: 'Recruta Teste', idempotencyKey: key, ...extra });
}

test('sem chave, chave errada, integração desligada ou chave fraca: nada passa', async () => {
  assert.equal((await api.call('GET', '/health', null, { key: null })).status, 401);
  const wrong = await api.call('GET', '/health', null, { key: 'x'.repeat(40) });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.code, 'unauthorized');
  assert.equal(wrong.body.ok, false);

  envRef.current = H.testEnv({ enabled: false });
  assert.equal((await api.call('GET', '/health')).body.code, 'integration_disabled');
  envRef.current = H.testEnv({ siteApiKey: 'curta' });
  const weak = await api.call('GET', '/health', null, { key: 'curta' });
  assert.equal(weak.status, 503);
  assert.equal(weak.body.code, 'integration_not_configured');
  envRef.current = H.testEnv({ siteApiKey: null });
  assert.equal((await api.call('GET', '/health')).status, 503);
});

test('health responde com displayText e diz o que o operador pode usar', async () => {
  const r = await api.call('GET', '/health', { guildId: H.GUILD, actorDiscordId: H.OPERATOR });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.code, 'healthy');
  assert.ok(r.body.data.displayText);
  assert.equal(r.body.data.canGenerate, 'true');
  assert.equal(r.body.data.canPromote, 'true');
  const other = await api.call('GET', '/health', { guildId: H.GUILD, actorDiscordId: H.OTHER_OPERATOR });
  assert.equal(other.body.data.canResults, 'false');
});

test('servidor errado, canal errado e operador fora da lista são negados com mensagem pronta', async () => {
  await H.seedExam();
  const guild = await api.call('POST', '/rooms/prepare', { ...H.actorFields(), guildId: '911111111111111111', student: H.STRANGER });
  assert.equal(guild.status, 403);
  assert.equal(guild.body.code, 'guild_not_allowed');

  const chan = await api.call('POST', '/rooms/prepare', { ...H.actorFields(H.OPERATOR, { channelId: '611111111111111111' }), student: H.STRANGER });
  assert.equal(chan.body.code, 'wrong_channel');

  const denied = await api.call('POST', '/rooms/prepare', { ...H.actorFields(H.STRANGER), student: '700000000000000001' });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'operator_not_allowed');
  assert.match(denied.body.data.message.content, /não está autorizado/);
  assert.ok(denied.body.data.displayText);

  // OTHER_OPERATOR pode gerar, mas não consultar notas.
  const results = await api.call('GET', '/results', H.actorFields(H.OTHER_OPERATOR));
  assert.equal(results.body.code, 'operator_not_allowed');
});

test('corpo inválido, grande demais e ID de Discord numérico são recusados', async () => {
  const bad = await api.call('POST', '/rooms', null, { raw: '{"student": ' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'invalid_json');
  const big = await api.call('POST', '/rooms', { ...H.actorFields(), junk: 'x'.repeat(40000) });
  assert.equal(big.status, 413);
  // actorDiscordId como número perde precisão no JSON — só aceitamos texto.
  const num = await api.call('POST', '/rooms/prepare', null, { raw: `{"guildId":"${H.GUILD}","actorDiscordId":700000000000000009,"channelId":"${H.PANEL}","student":"${H.STRANGER}"}` });
  assert.equal(num.status, 400);
  const unknown = await api.call('GET', '/nada');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, 'not_found');
});

test('Gerar prova: links só na primeira resposta, só o hash no banco, repetição idempotente sem links', async () => {
  const exam = await H.seedExam();
  const student = '700000000000000001';
  const first = await createRoom(`<@${student}>`, 'interacao-0001');
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.code, 'room_created');
  const { studentUrl, supervisorUrl, roomId } = first.body.data;
  assert.match(studentUrl, /^https:\/\/provas\.example\.com\/aluno\/[A-Za-z0-9_-]+$/);
  assert.match(supervisorUrl, /^https:\/\/provas\.example\.com\/professor\/[A-Za-z0-9_-]+$/);
  // Mensagem privada: os dois links vão juntos só para o operador.
  assert.equal(first.body.data.discordCallbackJson ? JSON.parse(first.body.data.discordCallbackJson).data.flags : 64, 64);
  const embedText = JSON.stringify(first.body.data.message);
  assert.ok(embedText.includes(studentUrl) && embedText.includes(supervisorUrl));

  const room = await M.Room.findById(roomId).lean();
  const token = studentUrl.split('/').pop();
  assert.equal(room.studentTokenHash, M.tokens.hashToken(token));
  assert.equal(room.discordUserId, student);
  assert.equal(room.discordGuildId, H.GUILD);
  assert.equal(String(room.examId), String(exam._id));
  assert.ok(!JSON.stringify(room).includes(token), 'token puro não pode estar no banco');
  const stored = await M.IntegrationRequest.find().lean();
  assert.ok(!JSON.stringify(stored).includes(token), 'resposta guardada para repetição não pode ter link');
  assert.equal(room.proctorTokens.length, 1);
  assert.equal(room.proctorTokens[0].discordUserId, H.OPERATOR);

  const again = await createRoom(`<@${student}>`, 'interacao-0001');
  assert.equal(again.body.code, 'room_already_created');
  assert.equal(again.body.data.replayed, 'true');
  assert.equal(again.body.data.studentUrl, undefined);
  assert.equal(await M.Room.countDocuments(), 1);

  const conflict = await createRoom('700000000000000002', 'interacao-0001');
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'idempotency_conflict');

  const exists = await createRoom(student, 'interacao-0002');
  assert.equal(exists.status, 409);
  assert.equal(exists.body.code, 'room_exists');
  assert.equal(exists.body.data.canRegenerate, 'true');
  assert.equal(exists.body.data.studentUrl, undefined);
  assert.equal(await M.Room.countDocuments(), 1);

  assert.equal((await createRoom(student, '')).body.code, 'idempotency_key_required');
});

test('regenerar links invalida os anteriores e não cria sala nova', async () => {
  await H.seedExam();
  const first = await createRoom('700000000000000001', 'interacao-1001');
  const { roomId, studentUrl } = first.body.data;
  const soon = await api.call('POST', `/rooms/${roomId}/regenerate-links`, { ...H.actorFields(), idempotencyKey: 'interacao-1002' });
  assert.equal(soon.body.code, 'regenerate_too_soon');
  await M.Room.updateOne({ _id: roomId }, { $set: { 'proctorTokens.0.createdAt': new Date(Date.now() - 60000) } });
  const regen = await api.call('POST', `/rooms/${roomId}/regenerate-links`, { ...H.actorFields(), idempotencyKey: 'interacao-1003' });
  assert.equal(regen.body.code, 'links_regenerated');
  assert.notEqual(regen.body.data.studentUrl, studentUrl);
  const room = await M.Room.findById(roomId).lean();
  assert.notEqual(room.studentTokenHash, M.tokens.hashToken(studentUrl.split('/').pop()));
  assert.equal(room.proctorTokens.filter((t) => !t.revokedAt).length, 1);
  assert.equal(await M.Room.countDocuments(), 1);
});

test('várias provas sem padrão exigem escolha explícita; com padrão, usa a padrão', async () => {
  const a = await H.seedExam({ name: 'Prova A' });
  await H.seedExam({ name: 'Prova B' });
  const prep = await api.call('POST', '/rooms/prepare', { ...H.actorFields(), student: '700000000000000001' });
  assert.equal(prep.body.data.examChoiceRequired, 'true');
  assert.equal(prep.body.data.opt3Hide, 'true');
  assert.equal(prep.body.data.opt1Hide, 'false');
  const noChoice = await createRoom('700000000000000001', 'interacao-2001');
  assert.equal(noChoice.status, 422);
  assert.equal(noChoice.body.code, 'exam_choice_required');
  const chosen = await createRoom('700000000000000001', 'interacao-2002', { examId: String(a._id) });
  assert.equal(chosen.status, 201);

  await H.saveDefaultConfig({ defaultExamId: String(a._id) });
  const exams = await api.call('GET', '/exams', H.actorFields());
  assert.equal(exams.body.data.choiceRequired, 'false');
  assert.equal(exams.body.data.defaultExamId, String(a._id));
});

test('Conferir resultados: lê o banco na hora, pagina, filtra e nunca devolve gabarito', async () => {
  await H.seedExam();
  const ids = [];
  for (let i = 1; i <= 3; i += 1) {
    const r = await createRoom(`70000000000000000${i}`, `interacao-300${i}`);
    ids.push(r.body.data.roomId);
    await H.takeExam(r.body.data.roomId, i + 1, i === 3 ? 'timeout' : 'manual');
  }
  const page = await api.call('GET', '/results', { ...H.actorFields(), pageSize: '2' });
  assert.equal(page.status, 200);
  assert.equal(page.body.data.total, '3');
  assert.equal(page.body.data.pages, '2');
  assert.equal(page.body.data.hasNext, 'true');
  assert.ok(!page.text.includes('correctKey') && !page.text.includes('snapshot') && !page.text.includes('TokenHash'));
  const timeout = await M.ExamAttempt.findOne({ discordUserId: '700000000000000003' }).lean();
  assert.equal(timeout.status, 'finished_timeout');

  const one = await api.call('GET', '/results', { ...H.actorFields(), student: '<@700000000000000002>' });
  assert.equal(one.body.data.total, '1');
  assert.equal(one.body.data.items[0].score, 60);

  const attempt = await M.ExamAttempt.findOne({ discordUserId: '700000000000000002' });
  await M.results.setOralScore({ attemptId: String(attempt._id), oralScore: 15, actor: 'admin:teste' });
  const withOral = await api.call('GET', '/results', { ...H.actorFields(), student: '700000000000000002' });
  assert.equal(withOral.body.data.items[0].score, 75);
  assert.equal(withOral.body.data.items[0].hasOral, 'true');
  assert.match(withOral.body.data.displayText, /Prova \(60\) \+ Prova Oral \(15\) = \*\*75\*\*/);
  assert.ok(!/ajustada/i.test(withOral.text));

  await M.results.softDeleteResult({ attemptId: String(attempt._id), reason: 'fraude confirmada', actor: 'admin:teste' });
  const gone = await api.call('GET', '/results', { ...H.actorFields(), student: '700000000000000002' });
  assert.equal(gone.body.code, 'results_empty');
  assert.equal(gone.body.data.total, '0');
  assert.equal(await M.ExamAttempt.countDocuments({ _id: attempt._id }), 1, 'exclusão é lógica');

  const invalidDate = await api.call('GET', '/results', { ...H.actorFields(), from: '31-31-2026' });
  assert.equal(invalidDate.status, 400);
});
