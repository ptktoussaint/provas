const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const BASE_ENV = { MONGODB_URI: 'mongodb://localhost/test', SESSION_SECRET: 'x' };

// Roda em processo filho (em vez de brincar com require.cache) para garantir
// que config/env.js leia exatamente as variáveis de ambiente do cenário,
// sem nenhum resquício de um teste anterior.
function buildIceServers(label, envOverrides) {
  const script = `
    const { buildIceServers } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'turn.js'))});
    console.log(JSON.stringify(buildIceServers(${JSON.stringify(label)})));
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, ...BASE_ENV, ...envOverrides },
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

test('buildIceServers só inclui STUN quando nenhum TURN está configurado', () => {
  const result = buildIceServers('teste', { TURN_URLS: '', TURN_SECRET: '', TURN_USERNAME: '', TURN_CREDENTIAL: '' });
  assert.equal(result.turnConfigured, false);
  assert.equal(result.iceServers.length, 1);
  assert.ok(result.iceServers[0].urls.startsWith('stun:'));
});

test('buildIceServers usa credenciais estáticas quando TURN_USERNAME/TURN_CREDENTIAL estão definidos', () => {
  const result = buildIceServers('teste', {
    TURN_URLS: 'turn:relay.example.com:80',
    TURN_USERNAME: 'user1',
    TURN_CREDENTIAL: 'pass1',
    TURN_SECRET: '',
  });
  assert.equal(result.turnConfigured, true);
  const turnEntry = result.iceServers.find((s) => JSON.stringify(s.urls).includes('turn:relay.example.com:80'));
  assert.equal(turnEntry.username, 'user1');
  assert.equal(turnEntry.credential, 'pass1');
});

test('buildIceServers gera credencial HMAC efêmera quando TURN_SECRET está definido', () => {
  const result = buildIceServers('viewer-123', {
    TURN_URLS: 'turn:relay.example.com:80',
    TURN_SECRET: 'segredo',
    TURN_USERNAME: '',
    TURN_CREDENTIAL: '',
  });
  assert.equal(result.turnConfigured, true);
  const turnEntry = result.iceServers.find((s) => JSON.stringify(s.urls).includes('turn:relay.example.com:80'));
  assert.match(turnEntry.username, /^\d+:viewer-123$/);
  assert.ok(turnEntry.credential.length > 0);
});
