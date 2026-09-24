const test = require('node:test');
const assert = require('node:assert/strict');

// Nenhum teste aqui conecta no banco: sem buffer, qualquer escrita
// acidental falha na hora em vez de travar o teste.
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:1/sem-banco';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'teste-unitario';
require('mongoose').set('bufferCommands', false);

const { parseUserIdInput, isSnowflake, parseIdList } = require('../lib/discordIds');
const { validateRpInput, validateTemplate } = require('../botghost/nickname');
const { applySelection } = require('../botghost/selection');
const { chunkUserIds } = require('../botghost/announce');
const { userText } = require('../botghost/format');
const { TEMPLATES, sampleContext } = require('../botghost/templates/catalog');
const { validateSpec, renderTemplate, urlProblem, normalizeSpec, LIMITS } = require('../botghost/templates/render');
const { canonicalHash } = require('../botghost/idempotency');
const { createKeyAuth, safeEqual } = require('../botghost/auth');
const { webhookConfigProblem, triggerWebhook } = require('../botghost/webhookClient');
const { parseRoleEvidence, statusFromSteps } = require('../botghost/promotionsService');

const TEMPLATE = '『TCEL•B』{nome} | {idRP}';
const ROLE = '1231023397069258844';

// ---------------- IDs, apelido, seleção ----------------

test('IDs do Discord: ID e menção viram String exata (sem perder dígitos de Number)', () => {
  const big = '1231023397069258844'; // > 2^53
  assert.equal(parseUserIdInput(big), big);
  assert.equal(parseUserIdInput(`<@${big}>`), big);
  assert.equal(parseUserIdInput(`<@!${big}>`), big);
  assert.equal(parseUserIdInput(' 12 '), null);
  assert.equal(parseUserIdInput('<@&1231023397069258844>'), null);
  assert.notEqual(String(Number(big)), big); // prova de que Number corromperia
  assert.equal(isSnowflake(123), false);
  assert.deepEqual(parseIdList('1057349963203498105, <@&1057349976482664569> x'), {
    ids: ['1057349963203498105', '1057349976482664569'],
    invalid: ['x'],
  });
});

test('apelido: modelo pedido, ID RP com zeros à esquerda, máximo de 32 caracteres', () => {
  const ok = validateRpInput({ nome: 'João Silva', idRP: '007', template: TEMPLATE });
  assert.equal(ok.ok, true);
  assert.equal(ok.nickname, '『TCEL•B』João Silva | 007');
  assert.ok(ok.nickname.length <= 32);
});

test('apelido longo: pede correção e NUNCA corta em silêncio', () => {
  const r = validateRpInput({ nome: 'Maximiliano Albuquerque Neto', idRP: '98765', template: TEMPLATE });
  assert.equal(r.ok, false);
  assert.equal(r.nickname, null);
  assert.match(r.errors.join(' '), /Encurte o NOME RP/);
});

test('apelido: bloqueia caracteres que viram menção/formatação', () => {
  assert.equal(validateRpInput({ nome: '@everyone', idRP: '1', template: TEMPLATE }).ok, false);
  assert.equal(validateRpInput({ nome: 'Ana <@123>', idRP: '1', template: TEMPLATE }).ok, false);
  assert.equal(validateRpInput({ nome: 'Ana', idRP: '1 2', template: TEMPLATE }).ok, false);
  // Aspas, barra e chaves quebrariam o JSON montado no BotGhost.
  for (const bad of ['Ana "X"', 'Ana\\', 'Ana {user_id}']) assert.equal(validateRpInput({ nome: bad, idRP: '1', template: TEMPLATE }).ok, false, bad);
  assert.ok(validateTemplate('sem placeholders'));
  assert.equal(validateTemplate(TEMPLATE), null);
});

function cand(id, userId, extra = {}) {
  return { _id: id, discordUserId: userId, studentName: `Aluno ${userId}`, effectiveScore: 80, maxScoreComputed: 100, revision: 1, ...extra };
}

test('seleção: o mesmo usuário não entra duas vezes; marcações de outras páginas persistem', () => {
  const page1 = [cand('a1', 'U1'), cand('a2', 'U1'), cand('b1', 'U2')];
  assert.match(applySelection([], { pageCandidates: page1, chosenIds: ['a1', 'a2'] }).error, /mais de um resultado/);
  let sel = applySelection([], { pageCandidates: page1, chosenIds: ['a2'] }).selections;
  const page2 = [cand('a9', 'U1'), cand('c1', 'U3')];
  sel = applySelection(sel, { pageCandidates: page2, chosenIds: ['c1'] }).selections;
  assert.deepEqual(sel.map((s) => s.attemptId).sort(), ['a2', 'c1']);
  assert.match(applySelection(sel, { pageCandidates: page2, chosenIds: ['a9', 'c1'] }).error, /já está no lote/);
  sel = applySelection(sel, { pageCandidates: page1, chosenIds: [] }).selections;
  assert.deepEqual(sel.map((s) => s.attemptId), ['c1']);
});

test('anúncio: lotes de até 40 pessoas por mensagem, sem perder ninguém', () => {
  const users = Array.from({ length: 95 }, (_, i) => String(100000000000000000n + BigInt(i)));
  const chunks = chunkUserIds(users);
  assert.deepEqual(chunks.map((c) => c.length), [40, 40, 15]);
  assert.deepEqual(chunks.flat(), users);
});

test('texto de pessoas: sem @everyone, menção, markdown, variável do BotGhost ou [[...]]', () => {
  const t = userText('@everyone <@&1> **x** {server_id} [[links.aluno]]');
  assert.ok(!t.includes('@everyone'));
  assert.ok(!t.includes('<@'));
  assert.ok(!t.includes('**'));
  assert.ok(!t.includes('{server_id}'));
  assert.ok(!t.includes('[[links'));
});

// ---------------- Modelos de mensagem ----------------

test('todos os modelos padrão TCEL são válidos e cabem nos limites com dados fictícios', () => {
  for (const key of Object.keys(TEMPLATES)) {
    assert.deepEqual(validateSpec(key, TEMPLATES[key].default), [], key);
    const r = renderTemplate(key, TEMPLATES[key].default, sampleContext(key), { mode: 'test' });
    assert.equal(r.ok, true, `${key}: ${JSON.stringify(r.errors)}`);
    JSON.parse(r.discordBodyJson);
    assert.ok(!r.discordBodyJson.includes('[object Object]'));
  }
});

test('mensagem de resultado no formato pedido; menção aparece mas não pinga por padrão', () => {
  const r = renderTemplate('result_finished', TEMPLATES.result_finished.default, {
    ...sampleContext('result_finished'), 'aluno.mencao': '<@200000000000000002>', 'resultado.nota': '86', 'resultado.total': '100', 'prova.nome': 'Prova TCEL',
  }, { pingIds: { aluno: ['200000000000000002'] } });
  assert.equal(r.message.content, 'Prova finalizada: <@200000000000000002> — Nota: 86 / 100 — Prova: Prova TCEL');
  assert.deepEqual(r.message.allowed_mentions, { parse: [], users: [], roles: [] });
});

test('anúncio: primeira linha pedida, uma menção por linha, pings só dos promovidos e do cargo', () => {
  const users = ['200000000000000002', '200000000000000003'];
  const ctx = { ...sampleContext('promotion_announcement'), 'promocao.cargoMencao': `<@&${ROLE}>`, 'promocao.listaMencoes': users.map((u) => `<@${u}>`).join('\n') };
  const r = renderTemplate('promotion_announcement', TEMPLATES.promotion_announcement.default, ctx, { pingIds: { promovidos: users, cargoPromocao: [ROLE] } });
  assert.equal(r.message.content, `Parabéns aos promovidos para <@&${ROLE}>\n<@${users[0]}>\n<@${users[1]}>`);
  assert.deepEqual(r.message.allowed_mentions, { parse: [], users, roles: [ROLE] });
  // Edição e teste nunca notificam.
  assert.deepEqual(renderTemplate('promotion_announcement', TEMPLATES.promotion_announcement.default, ctx, { mode: 'edit', pingIds: { promovidos: users, cargoPromocao: [ROLE] } }).message.allowed_mentions.users, []);
  assert.deepEqual(renderTemplate('promotion_announcement', TEMPLATES.promotion_announcement.default, ctx, { mode: 'test', pingIds: { promovidos: users, cargoPromocao: [ROLE] } }).message.allowed_mentions.roles, []);
});

test('ping só vale para quem aparece no TEXTO (fora do embed) e foi liberado', () => {
  const spec = normalizeSpec({ content: 'Oi <@300000000000000001>', embed: { enabled: true, title: '<@300000000000000002>' }, pings: { extraUserIds: ['300000000000000001', '300000000000000002'] } });
  const r = renderTemplate('result_finished', spec, sampleContext('result_finished'));
  assert.deepEqual(r.message.allowed_mentions.users, ['300000000000000001']);
  assert.deepEqual(r.message.allowed_mentions.parse, [], '@everyone/@here nunca por padrão');
});

test('variáveis: desconhecida é recusada; link só no modelo privado de sala; sem expansão dupla', () => {
  const unknown = validateSpec('result_finished', { content: 'Nota [[resultado.segredo]]', embed: { enabled: false } });
  assert.match(unknown[0].message, /desconhecida/);
  const leak = validateSpec('result_finished', { content: '[[links.aluno]]', embed: { enabled: false } });
  assert.match(leak[0].message, /Sala criada/);
  const other = validateSpec('results_list', { content: '[[links.fiscal]]', embed: { enabled: false } });
  assert.ok(other.length);
  assert.deepEqual(validateSpec('room_created', TEMPLATES.room_created.default), []);
  const broken = validateSpec('result_finished', { content: 'x [[aluno.mencao', embed: { enabled: false } });
  assert.ok(broken.some((e) => /não forma uma variável/.test(e.message)));
  // Valor que contém [[...]] não é expandido de novo (uma passada só).
  const r = renderTemplate('result_finished', { content: '[[aluno.nome]] [[resultado.nota]]', embed: { enabled: false } }, { ...sampleContext('result_finished'), 'aluno.nome': '[[resultado.nota]]', 'resultado.nota': '99' });
  assert.equal(r.message.content, '[[resultado.nota]] 99');
});

test('chaves, aspas, HTML e barras nos dados não quebram o JSON nem viram variável do BotGhost', () => {
  const ctx = { ...sampleContext('result_finished'), 'aluno.nome': 'A "b" {user_id} </script> \\ ${x}' };
  const r = renderTemplate('result_finished', { content: 'Nome: [[aluno.nome]]', embed: { enabled: false } }, ctx);
  const parsed = JSON.parse(r.discordBodyJson);
  assert.equal(parsed.content, 'Nome: A "b" {user_id} </script> \\ ${x}');
  assert.ok(!r.discordBodyJson.includes('{user_id}'), 'chaves dentro de texto vão escapadas (\\u007b)');
  const priv = renderTemplate('room_created', TEMPLATES.room_created.default, sampleContext('room_created'));
  const cb = JSON.parse(priv.discordCallbackJson);
  assert.equal(cb.type, 4);
  assert.equal(cb.data.flags, 64);
});

test('URLs de imagem: só https público, sem variável, sem IP/localhost', () => {
  assert.equal(urlProblem('https://cdn.exemplo.com/logo.png'), null);
  assert.ok(urlProblem('http://cdn.exemplo.com/logo.png'));
  assert.ok(urlProblem('https://127.0.0.1/x.png'));
  assert.ok(urlProblem('https://localhost/x.png'));
  assert.ok(urlProblem('https://[::1]/x.png'));
  assert.ok(urlProblem('https://user:senha@exemplo.com/x.png'));
  assert.ok(urlProblem('javascript:alert(1)'));
  assert.ok(urlProblem('https://exemplo.com/[[links.aluno]]'));
});

test('limites do Discord conferidos DEPOIS de preencher, com erro por campo', () => {
  const spec = { content: '[[aluno.nome]]', embed: { enabled: true, title: 'T', fields: [{ name: 'N', value: '[[aluno.nome]]' }] } };
  const r = renderTemplate('result_finished', spec, { ...sampleContext('result_finished'), 'aluno.nome': 'x'.repeat(2100) });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path === 'content'));
  assert.ok(r.errors.some((e) => e.path === 'embed.fields.0.value'));
  assert.equal(LIMITS.content, 2000);
  const many = validateSpec('result_finished', { content: 'x', embed: { enabled: true, title: 't', fields: Array.from({ length: 26 }, () => ({ name: 'a', value: 'b' })) } });
  assert.ok(many.some((e) => e.path === 'embed.fields'));
  assert.ok(validateSpec('result_finished', { content: 'x', embed: { enabled: true, title: 't', color: 'vermelho' } }).some((e) => e.path === 'embed.color'));
});

test('mensagens privadas não aceitam pings; ping precisa ser um alvo do modelo', () => {
  assert.ok(validateSpec('room_created', { ...TEMPLATES.room_created.default, pings: { extraUserIds: ['300000000000000001'] } }).length);
  assert.ok(validateSpec('result_finished', { content: 'x', embed: { enabled: false }, pings: { roles: ['cargoPromocao'] } }).length);
});

// ---------------- Autenticação, idempotência, webhook ----------------

function fakeReqRes(header) {
  const req = { ip: '203.0.113.9', path: '/health', method: 'GET', baseUrl: '/api/integrations/botghost', get: (h) => (h === 'authorization' ? header : undefined) };
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return { req, res };
}

test('chave do site: Bearer obrigatório, comparação segura, desligado sem segredo', () => {
  const key = 'k'.repeat(40);
  const auth = createKeyAuth(() => ({ enabled: true, siteApiKey: key }));
  let passed = false;
  let t = fakeReqRes(`Bearer ${key}`);
  auth(t.req, t.res, () => { passed = true; });
  assert.equal(passed, true);
  t = fakeReqRes(key);
  auth(t.req, t.res, () => assert.fail('sem Bearer não passa'));
  assert.equal(t.res.statusCode, 401);
  t = fakeReqRes(`Bearer ${key}x`);
  auth(t.req, t.res, () => assert.fail());
  assert.equal(t.res.statusCode, 401);
  assert.ok(!JSON.stringify(t.res.body).includes(key), 'resposta nunca repete a chave');
  const off = createKeyAuth(() => ({ enabled: true, siteApiKey: null }));
  t = fakeReqRes('Bearer qualquer');
  off(t.req, t.res, () => assert.fail());
  assert.equal(t.res.statusCode, 503);
  assert.equal(safeEqual('a', 'a'), true);
  assert.equal(safeEqual('a', 'ab'), false);
});

test('idempotência: mesmo conteúdo em outra ordem tem o mesmo hash; conteúdo diferente não', () => {
  assert.equal(canonicalHash({ a: 1, b: [1, 2] }), canonicalHash({ b: [1, 2], a: 1 }));
  assert.notEqual(canonicalHash({ a: 1 }), canonicalHash({ a: 2 }));
});

test('webhook: só a URL oficial do BotGhost; chave do módulo sem "Bearer"; só o ID vai no corpo', async () => {
  assert.equal(webhookConfigProblem({ webhookUrl: 'https://api.botghost.com/webhook/123456789012345678/abc_1', webhookApiKey: 'k' }), null);
  assert.ok(webhookConfigProblem({ webhookUrl: 'https://evil.example.com/webhook/1/2', webhookApiKey: 'k' }));
  assert.ok(webhookConfigProblem({ webhookUrl: 'https://api.botghost.com/webhook/123456789012345678/abc', webhookApiKey: '' }));
  let seen = null;
  const r = await triggerWebhook({
    webhookUrl: 'https://api.botghost.com/webhook/123456789012345678/abc',
    webhookApiKey: 'chave-modulo',
    notificationId: 'n1',
    kind: 'result',
    fetchImpl: async (url, init) => { seen = init; return { status: 200, headers: { get: () => null } }; },
  });
  assert.equal(r.ok, true);
  assert.equal(seen.headers.Authorization, 'chave-modulo');
  assert.deepEqual(JSON.parse(seen.body).variables.map((v) => v.variable), ['{tcel_notification_id}', '{tcel_notification_kind}']);
});

// ---------------- Evidências de promoção ----------------

test('evidência de cargos: aceita lista/CSV/JSON; [object Object] ou lixo é ilegível', () => {
  assert.deepEqual(parseRoleEvidence('1231023397069258844,1057349963203498105'), ['1231023397069258844', '1057349963203498105']);
  assert.deepEqual(parseRoleEvidence('["1231023397069258844"]'), ['1231023397069258844']);
  assert.deepEqual(parseRoleEvidence('<@&1231023397069258844> <@&1057349963203498105>'), ['1231023397069258844', '1057349963203498105']);
  assert.deepEqual(parseRoleEvidence(''), []);
  assert.equal(parseRoleEvidence('[object Object]'), null);
  assert.equal(parseRoleEvidence('12,abc'), null);
});

test('status da pessoa pelas etapas: tudo feito, parcial, falhou', () => {
  assert.equal(statusFromSteps([{ status: 'done' }, { status: 'done' }]), 'completed');
  assert.equal(statusFromSteps([{ status: 'done' }, { status: 'pending' }]), 'in_progress');
  assert.equal(statusFromSteps([{ status: 'done' }, { status: 'failed' }]), 'partial');
  assert.equal(statusFromSteps([{ status: 'done', alreadyInPlace: true }, { status: 'failed' }]), 'failed');
});

test('relato de status HTTP do modo "status"', () => {
  const { parseStatusReport } = require('../botghost/promotionsService');
  assert.deepEqual(parseStatusReport('add1=204, add2=403 rem1:204 nick=200 lixo=1'), { add1: 204, add2: 403, rem1: 204, nick: 200 });
  assert.deepEqual(parseStatusReport('add1={tcel_add1.status}'), {});
});
