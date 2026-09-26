const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

// Autorização do /provas-dafp pela ROLE de Professor DAFP
// (dafp.professorRoleId). actorDiscordId continua sendo quem executou; os
// cargos dele vêm atestados pelo BotGhost autenticado em actorRoleIds. A
// Role exigida é decidida só no site. TCEL continua pela lista de IDs.

let db;
let M;
const envRef = { current: null };
let api;

const EVALUATOR = '700000000000000202';
const ROLE = H.PROFESSOR_ROLE;

before(async () => {
  db = await H.setupDb();
  M = { Exam: require('../models/Exam'), IntegrationConfig: require('../models/IntegrationConfig'), configStore: require('../botghost/configStore') };
});
after(async () => { await db.teardown(); });

beforeEach(async () => {
  await db.reset();
  envRef.current = H.testEnv();
  await H.saveDefaultConfig({ dafp: { resultChannelId: '600000000000000009' } });
  M.configStore.invalidate();
  api = await H.startApi(envRef);
  const e = await H.seedExam({ name: 'Capitão', questions: 5, points: 2 });
  await M.Exam.updateOne({ _id: e._id }, { $set: { slug: 'capitao', group: 'DAFP' } });
  const t = await H.seedExam({ name: 'Prova Tcel' });
  await M.Exam.updateOne({ _id: t._id }, { $set: { slug: 'tcel', group: 'TCEL' } });
});
afterEach(async () => { await api.close(); });

let seq = 0;
function roomBody(actor, extra = {}) {
  seq += 1;
  return { ...actor, student: '700000000000000101', supervisorDiscordId: EVALUATOR, examSlug: 'capitao', idempotencyKey: `prof-${seq}`, ...extra };
}

test('professor com a Role cria a prova DAFP (actorDiscordId = usuário; Role em actorRoleIds)', async () => {
  const r = await api.call('POST', '/dafp/rooms', roomBody(H.dafpActorFields(H.STRANGER)));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.code, 'room_created');
  const room = await require('../models/Room').findById(r.body.data.roomId).lean();
  assert.equal(room.discordOperator.id, H.STRANGER, 'quem executou fica registrado pelo actorDiscordId');
});

test('formatos aceitos em actorRoleIds: IDs, menções, separados por vírgula/espaço, lista JSON', async () => {
  for (const roles of [ROLE, `${H.OTHER_ROLE},${ROLE}`, `<@&${H.OTHER_ROLE}> <@&${ROLE}>`, [H.OTHER_ROLE, ROLE], `["${H.OTHER_ROLE}","${ROLE}"]`]) {
    const r = await api.call('GET', '/dafp/exams', H.actorFields(H.STRANGER, { actorRoleIds: roles }));
    assert.equal(r.status, 200, `${JSON.stringify(roles)} → ${JSON.stringify(r.body)}`);
  }
  // Número no JSON perde precisão: recusado.
  const num = await api.call('POST', '/dafp/rooms/prepare', { ...H.actorFields(H.STRANGER), actorRoleIds: [8.2e17], student: '700000000000000101' });
  assert.equal(num.status, 400);
  assert.equal(num.body.data.field, 'actorRoleIds');
});

test('sem a Role → 403 operator_not_allowed com mensagem pronta; sem actorRoleIds → 400', async () => {
  const denied = await api.call('POST', '/dafp/rooms', roomBody(H.actorFields(H.OPERATOR, { actorRoleIds: `<@&${H.OTHER_ROLE}>` })));
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'operator_not_allowed');
  assert.match(denied.body.message, /Role de Professor DAFP/);
  assert.equal(denied.body.data.rolesReceived, '1');
  assert.ok(denied.body.data.displayText);
  const none = await api.call('POST', '/dafp/rooms', roomBody(H.actorFields(H.OPERATOR, { actorRoleIds: '' })));
  assert.equal(none.status, 403, 'sem cargos = sem a Role');
  const missing = await api.call('POST', '/dafp/rooms', roomBody(H.actorFields(H.OPERATOR)));
  assert.equal(missing.status, 400);
  assert.equal(missing.body.data.field, 'actorRoleIds');
});

test('o ID da Role nunca é tratado como usuário: actorDiscordId = ID da Role não autoriza', async () => {
  const r = await api.call('POST', '/dafp/rooms', roomBody(H.actorFields(ROLE, { actorRoleIds: `<@&${H.OTHER_ROLE}>` })));
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'operator_not_allowed');
});

test('todas as rotas /dafp/* exigem a Role', async () => {
  const ok = await api.call('POST', '/dafp/rooms', roomBody(H.dafpActorFields()));
  const roomId = ok.body.data.roomId;
  const no = H.actorFields(H.OPERATOR, { actorRoleIds: `<@&${H.OTHER_ROLE}>` });
  const calls = [
    ['GET', '/dafp/exams', no],
    ['GET', '/dafp/exams/capitao', no],
    ['POST', '/dafp/rooms/prepare', { ...no, student: '700000000000000101' }],
    ['POST', '/dafp/rooms', roomBody(no)],
    ['POST', `/dafp/rooms/${roomId}/regenerate-links`, { ...no, idempotencyKey: 'regen-x' }],
    ['GET', `/dafp/sessions/${roomId}`, no],
    ['GET', '/dafp/results', no],
  ];
  for (const [method, path, body] of calls) {
    const r = await api.call(method, path, body);
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.equal(r.body.code, 'operator_not_allowed', `${method} ${path}`);
  }
  assert.equal((await api.call('GET', `/dafp/sessions/${roomId}`, H.dafpActorFields())).status, 200);
});

test('Role não configurada → 403 operators_not_configured', async () => {
  await H.saveDefaultConfig({ dafp: { professorRoleId: '' } });
  M.configStore.invalidate();
  const r = await api.call('GET', '/dafp/exams', H.dafpActorFields());
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'operators_not_configured');
});

test('configuração antiga (lista operatorIds.dafp com o ID da Role) passa a valer como Role — o cenário que dava 403', async () => {
  // Como estava em produção: o admin colou o ID da ROLE no campo antigo.
  await M.IntegrationConfig.updateOne({ singleton: 'main' }, { $set: { 'operatorIds.dafp': [ROLE], 'dafp.professorRoleId': null } });
  M.configStore.invalidate();
  const cfg = await M.configStore.getConfig({ fresh: true });
  assert.equal(cfg.dafp.professorRoleId, ROLE);
  const r = await api.call('POST', '/dafp/rooms', roomBody(H.dafpActorFields(H.STRANGER)));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // Salvar pela aba Integração grava a Role no campo novo e limpa o antigo.
  const { update, errors } = M.configStore.validateConfig({
    operatorIds: { generate: H.OPERATOR, results: H.OPERATOR, promote: H.OPERATOR },
    dafp: { professorRoleId: `<@&${ROLE}>` },
    promotion: { addRoleIds: H.ADD1, announceChannelId: H.ANNOUNCE, announceRoleId: H.ADD1, nicknameTemplate: '{nome} | {idRP}' },
  });
  assert.deepEqual(errors, []);
  assert.equal(update.dafp.professorRoleId, ROLE, 'menção <@&ID> vira o ID');
  await M.configStore.saveConfig(update, 'teste');
  const raw = await M.IntegrationConfig.findOne({ singleton: 'main' }).lean();
  assert.equal(raw.dafp.professorRoleId, ROLE);
  assert.deepEqual(raw.operatorIds.dafp, []);
  // Lista antiga com vários IDs: não dá para saber qual é a Role → fechado.
  await M.IntegrationConfig.updateOne({ singleton: 'main' }, { $set: { 'operatorIds.dafp': [H.OPERATOR, H.STRANGER], 'dafp.professorRoleId': null } });
  M.configStore.invalidate();
  const multi = await M.configStore.getConfig({ fresh: true });
  assert.equal(multi.dafp.professorRoleId, null);
  assert.deepEqual(multi.dafp.legacyOperatorIds, [H.OPERATOR, H.STRANGER]);
  assert.equal((await api.call('GET', '/dafp/exams', H.dafpActorFields())).body.code, 'operators_not_configured');
});

test('TCEL intacto: continua pela lista de IDs; actorRoleIds não dá acesso à TCEL', async () => {
  assert.equal((await api.call('GET', '/exams', H.actorFields())).status, 200, 'TCEL não precisa de actorRoleIds');
  const r = await api.call('POST', '/rooms', { ...H.actorFields(), student: '700000000000000909', idempotencyKey: 'tcel-prof-1' });
  assert.equal(r.status, 201);
  const stranger = await api.call('GET', '/exams', H.dafpActorFields(H.STRANGER));
  assert.equal(stranger.status, 403, 'ter a Role de Professor DAFP não abre a TCEL');
  assert.equal(stranger.body.message, 'Você não está autorizado a usar esta função da Prova TCEL.');
});
