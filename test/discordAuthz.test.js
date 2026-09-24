const test = require('node:test');
const assert = require('node:assert/strict');
const { authorize } = require('../discord/authz');

const GUILD = '111111111111111111';
const PANEL = '222222222222222222';
const ROLE_GEN = '333333333333333333';
const ROLE_RES = '444444444444444444';
const ROLE_PRO = '555555555555555555';

function config(overrides = {}) {
  return {
    panelChannelId: PANEL,
    operatorRoles: { generate: [ROLE_GEN], results: [ROLE_RES], promote: [ROLE_PRO] },
    ...overrides,
  };
}

function base(overrides = {}) {
  return { guildId: GUILD, channelId: PANEL, memberRoleIds: [ROLE_GEN], action: 'generate', expectedGuildId: GUILD, config: config(), ...overrides };
}

test('authz: nega uso em mensagem direta (sem servidor)', () => {
  const r = authorize(base({ guildId: null }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'dm');
});

test('authz: nega servidor não autorizado', () => {
  const r = authorize(base({ guildId: '999999999999999999' }));
  assert.equal(r.code, 'wrong_guild');
});

test('authz: sem DISCORD_GUILD_ID configurado bloqueia (não libera para todos)', () => {
  assert.equal(authorize(base({ expectedGuildId: null })).code, 'not_configured');
});

test('authz: configuração ausente bloqueia', () => {
  assert.equal(authorize(base({ config: null })).code, 'not_configured');
  assert.equal(authorize(base({ config: config({ panelChannelId: null }) })).code, 'not_configured');
});

test('authz: nenhum cargo configurado para a ação bloqueia TODO mundo', () => {
  const r = authorize(base({ config: config({ operatorRoles: { generate: [], results: [ROLE_RES], promote: [] } }) }));
  assert.equal(r.code, 'not_configured');
});

test('authz: canal errado é negado', () => {
  assert.equal(authorize(base({ channelId: '777777777777777777' })).code, 'wrong_channel');
});

test('authz: cada ação exige o seu próprio cargo', () => {
  assert.equal(authorize(base({ action: 'generate', memberRoleIds: [ROLE_GEN] })).ok, true);
  assert.equal(authorize(base({ action: 'results', memberRoleIds: [ROLE_GEN] })).code, 'forbidden');
  assert.equal(authorize(base({ action: 'promote', memberRoleIds: [ROLE_RES] })).code, 'forbidden');
  assert.equal(authorize(base({ action: 'promote', memberRoleIds: [ROLE_PRO] })).ok, true);
});

test('authz: cargo de DESTINO da promoção não dá acesso ao bot', () => {
  const destino = '1231023397069258844';
  const r = authorize(base({ action: 'promote', memberRoleIds: [destino] }));
  assert.equal(r.code, 'forbidden');
});

test('authz: publicar painel aceita qualquer cargo de operador', () => {
  assert.equal(authorize(base({ action: 'panel', memberRoleIds: [ROLE_RES] })).ok, true);
  assert.equal(authorize(base({ action: 'panel', memberRoleIds: [] })).code, 'forbidden');
});
