const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

// Fiscal escolhido no formulário do Discord (diferente do operador que
// clicou e do aluno) e campos separados de aluno/fiscal/notas em /results.

let db;
let M;
const envRef = { current: null };
let api;

const STUDENT = '700000000000000101';
const SUPERVISOR = '700000000000000202';
const SUPERVISOR2 = '700000000000000303';
const AVATAR = `https://cdn.discordapp.com/avatars/${STUDENT}/0123456789abcdef0123456789abcdef.png?size=256`;

before(async () => {
  db = await H.setupDb();
  M = {
    Room: require('../models/Room'),
    ExamAttempt: require('../models/ExamAttempt'),
    results: require('../lib/results'),
  };
});
after(async () => { await db.teardown(); });

beforeEach(async () => {
  await db.reset();
  envRef.current = H.testEnv();
  await H.saveDefaultConfig();
  await H.seedExam();
  api = await H.startApi(envRef);
});
afterEach(async () => { await api.close(); });

function roomBody(extra = {}) {
  return {
    ...H.actorFields(), student: STUDENT, studentDisplayName: 'Recruta Silva', supervisorDiscordId: SUPERVISOR, supervisorDisplayName: 'Cabo Souza', idempotencyKey: 'interacao-s1', ...extra,
  };
}

test('sala com fiscal escolhido: três papéis separados, link de fiscal é do fiscal, vínculo gravado', async () => {
  const r = await api.call('POST', '/rooms', roomBody({ supervisorDiscordId: `<@${SUPERVISOR}>`, studentAvatarUrl: AVATAR }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const d = r.body.data;
  assert.equal(d.studentDiscordId, STUDENT);
  assert.equal(d.supervisorDiscordId, SUPERVISOR);
  assert.equal(d.supervisorMention, `<@${SUPERVISOR}>`);
  assert.equal(d.supervisorDisplayName, 'Cabo Souza');
  assert.equal(d.supervisorSelected, 'true');
  assert.equal(d.studentAvatarSaved, 'true');
  assert.match(d.supervisorUrl, /\/professor\//);
  const embedText = JSON.stringify(d.native);
  assert.ok(embedText.includes(`<@${SUPERVISOR}>`) && embedText.includes('Cabo Souza'), 'mensagem privada mostra o fiscal');

  const room = await M.Room.findById(d.roomId).lean();
  assert.deepEqual(room.supervisor, { discordUserId: SUPERVISOR, displayName: 'Cabo Souza' });
  assert.deepEqual(room.discordOperator, { id: H.OPERATOR, name: 'Operador Teste' });
  assert.equal(room.discordUserId, STUDENT);
  assert.equal(room.studentAvatarUrl, AVATAR);
  assert.equal(room.proctorTokens.length, 1);
  assert.equal(room.proctorTokens[0].discordUserId, SUPERVISOR, 'link de fiscal é do fiscal, não do operador');
  assert.equal(room.proctorTokens[0].label, 'Cabo Souza');

  // Repetição (mesma interação) não reexibe links e não cria outra sala.
  const again = await api.call('POST', '/rooms', roomBody({ supervisorDiscordId: `<@${SUPERVISOR}>`, studentAvatarUrl: AVATAR }));
  assert.equal(again.body.data.linksAvailable, 'false');
  assert.equal(again.body.data.supervisorDiscordId, SUPERVISOR);
  assert.equal(await M.Room.countDocuments(), 1);

  // A tentativa copia o fiscal e a foto da sala e mantém depois de encerrada.
  const at = await H.takeExam(d.roomId, 4);
  const saved = await M.ExamAttempt.findById(at._id).lean();
  assert.equal(saved.supervisorDiscordId, SUPERVISOR);
  assert.equal(saved.supervisorDisplayName, 'Cabo Souza');
  assert.equal(saved.studentAvatarUrl, AVATAR);
  await M.Room.deleteOne({ _id: d.roomId });
  assert.equal((await M.ExamAttempt.findById(at._id).lean()).supervisorDiscordId, SUPERVISOR);
});

test('validação do fiscal e da foto; mesma chave com outro fiscal é conflito', async () => {
  let r = await api.call('POST', '/rooms', roomBody({ supervisorDiscordId: STUDENT }));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'supervisor_is_student');
  r = await api.call('POST', '/rooms', roomBody({ supervisorDiscordId: 700000000000000202 }));
  assert.equal(r.status, 400);
  r = await api.call('POST', '/rooms', roomBody({ supervisorDiscordId: 'fulano' }));
  assert.equal(r.body.code, 'invalid_user');
  r = await api.call('POST', '/rooms/prepare', { ...H.actorFields(), student: STUDENT, supervisorDiscordId: STUDENT });
  assert.equal(r.body.code, 'supervisor_is_student');
  assert.equal(await M.Room.countDocuments(), 0);

  // Foto de outra pessoa / fora do CDN do Discord / variável não
  // substituída: sala criada, foto não guardada. Nome não substituído →
  // nome padrão.
  r = await api.call('POST', '/rooms', roomBody({
    studentAvatarUrl: `https://cdn.discordapp.com/avatars/${SUPERVISOR}/0123456789abcdef0123456789abcdef.png`,
    supervisorDisplayName: '{user_displayName[{form.fiscal}]}',
  }));
  assert.equal(r.status, 201);
  assert.equal(r.body.data.studentAvatarSaved, 'false');
  assert.equal(r.body.data.supervisorDisplayName, 'Fiscal 0202');
  assert.equal((await M.Room.findById(r.body.data.roomId).lean()).studentAvatarUrl, null);

  const conflict = await api.call('POST', '/rooms', roomBody({ supervisorDiscordId: SUPERVISOR2, supervisorDisplayName: '{user_displayName[{form.fiscal}]}' }));
  assert.equal(conflict.body.code, 'idempotency_conflict');
});

test('regenerar links por outro operador mantém o fiscal escolhido', async () => {
  const r = await api.call('POST', '/rooms', roomBody());
  const { roomId } = r.body.data;
  await M.Room.updateOne({ _id: roomId }, { $set: { 'proctorTokens.0.createdAt': new Date(Date.now() - 60000) } });
  const regen = await api.call('POST', `/rooms/${roomId}/regenerate-links`, { ...H.actorFields(H.OTHER_OPERATOR), idempotencyKey: 'interacao-s2' });
  assert.equal(regen.body.code, 'links_regenerated', JSON.stringify(regen.body));
  assert.equal(regen.body.data.supervisorDiscordId, SUPERVISOR);
  assert.ok(JSON.stringify(regen.body.data.native).includes(`<@${SUPERVISOR}>`));
  const room = await M.Room.findById(roomId).lean();
  assert.deepEqual(room.supervisor, { discordUserId: SUPERVISOR, displayName: 'Cabo Souza' });
  const active = room.proctorTokens.filter((t) => !t.revokedAt);
  assert.equal(active.length, 1);
  assert.equal(active[0].discordUserId, SUPERVISOR);
  assert.equal(active[0].label, 'Cabo Souza');
  assert.ok(!room.proctorTokens.some((t) => t.discordUserId === H.OTHER_OPERATOR), 'quem clicou não vira fiscal');
});

// Resultado gravado antes desta atualização: sem fiscal do Discord, com o
// nome do fiscal que se conectou.
async function legacyAttempt(finishedAt) {
  const Exam = require('../models/Exam');
  const exam = await Exam.findOne().lean();
  await M.ExamAttempt.collection.insertOne({
    examId: exam._id, roomId: exam._id, studentName: 'Aluno Antigo', status: 'finished', score: 60, proctorNames: ['Sgt Antigo'],
    pointsPerQuestion: 20, snapshot: [{}, {}, {}, {}, {}], finishedAt, createdAt: finishedAt, updatedAt: finishedAt,
  });
}

test('/results com pageSize=1: campos separados acompanham a prova de cada página', async () => {
  // 1ª prova do aluno: fiscal Cabo Souza, com foto, oral lançada.
  const r1 = await api.call('POST', '/rooms', roomBody({ studentAvatarUrl: AVATAR }));
  const a1 = await H.takeExam(r1.body.data.roomId, 4);
  await M.ExamAttempt.updateOne({ _id: a1._id }, { $set: { finishedAt: new Date('2026-09-20T12:00:00Z') }, $addToSet: { proctorNames: { $each: ['Cabo Souza', 'Sgt Extra'] } } });
  await M.results.setOralScore({ attemptId: String(a1._id), oralScore: 12.5, actor: 'admin:t' });
  // 2ª prova do MESMO aluno, outra sala, outro fiscal, oral pendente, sem foto.
  const r2 = await api.call('POST', '/rooms', roomBody({ supervisorDiscordId: SUPERVISOR2, supervisorDisplayName: 'Soldado Lima', idempotencyKey: 'interacao-s3' }));
  assert.equal(r2.status, 201, JSON.stringify(r2.body));
  const a2 = await H.takeExam(r2.body.data.roomId, 3);
  await M.ExamAttempt.updateOne({ _id: a2._id }, { $set: { finishedAt: new Date('2026-09-21T12:00:00Z') } });
  await legacyAttempt(new Date('2026-09-19T12:00:00Z'));

  const page = (n) => api.call('GET', '/results', { ...H.actorFields(), pageSize: '1', page: String(n) });

  let d = (await page(0)).body.data;
  assert.equal(d.resultSingle, 'true');
  assert.equal(d.resultAttemptId, String(a2._id));
  assert.equal(d.resultStudentDiscordId, STUDENT);
  assert.equal(d.resultStudentMention, `<@${STUDENT}>`);
  assert.equal(d.resultStudentDisplayName, 'Recruta Silva');
  assert.equal(d.resultStudentAvatarUrl, '');
  assert.equal(d.resultSupervisorDiscordId, SUPERVISOR2);
  assert.equal(d.resultSupervisorMention, `<@${SUPERVISOR2}>`);
  assert.equal(d.resultSupervisorDisplayName, 'Soldado Lima');
  assert.equal(d.resultExamScore, '60');
  assert.equal(d.resultOralScore, 'Pendente');
  assert.equal(d.resultOralPending, 'true');
  assert.equal(d.resultTotalScore, 'Pendente');
  assert.equal(d.resultScoreText, 'Prova: 60 | Prova oral: Pendente | Total: Pendente');
  assert.ok(d.displayText.includes('Página 1/3'), 'displayText continua igual');
  assert.ok(!JSON.stringify(d).includes('/professor/') && !JSON.stringify(d).includes('/aluno/'), 'sem links/tokens nos resultados');

  d = (await page(1)).body.data;
  assert.equal(d.resultAttemptId, String(a1._id));
  assert.equal(d.resultSupervisorDiscordId, SUPERVISOR);
  assert.equal(d.resultSupervisorDisplayName, 'Cabo Souza');
  assert.equal(d.resultStudentAvatarUrl, AVATAR);
  assert.equal(d.resultExamScore, '80');
  assert.equal(d.resultOralScore, '12,5');
  assert.equal(d.resultTotalScore, '92,5');
  assert.equal(d.resultScoreText, 'Prova: 80 | Prova oral: 12,5 | Total: 92,5');
  assert.equal(d.resultSupervisorsText, `⭐ <@${SUPERVISOR}> — Cabo Souza (principal, escolhido no Discord)\n• Sgt Extra`);

  d = (await page(2)).body.data;
  assert.equal(d.resultStudentDiscordId, '');
  assert.equal(d.resultStudentMention, '');
  assert.equal(d.resultSupervisorDiscordId, '', 'resultado antigo: sem ID de fiscal por palpite');
  assert.equal(d.resultSupervisorMention, '');
  assert.equal(d.resultSupervisorDisplayName, 'Sgt Antigo', 'nome antigo preservado');
  assert.equal(d.resultSupervisorsText, '• Sgt Antigo');
  assert.equal(d.resultScoreText, 'Prova: 60 | Prova oral: Pendente | Total: Pendente');

  // Página com várias provas: campos avulsos vazios (cada item tem os seus).
  d = (await api.call('GET', '/results', { ...H.actorFields(), pageSize: '10' })).body.data;
  assert.equal(d.resultSingle, 'false');
  assert.equal(d.resultSupervisorDiscordId, '');
  assert.equal(d.resultScoreText, '');
  assert.equal(d.items[1].supervisorDiscordId, SUPERVISOR);
  assert.equal(d.items[1].scoreText, 'Prova: 80 | Prova oral: 12,5 | Total: 92,5');
  assert.equal(d.items[0].oralPending, 'true');
  assert.equal(d.items[1].oralScore, 12.5, 'campo antigo continua numérico');
});
