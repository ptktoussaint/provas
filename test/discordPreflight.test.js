const test = require('node:test');
const assert = require('node:assert/strict');
const { preflightPromotion } = require('../discord/preflight');

const GUILD = '900000000000000000';
const ADD1 = '1231023397069258844';
const ADD2 = '1057349963203498105';
const REM = '1057349976482664569';
const CHANNEL = '1396947587235578017';

function config() {
  return { promotion: { addRoleIds: [ADD1, ADD2], removeRoleIds: [REM], announceChannelId: CHANNEL, announceRoleId: ADD1, nicknameTemplate: '『TCEL•B』{nome} | {idRP}' } };
}

function guild(overrides = {}) {
  return {
    id: GUILD,
    ownerId: '800000000000000000',
    roles: {
      [ADD1]: { exists: true, name: 'Promovido', position: 5, managed: false, mentionable: true },
      [ADD2]: { exists: true, name: 'TCEL', position: 4, managed: false, mentionable: false },
      [REM]: { exists: true, name: 'Recruta', position: 3, managed: false, mentionable: false },
    },
    bot: { highestPosition: 10, perms: { manageRoles: true, manageNicknames: true, administrator: false } },
    announceChannel: { exists: true, canView: true, canSend: true, canMentionEveryone: false },
    ...overrides,
  };
}

function entry(overrides = {}) {
  return {
    userId: '700000000000000001',
    nomeRP: 'Ana',
    idRP: '12',
    member: { isBot: false, roleIds: [REM], highestPosition: 3, nickname: null },
    alreadyPromoted: false,
    selection: { revisionAtSelection: 1, scoreAtSelection: 90 },
    result: { exists: true, deleted: false, finished: true, discordUserId: '700000000000000001', guildId: GUILD, revision: 1, effectiveScore: 90 },
    ...overrides,
  };
}

test('preflight: caso válido passa, com plano de cargos e apelido', () => {
  const r = preflightPromotion({ config: config(), guild: guild(), entries: [entry()] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.entries[0].plan, { add: [ADD1, ADD2], remove: [REM], nickname: '『TCEL•B』Ana | 12' });
});

test('preflight: hierarquia insuficiente (cargo acima do bot) bloqueia antes de qualquer operação', () => {
  const g = guild();
  g.roles[ADD1].position = 10;
  const r = preflightPromotion({ config: config(), guild: g, entries: [entry()] });
  assert.equal(r.ok, false);
  assert.match(r.globalErrors.join(' '), /acima/);
});

test('preflight: membro com cargo acima do bot, dono do servidor e bot são bloqueados', () => {
  const high = preflightPromotion({ config: config(), guild: guild(), entries: [entry({ member: { isBot: false, roleIds: [], highestPosition: 12 } })] });
  assert.equal(high.ok, false);
  const owner = preflightPromotion({ config: config(), guild: guild(), entries: [entry({ userId: '800000000000000000', result: { ...entry().result, discordUserId: '800000000000000000' } })] });
  assert.match(owner.entries[0].errors.join(' '), /dono do servidor/);
  const bot = preflightPromotion({ config: config(), guild: guild(), entries: [entry({ member: { isBot: true, roleIds: [], highestPosition: 0 } })] });
  assert.equal(bot.ok, false);
});

test('preflight: sem permissões, canal inacessível ou cargo gerenciado bloqueiam', () => {
  const g = guild({ bot: { highestPosition: 10, perms: { manageRoles: false, manageNicknames: false } }, announceChannel: { exists: true, canView: true, canSend: false } });
  g.roles[ADD2].managed = true;
  const r = preflightPromotion({ config: config(), guild: g, entries: [entry()] });
  const text = r.globalErrors.join(' ');
  assert.match(text, /Gerenciar cargos/);
  assert.match(text, /Gerenciar apelidos/);
  assert.match(text, /enviar mensagens/);
  assert.match(text, /gerenciado por uma integração/);
});

test('preflight: resultado excluído impede; nota alterada exige nova revisão; já promovido bloqueia', () => {
  const deleted = preflightPromotion({ config: config(), guild: guild(), entries: [entry({ result: { ...entry().result, deleted: true } })] });
  assert.equal(deleted.ok, false);
  assert.equal(deleted.entries[0].removedResult, true);

  const changed = preflightPromotion({ config: config(), guild: guild(), entries: [entry({ result: { ...entry().result, revision: 2, effectiveScore: 70 } })] });
  assert.equal(changed.entries[0].needsReReview, true);

  const promoted = preflightPromotion({ config: config(), guild: guild(), entries: [entry({ alreadyPromoted: true })] });
  assert.equal(promoted.ok, false);
});

test('preflight: quem já tem os cargos (fora do bot) é marcado para não entrar no anúncio', () => {
  const r = preflightPromotion({ config: config(), guild: guild(), entries: [entry({ member: { isBot: false, roleIds: [ADD1, ADD2], highestPosition: 5 } })] });
  assert.equal(r.entries[0].preexisting, true);
  assert.equal(r.ok, true);
});

test('preflight: cargo não mencionável sem permissão só gera aviso', () => {
  const g = guild();
  g.roles[ADD1].mentionable = false;
  const r = preflightPromotion({ config: config(), guild: g, entries: [entry()] });
  assert.equal(r.ok, true);
  assert.match(r.globalWarnings.join(' '), /não é mencionável/);
});

test('preflight: apelido longo bloqueia a pessoa', () => {
  const r = preflightPromotion({ config: config(), guild: guild(), entries: [entry({ nomeRP: 'Nome Extremamente Comprido Demais', idRP: '12345' })] });
  assert.equal(r.ok, false);
  assert.match(r.entries[0].errors.join(' '), /32/);
});
