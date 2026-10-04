const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');

// Recuperação num serviço novo (provasdafp): o site sobe apontando para o
// banco EXISTENTE "test", não apaga/sobrescreve nada, mostra nos Logs só
// contagens (sem segredos) e responde ao Health Check público /healthz.

let server;
let client;
let uri;

before(async () => {
  server = await MongoMemoryServer.create();
  uri = server.getUri(); // sem /<banco>, como uma URI copiada do Atlas
  client = await MongoClient.connect(uri);
});
after(async () => {
  await client.close();
  await server.stop();
});

async function seedTestDb() {
  const db = client.db('test');
  await db.dropDatabase();
  const exams = [];
  for (let i = 0; i < 6; i += 1) exams.push({ name: `Prova ${i}`, group: i ? 'DAFP' : 'TCEL', slug: i ? `p${i}` : 'tcel', questionCount: 2, pointsPerQuestion: 1, durationMinutes: 30, active: true, imageUrl: i === 1 ? '/uploads/antigo.png' : null });
  const { insertedIds } = await db.collection('exams').insertMany(exams);
  const questions = [];
  for (let i = 0; i < 150; i += 1) questions.push({ examId: insertedIds[i % 6], text: `q${i}`, options: [], correctKey: 'A', active: true });
  await db.collection('questions').insertMany(questions);
  const rooms = [];
  for (let i = 0; i < 24; i += 1) rooms.push({ examId: insertedIds[0], roomLabel: `S${i}`, studentName: 'A', studentTokenHash: `h${i}`, proctorTokens: [], status: 'finished' });
  const r = await db.collection('rooms').insertMany(rooms);
  const attempts = [];
  for (let i = 0; i < 46; i += 1) attempts.push({ roomId: r.insertedIds[i % 24], examId: insertedIds[0], studentName: 'A', status: 'finished', finishedAt: new Date(), snapshot: [] });
  await db.collection('examattempts').insertMany(attempts);
  await db.collection('users').insertMany([{ username: 'dono', passwordHash: 'x', role: 'primary' }, { username: 'outro', passwordHash: 'y', role: 'restricted' }]);
  await db.collection('settings').insertOne({ singleton: 'main', platformName: 'x', logoUrl: '/uploads/logo.png', theme: {} });
  await db.collection('messagetemplates').insertOne({ key: 'room_created', message: { embeds: [{ image: { url: 'https://servico-antigo.onrender.com/x.png' } }] } });
  await db.collection('integrationnotifications').insertMany([{ kind: 'result', key: 'k1', status: 'pending' }, { kind: 'result', key: 'k2', status: 'ambiguous' }]);
}

async function snapshot() {
  const db = client.db('test');
  const out = {};
  for (const c of await db.listCollections().toArray()) {
    if (c.name === 'sessions') continue;
    out[c.name] = await db.collection(c.name).find({}).sort({ _id: 1 }).toArray();
  }
  return out;
}

function startSite(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { PATH: process.env.PATH, ...env } });
    let out = '';
    const onData = (d) => {
      out += d.toString();
      const m = out.match(/rodando na porta (\d+)/);
      if (m && /\[inicio\] banco/.test(out)) resolve({ child, port: m[1], log: () => out });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`site saiu (${code}): ${out}`)));
    setTimeout(() => reject(new Error(`timeout: ${out}`)), 30000);
  });
}

test('serviço novo: MONGODB_DB_NAME=test abre o banco existente, não altera dados, logs sem segredos, /healthz público', async () => {
  await seedTestDb();
  const before = await snapshot();
  const port = String(30000 + Math.floor(Math.random() * 20000));
  const site = await startSite({ MONGODB_URI: uri, MONGODB_DB_NAME: 'test', SESSION_SECRET: 'segredo-de-sessao-de-teste-123', PORT: port, NODE_ENV: 'production', COOKIE_SECURE: 'true', RENDER_EXTERNAL_URL: 'https://provasdafp.onrender.com' });
  try {
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    // Painel continua pedindo login (não oferece "Criar administrador").
    const setup = await (await fetch(`http://127.0.0.1:${port}/api/admin/setup-status`)).json();
    assert.equal(setup.needsSetup, false);
    await new Promise((r) => setTimeout(r, 300));
    const log = site.log();
    assert.match(log, /banco em uso: "test" \(MONGODB_DB_NAME\)/);
    assert.match(log, /provas: 6, questões: 150, tentativas: 46, salas: 24, acessos admin: 2/);
    assert.match(log, /fila de avisos do BotGhost em aberto — (pending: 1, ambiguous: 1|ambiguous: 1, pending: 1)/);
    assert.match(log, /1 registro\(s\) em settings\.logoUrl apontam para \/uploads\//);
    assert.match(log, /1 registro\(s\) em exams\.imageUrl/);
    assert.match(log, /1 registro\(s\) em messagetemplates citam um endereço \*\.onrender\.com diferente/);
    assert.match(log, /integração desligada/);
    for (const secret of [uri, 'segredo-de-sessao-de-teste-123', 'servico-antigo', 'logo.png']) assert.ok(!log.includes(secret), `log sem ${secret}`);
  } finally {
    site.child.kill('SIGTERM');
    await new Promise((r) => site.child.on('exit', r));
  }
  // Nada existente foi apagado ou sobrescrito (só migrações aditivas).
  const after = await snapshot();
  for (const name of ['exams', 'questions', 'rooms', 'examattempts', 'messagetemplates', 'integrationnotifications']) {
    assert.deepEqual(after[name], before[name], `${name} intacta`);
  }
  assert.equal(after.users.length, 2);
  assert.deepEqual(after.users.map((u) => [u.username, u.passwordHash, u.role]), before.users.map((u) => [u.username, u.passwordHash, u.role]));
  assert.equal(after.settings.length, 1);
  assert.equal(after.settings[0].logoUrl, '/uploads/logo.png');
});

test('sem MONGODB_DB_NAME e URI sem banco: o driver também usa "test"; banco vazio gera alerta nos Logs', async () => {
  await client.db('test').dropDatabase();
  const port = String(30000 + Math.floor(Math.random() * 20000));
  const site = await startSite({ MONGODB_URI: uri, SESSION_SECRET: 's', PORT: port });
  try {
    await new Promise((r) => setTimeout(r, 300));
    const log = site.log();
    assert.match(log, /banco em uso: "test"/);
    assert.match(log, /BANCO VAZIO/);
  } finally {
    site.child.kill('SIGTERM');
    await new Promise((r) => site.child.on('exit', r));
  }
});
