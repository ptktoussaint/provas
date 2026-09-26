const express = require('express');
const rateLimit = require('express-rate-limit');
const { createKeyAuth, resolveActor } = require('./auth');
const { idempotent } = require('./idempotency');
const {
  ApiError, reply, wrap, reqSnowflake, reqUserInput, optText, reqText, optObjectId, reqObjectId, optInt, csvList, boolText,
} = require('./http');
const { isSnowflake, parseUserIdInput } = require('../lib/discordIds');
const { avatarUrl } = require('./format');
const { deniedMessage, baseContext, renderForApi } = require('./messages');
const configStore = require('./configStore');
const rooms = require('./roomsService');
const results = require('./resultsService');
const promotions = require('./promotionsService');
const notifications = require('./notifications');
const dafp = require('./dafpService');
const { MAX_SELECTIONS } = require('./selection');

// API máquina-a-máquina do BotGhost: /api/integrations/botghost/*.
// Montada ANTES da sessão e do CSRF das páginas (server.js): aqui não há
// cookie nem sessão — só a chave do header Authorization. As rotas /api/admin
// continuam exigindo login do admin; nada daqui dá acesso a elas.

const ACTIONS = { generate: 'generate', results: 'results', promote: 'promote', any: 'any', dafp: 'dafp' };

function createIntegrationRouter({ getEnv, getPublicBaseUrl, onNotificationCreated = () => {} }) {
  const router = express.Router();

  // Tamanho máximo pequeno: nenhum pedido legítimo passa de poucos KB.
  router.use(express.json({ limit: '32kb' }));
  router.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') return reply(res, 413, 'payload_too_large', 'Pedido grande demais.');
    if (err && err.type === 'entity.parse.failed') return reply(res, 400, 'invalid_json', 'Corpo do pedido não é JSON válido. Confira o Request Body no BotGhost.');
    return next(err);
  });

  // Antes da chave: só conta tentativas que falharam (chave errada/ausente),
  // para dificultar adivinhação sem atrapalhar o uso normal.
  router.use(rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (req, res) => res.statusCode !== 401,
    handler: (req, res) => reply(res, 429, 'rate_limited', 'Muitas tentativas sem chave válida. Aguarde alguns minutos.'),
  }));
  router.use(createKeyAuth(getEnv));
  // Depois da chave: teto geral (o BotGhost é o único cliente legítimo).
  router.use(rateLimit({
    windowMs: 60 * 1000,
    limit: 240,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: () => 'botghost',
    handler: (req, res) => reply(res, 429, 'rate_limited', 'Muitos pedidos em sequência. Aguarde um instante e tente de novo.'),
  }));

  // Resolve servidor/operador antes do handler; negações levam a mensagem
  // pronta do modelo "Acesso negado".
  function route(action, handler) {
    return wrap(async (req, res) => {
      let actor = null;
      if (action) {
        try {
          actor = await resolveActor(req, action, getEnv);
        } catch (err) {
          if (err instanceof ApiError && err.status === 403) {
            const src = req.method === 'GET' ? req.query : (req.body || {});
            const who = isSnowflake(String(src.actorDiscordId || '')) ? String(src.actorDiscordId) : '';
            err.data = { ...err.data, ...(await deniedMessage({ actorDiscordId: who, actorDisplayName: '' }, err.message)) };
          }
          throw err;
        }
      }
      await handler(req, res, actor);
    });
  }

  function send(res, out) {
    return reply(res, out.status || 200, out.code, out.message, out.data || {});
  }

  // ---------------- Saúde ----------------

  // Teste primeiro esta rota no Request Builder. Com guildId/actorDiscordId,
  // também diz o que aquele operador pode usar (para mostrar botões).
  router.get('/health', wrap(async (req, res) => {
    const env = getEnv();
    const config = await configStore.getConfig();
    const data = {
      site: 'online',
      serverTime: new Date().toISOString(),
      notificationsEnabled: boolText(Boolean(env.notificationsEnabled && env.webhookUrl && env.webhookApiKey)),
      guildConfigured: boolText(Boolean(env.allowedGuildId)),
    };
    const guildId = String(req.query.guildId || '');
    const actorId = String(req.query.actorDiscordId || '');
    if (guildId || actorId) {
      const sameGuild = Boolean(env.allowedGuildId) && guildId === env.allowedGuildId;
      const ops = config.operatorIds;
      data.guildAllowed = boolText(sameGuild);
      data.canGenerate = boolText(sameGuild && ops.generate.includes(actorId));
      data.canResults = boolText(sameGuild && ops.results.includes(actorId));
      data.canPromote = boolText(sameGuild && ops.promote.includes(actorId));
    }
    data.displayText = 'Site da Prova TCEL online.';
    return reply(res, 200, 'healthy', 'Site online e chave aceita.', data);
  }));

  // ---------------- Painel ----------------

  router.get('/panel', route(ACTIONS.any, async (req, res, actor) => {
    const msg = await renderForApi('panel', baseContext(actor));
    return reply(res, 200, 'panel', 'Conteúdo atual do painel.', msg);
  }));

  // Depois de publicar o painel, o BotGhost registra o ID da mensagem para
  // o botão "Atualizar painel" do admin poder editá-la.
  router.post('/panel/register', route(ACTIONS.any, async (req, res, actor) => {
    const channelId = reqSnowflake(req.body, 'panelChannelId', 'Canal do painel');
    const messageId = reqSnowflake(req.body, 'panelMessageId', 'Mensagem do painel');
    if (actor.config.channels.panel && channelId !== actor.config.channels.panel) {
      throw new ApiError(403, 'wrong_channel', 'O painel só pode ser registrado no canal configurado.');
    }
    await configStore.setPanelMessage(channelId, messageId);
    return reply(res, 200, 'panel_registered', 'Painel registrado. O admin já pode atualizá-lo pelo site.', { panelChannelId: channelId, panelMessageId: messageId });
  }));

  // ---------------- Gerar prova ----------------

  // Fluxo TCEL: com a prova fixa "tcel" definida, só ela aparece (e é a
  // padrão); nunca provas DAFP.
  router.get('/exams', route(ACTIONS.generate, async (req, res, actor) => {
    const choice = await rooms.resolveTcel(null, actor.config.defaultExamId);
    const exams = choice.exams || [];
    const def = choice.fixed ? String(choice.exam._id) : actor.config.defaultExamId;
    const hasDefault = Boolean(def && exams.some((e) => String(e._id) === def));
    return reply(res, 200, 'exams', `${exams.length} prova(s) apta(s).`, {
      examCount: String(exams.length),
      defaultExamId: hasDefault ? def : '',
      choiceRequired: boolText(!hasDefault && exams.length > 1),
      displayText: exams.map((e, i) => `${i + 1}. ${e.name}`).join('\n') || 'Nenhuma prova apta no site.',
      ...rooms.examOptionSlots(exams, hasDefault ? def : null),
    });
  }));

  // Fiscal escolhido no formulário (opcional: sem ele, a sala sai como no
  // fluxo antigo, com o link de fiscal do operador). Aceita ID ou menção.
  function optSupervisor(body) {
    const raw = body ? body.supervisorDiscordId : undefined;
    if (raw === undefined || raw === null || String(raw).trim() === '') return null;
    return reqUserInput(body, 'supervisorDiscordId', 'Fiscal');
  }

  // Sem efeito colateral: interpreta o ID/menção digitado e avisa sala aberta.
  router.post('/rooms/prepare', route(ACTIONS.generate, async (req, res, actor) => {
    const studentDiscordId = reqUserInput(req.body, 'student', 'Aluno');
    const supervisorDiscordId = optSupervisor(req.body);
    const examId = optObjectId(req.body, 'examId', 'Prova');
    const data = await rooms.prepare(actor, { studentDiscordId, supervisorDiscordId, examId });
    return reply(res, 200, 'ready', 'Pronto para criar a sala.', data);
  }));

  router.post('/rooms', route(ACTIONS.generate, async (req, res, actor) => {
    const studentDiscordId = reqUserInput(req.body, 'student', 'Aluno');
    const examId = optObjectId(req.body, 'examId', 'Prova');
    const studentDisplayName = optText(req.body, 'studentDisplayName', 80);
    const supervisorDiscordId = optSupervisor(req.body);
    const supervisorDisplayName = supervisorDiscordId ? optText(req.body, 'supervisorDisplayName', 80) : '';
    // Foto inválida/ausente não impede a sala: só não é guardada.
    const studentAvatarUrl = avatarUrl(optText(req.body, 'studentAvatarUrl', 400), studentDiscordId);
    // Campos novos só entram no conteúdo comparado quando enviados: um
    // pedido repetido do fluxo antigo continua batendo com o original.
    const payload = { studentDiscordId, examId, studentDisplayName };
    if (supervisorDiscordId) Object.assign(payload, { supervisorDiscordId, supervisorDisplayName });
    if (studentAvatarUrl) payload.studentAvatarUrl = studentAvatarUrl;
    const out = await idempotent({
      req,
      route: 'rooms',
      actorDiscordId: actor.actorDiscordId,
      payload,
      run: () => rooms.create(actor, {
        studentDiscordId, studentDisplayName, supervisorDiscordId, supervisorDisplayName, studentAvatarUrl, examId, idempotencyKey: req.body.idempotencyKey, publicBaseUrl: getPublicBaseUrl(),
      }),
    });
    return send(res, out);
  }));

  router.post('/rooms/:id/regenerate-links', route(ACTIONS.generate, async (req, res, actor) => {
    const roomId = reqObjectId(req.params.id, 'Sala');
    const out = await idempotent({
      req,
      route: 'regenerate',
      actorDiscordId: actor.actorDiscordId,
      payload: { roomId },
      run: () => rooms.regenerate(actor, roomId, { publicBaseUrl: getPublicBaseUrl() }),
    });
    return send(res, out);
  }));

  // ---------------- DAFP (/provas-dafp) ----------------
  // Rotas próprias: só provas do grupo DAFP entram e saem daqui. As rotas
  // TCEL acima continuam exatamente como antes (sempre a prova "tcel").

  function studentParam(src) {
    const raw = String((src && src.student) || '').trim();
    if (!raw) return null;
    const id = parseUserIdInput(raw);
    if (!id) throw new ApiError(400, 'invalid_user', 'Usuário: informe o ID (17 a 20 dígitos) ou a menção <@ID>.', { field: 'student' });
    return id;
  }

  function examRef(src) {
    return optText(src, 'examSlug', 60) || optText(src, 'examId', 60) || optText(src, 'exam', 60);
  }

  function requireSupervisor(body) {
    const id = optSupervisor(body);
    if (!id) throw new ApiError(400, 'supervisor_required', 'Avaliador: informe o ID ou a menção do avaliador (supervisorDiscordId).', { field: 'supervisorDiscordId' });
    return id;
  }

  router.get('/dafp/exams', route(ACTIONS.dafp, async (req, res, actor) => {
    const data = await dafp.listExams(actor);
    return reply(res, 200, 'dafp_exams', `${data.examCount} prova(s) DAFP apta(s).`, data);
  }));

  router.get('/dafp/exams/:ref', route(ACTIONS.dafp, async (req, res, actor) => {
    const data = await dafp.getExam(actor, String(req.params.ref || '').slice(0, 60));
    return reply(res, 200, 'dafp_exam', 'Prova DAFP encontrada.', data);
  }));

  router.post('/dafp/rooms/prepare', route(ACTIONS.dafp, async (req, res, actor) => {
    const studentDiscordId = reqUserInput(req.body, 'student', 'Aluno');
    const supervisorDiscordId = requireSupervisor(req.body);
    const data = await rooms.prepare(actor, { studentDiscordId, supervisorDiscordId, examId: examRef(req.body), group: 'DAFP' });
    return reply(res, 200, 'ready', 'Pronto para criar a sessão DAFP.', data);
  }));

  router.post('/dafp/rooms', route(ACTIONS.dafp, async (req, res, actor) => {
    const studentDiscordId = reqUserInput(req.body, 'student', 'Aluno');
    const supervisorDiscordId = requireSupervisor(req.body);
    const exam = examRef(req.body);
    const studentDisplayName = optText(req.body, 'studentDisplayName', 80);
    const supervisorDisplayName = optText(req.body, 'supervisorDisplayName', 80);
    const studentAvatarUrl = avatarUrl(optText(req.body, 'studentAvatarUrl', 400), studentDiscordId);
    const payload = { flow: 'DAFP', studentDiscordId, supervisorDiscordId, supervisorDisplayName, exam, studentDisplayName };
    if (studentAvatarUrl) payload.studentAvatarUrl = studentAvatarUrl;
    const out = await idempotent({
      req,
      route: 'dafp_rooms',
      actorDiscordId: actor.actorDiscordId,
      payload,
      run: () => rooms.create(actor, {
        studentDiscordId, studentDisplayName, supervisorDiscordId, supervisorDisplayName, studentAvatarUrl, examId: exam, idempotencyKey: req.body.idempotencyKey, publicBaseUrl: getPublicBaseUrl(), group: 'DAFP',
      }),
    });
    return send(res, out);
  }));

  router.post('/dafp/rooms/:id/regenerate-links', route(ACTIONS.dafp, async (req, res, actor) => {
    const roomId = reqObjectId(req.params.id, 'Sessão');
    const room = await require('../models/Room').findOne({ _id: roomId, discordGuildId: actor.guildId }).select('examGroup').lean();
    if (room && room.examGroup !== 'DAFP') throw new ApiError(409, 'session_not_dafp', 'Esta sessão não é do fluxo DAFP.');
    const out = await idempotent({
      req,
      route: 'dafp_regenerate',
      actorDiscordId: actor.actorDiscordId,
      payload: { roomId },
      run: () => rooms.regenerate(actor, roomId, { publicBaseUrl: getPublicBaseUrl() }),
    });
    return send(res, out);
  }));

  router.get('/dafp/sessions/:id', route(ACTIONS.dafp, async (req, res, actor) => {
    const data = await dafp.getSession(actor, reqObjectId(req.params.id, 'Sessão'));
    return reply(res, 200, 'dafp_session', data.displayText, data);
  }));

  router.get('/dafp/results', route(ACTIONS.dafp, async (req, res, actor) => {
    const data = await dafp.listResults(actor, {
      studentDiscordId: studentParam(req.query),
      examRef: examRef(req.query),
      from: optText(req.query, 'from', 10),
      to: optText(req.query, 'to', 10),
      page: optInt(req.query, 'page', { min: 0, max: 100000, def: 0 }),
      pageSize: optInt(req.query, 'pageSize', { min: 1, max: 25, def: 10 }),
    });
    return reply(res, 200, data.items.length ? 'dafp_results' : 'dafp_results_empty', data.items.length ? `Página ${data.pageNumber} de ${data.pages}.` : 'Nenhum resultado DAFP encontrado.', data);
  }));

  // ---------------- Conferir resultados ----------------

  router.get('/results', route(ACTIONS.results, async (req, res, actor) => {
    const raw = String(req.query.student || '').trim();
    let studentDiscordId = null;
    if (raw) {
      studentDiscordId = parseUserIdInput(raw);
      if (!studentDiscordId) throw new ApiError(400, 'invalid_user', 'Usuário: informe o ID (17 a 20 dígitos) ou a menção <@ID>.', { field: 'student' });
    }
    const data = await results.search(actor, {
      studentDiscordId,
      examId: optObjectId(req.query, 'examId', 'Prova'),
      from: optText(req.query, 'from', 10),
      to: optText(req.query, 'to', 10),
      sort: optText(req.query, 'sort', 20) || 'date-desc',
      page: optInt(req.query, 'page', { min: 0, max: 100000, def: 0 }),
      pageSize: optInt(req.query, 'pageSize', { min: 1, max: 25, def: 10 }),
    });
    return reply(res, 200, data.items.length ? 'results' : 'results_empty', data.items.length ? `Página ${data.pageNumber} de ${data.pages}.` : 'Nenhum resultado encontrado.', data);
  }));

  // ---------------- Promoção ----------------

  router.get('/promotion-candidates', route(ACTIONS.promote, async (req, res, actor) => {
    const raw = String(req.query.student || '').trim();
    const studentDiscordId = raw ? parseUserIdInput(raw) : null;
    if (raw && !studentDiscordId) throw new ApiError(400, 'invalid_user', 'Usuário: informe o ID ou a menção.', { field: 'student' });
    const page = optInt(req.query, 'page', { min: 0, max: 100000, def: 0 });
    const c = await promotions.listCandidates(actor.guildId, { studentDiscordId, page });
    return reply(res, 200, 'candidates', `${c.total} resultado(s) candidato(s).`, {
      total: String(c.total),
      page: String(c.page),
      pageNumber: String(c.page + 1),
      pages: String(c.pages),
      hasPrevious: boolText(c.page > 0),
      hasNext: boolText(c.page < c.pages - 1),
      ...promotions.candidateSlots(c.items, new Set()),
    });
  }));

  function draftIdParam(req) {
    return reqObjectId(req.params.id, 'Rascunho');
  }

  router.post('/promotion-drafts', route(ACTIONS.promote, async (req, res, actor) => {
    const { draft, reused } = await promotions.getOrCreateDraft(actor);
    const view = await promotions.draftView(actor, draft, { page: 0 });
    return reply(res, reused ? 200 : 201, reused ? 'draft_resumed' : 'draft_created', reused ? 'Continuando o seu rascunho de promoção.' : 'Rascunho de promoção criado.', { reused: boolText(reused), ...view });
  }));

  router.get('/promotion-drafts/:id', route(ACTIONS.promote, async (req, res, actor) => {
    const draft = await promotions.loadOwnedDraft(actor, draftIdParam(req));
    const view = await promotions.draftView(actor, draft, { page: optInt(req.query, 'page', { min: 0, max: 100000, def: 0 }) });
    return reply(res, 200, 'draft', 'Rascunho atual.', view);
  }));

  router.post('/promotion-drafts/:id/selection', route(ACTIONS.promote, async (req, res, actor) => {
    const page = optInt(req.body, 'page', { min: 0, max: 100000, def: 0 });
    const draft = await promotions.updateSelection(actor, draftIdParam(req), {
      page,
      attemptIds: csvList(req.body, 'attemptIds', { max: 25, pattern: /^[a-f0-9]{24}$|^vazio-\d{1,2}$/i }).filter((x) => !x.startsWith('vazio-')),
      discordUserIds: csvList(req.body, 'discordUserIds', { max: MAX_SELECTIONS, pattern: /^\d{17,20}$/ }),
      removeDiscordUserIds: csvList(req.body, 'removeDiscordUserIds', { max: MAX_SELECTIONS, pattern: /^\d{17,20}$/ }),
    });
    const view = await promotions.draftView(actor, draft, { page });
    return reply(res, 200, 'selection_saved', `Seleção salva (${view.selectedCount}/${MAX_SELECTIONS}).`, view);
  }));

  router.post('/promotion-drafts/:id/members', route(ACTIONS.promote, async (req, res, actor) => {
    const discordUserId = reqUserInput(req.body, 'member', 'Membro');
    const { draft, nickname } = await promotions.setMember(actor, draftIdParam(req), {
      discordUserId,
      nomeRP: optText(req.body, 'nomeRP', 64),
      idRP: optText(req.body, 'idRP', 32),
    });
    const view = await promotions.draftView(actor, draft, { page: optInt(req.body, 'page', { min: 0, max: 100000, def: 0 }) });
    return reply(res, 200, 'member_saved', `Dados salvos. Apelido: ${nickname}`, { nickname, ...view });
  }));

  router.post('/promotion-drafts/:id/review', route(ACTIONS.promote, async (req, res, actor) => {
    const data = await promotions.review(actor, draftIdParam(req));
    return reply(res, 200, data.canConfirm === 'true' ? 'review_ok' : 'review_blocked', data.canConfirm === 'true' ? 'Revisão pronta: confira e confirme.' : 'Há bloqueios: corrija antes de confirmar.', data);
  }));

  router.post('/promotion-drafts/:id/confirm', route(ACTIONS.promote, async (req, res, actor) => {
    const draftId = draftIdParam(req);
    const hash = reqText(req.body, 'reviewHash', 'reviewHash', 64);
    const out = await idempotent({
      req,
      route: 'confirm',
      actorDiscordId: actor.actorDiscordId,
      payload: { draftId, hash },
      run: async () => {
        const data = await promotions.confirm(actor, draftId, hash);
        return { status: 201, code: 'job_created', message: 'Promoção confirmada. Execute o lote agora.', data, replayData: data };
      },
    });
    return send(res, out);
  }));

  router.post('/promotion-drafts/:id/cancel', route(ACTIONS.promote, async (req, res, actor) => {
    const data = await promotions.cancelDraft(actor, draftIdParam(req));
    return reply(res, 200, 'draft_cancelled', 'Rascunho cancelado. Nenhum membro foi alterado.', data);
  }));

  function jobIdParam(req) {
    return reqObjectId(req.params.id, 'Lote');
  }

  router.post('/promotion-jobs/:id/claim', route(ACTIONS.promote, async (req, res, actor) => {
    const data = await promotions.claimJob(actor, jobIdParam(req));
    onNotificationCreated();
    return reply(res, 200, 'job_claimed', data.hasItem === 'true' ? `Próximo: ${data.memberMention}` : 'Nenhuma pessoa pendente neste lote.', data);
  }));

  router.post('/promotion-jobs/:id/progress', route(ACTIONS.promote, async (req, res, actor) => {
    const body = req.body || {};
    const data = await promotions.progress(actor, jobIdParam(req), {
      leaseToken: reqText(body, 'leaseToken', 'leaseToken', 64),
      memberDiscordId: reqSnowflake(body, 'memberDiscordId', 'Membro'),
      phase: optText(body, 'phase', 20),
      memberFound: optText(body, 'memberFound', 5) || 'true',
      roleIds: Array.isArray(body.roleIds) ? body.roleIds.slice(0, 300) : optText(body, 'roleIds', 8000),
      nickname: body.nickname == null ? '' : String(body.nickname).slice(0, 64),
      actionError: optText(body, 'actionError', 300),
      memberStatus: optText(body, 'memberStatus', 10),
      evidenceMode: optText(body, 'evidenceMode', 10),
      statusReport: optText(body, 'statusReport', 300),
    });
    onNotificationCreated();
    return reply(res, 200, 'progress_saved', `Situação de ${data.memberMention || 'membro'}: ${data.itemStatus}.`, data);
  }));

  router.get('/promotion-jobs/:id', route(ACTIONS.promote, async (req, res, actor) => {
    const data = await promotions.getJob(actor, jobIdParam(req));
    return reply(res, 200, 'job', 'Situação atual do lote.', data);
  }));

  router.post('/promotion-jobs/:id/resume', route(ACTIONS.promote, async (req, res, actor) => {
    const data = await promotions.resumeJob(actor, jobIdParam(req));
    return reply(res, 200, 'job_resumed', `${data.resumedCount} pessoa(s) voltaram para a fila. Chame claim para continuar.`, data);
  }));

  // ---------------- Notificações (evento do webhook) ----------------
  // Sem operador: quem chama é o evento "Webhook" do BotGhost, disparado
  // pelo próprio site. A chave basta; a reserva (leaseToken) protege a ação.

  router.post('/notifications/:id/claim', wrap(async (req, res) => {
    const out = await notifications.claim(String(req.params.id));
    return send(res, out);
  }));

  router.post('/notifications/:id/ack', wrap(async (req, res) => {
    const body = req.body || {};
    const out = await notifications.ack(String(req.params.id), {
      leaseToken: optText(body, 'leaseToken', 64),
      outcome: optText(body, 'outcome', 20),
      messageId: optText(body, 'messageId', 25),
      channelId: optText(body, 'channelId', 25),
      error: optText(body, 'error', 300),
    });
    if (out.code === 'acked' || out.code === 'will_retry') onNotificationCreated();
    return send(res, out);
  }));

  router.use((req, res) => reply(res, 404, 'not_found', 'Rota da integração não encontrada. Confira método e URL no guia BOTGHOST-API.md.'));

  return router;
}

module.exports = { createIntegrationRouter };
