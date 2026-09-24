const test = require('node:test');
const assert = require('node:assert/strict');
const { parseUserIdInput, isSnowflake, parseIdList } = require('../lib/discordIds');
const { validateRpInput, validateTemplate } = require('../discord/nickname');
const { buildAnnouncementChunks, nonceFor } = require('../discord/announce');
const { build, parse } = require('../discord/customIds');
const { applySelection } = require('../discord/selection');
const { validateDiscordConfig } = require('../discord/configValidation');
const { resultNotificationContent, safeName } = require('../discord/format');
const { isPermanentError } = require('../discord/errors');

const TEMPLATE = '『TCEL•B』{nome} | {idRP}';

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

test('apelido: monta no modelo e respeita 32 caracteres', () => {
  const ok = validateRpInput({ nome: 'João Silva', idRP: '123', template: TEMPLATE });
  assert.equal(ok.ok, true);
  assert.equal(ok.nickname, '『TCEL•B』João Silva | 123');
  assert.ok(ok.nickname.length <= 32);
});

test('apelido longo: pede ajuste e NUNCA corta em silêncio', () => {
  const r = validateRpInput({ nome: 'Maximiliano Albuquerque Neto', idRP: '98765', template: TEMPLATE });
  assert.equal(r.ok, false);
  assert.equal(r.nickname, null);
  assert.match(r.errors.join(' '), /Encurte o NOME RP/);
});

test('apelido: bloqueia caracteres que viram menção/formatação', () => {
  assert.equal(validateRpInput({ nome: '@everyone', idRP: '1', template: TEMPLATE }).ok, false);
  assert.equal(validateRpInput({ nome: 'Ana <@123>', idRP: '1', template: TEMPLATE }).ok, false);
  assert.equal(validateRpInput({ nome: 'Ana', idRP: '1 2', template: TEMPLATE }).ok, false);
  assert.ok(validateTemplate('sem placeholders'));
  assert.equal(validateTemplate(TEMPLATE), null);
});

test('anúncio: uma pessoa por linha, menções restritas aos promovidos e ao cargo', () => {
  const role = '1231023397069258844';
  const users = Array.from({ length: 95 }, (_, i) => String(100000000000000000n + BigInt(i)));
  const chunks = buildAnnouncementChunks({ roleId: role, userIds: users });
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].content.split('\n')[0], `Parabéns aos promovidos para <@&${role}>`);
  assert.equal(chunks[0].content.split('\n')[1], `<@${users[0]}>`);
  for (const [i, c] of chunks.entries()) {
    assert.ok(c.content.length <= 2000);
    assert.deepEqual(c.allowedMentions.parse, []);
    assert.ok(c.allowedMentions.users.length <= 100);
    assert.deepEqual(c.allowedMentions.roles, i === 0 ? [role] : []);
  }
  assert.deepEqual(chunks.flatMap((c) => c.allowedMentions.users), users);
  const n = nonceFor('announce:x:1', 0);
  assert.equal(n.length, 25);
  assert.equal(n, nonceFor('announce:x:1', 0));
  assert.notEqual(n, nonceFor('announce:x:1', 1));
});

test('customIds: estado cabe no limite de 100 caracteres e volta igual', () => {
  const id = build('r', 'e', 12, 'sd', 'a'.repeat(24), '12345678901234567890');
  assert.ok(id.length <= 100);
  assert.deepEqual(parse(id), ['r', 'e', '12', 'sd', 'a'.repeat(24), '12345678901234567890']);
  assert.equal(parse('outrobot:x'), null);
  assert.throws(() => build('x'.repeat(120)));
});

function cand(id, userId, extra = {}) {
  return { _id: id, discordUserId: userId, studentName: `Aluno ${userId}`, effectiveScore: 80, maxScoreComputed: 100, revision: 1, ...extra };
}

test('seleção (tentativas múltiplas): o mesmo usuário não entra duas vezes no lote', () => {
  const page = [cand('a1', 'U1'), cand('a2', 'U1'), cand('b1', 'U2')];
  const dup = applySelection([], { pageCandidates: page, chosenIds: ['a1', 'a2'] });
  assert.match(dup.error, /mais de um resultado do mesmo usuário/);

  const ok = applySelection([], { pageCandidates: page, chosenIds: ['a2', 'b1'] });
  assert.deepEqual(ok.selections.map((s) => s.attemptId), ['a2', 'b1']);
});

test('seleção: marcações de outras páginas persistem; conflito entre páginas é recusado', () => {
  const page1 = [cand('a1', 'U1'), cand('b1', 'U2')];
  const page2 = [cand('a9', 'U1'), cand('c1', 'U3')];
  let sel = applySelection([], { pageCandidates: page1, chosenIds: ['a1'] }).selections;
  sel = applySelection(sel, { pageCandidates: page2, chosenIds: ['c1'] }).selections;
  assert.deepEqual(sel.map((s) => s.attemptId).sort(), ['a1', 'c1']);

  const conflict = applySelection(sel, { pageCandidates: page2, chosenIds: ['a9', 'c1'] });
  assert.match(conflict.error, /já está no lote com outra tentativa/);

  // Desmarcar na página 1 não mexe na página 2.
  sel = applySelection(sel, { pageCandidates: page1, chosenIds: [] }).selections;
  assert.deepEqual(sel.map((s) => s.attemptId), ['c1']);
});

test('seleção: trocar a tentativa do mesmo usuário na mesma página preserva os dados RP', () => {
  const page = [cand('a1', 'U1'), cand('a2', 'U1')];
  let sel = applySelection([], { pageCandidates: page, chosenIds: ['a1'] }).selections;
  sel[0].nomeRP = 'Ana';
  sel[0].idRP = '12';
  sel = applySelection(sel, { pageCandidates: page, chosenIds: ['a2'] }).selections;
  assert.equal(sel[0].attemptId, 'a2');
  assert.equal(sel[0].nomeRP, 'Ana');
  assert.equal(applySelection([], { pageCandidates: page.concat([cand('z', 'U9')]), chosenIds: ['a1', 'z'], max: 1 }).error.includes('no máximo'), true);
});

test('config: valores iniciais pedidos são aceitos e erros são claros', () => {
  const { update, errors } = validateDiscordConfig({
    panelChannelId: '1396947587235578017',
    operatorRoles: { generate: '1057349963203498105', results: '', promote: '' },
    promotion: {
      addRoleIds: '1231023397069258844, 1057349963203498105',
      removeRoleIds: '1057349976482664569',
      announceChannelId: '1396947587235578017',
      announceRoleId: '1231023397069258844',
      nicknameTemplate: TEMPLATE,
    },
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(update.promotion.addRoleIds, ['1231023397069258844', '1057349963203498105']);

  const bad = validateDiscordConfig({ panelChannelId: 'abc', promotion: { addRoleIds: '1', removeRoleIds: '', nicknameTemplate: '{nome}' } });
  assert.ok(bad.errors.length >= 3);

  const overlap = validateDiscordConfig({ promotion: { addRoleIds: '1231023397069258844', removeRoleIds: '1231023397069258844', announceChannelId: '1396947587235578017', announceRoleId: '1231023397069258844', nicknameTemplate: TEMPLATE } });
  assert.match(overlap.errors.join(' '), /adicionar" e "remover/);
});

test('mensagem de resultado: formato pedido, menção sem @everyone escondido', () => {
  const text = resultNotificationContent({ attemptId: 'x1', discordUserId: '123456789012345678', score: 86, maxScore: 100, examName: 'Prova @everyone', adjusted: false, deleted: false });
  assert.equal(text.split('\n')[0], 'Prova finalizada: <@123456789012345678> — Nota: 86 / 100 — Prova: Prova @​everyone');
  const removed = resultNotificationContent({ attemptId: 'x1', discordUserId: '123456789012345678', score: 86, maxScore: 100, examName: 'P', deleted: true });
  assert.match(removed, /^Resultado removido/);
  assert.equal(safeName('<@&1> *negrito*'), '@​&1 \\*negrito\\*');
});

test('erros: permissão/inexistente são definitivos; rede e 5xx/429 são transitórios', () => {
  assert.equal(isPermanentError({ code: 50013, status: 403 }), true);
  assert.equal(isPermanentError({ code: 10007, status: 404 }), true);
  assert.equal(isPermanentError({ status: 500 }), false);
  assert.equal(isPermanentError({ status: 429 }), false);
  assert.equal(isPermanentError(new Error('ECONNRESET')), false);
  assert.equal(isPermanentError({ permanent: true }), true);
});
