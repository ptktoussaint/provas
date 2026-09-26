const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

// Fluxo DAFP (/provas-dafp) ao lado do TCEL (/provas-tcel): prova fixa
// "tcel", isolamento entre os grupos, aprovação automática com cargo,
// finalização idempotente e migração dos dados antigos.

let db;
let M;
const envRef = { current: null };
let api;

const STUDENT = '700000000000000101';
const EVALUATOR = '700000000000000202';
const DAFP_CHANNEL = '600000000000000009';
const ROLE_OK = '800000000000000001';
const ROLE_FAIL = '800000000000000002';

before(async () => {
  db = await H.setupDb();
  M = {
    Exam: require('../models/Exam'),
    Room: require('../models/Room'),
    ExamAttempt: require('../models/ExamAttempt'),
    ExamEvent: require('../models/ExamEvent'),
    Notification: require('../models/IntegrationNotification'),
    lifecycle: require('../lib/examLifecycle'),
    groups: require('../lib/examGroups'),
  };
});
after(async () => { await db.teardown(); });

beforeEach(async () => {
  await db.reset();
  envRef.current = H.testEnv();
  await H.saveDefaultConfig({
    operatorIds: { generate: H.OPERATOR, results: H.OPERATOR, promote: H.OPERATOR, dafp: H.OPERATOR },
    dafp: { resultChannelId: DAFP_CHANNEL },
  });
  api = await H.startApi(envRef);
});
afterEach(async () => { await api.close(); });

async function tcelExam() {
  const e = await H.seedExam({ name: 'Prova Tcel' });
  await M.Exam.updateOne({ _id: e._id }, { $set: { slug: 'tcel', group: 'TCEL' } });
  return e;
}

// 10 questões × 1 ponto: nota = acertos.
async function dafpExam(name, slug, { auto = true, passing = 7 } = {}) {
  const e = await H.seedExam({ name, questions: 10, points: 1 });
  await M.Exam.updateOne({ _id: e._id }, {
    $set: { slug, group: 'DAFP', autoApproval: auto, passingScore: auto ? passing : null, approvedRoleId: auto ? ROLE_OK : null, failedRoleId: auto ? ROLE_FAIL : null },
  });
  return M.Exam.findById(e._id).lean();
}

let seq = 0;
function dafpBody(examSlug, extra = {}) {
  seq += 1;
  return {
    ...H.actorFields(), student: STUDENT, studentDisplayName: 'Recruta Lima', supervisorDiscordId: EVALUATOR, supervisorDisplayName: 'Cap Souza', examSlug, idempotencyKey: `dafp-${seq}`, ...extra,
  };
}

async function dafpRun(examSlug, correct) {
  const r = await api.call('POST', '/dafp/rooms', dafpBody(examSlug));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const at = await H.takeExam(r.body.data.roomId, correct);
  return { room: r.body.data, attempt: at };
}

test('TCEL continua sempre na prova "tcel", mesmo com provas DAFP e com examId de prova DAFP', async () => {
  const tcel = await tcelExam();
  const asp = await dafpExam('Aspirante', 'aspirante');
  await dafpExam('Capitão', 'capitao');

  const list = await api.call('GET', '/exams', H.actorFields());
  assert.equal(list.body.data.examCount, '1');
  assert.equal(list.body.data.defaultExamId, String(tcel._id));
  assert.equal(list.body.data.choiceRequired, 'false');
  assert.equal(list.body.data.opt2Hide, 'true');

  const prep = await api.call('POST', '/rooms/prepare', { ...H.actorFields(), student: STUDENT });
  assert.equal(prep.body.data.examChoiceRequired, 'false');
  assert.equal(prep.body.data.examId, String(tcel._id));

  // Fluxo antigo, sem examId (como o /provas-tcel já configurado).
  const r1 = await api.call('POST', '/rooms', { ...H.actorFields(), student: STUDENT, idempotencyKey: 'tcel-1' });
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  assert.equal(r1.body.data.examId, String(tcel._id));
  assert.equal((await M.Room.findById(r1.body.data.roomId).lean()).examGroup, 'TCEL');

  // Tentativa de abrir DAFP pelo fluxo TCEL: continua abrindo a TCEL.
  const r2 = await api.call('POST', '/rooms', { ...H.actorFields(), student: '700000000000000303', examId: String(asp._id), idempotencyKey: 'tcel-2' });
  assert.equal(r2.status, 201, JSON.stringify(r2.body));
  assert.equal(r2.body.data.examId, String(tcel._id));
  assert.equal(r2.body.data.examName, 'Prova Tcel');

  // Links, finalização e resultado TCEL como antes.
  assert.match(r1.body.data.studentUrl, /\/aluno\//);
  assert.match(r1.body.data.supervisorUrl, /\/professor\//);
  const at = await H.takeExam(r1.body.data.roomId, 4);
  assert.equal(at.status, 'finished');
  assert.equal(at.score, 80);
  assert.equal(at.examGroup, 'TCEL');
  assert.equal(at.outcome.resultStatus, 'NAO_APLICAVEL');
  const res = await api.call('GET', '/results', H.actorFields());
  assert.equal(res.body.data.total, '1');

  // Prova "tcel" desativada: o fluxo TCEL recusa em vez de abrir outra.
  await M.Exam.updateOne({ _id: tcel._id }, { $set: { active: false } });
  const r3 = await api.call('POST', '/rooms', { ...H.actorFields(), student: '700000000000000404', idempotencyKey: 'tcel-3' });
  assert.equal(r3.status, 409);
  assert.equal(r3.body.code, 'exam_not_eligible');
});

test('listagem e consulta DAFP: só provas DAFP aptas; TCEL nunca aparece e é recusada', async () => {
  await tcelExam();
  const asp = await dafpExam('Aspirante', 'aspirante');
  await dafpExam('Major', 'major');
  const inactive = await dafpExam('Capitão', 'capitao');
  await M.Exam.updateOne({ _id: inactive._id }, { $set: { active: false } });

  const list = await api.call('GET', '/dafp/exams', H.actorFields());
  assert.equal(list.status, 200);
  assert.equal(list.body.data.examCount, '2');
  const slugs = list.body.data.exams.map((e) => e.examSlug).sort();
  assert.deepEqual(slugs, ['aspirante', 'major']);
  assert.ok(!JSON.stringify(list.body.data).includes('tcel'));
  assert.ok(['aspirante', 'major'].includes(list.body.data.opt1Value));
  assert.equal(list.body.data.opt3Hide, 'true');
  const aspView = list.body.data.exams.find((e) => e.examSlug === 'aspirante');
  assert.equal(aspView.examId, String(asp._id));
  assert.equal(aspView.autoApproval, 'true');
  assert.equal(aspView.passingScore, '7');
  assert.equal(aspView.examMaxScore, '10');
  assert.equal(aspView.resultChannelId, DAFP_CHANNEL);

  const one = await api.call('GET', '/dafp/exams/aspirante', H.actorFields());
  assert.equal(one.body.data.examId, String(asp._id));
  assert.equal(one.body.data.eligible, 'true');
  assert.equal((await api.call('GET', `/dafp/exams/${asp._id}`, H.actorFields())).body.data.examSlug, 'aspirante');
  assert.equal((await api.call('GET', '/dafp/exams/capitao', H.actorFields())).body.data.eligible, 'false');
  const t = await api.call('GET', '/dafp/exams/tcel', H.actorFields());
  assert.equal(t.status, 409);
  assert.equal(t.body.code, 'exam_not_dafp');

  // Iniciar a TCEL pelo endpoint DAFP: recusado, nenhuma sala criada.
  const bad = await api.call('POST', '/dafp/rooms', dafpBody('tcel'));
  assert.equal(bad.status, 409);
  assert.equal(bad.body.code, 'exam_not_dafp');
  const inact = await api.call('POST', '/dafp/rooms', dafpBody('capitao'));
  assert.equal(inact.body.code, 'exam_inactive');
  const none = await api.call('POST', '/dafp/rooms', dafpBody('general'));
  assert.equal(none.status, 404);
  const noEval = await api.call('POST', '/dafp/rooms', dafpBody('aspirante', { supervisorDiscordId: '' }));
  assert.equal(noEval.body.code, 'supervisor_required');
  const noExam = await api.call('POST', '/dafp/rooms', dafpBody(''));
  assert.equal(noExam.body.code, 'exam_required');
  assert.equal(await M.Room.countDocuments(), 0);
});

test('DAFP aprovado: sessão, links, finalização, aprovação e cargo; consulta e aviso com o cargo', async () => {
  const asp = await dafpExam('Aspirante', 'aspirante');
  const created = await api.call('POST', '/dafp/rooms', dafpBody('aspirante', { studentAvatarUrl: `https://cdn.discordapp.com/avatars/${STUDENT}/0123456789abcdef0123456789abcdef.png` }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const d = created.body.data;
  assert.equal(d.sessionId, d.roomId);
  assert.equal(d.sessionStatus, 'CRIADA');
  assert.equal(d.examGroup, 'DAFP');
  assert.equal(d.examSlug, 'aspirante');
  assert.equal(d.examId, String(asp._id));
  assert.equal(d.studentDiscordId, STUDENT);
  assert.equal(d.supervisorDiscordId, EVALUATOR);
  assert.equal(d.autoApproval, 'true');
  assert.equal(d.passingScore, '7');
  assert.equal(d.approvedRoleId, ROLE_OK);
  assert.equal(d.failedRoleId, '', 'cargo de reprovado é legado');
  assert.equal(d.resultChannelId, DAFP_CHANNEL);
  assert.ok(d.studentAvatarUrl.startsWith('https://cdn.discordapp.com/'));
  assert.match(d.studentUrl, /\/aluno\//);
  assert.match(d.supervisorUrl, /\/professor\//);
  const room = await M.Room.findById(d.roomId).lean();
  assert.equal(room.examGroup, 'DAFP');
  assert.equal(room.proctorTokens[0].discordUserId, EVALUATOR);

  let s = await api.call('GET', `/dafp/sessions/${d.sessionId}`, H.actorFields());
  assert.equal(s.body.data.sessionStatus, 'CRIADA');
  assert.equal(s.body.data.resultStatus, '');

  const lifecycle = M.lifecycle;
  const { attempt } = await lifecycle.startOrResumeAttempt(d.roomId);
  assert.equal(attempt.examGroup, 'DAFP');
  s = await api.call('GET', `/dafp/sessions/${d.sessionId}`, H.actorFields());
  assert.equal(s.body.data.sessionStatus, 'EM_ANDAMENTO');

  const at = await H.takeExam(d.roomId, 8);
  assert.equal(at.outcome.resultStatus, 'APROVADO');
  assert.equal(at.outcome.resultRoleId, ROLE_OK);

  s = await api.call('GET', `/dafp/sessions/${d.sessionId}`, H.actorFields());
  const r = s.body.data;
  assert.equal(r.sessionStatus, 'FINALIZADA');
  assert.equal(r.attemptId, String(at._id));
  assert.equal(r.examName, 'Aspirante');
  assert.equal(r.studentMention, `<@${STUDENT}>`);
  assert.equal(r.supervisorMention, `<@${EVALUATOR}>`);
  assert.equal(r.score, '8');
  assert.equal(r.maxScore, '10');
  assert.equal(r.scoreText, '8/10');
  assert.equal(r.autoApproval, 'true');
  assert.equal(r.passingScore, '7');
  assert.equal(r.resultStatus, 'APROVADO');
  assert.equal(r.passed, 'true');
  assert.equal(r.resultRoleId, ROLE_OK);
  assert.equal(r.approvedRoleId, ROLE_OK);
  assert.equal(r.failedRoleId, '', 'cargo de reprovado é legado');
  assert.equal(r.resultChannelId, DAFP_CHANNEL);
  assert.ok(r.finishedAt);
  assert.equal(r.resultPublished, 'false');
  assert.ok(!JSON.stringify(r).includes('/aluno/') && !JSON.stringify(r).includes('/professor/'), 'sem links no resultado');

  // Aviso (webhook → claim): canal DAFP, modelo DAFP, cargo a aplicar.
  const n = await M.Notification.findOne({ attemptId: at._id });
  const c = await api.call('POST', `/notifications/${n._id}/claim`, {});
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const cd = c.body.data;
  assert.equal(cd.action, 'send');
  assert.equal(cd.templateKey, 'dafp_result');
  assert.equal(cd.channelId, DAFP_CHANNEL);
  assert.equal(cd.applyRole, 'true');
  assert.equal(cd.roleId, ROLE_OK);
  assert.equal(cd.memberDiscordId, STUDENT);
  assert.equal(cd.resultStatus, 'APROVADO');
  assert.equal(cd.scoreText, '8/10');
  const embed = cd.message.embeds[0];
  assert.equal(embed.title, 'RESULTADO DA PROVA');
  const f = Object.fromEntries(embed.fields.map((x) => [x.name, x.value]));
  assert.equal(f.Aluno, `<@${STUDENT}>`);
  assert.equal(f.Avaliador, `<@${EVALUATOR}>`);
  assert.equal(f.Prova, 'Aspirante');
  assert.equal(f.Nota, '8/10');
  assert.equal(f.Resultado, 'APROVADO');
  const ack = await api.call('POST', `/notifications/${n._id}/ack`, { leaseToken: cd.leaseToken, outcome: 'delivered', messageId: '910000000000000001', channelId: DAFP_CHANNEL });
  assert.equal(ack.body.code, 'acked');
  assert.equal((await api.call('GET', `/dafp/sessions/${d.sessionId}`, H.actorFields())).body.data.resultPublished, 'true');

  // Edição posterior (ex.: prova oral no admin) edita a mensagem e NÃO
  // reaplica cargo; a aprovação gravada não muda.
  await require('../lib/results').setOralScore({ attemptId: String(at._id), oralScore: 1, actor: 'admin:t' });
  await M.Notification.updateOne({ _id: n._id }, { $set: { status: 'pending' } });
  const edit = await api.call('POST', `/notifications/${n._id}/claim`, {});
  assert.equal(edit.body.data.action, 'edit');
  assert.equal(edit.body.data.applyRole, 'false');
  assert.equal(edit.body.data.roleId, '');
  assert.equal(edit.body.data.resultStatus, 'APROVADO');
});

test('DAFP reprovado, nota igual à mínima = aprovado, e sem aprovação automática', async () => {
  await dafpExam('Segundo Tenente', 'segundo-tenente');
  await dafpExam('Primeiro Tenente', 'primeiro-tenente', { auto: false });

  const fail = await dafpRun('segundo-tenente', 6);
  assert.equal(fail.attempt.outcome.resultStatus, 'REPROVADO');
  assert.equal(fail.attempt.outcome.resultRoleId, null, 'reprovado não recebe cargo');
  let s = (await api.call('GET', `/dafp/sessions/${fail.room.sessionId}`, H.actorFields())).body.data;
  assert.equal(s.resultStatus, 'REPROVADO');
  assert.equal(s.passed, 'false');
  assert.equal(s.resultRoleId, '');
  assert.equal(s.scoreText, '6/10');

  await M.ExamAttempt.updateOne({ _id: fail.attempt._id }, { $set: { deletedAt: new Date() } });
  await M.Room.updateOne({ _id: fail.room.roomId }, { $set: { status: 'closed' } });
  const exact = await dafpRun('segundo-tenente', 7);
  assert.equal(exact.attempt.score, 7);
  assert.equal(exact.attempt.outcome.resultStatus, 'APROVADO', 'nota igual à mínima aprova (>=)');
  assert.equal(exact.attempt.outcome.resultRoleId, ROLE_OK);

  const noAuto = await dafpRun('primeiro-tenente', 3);
  s = (await api.call('GET', `/dafp/sessions/${noAuto.room.sessionId}`, H.actorFields())).body.data;
  assert.equal(s.sessionStatus, 'FINALIZADA');
  assert.equal(s.scoreText, '3/10');
  assert.equal(s.autoApproval, 'false');
  assert.equal(s.resultStatus, 'NAO_APLICAVEL');
  assert.equal(s.passed, '');
  assert.equal(s.resultRoleId, '');
  const n = await M.Notification.findOne({ attemptId: noAuto.attempt._id });
  const c = await api.call('POST', `/notifications/${n._id}/claim`, {});
  assert.equal(c.body.data.applyRole, 'false');
  assert.equal(Object.fromEntries(c.body.data.message.embeds[0].fields.map((x) => [x.name, x.value])).Resultado, 'Nota registrada');

  // Mudar a configuração da prova depois NÃO reescreve resultado antigo.
  await M.Exam.updateOne({ slug: 'segundo-tenente' }, { $set: { passingScore: 9 } });
  s = (await api.call('GET', `/dafp/sessions/${exact.room.sessionId}`, H.actorFields())).body.data;
  assert.equal(s.resultStatus, 'APROVADO');
  assert.equal(s.passingScore, '7');
});

test('finalização duplicada (concorrente e repetida): um só resultado, um só evento, um só aviso', async () => {
  await dafpExam('Capitão', 'capitao');
  const r = await api.call('POST', '/dafp/rooms', dafpBody('capitao'));
  const { attempt } = await M.lifecycle.startOrResumeAttempt(r.body.data.roomId);
  attempt.snapshot.forEach((q, i) => { q.selectedKey = i < 9 ? q.correctKey : (q.correctKey === 'A' ? 'B' : 'A'); q.isCorrect = i < 9; });
  await attempt.save();
  const stale = await M.ExamAttempt.findById(attempt._id);
  const outs = await Promise.all([
    M.lifecycle.finalizeAttempt(stale, 'manual'),
    M.lifecycle.finalizeAttempt(stale, 'timeout'),
    M.lifecycle.finalizeAttempt(await M.ExamAttempt.findById(attempt._id), 'admin_closed'),
  ]);
  assert.ok(outs.every((o) => o.status === outs[0].status && String(o._id) === String(attempt._id)));
  const again = await M.lifecycle.finalizeAttempt(await M.ExamAttempt.findById(attempt._id), 'manual');
  const doc = await M.ExamAttempt.findById(attempt._id).lean();
  assert.equal(doc.revision, 1, 'finalizou uma vez só');
  assert.equal(doc.score, 9);
  assert.equal(doc.outcome.resultStatus, 'APROVADO');
  assert.equal(String(again.finishedAt), String(doc.finishedAt));
  const events = await M.ExamEvent.countDocuments({ attemptId: attempt._id, type: /^attempt_finished/ });
  assert.equal(events, 1);
  assert.equal(await M.Notification.countDocuments({ attemptId: attempt._id }), 1);
});

test('isolamento: TCEL não lista nem promove DAFP; /dafp/results só DAFP; permissões próprias', async () => {
  await tcelExam();
  await dafpExam('Major', 'major');
  const t = await api.call('POST', '/rooms', { ...H.actorFields(), student: '700000000000000909', idempotencyKey: 'tcel-iso' });
  await H.takeExam(t.body.data.roomId, 5);
  const dafpRes = await dafpRun('major', 8);

  const tcelList = await api.call('GET', '/results', H.actorFields());
  assert.equal(tcelList.body.data.total, '1');
  assert.equal(tcelList.body.data.items[0].discordUserId, '700000000000000909');
  const cands = await api.call('GET', '/promotion-candidates', H.actorFields());
  assert.equal(cands.body.data.total, '1');

  const dl = await api.call('GET', '/dafp/results', { ...H.actorFields(), pageSize: '1' });
  assert.equal(dl.body.data.total, '1');
  assert.equal(dl.body.data.resultSingle, 'true');
  assert.equal(dl.body.data.resultAttemptId, String(dafpRes.attempt._id));
  assert.equal(dl.body.data.resultStatus, 'APROVADO');
  assert.equal(dl.body.data.resultRoleId, ROLE_OK);
  assert.equal(dl.body.data.resultScoreText, '8/10');
  assert.equal(dl.body.data.items[0].supervisorMention, `<@${EVALUATOR}>`);
  assert.equal((await api.call('GET', '/dafp/results', { ...H.actorFields(), examSlug: 'major' })).body.data.total, '1');

  // Sessão TCEL não é consultável pelo DAFP e vice-versa no regenerar.
  assert.equal((await api.call('GET', `/dafp/sessions/${t.body.data.roomId}`, H.actorFields())).body.code, 'session_not_dafp');

  // Operador só da TCEL não usa o DAFP (lista própria).
  await H.saveDefaultConfig({ operatorIds: { generate: H.OPERATOR, results: H.OPERATOR, promote: H.OPERATOR, dafp: H.OTHER_OPERATOR }, dafp: { resultChannelId: DAFP_CHANNEL } });
  require('../botghost/configStore').invalidate();
  const denied = await api.call('GET', '/dafp/exams', H.actorFields());
  assert.equal(denied.status, 403);
  assert.equal((await api.call('GET', '/dafp/exams', H.actorFields(H.OTHER_OPERATOR))).status, 200);
  assert.equal((await api.call('GET', '/exams', H.actorFields(H.OTHER_OPERATOR))).status, 403, 'professor DAFP não ganha acesso à TCEL');
});

test('migração: prova antiga vira TCEL fixa ("tcel"), histórico intacto, idempotente', async () => {
  const Exam = M.Exam;
  // Como no banco de produção antes desta versão: sem group/slug.
  const { insertedId: examId } = await Exam.collection.insertOne({ name: 'Prova Tcel', questionCount: 5, pointsPerQuestion: 20, durationMinutes: 120, active: true, createdAt: new Date(), updatedAt: new Date() });
  await require('../models/Question').create({ examId, text: 'Q', options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }, { key: 'C', text: 'c' }, { key: 'D', text: 'd' }], correctKey: 'A' });
  await M.ExamAttempt.collection.insertOne({ examId, roomId: examId, studentName: 'Aluno Antigo', status: 'finished', score: 60, pointsPerQuestion: 20, snapshot: [{}, {}, {}, {}, {}], finishedAt: new Date(), createdAt: new Date(), updatedAt: new Date() });

  const out = await M.groups.migrateExamGroups({ log: H.silentLog });
  assert.equal(out.tcelAssigned.examId, String(examId));
  const migrated = await Exam.findById(examId).lean();
  assert.equal(migrated.slug, 'tcel');
  assert.equal(migrated.group, 'TCEL');
  assert.equal(migrated.name, 'Prova Tcel');

  // Provas DAFP criadas depois não mudam a TCEL; migração repetida é inócua.
  await dafpExam('Aspirante', 'aspirante');
  const again = await M.groups.migrateExamGroups({ log: H.silentLog });
  assert.equal(again.tcelAssigned, null);
  assert.equal((await Exam.findById(examId).lean()).slug, 'tcel');

  // Resultado antigo continua na consulta TCEL.
  const res = await api.call('GET', '/results', H.actorFields());
  assert.equal(res.body.data.total, '1');
  assert.equal(res.body.data.items[0].studentName, 'Aluno Antigo');

  // Várias provas antigas e nenhuma pista: não marca nada (sem palpite).
  await db.reset();
  await Exam.collection.insertMany([{ name: 'A', questionCount: 1, pointsPerQuestion: 1, durationMinutes: 1, active: true }, { name: 'B', questionCount: 1, pointsPerQuestion: 1, durationMinutes: 1, active: true }]);
  const ambiguous = await M.groups.migrateExamGroups({ log: H.silentLog });
  assert.equal(ambiguous.tcelAssigned, null);
  assert.equal(await Exam.countDocuments({ slug: 'tcel' }), 0);
  assert.deepEqual((await Exam.find().sort({ name: 1 }).lean()).map((e) => [e.group, e.slug]), [['TCEL', 'a'], ['TCEL', 'b']]);
});
