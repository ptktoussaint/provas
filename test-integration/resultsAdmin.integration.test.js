const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

// Gestão de resultados pelo admin: resultados antigos (sem `revision` no
// banco), pontos da prova oral somados e arquivamento (some do bot).

let db;
let M;
const envRef = { current: null };
let api;

before(async () => {
  db = await H.setupDb();
  M = {
    ExamAttempt: require('../models/ExamAttempt'),
    Notification: require('../models/IntegrationNotification'),
    results: require('../lib/results'),
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

let seq = 0;
async function finished(student, correct = 4) {
  if (!(await require('../models/Exam').countDocuments())) await H.seedExam();
  seq += 1;
  const r = await api.call('POST', '/rooms', { ...H.actorFields(), student, studentDisplayName: 'Recruta', idempotencyKey: `interacao-r${seq}` });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return H.takeExam(r.body.data.roomId, correct);
}

// Como os resultados que já estavam no site antes da atualização: sem os
// campos novos no banco (revision, oralScore, archivedAt, discord...).
async function legacyAttempt() {
  const exam = await H.seedExam({ name: 'Prova Antiga' });
  const { insertedId } = await M.ExamAttempt.collection.insertOne({
    examId: exam._id, roomId: exam._id, studentName: 'Aluno Antigo', status: 'finished', score: 60,
    pointsPerQuestion: 20, snapshot: [{}, {}, {}, {}, {}], finishedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
  });
  return String(insertedId);
}

test('resultado antigo (sem "revision" no banco): vincular Discord, lançar prova oral e arquivar funcionam', async () => {
  const id = await legacyAttempt();
  await M.results.linkDiscordUser({ attemptId: id, discordUserId: '700000000000000001', guildId: H.GUILD, reason: 'vínculo manual', actor: 'admin:t' });
  let doc = await M.ExamAttempt.findById(id).lean();
  assert.equal(doc.discordUserId, '700000000000000001');
  assert.equal(doc.revision, 1);
  await M.results.setOralScore({ attemptId: id, oralScore: 20, actor: 'admin:t' });
  doc = await M.ExamAttempt.findById(id).lean();
  assert.equal(M.results.effectiveScore(doc), 80);
  assert.equal(doc.maxScore, undefined, 'prova oral não mexe na pontuação máxima da prova');
  assert.equal((await M.results.listForAdmin({}))[0].maxScoreComputed, 100);
  await M.results.setArchived({ attemptId: id, archived: true, actor: 'admin:t' });
  assert.ok((await M.ExamAttempt.findById(id).lean()).archivedAt);
});

test('prova oral: somada à nota, sem teto de 100, não negativa; vazio remove', async () => {
  const at = await finished('700000000000000001', 5); // 100 pontos
  const id = String(at._id);
  const out = await M.results.setOralScore({ attemptId: id, oralScore: 25.5, actor: 'admin:t' });
  assert.equal(M.results.effectiveScore(out.attempt), 125.5, 'a soma pode passar de 100');
  await assert.rejects(() => M.results.setOralScore({ attemptId: id, oralScore: -1, actor: 'admin:t' }), /negativos/);
  await assert.rejects(() => M.results.setOralScore({ attemptId: id, oralScore: 1.234, actor: 'admin:t' }), /duas casas/);
  await assert.rejects(() => M.results.setOralScore({ attemptId: id, oralScore: 25.5, actor: 'admin:t' }), /iguais/);
  const removed = await M.results.setOralScore({ attemptId: id, oralScore: '', actor: 'admin:t' });
  assert.equal(removed.attempt.oralScore, null);
  assert.equal(M.results.effectiveScore(removed.attempt), 100);
  const doc = await M.ExamAttempt.findById(id).lean();
  assert.deepEqual(doc.auditTrail.map((e) => e.type), ['oral_score_set', 'oral_score_removed']);
  const listed = await M.results.listForAdmin({});
  assert.equal(listed[0].effectiveScore, 100);
});

test('prova oral lançada antes do primeiro aviso sair: a primeira mensagem já mostra a soma', async () => {
  const at = await finished('700000000000000001', 4);
  await M.results.setOralScore({ attemptId: String(at._id), oralScore: 12, actor: 'admin:t' });
  const n = await M.Notification.findOne({ attemptId: at._id });
  const c = await api.call('POST', `/notifications/${n._id}/claim`, {});
  assert.equal(c.body.data.action, 'send');
  assert.equal(c.body.data.message.content, 'Prova finalizada: <@700000000000000001> — Prova (80) + Prova Oral (12) = 92 — Prova: Prova TCEL');
});

test('arquivado some da consulta do bot e da promoção; continua no admin; desarquivar devolve', async () => {
  const a = await finished('700000000000000001', 4);
  const b = await finished('700000000000000002', 3);
  await M.results.setArchived({ attemptId: String(a._id), archived: true, actor: 'admin:t' });

  const res = await api.call('GET', '/results', H.actorFields());
  assert.equal(res.body.data.total, '1');
  assert.equal(res.body.data.items[0].attemptId, String(b._id));
  const one = await api.call('GET', '/results', { ...H.actorFields(), student: '700000000000000001' });
  assert.equal(one.body.code, 'results_empty');
  const cands = await api.call('GET', '/promotion-candidates', H.actorFields());
  assert.equal(cands.body.data.total, '1');

  assert.equal((await M.results.listForAdmin({})).length, 1, 'escondido por padrão no admin');
  assert.equal((await M.results.listForAdmin({ archived: 'show' })).length, 2);
  assert.equal((await M.results.listForAdmin({ archived: 'only' }))[0]._id.toString(), String(a._id));
  await assert.rejects(() => M.results.setArchived({ attemptId: String(a._id), archived: true, actor: 'admin:t' }), /já está arquivado/);

  await M.results.setArchived({ attemptId: String(a._id), archived: false, actor: 'admin:t' });
  assert.equal((await api.call('GET', '/results', H.actorFields())).body.data.total, '2');
});

test('arquivado depois de selecionado para promoção: a revisão bloqueia', async () => {
  const a = await finished('700000000000000001', 4);
  const d = (await api.call('POST', '/promotion-drafts', H.actorFields())).body.data;
  await api.call('POST', `/promotion-drafts/${d.draftId}/selection`, { ...H.actorFields(), page: 0, attemptIds: String(a._id) });
  await api.call('POST', `/promotion-drafts/${d.draftId}/members`, { ...H.actorFields(), member: '700000000000000001', nomeRP: 'Silva', idRP: '1' });
  await M.results.setArchived({ attemptId: String(a._id), archived: true, actor: 'admin:t' });
  const rev = await api.call('POST', `/promotion-drafts/${d.draftId}/review`, H.actorFields());
  assert.equal(rev.body.data.canConfirm, 'false');
  assert.match(rev.body.data.displayText, /arquivado/);
});
