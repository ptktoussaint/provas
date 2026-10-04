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

test('STUN_URLS: vírgulas, espaços, vazios e repetidos; cada STUN vira uma entrada no iceServers, TURN preservado', () => {
  const list = 'stun:stun.l.google.com:19302, stun:stun1.l.google.com:19302,,stun:stun2.l.google.com:19302 ,stun:stun3.l.google.com:19302,stun:stun4.l.google.com:19302,stun:stun.relay.metered.ca:80, stun:stun1.l.google.com:19302 , ';
  const result = buildIceServers('teste', {
    STUN_URLS: list,
    TURN_URLS: 'turn:global.relay.metered.ca:80, turn:global.relay.metered.ca:443?transport=tcp,turn:global.relay.metered.ca:80',
    TURN_USERNAME: 'user1',
    TURN_CREDENTIAL: 'pass1',
    TURN_SECRET: '',
  });
  const stun = result.iceServers.filter((s) => typeof s.urls === 'string').map((s) => s.urls);
  assert.deepEqual(stun, [
    'stun:stun.l.google.com:19302',
    'stun:stun1.l.google.com:19302',
    'stun:stun2.l.google.com:19302',
    'stun:stun3.l.google.com:19302',
    'stun:stun4.l.google.com:19302',
    'stun:stun.relay.metered.ca:80',
  ]);
  const turn = result.iceServers.find((s) => Array.isArray(s.urls));
  assert.deepEqual(turn, { urls: ['turn:global.relay.metered.ca:80', 'turn:global.relay.metered.ca:443?transport=tcp'], username: 'user1', credential: 'pass1' });
  assert.equal(result.turnConfigured, true);
  assert.equal(result.iceServers.length, 7);
});

test('STUN_URLS inválido ou vazio: entrada sem "stun:" é ignorada (não quebra o WebRTC); lista vazia volta ao padrão', () => {
  const bad = buildIceServers('teste', { STUN_URLS: 'stun.l.google.com:19302, https://x, stun:ok.example.com:3478', TURN_URLS: '' });
  assert.deepEqual(bad.iceServers.map((s) => s.urls), ['stun:ok.example.com:3478']);
  const empty = buildIceServers('teste', { STUN_URLS: ' , ,', TURN_URLS: '' });
  assert.deepEqual(empty.iceServers.map((s) => s.urls), ['stun:stun.l.google.com:19302']);
  // TURN com esquema errado também é descartado (e então nada de TURN).
  const turnBad = buildIceServers('teste', { STUN_URLS: '', TURN_URLS: 'relay.example.com:80', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p' });
  assert.equal(turnBad.turnConfigured, false);
});
