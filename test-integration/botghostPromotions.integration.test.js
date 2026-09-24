const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

// Promoção em lote pela API: rascunho por operador, seleção, dados RP,
// revisão, confirmação única, execução com evidências, falha parcial,
// retomada, anúncio só dos concluídos e travas contra promoção dupla.
// Nenhum Discord real: as "evidências" são o que o BotGhost relataria.

let db;
let M;
const envRef = { current: null };
let api;

const A = '700000000000000001';
const B = '700000000000000002';
const C = '700000000000000003';

before(async () => {
  db = await H.setupDb();
  M = {
    ExamAttempt: require('../models/ExamAttempt'),
    Promotion: require('../models/Promotion'),
    Draft: require('../models/PromotionDraft'),
    Notification: require('../models/IntegrationNotification'),
    results: require('../lib/results'),
    notifications: require('../botghost/notifications'),
    promotions: require('../botghost/promotionsService'),
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

let keySeq = 0;
async function finished(student, correct = 4, examId = null) {
  if (!(await require('../models/Exam').countDocuments())) await H.seedExam();
  keySeq += 1;
  const extra = examId ? { examId: String(examId) } : {};
  const r = await api.call('POST', '/rooms', { ...H.actorFields(), student, studentDisplayName: `Recruta ${student.slice(-2)}`, idempotencyKey: `interacao-p${keySeq}`, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return H.takeExam(r.body.data.roomId, correct);
}

const as = (op = H.OPERATOR, extra = {}) => H.actorFields(op, extra);

async function draft(op = H.OPERATOR) {
  const r = await api.call('POST', '/promotion-drafts', as(op));
  assert.ok([200, 201].includes(r.status), JSON.stringify(r.body));
  return r.body.data;
}

function slotValue(view, attemptId) {
  for (let i = 1; i <= 25; i += 1) if (view[`opt${i}Value`] === String(attemptId)) return view[`opt${i}Value`];
  return null;
}

async function select(draftId, attemptIds, op = H.OPERATOR) {
  return api.call('POST', `/promotion-drafts/${draftId}/selection`, { ...as(op), page: 0, attemptIds: attemptIds.map(String).join(',') });
}

async function fill(draftId, member, nomeRP, idRP, op = H.OPERATOR) {
  return api.call('POST', `/promotion-drafts/${draftId}/members`, { ...as(op), member, nomeRP, idRP });
}

async function reviewAndConfirm(draftId, key = 'interacao-conf1', op = H.OPERATOR) {
  const rev = await api.call('POST', `/promotion-drafts/${draftId}/review`, as(op));
  assert.equal(rev.body.data.canConfirm, 'true', JSON.stringify(rev.body));
  const conf = await api.call('POST', `/promotion-drafts/${draftId}/confirm`, { ...as(op), reviewHash: rev.body.data.reviewHash, idempotencyKey: key });
  return { rev, conf };
}

const progress = (jobId, body, op = H.OPERATOR) => api.call('POST', `/promotion-jobs/${jobId}/progress`, { ...as(op), ...body });

// Simula o BotGhost executando uma pessoa: pré-verificação, ação, resultado.
async function runMember(jobId, lease, member, { pre = [H.REM], post = [H.ADD1, H.ADD2], nickname, found = 'true', error = '' }) {
  const p1 = await progress(jobId, { leaseToken: lease, memberDiscordId: member, phase: 'precheck', memberFound: found, roleIds: pre.join(','), nickname: '' });
  if (found === 'false' || p1.body.data.phase !== 'act') return p1;
  return progress(jobId, { leaseToken: lease, memberDiscordId: member, phase: 'result', roleIds: post.join(','), nickname, actionError: error });
}

test('lote completo: seleção, RP com zeros, revisão, confirmação única, execução, parcial, retomada e anúncio só dos concluídos', async () => {
  const aAttempt = await finished(A, 4);
  const bAttempt = await finished(B, 5);
  const cAttempt = await finished(C, 3);

  const view = await draft();
  assert.equal(view.candidatesTotal, '3');
  assert.ok(slotValue(view, aAttempt._id));
  assert.equal(view.opt4Hide, 'true');

  // Outro operador não mexe no rascunho de ninguém.
  const foreign = await select(view.draftId, [aAttempt._id], H.OTHER_OPERATOR);
  assert.equal(foreign.body.code, 'not_draft_owner');

  const sel = await select(view.draftId, [aAttempt._id, bAttempt._id, cAttempt._id]);
  assert.equal(sel.body.data.selectedCount, '3');
  assert.equal(sel.body.data.nextDiscordUserId, A);

  const tooLong = await fill(view.draftId, A, 'Nome Muito Comprido Demais Para Caber', '001');
  assert.equal(tooLong.body.code, 'rp_invalid');
  assert.match(tooLong.body.message, /no máximo 32|caracteres/);
  const okA = await fill(view.draftId, `<@${A}>`, 'Silva', '007');
  assert.equal(okA.body.data.nickname, '『TCEL•B』Silva | 007');
  assert.equal(okA.body.data.nextDiscordUserId, B);
  await fill(view.draftId, B, 'Souza', '0102');
  const notReady = await api.call('POST', `/promotion-drafts/${view.draftId}/review`, as());
  assert.equal(notReady.body.data.canConfirm, 'false');
  await fill(view.draftId, C, 'Lima', '33');

  const { rev, conf } = await reviewAndConfirm(view.draftId);
  assert.equal(conf.status, 201, JSON.stringify(conf.body));
  const jobId = conf.body.data.jobId;
  const promo = await M.Promotion.findOne({ discordUserId: A }).lean();
  assert.equal(promo.idRP, '007', 'ID RP guarda zeros à esquerda');
  assert.equal(promo.nickname, '『TCEL•B』Silva | 007');

  // Confirmação repetida: mesma chave = mesma resposta; chave nova = já confirmado.
  const rep = await api.call('POST', `/promotion-drafts/${view.draftId}/confirm`, { ...as(), reviewHash: rev.body.data.reviewHash, idempotencyKey: 'interacao-conf1' });
  assert.equal(rep.body.data.replayed, 'true');
  const dup = await api.call('POST', `/promotion-drafts/${view.draftId}/confirm`, { ...as(), reviewHash: rev.body.data.reviewHash, idempotencyKey: 'interacao-conf2' });
  assert.equal(dup.body.code, 'already_confirmed');
  assert.equal(await M.Promotion.countDocuments(), 3);

  const claim = await api.call('POST', `/promotion-jobs/${jobId}/claim`, as());
  assert.equal(claim.body.code, 'job_claimed');
  const lease = claim.body.data.leaseToken;
  assert.equal(claim.body.data.memberDiscordId, A);
  assert.equal(claim.body.data.phase, 'precheck');
  assert.equal(claim.body.data.addRoleIds, `${H.ADD1},${H.ADD2}`);
  assert.equal(claim.body.data.removeRoleIds, H.REM);
  // Um slot por cargo (um bloco fixo no BotGhost para cada).
  assert.deepEqual([claim.body.data.addRole1, claim.body.data.addRole2, claim.body.data.addRole3, claim.body.data.removeRole1, claim.body.data.removeRole2], [H.ADD1, H.ADD2, '', H.REM, '']);

  // Reserva de outra pessoa / token errado.
  assert.equal((await api.call('POST', `/promotion-jobs/${jobId}/claim`, as(H.OTHER_OPERATOR))).body.code, 'not_draft_owner');
  assert.equal((await progress(jobId, { leaseToken: 'errado', memberDiscordId: A, phase: 'precheck', roleIds: H.REM, nickname: '' })).body.code, 'lease_invalid');
  // Evidência ilegível ([object Object]) não conta como feito.
  const unreadable = await progress(jobId, { leaseToken: lease, memberDiscordId: A, phase: 'precheck', roleIds: '[object Object],[object Object]', nickname: '' });
  assert.equal(unreadable.body.code, 'evidence_unreadable');
  assert.equal(await M.Promotion.countDocuments({ status: 'completed' }), 0);

  const a = await runMember(jobId, lease, A, { nickname: '『TCEL•B』Silva | 007' });
  assert.equal(a.body.data.itemStatus, 'completed', JSON.stringify(a.body));
  assert.equal(a.body.data.memberDiscordId, B);
  // Repetir o relato de quem já terminou não refaz nada.
  assert.equal((await progress(jobId, { leaseToken: lease, memberDiscordId: A, phase: 'result', roleIds: `${H.ADD1},${H.ADD2}`, nickname: 'x' })).body.code, 'item_already_final');

  // B: o Discord recusou um dos cargos (hierarquia) — só esse passo falha.
  const b = await runMember(jobId, lease, B, { post: [H.ADD1], nickname: '『TCEL•B』Souza | 0102', error: 'Missing Permissions (hierarquia)' });
  assert.equal(b.body.data.itemStatus, 'partial');
  const bDoc = await M.Promotion.findOne({ discordUserId: B }).lean();
  assert.deepEqual(bDoc.steps.map((s) => `${s.type}:${s.roleId || ''}:${s.status}`), [`addRole:${H.ADD1}:done`, `addRole:${H.ADD2}:failed`, `removeRole:${H.REM}:done`, 'setNickname::done']);
  assert.match(bDoc.lastError, /hierarquia/);

  // C saiu do servidor.
  const c = await runMember(jobId, lease, C, { found: 'false' });
  assert.equal(c.body.data.itemStatus, 'failed');
  assert.equal(c.body.data.jobDone, 'true');
  const cDoc = await M.Promotion.findOne({ discordUserId: C }).lean();
  assert.equal(cDoc.lockKey, undefined, 'falha sem nenhuma mudança libera a pessoa');
  assert.equal(c.body.data.message.content.includes('falha') || JSON.stringify(c.body.data.message).includes(C), true);

  // Anúncio: só A (concluída); nunca B (parcial) nem C (falhou).
  const ann = await M.Notification.find({ kind: 'promotion_announcement' }).lean();
  assert.equal(ann.length, 1);
  assert.deepEqual(ann[0].payload.userIds, [A]);
  assert.equal(c.body.data.nextAnnouncementId, String(ann[0]._id));
  const ac = await api.call('POST', `/notifications/${ann[0]._id}/claim`, {});
  assert.equal(ac.body.data.channelId, H.ANNOUNCE);
  assert.equal(ac.body.data.message.content, `Parabéns aos promovidos para <@&${H.ADD1}>\n<@${A}>`);
  assert.deepEqual(ac.body.data.message.allowed_mentions, { parse: [], users: [A], roles: [H.ADD1] });
  await api.call('POST', `/notifications/${ann[0]._id}/ack`, { leaseToken: ac.body.data.leaseToken, outcome: 'delivered', messageId: '1400000000000000100' });
  assert.equal((await M.Promotion.findOne({ discordUserId: A })).announced, true);

  // Retomada: só os passos que falharam voltam (B e C); cada pessoa passa
  // de novo pela verificação do estado real.
  const resumed = await api.call('POST', `/promotion-jobs/${jobId}/resume`, as());
  assert.equal(resumed.body.data.resumedCount, '2');
  const claim2 = await api.call('POST', `/promotion-jobs/${jobId}/claim`, as());
  assert.equal(claim2.body.data.memberDiscordId, B);
  assert.equal(claim2.body.data.addRoleIds, H.ADD2, 'só o que falta');
  assert.deepEqual([claim2.body.data.addRole1, claim2.body.data.addRole2, claim2.body.data.removeRole1], ['', H.ADD2, '']);
  assert.equal(claim2.body.data.needRemoveRoles, 'false');
  const b2 = await runMember(jobId, claim2.body.data.leaseToken, B, { pre: [H.ADD1], post: [H.ADD1, H.ADD2], nickname: '『TCEL•B』Souza | 0102' });
  assert.equal(b2.body.data.itemStatus, 'completed');
  assert.equal(b2.body.data.memberDiscordId, C);
  const c2 = await runMember(jobId, claim2.body.data.leaseToken, C, { found: 'false' });
  assert.equal(c2.body.data.jobDone, 'true');
  const ann2 = await M.Notification.find({ kind: 'promotion_announcement' }).sort({ createdAt: 1 }).lean();
  assert.equal(ann2.length, 2);
  assert.deepEqual(ann2[1].payload.userIds, [B], 'A não é anunciada de novo');
});

test('um usuário com vários resultados entra uma vez só, com resultado explícito', async () => {
  const first = await finished(A, 3);
  const exam2 = await H.seedExam({ name: 'Prova TCEL 2' });
  const second = await finished(A, 5, exam2._id);
  const view = await draft();
  const both = await select(view.draftId, [first._id, second._id]);
  assert.equal(both.body.code, 'selection_invalid');
  const byUser = await api.call('POST', `/promotion-drafts/${view.draftId}/selection`, { ...as(), discordUserIds: A });
  assert.equal(byUser.body.code, 'selection_invalid');
  assert.match(byUser.body.message, /2 resultados/);
  const one = await select(view.draftId, [second._id]);
  assert.equal(one.body.data.selectedCount, '1');
  // Menu de usuário para quem tem 1 resultado; valida TODOS antes de aceitar.
  await finished(B, 4, exam2._id);
  const mixed = await api.call('POST', `/promotion-drafts/${view.draftId}/selection`, { ...as(), page: 0, attemptIds: String(second._id), discordUserIds: `${B},${H.STRANGER}` });
  assert.equal(mixed.body.code, 'selection_invalid');
  assert.equal((await M.Draft.findById(view.draftId)).selections.length, 1, 'nada muda se algum for inválido');
});

test('dois operadores não promovem a mesma pessoa', async () => {
  const at = await finished(A, 4);
  const v1 = await draft(H.OPERATOR);
  const v2 = await draft(H.OTHER_OPERATOR);
  await select(v1.draftId, [at._id], H.OPERATOR);
  await select(v2.draftId, [at._id], H.OTHER_OPERATOR);
  await fill(v1.draftId, A, 'Silva', '1', H.OPERATOR);
  await fill(v2.draftId, A, 'Silva', '1', H.OTHER_OPERATOR);
  const r1 = await api.call('POST', `/promotion-drafts/${v1.draftId}/review`, as(H.OPERATOR));
  const r2 = await api.call('POST', `/promotion-drafts/${v2.draftId}/review`, as(H.OTHER_OPERATOR));
  const [c1, c2] = await Promise.all([
    api.call('POST', `/promotion-drafts/${v1.draftId}/confirm`, { ...as(H.OPERATOR), reviewHash: r1.body.data.reviewHash, idempotencyKey: 'interacao-x1' }),
    api.call('POST', `/promotion-drafts/${v2.draftId}/confirm`, { ...as(H.OTHER_OPERATOR), reviewHash: r2.body.data.reviewHash, idempotencyKey: 'interacao-x2' }),
  ]);
  const codes = [c1.body.code, c2.body.code].sort();
  assert.ok(codes.includes('job_created'), JSON.stringify(codes));
  assert.ok(codes.some((c) => ['nobody_to_promote', 'changed_since_review'].includes(c)), JSON.stringify(codes));
  assert.equal(await M.Promotion.countDocuments({ discordUserId: A }), 1);
});

test('nota alterada antes de começar → revisão; resultado excluído → bloqueado; exclusão depois de iniciar → conflito', async () => {
  const at = [await finished(A, 4), await finished(B, 4), await finished(C, 4)];
  const view = await draft();
  await select(view.draftId, at.map((a) => a._id));
  await fill(view.draftId, A, 'Silva', '1');
  await fill(view.draftId, B, 'Souza', '2');
  await fill(view.draftId, C, 'Lima', '3');

  // Mudou entre a revisão e a confirmação: volta para revisão.
  const rev = await api.call('POST', `/promotion-drafts/${view.draftId}/review`, as());
  await M.results.adjustScore({ attemptId: String(at[0]._id), score: 70, reason: 'revisão', actor: 'admin:teste' });
  const changed = await api.call('POST', `/promotion-drafts/${view.draftId}/confirm`, { ...as(), reviewHash: rev.body.data.reviewHash, idempotencyKey: 'interacao-y1' });
  assert.equal(changed.body.code, 'changed_since_review');
  assert.equal(await M.Promotion.countDocuments(), 0);

  const { conf } = await reviewAndConfirm(view.draftId, 'interacao-y2');
  const jobId = conf.body.data.jobId;
  const claim = await api.call('POST', `/promotion-jobs/${jobId}/claim`, as());
  const lease = claim.body.data.leaseToken;
  // A começa (pré-verificação feita) e depois tem o resultado excluído.
  await progress(jobId, { leaseToken: lease, memberDiscordId: A, phase: 'precheck', roleIds: H.REM, nickname: '' });
  await M.results.softDeleteResult({ attemptId: String(at[0]._id), reason: 'anulada', actor: 'admin:teste' });
  // B: nota muda depois da confirmação e antes de começar; C: excluído.
  await M.results.adjustScore({ attemptId: String(at[1]._id), score: 10, reason: 'erro', actor: 'admin:teste' });
  await M.results.softDeleteResult({ attemptId: String(at[2]._id), reason: 'anulada', actor: 'admin:teste' });

  const a = await progress(jobId, { leaseToken: lease, memberDiscordId: A, phase: 'result', roleIds: `${H.ADD1},${H.ADD2}`, nickname: '『TCEL•B』Silva | 1' });
  assert.equal(a.body.data.itemStatus, 'completed');
  const aDoc = await M.Promotion.findOne({ discordUserId: A }).lean();
  assert.match(aDoc.conflict, /excluído depois/);
  assert.equal(a.body.data.jobDone, 'true');
  assert.equal((await M.Promotion.findOne({ discordUserId: B })).status, 'needs_review');
  const cDoc = await M.Promotion.findOne({ discordUserId: C }).lean();
  assert.equal(cDoc.status, 'blocked');
  assert.equal(cDoc.lockKey, undefined);
  assert.equal(await M.Notification.countDocuments({ kind: 'promotion_announcement' }), 0, 'conflito não é anunciado');
});

test('cargos atribuídos fora da integração exigem revisão; admin aceita e só o apelido é aplicado, sem anúncio', async () => {
  const at = await finished(A, 4);
  const view = await draft();
  await select(view.draftId, [at._id]);
  await fill(view.draftId, A, 'Silva', '1');
  const { conf } = await reviewAndConfirm(view.draftId, 'interacao-z1');
  const jobId = conf.body.data.jobId;
  const claim = await api.call('POST', `/promotion-jobs/${jobId}/claim`, as());
  const pre = await progress(jobId, { leaseToken: claim.body.data.leaseToken, memberDiscordId: A, phase: 'precheck', roleIds: `${H.ADD1},${H.ADD2}`, nickname: 'Outro' });
  assert.equal(pre.body.data.itemStatus, 'needs_review');
  const p = await M.Promotion.findOne({ discordUserId: A });
  await M.promotions.acceptExternalState(p._id, 'admin:teste');
  const claim2 = await api.call('POST', `/promotion-jobs/${jobId}/claim`, as());
  assert.equal(claim2.body.data.memberDiscordId, A);
  const r = await runMember(jobId, claim2.body.data.leaseToken, A, { pre: [H.ADD1, H.ADD2], post: [H.ADD1, H.ADD2], nickname: '『TCEL•B』Silva | 1' });
  assert.equal(r.body.data.itemStatus, 'completed');
  assert.equal(await M.Notification.countDocuments({ kind: 'promotion_announcement' }), 0);
});

test('anúncio sem confirmação fica ambíguo e nunca é repetido sozinho', async () => {
  const at = await finished(A, 4);
  const view = await draft();
  await select(view.draftId, [at._id]);
  await fill(view.draftId, A, 'Silva', '1');
  const { conf } = await reviewAndConfirm(view.draftId, 'interacao-w1');
  const jobId = conf.body.data.jobId;
  const claim = await api.call('POST', `/promotion-jobs/${jobId}/claim`, as());
  await runMember(jobId, claim.body.data.leaseToken, A, { nickname: '『TCEL•B』Silva | 1' });
  const n = await M.Notification.findOne({ kind: 'promotion_announcement' });
  await api.call('POST', `/notifications/${n._id}/claim`, {});
  await M.notifications.expireLeases(new Date(Date.now() + M.notifications.LEASE_MS + 1000));
  assert.equal((await M.Notification.findById(n._id)).status, 'ambiguous');
  assert.equal((await api.call('POST', `/notifications/${n._id}/claim`, {})).body.code, 'ambiguous_needs_review');
  assert.equal((await M.Promotion.findOne({ discordUserId: A })).announced, false);
  // Rodar de novo o lote não cria outro anúncio.
  await api.call('GET', `/promotion-jobs/${jobId}`, as());
  assert.equal(await M.Notification.countDocuments({ kind: 'promotion_announcement' }), 1);
});

test('rascunho expira e é isolado por operador; cancelar não altera ninguém', async () => {
  const at = await finished(A, 4);
  const v1 = await draft(H.OPERATOR);
  const again = await draft(H.OPERATOR);
  assert.equal(again.draftId, v1.draftId, 'reaproveita o rascunho aberto do mesmo operador');
  const v2 = await draft(H.OTHER_OPERATOR);
  assert.notEqual(v2.draftId, v1.draftId);
  await M.Draft.updateOne({ _id: v1.draftId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await select(v1.draftId, [at._id])).body.code, 'draft_expired');
  const cancel = await api.call('POST', `/promotion-drafts/${v2.draftId}/cancel`, as(H.OTHER_OPERATOR));
  assert.equal(cancel.body.code, 'draft_cancelled');
  assert.equal(await M.Promotion.countDocuments(), 0);
});

test('modo "status" (sem lista de cargos): status HTTP de cada pedido decide cada etapa; leitura do membro 404/500', async () => {
  const at = [await finished(A, 4), await finished(B, 4)];
  const view = await draft();
  await select(view.draftId, at.map((a) => a._id));
  await fill(view.draftId, A, 'Silva', '1');
  await fill(view.draftId, B, 'Souza', '2');
  const { conf } = await reviewAndConfirm(view.draftId, 'interacao-s1');
  const jobId = conf.body.data.jobId;
  const lease = (await api.call('POST', `/promotion-jobs/${jobId}/claim`, as())).body.data.leaseToken;

  // Falha ao LER o membro (ex.: 500): nada muda.
  const readFail = await progress(jobId, { leaseToken: lease, memberDiscordId: A, phase: 'precheck', memberStatus: '500', evidenceMode: 'status' });
  assert.equal(readFail.body.code, 'member_read_failed');
  assert.equal((await M.Promotion.findOne({ discordUserId: A })).phase, 'awaiting_precheck');

  const pre = await progress(jobId, { leaseToken: lease, memberDiscordId: A, phase: 'precheck', memberStatus: '200', evidenceMode: 'status' });
  assert.equal(pre.body.data.phase, 'act');
  const res = await progress(jobId, { leaseToken: lease, memberDiscordId: A, phase: 'result', evidenceMode: 'status', statusReport: 'add1=204, add2=403, rem1=204, nick=200' });
  assert.equal(res.body.data.itemStatus, 'partial');
  const aDoc = await M.Promotion.findOne({ discordUserId: A }).lean();
  assert.deepEqual(aDoc.steps.map((s) => s.status), ['done', 'failed', 'done', 'done']);
  assert.match(aDoc.lastError, /HTTP 403/);

  // B saiu do servidor (GET do membro = 404).
  const gone = await progress(jobId, { leaseToken: lease, memberDiscordId: B, phase: 'precheck', memberStatus: '404', evidenceMode: 'status' });
  assert.equal(gone.body.data.itemStatus, 'failed');
  assert.equal(gone.body.data.jobDone, 'true');
});
