const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

let db;
let M; // módulos do app, carregados depois que o Mongo de teste sobe

before(async () => {
  db = await H.setupDb();
  M = {
    Exam: require('../models/Exam'),
    Question: require('../models/Question'),
    Room: require('../models/Room'),
    ExamAttempt: require('../models/ExamAttempt'),
    DiscordTask: require('../models/DiscordTask'),
    Promotion: require('../models/Promotion'),
    PromotionDraft: require('../models/PromotionDraft'),
    SecurityLog: require('../models/SecurityLog'),
    lifecycle: require('../lib/examLifecycle'),
    results: require('../lib/results'),
    outbox: require('../lib/outbox'),
    rooms: require('../lib/rooms'),
    gen: require('../discord/generateService'),
    promo: require('../discord/promotionService'),
    processors: require('../discord/processors'),
    configStore: require('../discord/configStore'),
    configValidation: require('../discord/configValidation'),
    selection: require('../discord/selection'),
    router: require('../discord/router'),
    Worker: require('../discord/worker').DiscordWorker,
  };
});

after(async () => { await db.teardown(); });

let fake;
let ctx;

beforeEach(async () => {
  await db.reset();
  fake = H.createFakeDiscord();
  const { update, errors } = M.configValidation.validateDiscordConfig({
    panelChannelId: H.PANEL,
    resultsChannelId: H.RESULTS,
    operatorRoles: { generate: H.ROLE_OPS, results: H.ROLE_OPS, promote: H.ROLE_OPS },
    promotion: {
      addRoleIds: `${H.ADD1}, ${H.ADD2}`,
      removeRoleIds: H.REM,
      announceChannelId: H.ANNOUNCE,
      announceRoleId: H.ADD1,
      nicknameTemplate: '『TCEL•B』{nome} | {idRP}',
    },
  });
  assert.deepEqual(errors, []);
  await M.configStore.saveConfig(update, 'teste');
  ctx = {
    adapter: fake.adapter,
    guildId: H.GUILD,
    publicBaseUrl: 'https://provas.example.com',
    getConfig: (opts) => M.configStore.getConfig(opts),
    configStore: M.configStore,
    kickWorker: () => {},
  };
});

// Processa a fila até esvaziar (sem timers), como o worker faria.
async function runQueue() {
  const worker = new M.Worker({ ctx, log: H.silentLog });
  worker.stopped = false;
  let total = 0;
  for (let i = 0; i < 10; i += 1) {
    const n = await worker.tick();
    total += n;
    if (!n) break;
  }
  return total;
}

async function seedExam({ name = 'Prova TCEL', questions = 5, points = 20 } = {}) {
  const exam = await M.Exam.create({ name, questionCount: questions, pointsPerQuestion: points, durationMinutes: 120 });
  for (let i = 0; i < questions; i += 1) {
    await M.Question.create({
      examId: exam._id,
      text: `${name} — pergunta ${i}`,
      options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }, { key: 'C', text: 'c' }, { key: 'D', text: 'd' }],
      correctKey: 'A',
    });
  }
  return exam;
}

async function discordRoom(exam, userId, operatorId = H.OPERATOR) {
  const req = await M.gen.createRequest({ guildId: H.GUILD, operatorId, operatorName: 'Operador Teste', targetUserId: userId, studentName: `Aluno ${userId.slice(-3)}`, examId: exam._id });
  const out = await M.gen.confirmRequest(req._id, { guildId: H.GUILD, operatorId, publicBaseUrl: ctx.publicBaseUrl });
  assert.equal(out.kind, 'created');
  return out;
}

// Responde `correct` questões certas (as demais erradas) e finaliza.
async function takeExam(roomId, correct, reason = 'manual') {
  const { attempt } = await M.lifecycle.startOrResumeAttempt(roomId);
  attempt.snapshot.forEach((q, i) => {
    q.selectedKey = i < correct ? q.correctKey : (q.correctKey === 'A' ? 'B' : 'A');
    q.isCorrect = i < correct;
  });
  await attempt.save();
  return M.lifecycle.finalizeAttempt(attempt, reason);
}

async function finishedAttemptFor(userId, correct = 4, exam = null) {
  const e = exam || await seedExam();
  const { room } = await discordRoom(e, userId);
  return takeExam(room._id, correct);
}

test('Gerar Prova: clique repetido não duplica a sala; só o hash do link fica no banco; vínculo congelado', async () => {
  const exam = await seedExam();
  const req = await M.gen.createRequest({ guildId: H.GUILD, operatorId: H.OPERATOR, operatorName: 'Operador Teste', targetUserId: '700000000000000001', studentName: 'Ana', examId: exam._id });

  const outs = await Promise.all([1, 2, 3].map(() => M.gen.confirmRequest(req._id, { guildId: H.GUILD, operatorId: H.OPERATOR, publicBaseUrl: ctx.publicBaseUrl })));
  const kinds = outs.map((o) => o.kind).sort();
  assert.deepEqual(kinds, ['already', 'already', 'created']);
  assert.equal(await M.Room.countDocuments(), 1);

  const created = outs.find((o) => o.kind === 'created');
  assert.match(created.studentUrl, /^https:\/\/provas\.example\.com\/aluno\/[A-Za-z0-9_-]{40,}$/);
  assert.match(created.proctorUrl, /^https:\/\/provas\.example\.com\/professor\//);
  const raw = created.studentUrl.split('/').pop();
  const stored = JSON.stringify(await M.Room.findOne().lean());
  assert.equal(stored.includes(raw), false, 'o token puro nunca pode ir para o banco');

  const room = await M.Room.findOne().lean();
  assert.equal(room.discordUserId, '700000000000000001');
  assert.equal(room.createdVia, 'discord');
  assert.equal(room.proctorTokens[0].label, 'Operador Teste');
  assert.equal(room.proctorTokens[0].discordUserId, H.OPERATOR);

  // Já existe sala aberta para o mesmo usuário/prova → tratamento explícito.
  const req2 = await M.gen.createRequest({ guildId: H.GUILD, operatorId: H.OPERATOR, operatorName: 'Op', targetUserId: '700000000000000001', studentName: 'Ana', examId: exam._id });
  const again = await M.gen.confirmRequest(req2._id, { guildId: H.GUILD, operatorId: H.OPERATOR, publicBaseUrl: ctx.publicBaseUrl });
  assert.equal(again.kind, 'open_room');
  assert.equal(await M.Room.countDocuments(), 1);

  // Outro operador não pode confirmar a solicitação alheia.
  await assert.rejects(M.gen.confirmRequest(req2._id, { guildId: H.GUILD, operatorId: '700000000000000077', publicBaseUrl: ctx.publicBaseUrl }), /outro operador/);

  // Vínculo copiado para a tentativa e preservado após excluir a sala.
  const { attempt } = await M.lifecycle.startOrResumeAttempt(room._id);
  assert.equal(attempt.discordUserId, '700000000000000001');
  assert.equal(attempt.discordGuildId, H.GUILD);
  assert.equal(attempt.maxScore, 100);
  await M.Room.deleteOne({ _id: room._id });
  const kept = await M.ExamAttempt.findById(attempt._id).lean();
  assert.equal(kept.discordUserId, '700000000000000001');

  // As rotas do aluno não tocam no vínculo.
  const studentRoutes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'student.js'), 'utf8');
  assert.equal(/discord/i.test(studentRoutes), false);
});

test('Gerar Prova: regeneração explícita invalida os links anteriores e clique repetido não regenera de novo', async () => {
  const exam = await seedExam();
  const { room, studentUrl } = await discordRoom(exam, '700000000000000001');
  const prefix = room.studentTokenHash.slice(0, 12);

  const first = await M.gen.regenerateLinks(room._id, { guildId: H.GUILD, operatorId: H.OPERATOR, operatorName: 'Op', expectedPrefix: prefix, publicBaseUrl: ctx.publicBaseUrl });
  const second = await M.gen.regenerateLinks(room._id, { guildId: H.GUILD, operatorId: H.OPERATOR, operatorName: 'Op', expectedPrefix: prefix, publicBaseUrl: ctx.publicBaseUrl });
  assert.equal(first.kind, 'ok');
  assert.equal(second.kind, 'stale');
  assert.notEqual(first.studentUrl, studentUrl);

  const fresh = await M.Room.findById(room._id).lean();
  const operatorTokens = fresh.proctorTokens.filter((t) => t.discordUserId === H.OPERATOR);
  assert.equal(operatorTokens.length, 2);
  assert.equal(operatorTokens.filter((t) => !t.revokedAt).length, 1, 'o link de fiscal anterior do operador foi revogado');
});

test('Finalização manual e por tempo: nota corrigida no servidor; aviso vai para a fila; bot offline não atrapalha', async () => {
  const exam = await seedExam();
  const a = await discordRoom(exam, '700000000000000001');
  const exam2 = await seedExam({ name: 'Prova B' });
  const b = await discordRoom(exam2, '700000000000000002');

  fake.state.ready = false; // Discord fora do ar
  const manual = await takeExam(a.room._id, 3, 'manual');
  const timeout = await takeExam(b.room._id, 5, 'timeout');
  assert.equal(manual.status, 'finished');
  assert.equal(manual.score, 60);
  assert.equal(timeout.status, 'finished_timeout');
  assert.equal(timeout.score, 100);

  assert.equal(await M.DiscordTask.countDocuments({ kind: 'result_sync', status: 'pending' }), 2);
  assert.equal(await runQueue(), 0, 'sem Discord, nada é processado — e nada se perde');
  assert.equal(await M.DiscordTask.countDocuments({ status: 'pending' }), 2);

  fake.state.ready = true;
  assert.equal(await runQueue(), 2);
  const msgs = fake.messages(H.RESULTS).map((m) => m.content.split('\n')[0]).sort();
  assert.deepEqual(msgs, [
    'Prova finalizada: <@700000000000000001> — Nota: 60 / 100 — Prova: Prova TCEL',
    'Prova finalizada: <@700000000000000002> — Nota: 100 / 100 — Prova: Prova B',
  ]);
  for (const m of fake.messages(H.RESULTS)) assert.deepEqual(m.allowedMentions, { parse: [] });
  const synced = await M.ExamAttempt.findById(manual._id).lean();
  assert.equal(synced.discordSync.syncedRevision, 1);
  assert.ok(synced.discordSync.messageId);
});

test('Nota editada e excluída: Discord mostra a versão atual; tarefa antiga não sobrescreve; excluído não volta', async () => {
  const attempt = await finishedAttemptFor('700000000000000001', 4);
  await runQueue();
  assert.equal(fake.count('send'), 1);

  await assert.rejects(M.results.adjustScore({ attemptId: attempt._id, score: 101, reason: 'teste', actor: 'admin:a' }), /entre 0 e 100/);
  await assert.rejects(M.results.adjustScore({ attemptId: attempt._id, score: 90, reason: '', actor: 'admin:a' }), /motivo/);

  const adj = await M.results.adjustScore({ attemptId: attempt._id, score: 95, reason: 'revisão de gabarito', actor: 'admin:a' });
  assert.equal(adj.attempt.revision, 2);
  assert.equal(adj.attempt.score, 80, 'nota calculada preservada');
  assert.equal(adj.attempt.correctCount, 4, 'acertos não mudam');
  assert.equal(adj.attempt.auditTrail[0].by, 'admin:a');

  // Uma tarefa da revisão 1 processada agora é descartada (não publica nota velha).
  const stale = await M.processors.processResultSync({ attemptId: attempt._id, revision: 1, key: 'x' }, ctx);
  assert.equal(stale.superseded, true);

  await runQueue();
  assert.equal(fake.count('send'), 1, 'edita a mensagem existente, não cria outra');
  assert.match(fake.messages(H.RESULTS)[0].content, /Nota: 95 \/ 100/);
  assert.match(fake.messages(H.RESULTS)[0].content, /ajustada/);

  const del = await M.results.softDeleteResult({ attemptId: attempt._id, reason: 'fraude confirmada', actor: 'admin:a' });
  assert.ok(del.attempt.deletedAt);
  await runQueue();
  assert.match(fake.messages(H.RESULTS)[0].content, /^Resultado removido/);
  assert.equal(fake.count('send'), 1);

  // Reprocessar qualquer revisão depois disso não ressuscita o resultado.
  await M.processors.processResultSync({ attemptId: attempt._id, revision: 3, key: 'y' }, ctx);
  assert.match(fake.messages(H.RESULTS)[0].content, /^Resultado removido/);
  await assert.rejects(M.results.adjustScore({ attemptId: attempt._id, score: 50, reason: 'x x x', actor: 'admin:a' }), /excluído/);

  const list = await M.results.listForDiscord({ guildId: H.GUILD });
  assert.equal(list.total, 0);
  assert.equal((await M.results.listForAdmin({})).length, 0);
  assert.equal((await M.results.listForAdmin({ includeDeleted: true })).length, 1);
  const cands = await M.promo.listCandidates(H.GUILD);
  assert.equal(cands.total, 0, 'resultado excluído não pode ser usado em promoção');
});

test('Tentativas múltiplas e resultados antigos sem vínculo', async () => {
  const exam = await seedExam();
  const first = await finishedAttemptFor('700000000000000001', 2, exam);
  const second = await finishedAttemptFor('700000000000000001', 5, exam); // sala anterior já finalizada
  assert.notEqual(String(first._id), String(second._id));

  // Resultado antigo feito pelo painel (sem Discord).
  const { room } = await M.rooms.createRoom({ examId: exam._id, roomLabel: 'Sala 1', studentName: 'Antigo' });
  await takeExam(room._id, 1);

  const all = await M.results.listForDiscord({ guildId: H.GUILD, sort: 'score-desc' });
  assert.equal(all.total, 3);
  assert.deepEqual(all.items.map((i) => i.effectiveScore), [100, 40, 20]);
  assert.equal(all.items.filter((i) => !i.discordUserId).length, 1, 'sem vínculo aparece como não vinculado');

  const onlyUser = await M.results.listForDiscord({ guildId: H.GUILD, userId: '700000000000000001' });
  assert.equal(onlyUser.total, 2);

  const cands = await M.promo.listCandidates(H.GUILD);
  assert.equal(cands.total, 2);
  const same = M.selection.applySelection([], { pageCandidates: cands.items, chosenIds: cands.items.map((c) => String(c._id)) });
  assert.match(same.error, /mesmo usuário/);

  // Vinculação explícita e auditada (sem publicar aviso de finalização).
  const legacy = all.items.find((i) => !i.discordUserId);
  await M.results.linkDiscordUser({ attemptId: legacy._id, discordUserId: '700000000000000003', guildId: H.GUILD, reason: 'conferido pelo admin', actor: 'admin:a' });
  await runQueue();
  const linked = await M.ExamAttempt.findById(legacy._id).lean();
  assert.equal(linked.discordUserId, '700000000000000003');
  assert.equal(linked.auditTrail[0].type, 'discord_linked');
  assert.equal(fake.messages(H.RESULTS).some((m) => m.content.includes('700000000000000003')), false);
});

async function preparedDraft(userIds, operatorId = H.OPERATOR, names = {}) {
  const draft = await M.promo.getOrCreateDraft(H.GUILD, operatorId);
  const cands = await M.promo.listCandidates(H.GUILD);
  const chosen = [];
  for (const u of userIds) {
    const c = cands.items.find((x) => x.discordUserId === u);
    assert.ok(c, `candidato ${u}`);
    chosen.push(String(c._id));
  }
  const out = M.selection.applySelection([], { pageCandidates: cands.items, chosenIds: chosen });
  assert.equal(out.error, undefined);
  await M.promo.saveSelections(draft, out.selections);
  for (const u of userIds) {
    const r = await M.promo.setRpData(draft, u, { nome: names[u] || `Nome${u.slice(-2)}`, idRP: u.slice(-3) }, '『TCEL•B』{nome} | {idRP}');
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  return draft;
}

test('Promoção completa: revisão, confirmação (clique duplo), cargos, apelido e anúncio só dos concluídos', async () => {
  const U1 = '700000000000000011';
  const U2 = '700000000000000012';
  await finishedAttemptFor(U1, 5);
  await finishedAttemptFor(U2, 4);
  await runQueue();
  fake.addMember(U1);
  fake.addMember(U2);

  const draft = await preparedDraft([U1, U2]);
  const { report } = await M.promo.reviewDraft(draft, ctx);
  assert.equal(report.ok, true, JSON.stringify(report));

  const outs = await Promise.all([
    M.promo.confirmDraft(draft._id, { guildId: H.GUILD, operatorId: H.OPERATOR }, draft.reviewHash, ctx),
    M.promo.confirmDraft(draft._id, { guildId: H.GUILD, operatorId: H.OPERATOR }, draft.reviewHash, ctx),
  ]);
  assert.deepEqual(outs.map((o) => o.kind).sort(), ['already', 'started']);
  assert.equal(await M.Promotion.countDocuments(), 2);

  await runQueue();
  for (const u of [U1, U2]) {
    const m = fake.state.members.get(u);
    assert.ok(m.roleIds.includes(H.ADD1) && m.roleIds.includes(H.ADD2));
    assert.equal(m.roleIds.includes(H.REM), false);
    assert.equal(m.nickname, `『TCEL•B』Nome${u.slice(-2)} | ${u.slice(-3)}`);
  }
  const promos = await M.Promotion.find().lean();
  assert.ok(promos.every((p) => p.status === 'completed' && p.announced));
  assert.equal((await M.PromotionDraft.findById(draft._id)).status, 'completed');

  const announce = fake.messages(H.ANNOUNCE);
  assert.equal(announce.length, 1);
  const lines = announce[0].content.split('\n');
  assert.equal(lines[0], `Parabéns aos promovidos para <@&${H.ADD1}>`);
  assert.deepEqual(lines.slice(1).sort(), [`<@${U1}>`, `<@${U2}>`]);
  assert.deepEqual(announce[0].allowedMentions.roles, [H.ADD1]);
  assert.deepEqual([...announce[0].allowedMentions.users].sort(), [U1, U2]);

  // Promovidos saem da lista de candidatos (bloqueio) e editar a nota avisa.
  assert.equal((await M.promo.listCandidates(H.GUILD)).total, 0);
  const promoted = await M.ExamAttempt.findOne({ discordUserId: U1 });
  const adj = await M.results.adjustScore({ attemptId: promoted._id, score: 10, reason: 'ajuste', actor: 'admin:a' });
  assert.match(adj.warning, /NÃO é desfeita/);
  assert.equal((await M.Promotion.findOne({ discordUserId: U1 })).status, 'completed');
  assert.ok(fake.state.members.get(U1).roleIds.includes(H.ADD1), 'nenhum cargo é removido automaticamente');
});

test('Promoção concorrente: dois operadores, mesma pessoa → uma única promoção', async () => {
  const U1 = '700000000000000021';
  await finishedAttemptFor(U1, 5);
  fake.addMember(U1);
  const d1 = await preparedDraft([U1], H.OPERATOR);
  const d2 = await preparedDraft([U1], '700000000000000088');
  await M.promo.reviewDraft(d1, ctx);
  await M.promo.reviewDraft(d2, ctx);

  const outs = await Promise.all([
    M.promo.confirmDraft(d1._id, { guildId: H.GUILD, operatorId: H.OPERATOR }, d1.reviewHash, ctx),
    M.promo.confirmDraft(d2._id, { guildId: H.GUILD, operatorId: '700000000000000088' }, d2.reviewHash, ctx),
  ]);
  const created = outs.reduce((n, o) => n + (o.created ? o.created.length : 0), 0);
  assert.equal(created, 1);
  assert.equal(await M.Promotion.countDocuments({ discordUserId: U1 }), 1);
  await runQueue();
  assert.equal(fake.count('addRole'), 2, 'cada cargo aplicado uma única vez');
  assert.equal(fake.messages(H.ANNOUNCE).length, 1);
});

test('Hierarquia insuficiente: a revisão bloqueia e nada é alterado no Discord', async () => {
  const U1 = '700000000000000031';
  await finishedAttemptFor(U1, 5);
  fake.addMember(U1);
  fake.state.roles[H.ADD1].position = 12; // acima do bot (10)
  const draft = await preparedDraft([U1]);
  const { report } = await M.promo.reviewDraft(draft, ctx);
  assert.equal(report.ok, false);
  const out = await M.promo.confirmDraft(draft._id, { guildId: H.GUILD, operatorId: H.OPERATOR }, draft.reviewHash, ctx);
  assert.notEqual(out.kind, 'started');
  assert.equal(await M.Promotion.countDocuments(), 0);
  assert.equal(fake.state.calls.filter((c) => ['addRole', 'removeRole', 'setNickname'].includes(c.op)).length, 0);
});

test('Resultado alterado entre revisão e confirmação exige nova revisão; excluído impede', async () => {
  const U1 = '700000000000000041';
  const attempt = await finishedAttemptFor(U1, 5);
  fake.addMember(U1);
  const draft = await preparedDraft([U1]);
  await M.promo.reviewDraft(draft, ctx);
  const oldHash = draft.reviewHash;

  await M.results.adjustScore({ attemptId: attempt._id, score: 70, reason: 'correção', actor: 'admin:a' });
  const changed = await M.promo.confirmDraft(draft._id, { guildId: H.GUILD, operatorId: H.OPERATOR }, oldHash, ctx);
  assert.equal(changed.kind, 'changed');
  assert.equal(await M.Promotion.countDocuments(), 0);
  assert.notEqual(changed.draft.reviewHash, oldHash);

  await M.results.softDeleteResult({ attemptId: attempt._id, reason: 'anulada', actor: 'admin:a' });
  const blocked = await M.promo.confirmDraft(draft._id, { guildId: H.GUILD, operatorId: H.OPERATOR }, changed.draft.reviewHash, ctx);
  assert.equal(blocked.kind, 'changed');
  assert.equal(blocked.report.ok, false);
  assert.equal(await M.Promotion.countDocuments(), 0);
});

test('Falha parcial: cargos aplicados, apelido falha; retomada refaz só o pendente e então anuncia', async () => {
  const U1 = '700000000000000051';
  await finishedAttemptFor(U1, 5);
  fake.addMember(U1);
  const draft = await preparedDraft([U1]);
  await M.promo.reviewDraft(draft, ctx);
  fake.state.failures.push({ op: 'setNickname', times: 1, error: { code: 50013, status: 403 }, message: 'Missing Permissions' });
  const out = await M.promo.confirmDraft(draft._id, { guildId: H.GUILD, operatorId: H.OPERATOR }, draft.reviewHash, ctx);
  assert.equal(out.kind, 'started');
  await runQueue();

  let p = await M.Promotion.findOne({ discordUserId: U1 }).lean();
  assert.equal(p.status, 'partial');
  assert.deepEqual(p.steps.map((s) => s.status), ['done', 'done', 'done', 'failed']);
  assert.equal(fake.messages(H.ANNOUNCE).length, 0, 'sucesso parcial não é anunciado como promoção completa');
  assert.equal((await M.PromotionDraft.findById(draft._id)).status, 'partial');
  const addRolesBefore = fake.count('addRole');

  const resumed = await M.promo.resumePromotion(p._id, 'discord:op');
  assert.equal(resumed.kind, 'resumed');
  await runQueue();
  p = await M.Promotion.findOne({ discordUserId: U1 }).lean();
  assert.equal(p.status, 'completed');
  assert.equal(fake.count('addRole'), addRolesBefore, 'etapas já feitas não são repetidas');
  assert.equal(fake.state.members.get(U1).nickname, '『TCEL•B』Nome51 | 051');
  assert.equal(fake.messages(H.ANNOUNCE).length, 1);
});

test('Falha só no anúncio: a promoção não é refeita; só o anúncio é repetido (transitório e após falha definitiva)', async () => {
  const U1 = '700000000000000061';
  await finishedAttemptFor(U1, 5);
  fake.addMember(U1);
  const draft = await preparedDraft([U1]);
  await M.promo.reviewDraft(draft, ctx);
  fake.state.failures.push({ op: 'send', times: 1, match: ({ channelId }) => channelId === H.ANNOUNCE, error: { status: 500 } });
  await M.promo.confirmDraft(draft._id, { guildId: H.GUILD, operatorId: H.OPERATOR }, draft.reviewHash, ctx);
  await runQueue();

  assert.equal((await M.Promotion.findOne({ discordUserId: U1 })).status, 'completed');
  const task = await M.DiscordTask.findOne({ kind: 'promotion_announce' });
  assert.equal(task.status, 'pending');
  assert.equal(fake.messages(H.ANNOUNCE).length, 0);
  const addRoles = fake.count('addRole');

  await M.DiscordTask.updateOne({ _id: task._id }, { $set: { nextRunAt: new Date() } });
  await runQueue();
  assert.equal(fake.messages(H.ANNOUNCE).length, 1);
  assert.equal(fake.count('addRole'), addRoles);
  assert.equal((await M.Promotion.findOne({ discordUserId: U1 })).announced, true);

  // Falha definitiva (sem permissão) → tarefa "failed" → reprocessar repete só o anúncio.
  const U2 = '700000000000000062';
  await finishedAttemptFor(U2, 5);
  fake.addMember(U2);
  const d2 = await preparedDraft([U2]);
  await M.promo.reviewDraft(d2, ctx);
  fake.state.failures.push({ op: 'send', times: 1, match: ({ channelId }) => channelId === H.ANNOUNCE, error: { code: 50013, status: 403 } });
  await M.promo.confirmDraft(d2._id, { guildId: H.GUILD, operatorId: H.OPERATOR }, d2.reviewHash, ctx);
  await runQueue();
  const failed = await M.DiscordTask.findOne({ kind: 'promotion_announce', draftId: d2._id });
  assert.equal(failed.status, 'failed');
  const addRoles2 = fake.count('addRole');
  await M.outbox.retryTask(failed._id);
  await runQueue();
  assert.equal(fake.messages(H.ANNOUNCE).length, 2);
  assert.equal(fake.count('addRole'), addRoles2);
});

test('Reinício com tarefas pendentes e envio ambíguo: retoma sem duplicar mensagem', async () => {
  const attempt = await finishedAttemptFor('700000000000000071', 5);

  // Simula o processo morrendo DEPOIS de enviar e ANTES de gravar o ID.
  const claimed = await M.outbox.claimNext();
  assert.equal(String(claimed.attemptId), String(attempt._id));
  await M.outbox.saveProgress(claimed, { sendStartedAt: new Date() });
  await fake.adapter.sendMessage(H.RESULTS, { content: `Prova finalizada: <@700000000000000071> — Nota: 100 / 100 — Prova: Prova TCEL\n-# Tentativa \`${attempt._id}\``, allowedMentions: { parse: [] } });
  const sendsBefore = fake.count('send');

  // "Reinício": trava da tarefa antiga é liberada ao subir.
  const worker = new M.Worker({ ctx, log: H.silentLog });
  await worker.start();
  await worker.running;
  await worker.stop();

  assert.equal(fake.count('send'), sendsBefore, 'não publicou de novo');
  assert.equal(fake.messages(H.RESULTS).length, 1);
  const synced = await M.ExamAttempt.findById(attempt._id).lean();
  assert.equal(synced.discordSync.syncedRevision, 1);
  assert.equal(synced.discordSync.messageId, fake.messages(H.RESULTS)[0].id);
  assert.equal((await M.DiscordTask.findById(claimed._id)).status, 'done');
});

test('Reconciliação: resultado finalizado sem tarefa na fila ganha a tarefa que faltou', async () => {
  const attempt = await finishedAttemptFor('700000000000000081', 5);
  await M.DiscordTask.deleteMany({}); // simula queda entre salvar a nota e enfileirar
  const worker = new M.Worker({ ctx, log: H.silentLog });
  worker.stopped = false;
  const created = await worker.reconcile();
  assert.equal(created, 1);
  await worker.running; // a reconciliação já aciona o processamento
  await runQueue();
  assert.equal(fake.messages(H.RESULTS).length, 1);
  assert.equal((await M.ExamAttempt.findById(attempt._id).lean()).discordSync.syncedRevision, 1);
});

test('Acesso negado: DM, servidor/canal errado, sem cargo e sem configuração nunca chegam ao handler', async () => {
  const calls = [];
  const handlers = { generate: async () => calls.push('generate'), results: async () => calls.push('results'), promote: async () => calls.push('promote'), panel: async () => calls.push('panel') };
  const router = M.router.createRouter({ handlers, getConfig: () => M.configStore.getConfig(), expectedGuildId: H.GUILD, log: H.silentLog });

  function interaction({ guildId = H.GUILD, channelId = H.PANEL, roles = [H.ROLE_OPS], customId = 'ptc:gen', userId = '700000000000000099' } = {}) {
    const replies = [];
    return {
      replies,
      guildId,
      channelId,
      customId,
      user: { id: userId },
      member: roles ? { roles } : null,
      deferred: false,
      replied: false,
      isChatInputCommand: () => false,
      async reply(data) { replies.push(data); this.replied = true; },
      async followUp(data) { replies.push(data); },
    };
  }

  const cases = [
    interaction({ guildId: null, roles: null }),
    interaction({ guildId: '999999999999999999' }),
    interaction({ channelId: '600000000000000999' }),
    interaction({ roles: [H.ADD1] }), // cargo de destino da promoção NÃO autoriza
  ];
  for (const i of cases) {
    await router(i);
    assert.equal(i.replies.length, 1);
    assert.match(i.replies[0].content, /^⛔/);
    assert.ok(i.replies[0].flags, 'resposta privada (efêmera)');
  }
  assert.deepEqual(calls, []);

  const ok = interaction();
  await router(ok);
  assert.deepEqual(calls, ['generate']);

  // Configuração apagada → bloqueia em vez de liberar.
  await require('../models/DiscordConfig').deleteMany({});
  M.configStore.invalidate();
  const noConfig = interaction();
  await router(noConfig);
  assert.match(noConfig.replies[0].content, /^⛔/);
  assert.deepEqual(calls, ['generate']);

  assert.ok(await M.SecurityLog.countDocuments({ type: 'discord_unauthorized' }) >= 4);
});

test('Encerrar sala no meio da prova corrige a tentativa pelo servidor (não fica com nota 0)', async () => {
  const exam = await seedExam();
  const { room } = await discordRoom(exam, '700000000000000091');
  const { attempt } = await M.lifecycle.startOrResumeAttempt(room._id);
  attempt.snapshot.forEach((q, i) => { q.selectedKey = q.correctKey; q.isCorrect = i < 2; });
  await attempt.save();
  const closed = await M.lifecycle.finalizeAttempt(attempt, 'admin_closed');
  assert.equal(closed.status, 'finished');
  assert.equal(closed.correctCount, 2);
  assert.equal(closed.score, 40);
  const ev = await require('../models/ExamEvent').findOne({ attemptId: attempt._id, type: 'attempt_finished_room_closed' }).lean();
  assert.equal(ev.actor, 'admin');
});
