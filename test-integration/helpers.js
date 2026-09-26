// Infraestrutura dos testes de integração: MongoDB temporário em memória
// (mongodb-memory-server), a API do BotGhost montada num Express de teste e
// um webhook falso. Nenhum teste chama o BotGhost, o Discord real nem o
// banco de produção.
const http = require('http');
const express = require('express');
const { MongoMemoryServer } = require('mongodb-memory-server');

const GUILD = '900000000000000000';
const OPERATOR = '700000000000000009';
const OTHER_OPERATOR = '700000000000000008';
const STRANGER = '700000000000000007';
const PANEL = '600000000000000001';
const RESULTS = '600000000000000002';
const TEST_CHANNEL = '600000000000000003';
const ANNOUNCE = '1396947587235578017';
const ADD1 = '1231023397069258844';
const ADD2 = '1057349963203498105';
const REM = '1057349976482664569';
const PROFESSOR_ROLE = '820000000000000001'; // Role de Professor DAFP
const OTHER_ROLE = '820000000000000002';
const KEY = 'chave-de-teste-com-mais-de-32-caracteres-0123456789';
const WEBHOOK_URL = 'https://api.botghost.com/webhook/123456789012345678/evento_tcel';

async function setupDb() {
  const server = await MongoMemoryServer.create();
  process.env.MONGODB_URI = server.getUri('provas_test');
  process.env.SESSION_SECRET = 'test-secret';
  const { connectDb, mongoose } = require('../config/db');
  const originalLog = console.log;
  console.log = () => {};
  await connectDb();
  console.log = originalLog;
  // Garante os índices únicos (pedido repetido, promoção concorrente).
  for (const file of ['Room', 'ExamAttempt', 'Exam', 'Question', 'IntegrationConfig', 'IntegrationNotification', 'IntegrationRequest', 'MessageTemplate', 'PromotionDraft', 'Promotion', 'SecurityLog', 'ExamEvent']) {
    await require(`../models/${file}`).init();
  }
  return {
    mongoose,
    async reset() {
      const collections = await mongoose.connection.db.collections();
      await Promise.all(collections.map((c) => c.deleteMany({})));
      require('../botghost/configStore').invalidate();
    },
    async teardown() {
      await mongoose.disconnect();
      await server.stop();
    },
  };
}

function testEnv(overrides = {}) {
  return {
    enabled: true,
    siteApiKey: KEY,
    allowedGuildId: GUILD,
    notificationsEnabled: true,
    webhookUrl: WEBHOOK_URL,
    webhookApiKey: 'chave-do-modulo-webhooks',
    ...overrides,
  };
}

// Sobe só a API da integração num Express de teste (porta aleatória).
async function startApi(envRef) {
  const { createIntegrationRouter } = require('../botghost/routes');
  const app = express();
  app.set('trust proxy', 1);
  app.use('/api/integrations/botghost', createIntegrationRouter({
    getEnv: () => envRef.current,
    getPublicBaseUrl: () => 'https://provas.example.com',
  }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/integrations/botghost`;
  async function call(method, path, body, { key = KEY, raw = null, headers = {} } = {}) {
    const h = { ...headers };
    if (key) h.Authorization = `Bearer ${key}`;
    let payload;
    if (raw != null) { payload = raw; h['Content-Type'] = 'application/json'; } else if (body !== undefined && method !== 'GET') { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
    let url = `${base}${path}`;
    if (method === 'GET' && body) url += `?${new URLSearchParams(body)}`;
    const res = await fetch(url, { method, headers: h, body: payload });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* resposta não-JSON */ }
    return { status: res.status, body: json, text };
  }
  return { call, close: () => new Promise((r) => server.close(r)) };
}

// Contexto de interação vindo do BotGhost ({server_id}, {user_id},
// {channel_id}).
function actorFields(userId = OPERATOR, extra = {}) {
  return { guildId: GUILD, actorDiscordId: userId, channelId: PANEL, actorDisplayName: 'Operador Teste', ...extra };
}

// /provas-dafp: além de quem executou, os cargos dele (como o BotGhost
// atesta). Por padrão, alguém com a Role de Professor DAFP e outro cargo.
function dafpActorFields(userId = OPERATOR, extra = {}) {
  return actorFields(userId, { actorRoleIds: `<@&${OTHER_ROLE}> <@&${PROFESSOR_ROLE}>`, ...extra });
}

async function saveDefaultConfig(overrides = {}) {
  const configStore = require('../botghost/configStore');
  const { update, errors } = configStore.validateConfig({
    operatorIds: { generate: `${OPERATOR},${OTHER_OPERATOR}`, results: OPERATOR, promote: `${OPERATOR},${OTHER_OPERATOR}` },
    channels: { panel: PANEL, results: RESULTS, test: TEST_CHANNEL },
    promotion: { addRoleIds: `${ADD1},${ADD2}`, removeRoleIds: REM, announceChannelId: ANNOUNCE, announceRoleId: ADD1, nicknameTemplate: '『TCEL•B』{nome} | {idRP}' },
    ...overrides,
    dafp: { professorRoleId: PROFESSOR_ROLE, ...(overrides.dafp || {}) },
  });
  if (errors.length) throw new Error(errors.join(' '));
  return configStore.saveConfig(update, 'teste');
}

async function seedExam({ name = 'Prova TCEL', questions = 5, points = 20 } = {}) {
  const Exam = require('../models/Exam');
  const Question = require('../models/Question');
  const exam = await Exam.create({ name, questionCount: questions, pointsPerQuestion: points, durationMinutes: 120 });
  for (let i = 0; i < questions; i += 1) {
    await Question.create({
      examId: exam._id,
      text: `${name} — pergunta ${i}`,
      options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }, { key: 'C', text: 'c' }, { key: 'D', text: 'd' }],
      correctKey: 'A',
    });
  }
  return exam;
}

// Responde `correct` questões certas (as demais erradas) e finaliza.
async function takeExam(roomId, correct, reason = 'manual') {
  const lifecycle = require('../lib/examLifecycle');
  const { attempt } = await lifecycle.startOrResumeAttempt(roomId);
  attempt.snapshot.forEach((q, i) => {
    q.selectedKey = i < correct ? q.correctKey : (q.correctKey === 'A' ? 'B' : 'A');
    q.isCorrect = i < correct;
  });
  await attempt.save();
  return lifecycle.finalizeAttempt(attempt, reason);
}

// Webhook falso do BotGhost: registra os disparos; `state.respond` decide a
// resposta (status HTTP ou um Error para simular falha de rede).
function fakeWebhook() {
  const calls = [];
  const state = { respond: () => ({ status: 200, body: '{}' }) };
  async function fetchImpl(url, init) {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = state.respond(calls.length);
    if (r instanceof Error) throw r;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: (h) => (r.headers || {})[h.toLowerCase()] || null }, text: async () => r.body || '' };
  }
  return { calls, state, fetchImpl };
}

const silentLog = { log() {}, warn() {}, error() {} };

module.exports = {
  setupDb, testEnv, startApi, actorFields, dafpActorFields, PROFESSOR_ROLE, OTHER_ROLE, saveDefaultConfig, seedExam, takeExam, fakeWebhook, silentLog,
  GUILD, OPERATOR, OTHER_OPERATOR, STRANGER, PANEL, RESULTS, TEST_CHANNEL, ANNOUNCE, ADD1, ADD2, REM, KEY, WEBHOOK_URL,
};
