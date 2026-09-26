const crypto = require('crypto');
const Room = require('../models/Room');
const Exam = require('../models/Exam');
const Question = require('../models/Question');
const { createRoom, addProctorLink } = require('../lib/rooms');
const { generateToken, hashToken } = require('../lib/tokens');
const { logSecurityEvent } = require('../lib/securityLog');
const { ApiError, boolText } = require('./http');
const { baseContext, renderForApi } = require('./messages');
const { userText, mention, truncate, displayName } = require('./format');
const { TCEL_SLUG, findExamByRef, maxPossibleScore } = require('../lib/examGroups');

// Salas criadas a pedido do BotGhost, pelos MESMOS serviços do painel admin
// (lib/rooms.js). O ID do aluno é o destinatário cadastrado pelo operador —
// não prova quem vai abrir o link.

const OPEN_ROOM_STATUSES = ['pending', 'active'];
const MAX_OPTIONS = 25;

const EXAM_FIELDS = 'name slug group questionCount pointsPerQuestion durationMinutes active autoApproval passingScore approvedRoleId failedRoleId resultChannelId';

// "Apta" = ativa e com pelo menos uma questão ativa (senão a prova não
// conseguiria começar). Só do grupo pedido: provas DAFP nunca aparecem no
// fluxo TCEL e vice-versa (provas antigas sem grupo contam como TCEL).
async function eligibleExams(group = 'TCEL') {
  const withQuestions = await Question.distinct('examId', { active: true });
  const q = { active: true, _id: { $in: withQuestions }, group: group === 'DAFP' ? 'DAFP' : { $ne: 'DAFP' } };
  return Exam.find(q).select(EXAM_FIELDS).sort({ createdAt: -1 }).lean();
}

async function hasActiveQuestions(examId) {
  return Boolean(await Question.exists({ examId, active: true }));
}

// Fluxo TCEL (/provas-tcel): SEMPRE a prova de slug "tcel". O examId
// enviado é ignorado — nenhum pedido pelo fluxo TCEL abre outra prova.
// Só se nenhuma prova tiver o slug (migração não conseguiu decidir), vale a
// regra antiga, limitada às provas do grupo TCEL.
async function resolveTcel(requestedExamId, defaultExamId) {
  const fixed = await Exam.findOne({ slug: TCEL_SLUG }).select(EXAM_FIELDS).lean();
  if (fixed) {
    if (!fixed.active || !(await hasActiveQuestions(fixed._id))) return { error: 'tcel_not_eligible', exams: [] };
    return { exam: fixed, fixed: true, exams: [fixed] };
  }
  const exams = await eligibleExams('TCEL');
  return { ...resolveExam(requestedExamId, defaultExamId, exams), exams };
}

function tcelChoiceError(choice) {
  if (choice.error === 'tcel_not_eligible') return new ApiError(409, 'exam_not_eligible', 'A prova TCEL (identificador "tcel") está inativa ou sem questões ativas. Nenhuma sala foi criada.');
  if (choice.error === 'no_eligible_exam') return new ApiError(409, 'no_eligible_exam', 'Não há prova apta no site (ativa e com questões ativas). Nenhuma sala foi criada.');
  if (choice.error === 'exam_not_eligible') return new ApiError(409, 'exam_not_eligible', 'A prova escolhida não está apta (inativa ou sem questões).');
  return null;
}

// Fluxo DAFP: a prova escolhida (ID ou slug) precisa existir, ser do grupo
// DAFP, estar ativa e ter questões ativas. Nunca pelo nome.
async function resolveDafp(examRef) {
  if (!String(examRef || '').trim()) throw new ApiError(400, 'exam_required', 'Escolha a prova DAFP (examSlug ou examId).', { field: 'examSlug' });
  const exam = await findExamByRef(examRef);
  if (!exam) throw new ApiError(404, 'exam_not_found', 'Prova não encontrada.', { field: 'examSlug' });
  if (exam.group !== 'DAFP') throw new ApiError(409, 'exam_not_dafp', 'Esta prova não pertence ao grupo DAFP e não pode ser iniciada pelo /provas-dafp.', { field: 'examSlug' });
  if (!exam.active) throw new ApiError(409, 'exam_inactive', `A prova "${exam.name}" está desativada no site.`);
  if (!(await hasActiveQuestions(exam._id))) throw new ApiError(409, 'exam_not_eligible', `A prova "${exam.name}" não tem questões ativas.`);
  return exam;
}

function resolveExam(requestedExamId, defaultExamId, exams) {
  if (!exams.length) return { error: 'no_eligible_exam' };
  if (requestedExamId) {
    const found = exams.find((e) => String(e._id) === String(requestedExamId));
    return found ? { exam: found } : { error: 'exam_not_eligible' };
  }
  if (defaultExamId) {
    const found = exams.find((e) => String(e._id) === String(defaultExamId));
    if (found) return { exam: found };
  }
  if (exams.length === 1) return { exam: exams[0] };
  return { choiceRequired: true };
}

// Menu de seleção do BotGhost: 25 opções fixas no bloco, cada uma ligada a
// estas variáveis; as que sobram ficam escondidas (Hide Option = "true").
function examOptionSlots(exams, defaultExamId) {
  const slots = {};
  for (let i = 0; i < MAX_OPTIONS; i += 1) {
    const e = exams[i];
    const n = i + 1;
    slots[`opt${n}Label`] = e ? truncate(e.name, 100) : '-';
    slots[`opt${n}Description`] = e ? truncate(`${e.questionCount} questões · ${e.durationMinutes} min`, 100) : '-';
    slots[`opt${n}Value`] = e ? String(e._id) : `vazio-${n}`;
    slots[`opt${n}Hide`] = boolText(!e);
    slots[`opt${n}Default`] = boolText(Boolean(e && defaultExamId && String(e._id) === String(defaultExamId)));
  }
  return slots;
}

function examListText(exams) {
  return exams.slice(0, MAX_OPTIONS).map((e, i) => `${i + 1}. ${userText(e.name, 80)} (${e.durationMinutes} min)`).join('\n') || 'Nenhuma prova apta.';
}

async function findOpenRoom(guildId, studentId, examId) {
  return Room.findOne({ discordGuildId: guildId, discordUserId: studentId, examId, status: { $in: OPEN_ROOM_STATUSES } }).sort({ createdAt: -1 }).lean();
}

function roomCode(room) {
  return `#${String(room._id).slice(-6)}`;
}

function openRoomError(room) {
  return new ApiError(409, 'room_exists', 'Já existe uma sala aberta para este aluno nesta prova. Os links antigos não podem ser mostrados de novo; se precisar, regenere (os anteriores deixam de funcionar).', {
    roomId: String(room._id),
    roomLabel: room.roomLabel,
    roomCode: roomCode(room),
    roomStatus: room.status,
    supervisorDiscordId: (room.supervisor && room.supervisor.discordUserId) || '',
    canRegenerate: 'true',
  });
}

// Sem efeito colateral: interpreta ID/menção, escolhe a prova e avisa se já
// existe sala aberta. Serve também para "acordar" o site antes do resto.
async function prepare(actor, { studentDiscordId, supervisorDiscordId = null, examId, group = 'TCEL' }) {
  checkSupervisor(studentDiscordId, supervisorDiscordId);
  let choice;
  let exams;
  if (group === 'DAFP') {
    const exam = await resolveDafp(examId);
    choice = { exam };
    exams = [exam];
  } else {
    choice = await resolveTcel(examId, actor.config.defaultExamId);
    const err = tcelChoiceError(choice);
    if (err) throw err;
    exams = choice.exams;
  }
  const data = {
    studentDiscordId,
    studentMention: mention(studentDiscordId),
    supervisorDiscordId: supervisorDiscordId || '',
    supervisorMention: supervisorDiscordId ? mention(supervisorDiscordId) : '',
    examChoiceRequired: boolText(Boolean(choice.choiceRequired)),
    examId: choice.exam ? String(choice.exam._id) : '',
    examName: choice.exam ? choice.exam.name : '',
    examCount: String(exams.length),
    examSlug: choice.exam ? choice.exam.slug || '' : '',
    examListText: examListText(exams),
    ...examOptionSlots(exams, choice.fixed ? choice.exam._id : actor.config.defaultExamId),
  };
  if (choice.exam) {
    const open = await findOpenRoom(actor.guildId, studentDiscordId, choice.exam._id);
    if (open) throw openRoomError(open);
  }
  return data;
}

// Aluno, fiscal e operador são papéis diferentes. O operador pode ser o
// próprio fiscal; o aluno não pode fiscalizar a própria prova.
function checkSupervisor(studentDiscordId, supervisorDiscordId) {
  if (supervisorDiscordId && supervisorDiscordId === studentDiscordId) {
    throw new ApiError(400, 'supervisor_is_student', 'O fiscal não pode ser o próprio aluno. Escolha outra pessoa como fiscal.', { field: 'supervisorDiscordId' });
  }
}

// Dono do link de fiscal da sala: o fiscal escolhido no formulário; em
// salas criadas sem fiscal (fluxo antigo), o operador — como era antes.
function linkOwner(room, actor) {
  if (room.supervisor && room.supervisor.discordUserId) {
    return { discordUserId: room.supervisor.discordUserId, label: room.supervisor.displayName || `Fiscal ${room.supervisor.discordUserId.slice(-4)}`, selected: true };
  }
  return { discordUserId: actor.actorDiscordId, label: actor.actorDisplayName, selected: false };
}

function supervisorData(room) {
  const sup = room.supervisor && room.supervisor.discordUserId ? room.supervisor : null;
  return {
    supervisorDiscordId: sup ? sup.discordUserId : '',
    supervisorDisplayName: sup ? (sup.displayName || '') : '',
    supervisorMention: sup ? mention(sup.discordUserId) : '',
    supervisorSelected: boolText(Boolean(sup)),
  };
}

// Dados fixos da sessão DAFP devolvidos na criação (a configuração de
// aprovação que vale é a da prova no momento da FINALIZAÇÃO).
function dafpSessionData(room, exam, config, studentAvatarUrl) {
  return {
    sessionId: String(room._id),
    sessionStatus: 'CRIADA',
    examGroup: 'DAFP',
    examSlug: exam.slug || '',
    studentMention: mention(room.discordUserId),
    studentAvatarUrl: studentAvatarUrl || '',
    examMaxScore: String(maxPossibleScore(exam)),
    autoApproval: boolText(Boolean(exam.autoApproval)),
    passingScore: exam.autoApproval && exam.passingScore != null ? String(exam.passingScore) : '',
    approvedRoleId: exam.autoApproval ? exam.approvedRoleId || '' : '',
    failedRoleId: '', // LEGADO: reprovado não recebe cargo
    resultChannelId: exam.resultChannelId || config.dafp.resultChannelId || '',
    dafpBaseRoleId: config.dafp.baseRoleId || '',
    dafpPerfectScoreRoleId: config.dafp.perfectScoreRoleId || '',
  };
}

// Evita duas salas abertas para a mesma pessoa/prova quando dois pedidos
// chegam juntos (instância única do site).
const locks = new Map();
async function withLock(key, fn) {
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((r) => { release = r; });
  const chained = previous.then(() => current);
  locks.set(key, chained);
  await previous;
  try { return await fn(); } finally {
    release();
    if (locks.get(key) === chained) locks.delete(key);
  }
}

async function roomMessage(actor, room, exam, studentId, studentUrl, supervisorUrl, owner) {
  return renderForApi('room_created', {
    'fiscal.mencao': mention(owner.discordUserId),
    'fiscal.nome': userText(owner.label, 80),
    'fiscal.discordId': owner.discordUserId,
    ...baseContext(actor),
    'aluno.mencao': mention(studentId),
    'aluno.nome': userText(room.studentName, 80),
    'aluno.discordId': studentId,
    'prova.nome': userText(exam ? exam.name : '—', 100),
    'prova.duracao': exam ? `${exam.durationMinutes} minutos` : '—',
    'sala.nome': userText(room.roomLabel, 60),
    'sala.codigo': roomCode(room),
    'links.aluno': studentUrl,
    'links.fiscal': supervisorUrl,
  });
}

async function create(actor, {
  studentDiscordId, studentDisplayName, supervisorDiscordId = null, supervisorDisplayName = '', studentAvatarUrl = '', examId, idempotencyKey, publicBaseUrl, group = 'TCEL',
}) {
  checkSupervisor(studentDiscordId, supervisorDiscordId);
  return withLock(`${actor.guildId}:${studentDiscordId}`, async () => {
    let choice;
    if (group === 'DAFP') {
      choice = { exam: await resolveDafp(examId) };
    } else {
      choice = await resolveTcel(examId, actor.config.defaultExamId);
      const err = tcelChoiceError(choice);
      if (err) throw err;
      if (choice.choiceRequired) throw new ApiError(422, 'exam_choice_required', 'Há várias provas aptas e nenhuma padrão: escolha a prova.', examOptionSlots(choice.exams, null));
    }
    const examGroup = choice.exam.group === 'DAFP' ? 'DAFP' : 'TCEL';

    const open = await findOpenRoom(actor.guildId, studentDiscordId, choice.exam._id);
    if (open) throw openRoomError(open);

    const requestId = `bg:${crypto.createHash('sha256').update(`${actor.actorDiscordId}:${idempotencyKey}`).digest('hex').slice(0, 32)}`;
    // Sem nome digitado: final do ID, para diferenciar as salas no admin.
    const name = displayName(studentDisplayName) || `Aluno ${studentDiscordId.slice(-4)}`;
    const supervisor = supervisorDiscordId
      ? { discordUserId: supervisorDiscordId, displayName: displayName(supervisorDisplayName) || `Fiscal ${supervisorDiscordId.slice(-4)}` }
      : null;
    let created;
    try {
      created = await createRoom({
        examId: choice.exam._id,
        roomLabel: `Discord ${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
        studentName: name,
        createdVia: 'discord',
        discord: {
          guildId: actor.guildId, userId: studentDiscordId, operatorId: actor.actorDiscordId, operatorName: actor.actorDisplayName, requestId, supervisor, studentAvatarUrl: studentAvatarUrl || null, examGroup,
        },
        // Link de fiscal do fiscal escolhido (sem fiscal no pedido: do
        // operador, como no fluxo antigo).
        initialProctor: supervisor
          ? { label: supervisor.displayName, discordUserId: supervisor.discordUserId }
          : { label: actor.actorDisplayName, discordUserId: actor.actorDiscordId },
      });
    } catch (err) {
      if (err && err.code === 11000) throw new ApiError(409, 'room_already_created', 'Esta solicitação já criou uma sala. Use regenerar links se precisar.');
      throw err;
    }
    const studentUrl = `${publicBaseUrl}${created.studentLink}`;
    const supervisorUrl = `${publicBaseUrl}${created.proctorLink}`;
    await logSecurityEvent('botghost_room_created', {
      meta: { roomId: String(created.room._id), examId: String(choice.exam._id), examGroup, studentDiscordId, supervisorDiscordId, operatorId: actor.actorDiscordId },
    });
    const owner = linkOwner(created.room, actor);
    const msg = await roomMessage(actor, created.room, choice.exam, studentDiscordId, studentUrl, supervisorUrl, owner);
    const safe = {
      roomId: String(created.room._id),
      roomLabel: created.room.roomLabel,
      roomCode: roomCode(created.room),
      examId: String(choice.exam._id),
      examName: choice.exam.name,
      studentDiscordId,
      studentAvatarSaved: boolText(Boolean(studentAvatarUrl)),
      ...supervisorData(created.room),
      ...(examGroup === 'DAFP' ? dafpSessionData(created.room, choice.exam, actor.config, studentAvatarUrl) : {}),
    };
    return {
      status: 201,
      code: 'room_created',
      message: 'Sala criada. Os links vão só nesta resposta privada.',
      data: { ...safe, studentUrl, supervisorUrl, linksAvailable: 'true', ...msg },
      replayCode: 'room_already_created',
      replayMessage: 'Esta solicitação já criou a sala. Os links não podem ser mostrados de novo; use regenerar links (os anteriores deixam de funcionar).',
      replayData: { ...safe, linksAvailable: 'false', canRegenerate: 'true' },
    };
  });
}

// Regeneração EXPLÍCITA: novo link do aluno e novo link de fiscal para o
// fiscal escolhido na criação (salas antigas sem fiscal: o operador); os
// anteriores (aluno + fiscal desse dono) param de funcionar. Quem clicou
// nunca substitui o fiscal. Quem já está na prova não cai.
async function regenerate(actor, roomId, { publicBaseUrl }) {
  const room = await Room.findOne({ _id: roomId, discordGuildId: actor.guildId });
  if (!room) throw new ApiError(404, 'room_not_found', 'Sala não encontrada (ou não foi criada pela integração).');
  if (room.status === 'closed') throw new ApiError(409, 'room_closed', 'Esta sala foi encerrada — gere uma prova nova.');
  // Clique duplo gera dois pedidos distintos: o segundo invalidaria os links
  // que o primeiro acabou de mostrar. Pequena carência evita isso.
  const owner = linkOwner(room, actor);
  const recent = room.proctorTokens.find((t) => t.discordUserId === owner.discordUserId && !t.revokedAt && Date.now() - new Date(t.createdAt).getTime() < 15000);
  if (recent) throw new ApiError(409, 'regenerate_too_soon', 'Os links desta sala acabaram de ser gerados. Use os que já apareceram; se precisar mesmo, tente de novo em alguns segundos.');
  const raw = generateToken();
  room.studentTokenHash = hashToken(raw);
  await room.save();
  const { proctorLink } = await addProctorLink(room._id, { label: owner.label, discordUserId: owner.discordUserId, revokePreviousForDiscordUser: true });
  const exam = await Exam.findById(room.examId).select('name durationMinutes').lean();
  const studentUrl = `${publicBaseUrl}/aluno/${raw}`;
  const supervisorUrl = `${publicBaseUrl}${proctorLink}`;
  await logSecurityEvent('botghost_links_regenerated', { meta: { roomId: String(room._id), operatorId: actor.actorDiscordId, supervisorDiscordId: owner.selected ? owner.discordUserId : null } });
  const msg = await roomMessage(actor, room, exam, room.discordUserId, studentUrl, supervisorUrl, owner);
  const safe = { roomId: String(room._id), roomLabel: room.roomLabel, roomCode: roomCode(room), studentDiscordId: room.discordUserId, ...supervisorData(room) };
  return {
    status: 200,
    code: 'links_regenerated',
    message: 'Novos links gerados; os anteriores deixaram de funcionar.',
    data: { ...safe, studentUrl, supervisorUrl, linksAvailable: 'true', ...msg },
    replayCode: 'links_already_regenerated',
    replayMessage: 'Estes links já foram regenerados por este mesmo pedido e não podem ser reexibidos. Faça uma nova regeneração se precisar.',
    replayData: { ...safe, linksAvailable: 'false' },
  };
}

module.exports = {
  eligibleExams, resolveExam, resolveTcel, resolveDafp, examOptionSlots, prepare, create, regenerate, findOpenRoom, roomCode,
};
