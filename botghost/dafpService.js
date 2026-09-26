const mongoose = require('mongoose');
const Room = require('../models/Room');
const ExamAttempt = require('../models/ExamAttempt');
const Exam = require('../models/Exam');
const IntegrationNotification = require('../models/IntegrationNotification');
const { listForDiscord, writtenScore, maxScoreOf, isFinished } = require('../lib/results');
const {
  maxPossibleScore, findExamByRef, RESULT, isPerfectScore, startRoleActions, finishRoleActions, roleActionFields,
} = require('../lib/examGroups');
const { ApiError, boolText } = require('./http');
const { userText, plainText, fmtNumber, fmtDate, fmtDateTime, mention, truncate } = require('./format');
const rooms = require('./roomsService');
const { parseDate } = require('./resultsService');

// Fluxo DAFP (/provas-dafp): consulta das provas do grupo DAFP, sessão
// (= sala) e resultado com aprovação e cargo. Reaproveita as salas,
// tokens, links e a finalização do fluxo TCEL — só a escolha da prova e o
// resultado de aprovação são próprios daqui.

const MAX_OPTIONS = 25;
const SESSION_STATUS = { CREATED: 'CRIADA', IN_PROGRESS: 'EM_ANDAMENTO', FINISHED: 'FINALIZADA', CLOSED: 'ENCERRADA' };

function examView(exam, config) {
  return {
    examId: String(exam._id),
    examSlug: exam.slug || '',
    examName: exam.name,
    examGroup: exam.group || 'TCEL',
    questionCount: String(exam.questionCount),
    pointsPerQuestion: String(exam.pointsPerQuestion),
    examMaxScore: String(maxPossibleScore(exam)),
    durationMinutes: String(exam.durationMinutes),
    autoApproval: boolText(Boolean(exam.autoApproval)),
    passingScore: exam.autoApproval && exam.passingScore != null ? String(exam.passingScore) : '',
    approvedRoleId: exam.autoApproval ? exam.approvedRoleId || '' : '',
    // LEGADO: reprovado não recebe mais cargo (campo mantido, sempre vazio).
    failedRoleId: '',
    resultChannelId: exam.resultChannelId || config.dafp.resultChannelId || '',
    ...globalRoleFields(config),
  };
}

// Cargos globais DAFP da aba Integração (Role base e Mérito).
function globalRoleFields(config) {
  return {
    dafpBaseRoleId: (config.dafp && config.dafp.baseRoleId) || '',
    dafpPerfectScoreRoleId: (config.dafp && config.dafp.perfectScoreRoleId) || '',
  };
}

// 25 opções fixas para um Select Menu do BotGhost; valor = slug da prova
// (estável mesmo se o nome mudar). As que sobram ficam escondidas.
function optionSlots(exams) {
  const slots = {};
  for (let i = 0; i < MAX_OPTIONS; i += 1) {
    const e = exams[i];
    const n = i + 1;
    slots[`opt${n}Label`] = e ? truncate(e.name, 100) : '-';
    slots[`opt${n}Description`] = e ? truncate(`${e.questionCount} questões · ${e.durationMinutes} min${e.autoApproval && e.passingScore != null ? ` · mínimo ${fmtNumber(e.passingScore)}` : ''}`, 100) : '-';
    slots[`opt${n}Value`] = e ? e.slug || String(e._id) : `vazio-${n}`;
    slots[`opt${n}Hide`] = boolText(!e);
    slots[`opt${n}Default`] = 'false';
  }
  return slots;
}

async function listExams(actor) {
  const exams = await rooms.eligibleExams('DAFP');
  return {
    examCount: String(exams.length),
    exams: exams.map((e) => examView(e, actor.config)),
    displayText: exams.map((e, i) => `${i + 1}. ${userText(e.name, 80)} (${e.slug})`).join('\n') || 'Nenhuma prova DAFP apta no site (ativa e com questões ativas).',
    ...optionSlots(exams),
  };
}

// Consulta/validação de UMA prova DAFP por slug ou ID (para quem não usa o
// menu dinâmico). TCEL ou outra prova fora do grupo → exam_not_dafp.
async function getExam(actor, ref) {
  const exam = await findExamByRef(ref);
  if (!exam) throw new ApiError(404, 'exam_not_found', 'Prova não encontrada.');
  if (exam.group !== 'DAFP') throw new ApiError(409, 'exam_not_dafp', 'Esta prova não pertence ao grupo DAFP.');
  const eligible = (await rooms.eligibleExams('DAFP')).some((e) => String(e._id) === String(exam._id));
  return { ...examView(exam, actor.config), active: boolText(Boolean(exam.active)), eligible: boolText(eligible), displayText: `${exam.name} (${exam.slug})${eligible ? '' : ' — indisponível: inativa ou sem questões ativas'}` };
}

function sessionStatusOf(room, attempt) {
  if (attempt && !attempt.deletedAt) return attempt.status === 'in_progress' ? SESSION_STATUS.IN_PROGRESS : SESSION_STATUS.FINISHED;
  if (room && room.status === 'closed') return SESSION_STATUS.CLOSED;
  return SESSION_STATUS.CREATED;
}

// Campos do resultado DAFP — os MESMOS nomes na consulta da sessão, na
// lista de resultados e na notificação (claim) do webhook.
function resultFields(attempt, { room = null, exam = null, config, published = false } = {}) {
  const finished = Boolean(attempt && !attempt.deletedAt && isFinished(attempt));
  const o = (attempt && attempt.outcome) || {};
  const examName = (exam && exam.name) || o.examName || (attempt && attempt.examId && attempt.examId.name) || '';
  const score = finished ? writtenScore(attempt) : null;
  let max = exam ? maxPossibleScore(exam) : null;
  if (attempt) max = attempt.maxScoreComputed != null ? attempt.maxScoreComputed : maxScoreOf(attempt);
  const decided = finished && o.decidedAt;
  const studentId = (attempt && attempt.discordUserId) || (room && room.discordUserId) || '';
  const supId = (attempt && attempt.supervisorDiscordId) || (room && room.supervisor && room.supervisor.discordUserId) || '';
  const supName = (attempt && attempt.supervisorDisplayName) || (room && room.supervisor && room.supervisor.displayName) || '';
  return {
    sessionId: room ? String(room._id) : (attempt ? String(attempt.roomId) : ''),
    attemptId: attempt ? String(attempt._id) : '',
    sessionStatus: sessionStatusOf(room, attempt),
    examId: exam ? String(exam._id) : (attempt ? String(attempt.examId && attempt.examId._id ? attempt.examId._id : attempt.examId) : ''),
    examSlug: (exam && exam.slug) || o.examSlug || (attempt && attempt.examId && attempt.examId.slug) || '',
    examName: plainText(examName, 100),
    examGroup: 'DAFP',
    studentDiscordId: studentId,
    studentMention: studentId ? mention(studentId) : '',
    studentDisplayName: plainText((attempt && attempt.studentName) || (room && room.studentName) || '', 80),
    studentAvatarUrl: (attempt && attempt.studentAvatarUrl) || (room && room.studentAvatarUrl) || '',
    supervisorDiscordId: supId,
    supervisorMention: supId ? mention(supId) : '',
    supervisorDisplayName: plainText(supName, 80),
    score: score == null ? '' : fmtNumber(score),
    maxScore: max == null ? '' : fmtNumber(max),
    scoreText: score == null ? '' : `${fmtNumber(score)}/${fmtNumber(max)}`,
    autoApproval: decided ? boolText(Boolean(o.autoApproval)) : '',
    passingScore: decided && o.autoApproval && o.passingScore != null ? fmtNumber(o.passingScore) : '',
    resultStatus: decided ? o.resultStatus || RESULT.NOT_APPLICABLE : '',
    passed: decided && o.autoApproval ? boolText(o.resultStatus === RESULT.APPROVED) : '',
    resultRoleId: decided ? o.resultRoleId || '' : '',
    approvedRoleId: decided ? o.approvedRoleId || '' : '',
    // LEGADO: só resultados antigos (anteriores ao fim do cargo de reprovado).
    failedRoleId: decided ? o.failedRoleId || '' : '',
    resultChannelId: o.resultChannelId || (exam && exam.resultChannelId) || config.dafp.resultChannelId || '',
    finishedAt: finished && attempt.finishedAt ? new Date(attempt.finishedAt).toISOString() : '',
    finishedAtText: finished ? fmtDateTime(attempt.finishedAt) : '',
    resultPublished: boolText(Boolean(published)),
    // Nota máxima (decidido no servidor na finalização). Resultados de antes
    // deste campo: calculado da nota gravada.
    perfectScore: decided ? boolText(o.perfectScore != null ? Boolean(o.perfectScore) : isPerfectScore(score, max)) : '',
    finishReason: decided ? o.finishReason || '' : '',
    ...globalRoleFields(config),
    ...phaseRoleActions(attempt, finished),
  };
}

// Ações de cargo da fase atual da sessão (as mesmas que a fila entrega ao
// BotGhost): START = tirar a Role base; FINISH = devolver + aprovado + Mérito.
function phaseRoleActions(attempt, finished) {
  if (attempt && !attempt.deletedAt && attempt.status === 'in_progress' && attempt.dafpBaseRoleRemovedId) {
    return { roleActionsPhase: 'START', ...roleActionFields(startRoleActions(attempt)) };
  }
  if (attempt && (finished || (attempt.deletedAt && attempt.dafpBaseRoleRemovedId))) {
    return { roleActionsPhase: 'FINISH', ...roleActionFields(finishRoleActions(attempt)) };
  }
  return { roleActionsPhase: '', ...roleActionFields([]) };
}

async function publishedMap(attemptIds) {
  if (!attemptIds.length) return new Set();
  const delivered = await IntegrationNotification.find({ key: { $in: attemptIds.map((id) => `result:${id}`) }, status: 'delivered' }).select('attemptId').lean();
  return new Set(delivered.map((n) => String(n.attemptId)));
}

// Situação atual da sessão (sala) DAFP e, se finalizada, o resultado já
// gravado. Só lê: nunca recalcula nota nem aprovação.
async function getSession(actor, sessionId) {
  const room = await Room.findOne({ _id: sessionId, discordGuildId: actor.guildId }).lean();
  if (!room) throw new ApiError(404, 'session_not_found', 'Sessão não encontrada.');
  if (room.examGroup !== 'DAFP') throw new ApiError(409, 'session_not_dafp', 'Esta sessão não é do fluxo DAFP.');
  let attempt = null;
  if (room.currentAttemptId) attempt = await ExamAttempt.findById(room.currentAttemptId).select('-snapshot -auditTrail -focusEvents -streamEvents').lean();
  if (!attempt) {
    attempt = await ExamAttempt.findOne({ roomId: room._id, deletedAt: null }).sort({ createdAt: -1 }).select('-snapshot -auditTrail -focusEvents -streamEvents').lean();
  }
  if (attempt && attempt.deletedAt) attempt = null;
  const exam = await Exam.findById(room.examId).lean();
  const published = attempt ? (await publishedMap([String(attempt._id)])).has(String(attempt._id)) : false;
  const data = resultFields(attempt, { room, exam, config: actor.config, published });
  const msg = {
    [SESSION_STATUS.CREATED]: 'Sessão criada: o aluno ainda não começou a prova.',
    [SESSION_STATUS.IN_PROGRESS]: 'Prova em andamento.',
    [SESSION_STATUS.FINISHED]: data.resultStatus && data.resultStatus !== RESULT.NOT_APPLICABLE
      ? `Prova finalizada: ${data.scoreText} — ${data.resultStatus}.`
      : `Prova finalizada: ${data.scoreText}.`,
    [SESSION_STATUS.CLOSED]: 'Sessão encerrada pelo admin sem prova finalizada.',
  }[data.sessionStatus];
  return { ...data, displayText: msg };
}

function line(f, index) {
  const who = f.studentMention || '*não vinculado*';
  const status = f.resultStatus === RESULT.APPROVED ? '✅ APROVADO' : f.resultStatus === RESULT.FAILED ? '❌ REPROVADO' : 'sem aprovação automática';
  return `**${index}.** ${who} · ${userText(f.studentDisplayName, 40)} — ${userText(f.examName, 40)} — **${f.scoreText}** — ${status} · avaliador ${f.supervisorMention || '—'} · ${fmtDate(f.finishedAt)}`;
}

const SINGLE_KEYS = ['sessionId', 'attemptId', 'sessionStatus', 'examId', 'examSlug', 'examName', 'studentDiscordId', 'studentMention', 'studentDisplayName', 'studentAvatarUrl',
  'supervisorDiscordId', 'supervisorMention', 'supervisorDisplayName', 'score', 'maxScore', 'scoreText', 'autoApproval', 'passingScore', 'resultStatus', 'passed',
  'resultRoleId', 'approvedRoleId', 'failedRoleId', 'resultChannelId', 'finishedAt', 'finishedAtText', 'resultPublished', 'perfectScore', 'finishReason'];

// Lista paginada dos resultados DAFP (finalizados, não excluídos nem
// arquivados). Com exatamente uma prova na página, os campos dela também
// vêm soltos com prefixo "result" (resultScoreText, resultRoleId...).
async function listResults(actor, { studentDiscordId, examRef, from, to, page, pageSize }) {
  let examId = null;
  if (examRef) {
    const exam = await findExamByRef(examRef);
    if (!exam || exam.group !== 'DAFP') throw new ApiError(404, 'exam_not_found', 'Prova DAFP não encontrada.');
    examId = String(exam._id);
  }
  const data = await listForDiscord({
    guildId: actor.guildId, userId: studentDiscordId, examId, from: parseDate(from, false), to: parseDate(to, true), sort: 'date-desc', page, pageSize, group: 'DAFP',
  });
  const published = await publishedMap(data.items.map((i) => String(i._id)));
  const items = data.items.map((item) => resultFields(item, { config: actor.config, published: published.has(String(item._id)) }));
  const out = {
    total: String(data.total),
    page: String(data.page),
    pageNumber: String(data.page + 1),
    pages: String(data.pages),
    pageSize: String(pageSize),
    hasPrevious: boolText(data.page > 0),
    hasNext: boolText(data.page < data.pages - 1),
    previousPage: String(Math.max(0, data.page - 1)),
    nextPage: String(Math.min(data.pages - 1, data.page + 1)),
    items,
    displayText: items.length ? `${items.map((f, i) => line(f, data.page * pageSize + i + 1)).join('\n')}\n\nPágina ${data.page + 1}/${data.pages}` : 'Nenhum resultado DAFP encontrado.',
    resultSingle: boolText(items.length === 1),
  };
  // Campos que já começam com "result" (resultStatus, resultRoleId,
  // resultChannelId, resultPublished) mantêm o mesmo nome.
  for (const k of SINGLE_KEYS) out[k.startsWith('result') ? k : `result${k[0].toUpperCase()}${k.slice(1)}`] = items.length === 1 ? items[0][k] : '';
  return out;
}

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id) && /^[a-f0-9]{24}$/i.test(String(id));
}

module.exports = { listExams, getExam, getSession, listResults, resultFields, sessionStatusOf, examView, isValidId, SESSION_STATUS };
