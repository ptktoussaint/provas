const crypto = require('crypto');
const Room = require('../models/Room');
const Exam = require('../models/Exam');
const Question = require('../models/Question');
const { createRoom, addProctorLink } = require('../lib/rooms');
const { generateToken, hashToken } = require('../lib/tokens');
const { logSecurityEvent } = require('../lib/securityLog');
const { ApiError, boolText } = require('./http');
const { baseContext, renderForApi } = require('./messages');
const { userText, mention, truncate } = require('./format');

// Salas criadas a pedido do BotGhost, pelos MESMOS serviços do painel admin
// (lib/rooms.js). O ID do aluno é o destinatário cadastrado pelo operador —
// não prova quem vai abrir o link.

const OPEN_ROOM_STATUSES = ['pending', 'active'];
const MAX_OPTIONS = 25;

// "Apta" = ativa e com pelo menos uma questão ativa (senão a prova não
// conseguiria começar).
async function eligibleExams() {
  const withQuestions = await Question.distinct('examId', { active: true });
  return Exam.find({ active: true, _id: { $in: withQuestions } }).select('name questionCount durationMinutes').sort({ createdAt: -1 }).lean();
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
    canRegenerate: 'true',
  });
}

// Sem efeito colateral: interpreta ID/menção, escolhe a prova e avisa se já
// existe sala aberta. Serve também para "acordar" o site antes do resto.
async function prepare(actor, { studentDiscordId, examId }) {
  const exams = await eligibleExams();
  const choice = resolveExam(examId, actor.config.defaultExamId, exams);
  if (choice.error === 'no_eligible_exam') throw new ApiError(409, 'no_eligible_exam', 'Não há prova apta no site (ativa e com questões ativas). Nenhuma sala foi criada.');
  if (choice.error === 'exam_not_eligible') throw new ApiError(409, 'exam_not_eligible', 'A prova escolhida não está apta (inativa ou sem questões).');
  if (studentDiscordId === actor.actorDiscordId) {
    // Permitido (ex.: teste), mas sinalizado.
  }
  const data = {
    studentDiscordId,
    studentMention: mention(studentDiscordId),
    examChoiceRequired: boolText(Boolean(choice.choiceRequired)),
    examId: choice.exam ? String(choice.exam._id) : '',
    examName: choice.exam ? choice.exam.name : '',
    examCount: String(exams.length),
    examListText: examListText(exams),
    ...examOptionSlots(exams, actor.config.defaultExamId),
  };
  if (choice.exam) {
    const open = await findOpenRoom(actor.guildId, studentDiscordId, choice.exam._id);
    if (open) throw openRoomError(open);
  }
  return data;
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

async function roomMessage(actor, room, exam, studentId, studentUrl, supervisorUrl) {
  return renderForApi('room_created', {
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

async function create(actor, { studentDiscordId, studentDisplayName, examId, idempotencyKey, publicBaseUrl }) {
  return withLock(`${actor.guildId}:${studentDiscordId}`, async () => {
    const exams = await eligibleExams();
    const choice = resolveExam(examId, actor.config.defaultExamId, exams);
    if (choice.error === 'no_eligible_exam') throw new ApiError(409, 'no_eligible_exam', 'Não há prova apta no site. Nenhuma sala foi criada.');
    if (choice.error === 'exam_not_eligible') throw new ApiError(409, 'exam_not_eligible', 'A prova escolhida não está apta (inativa ou sem questões).');
    if (choice.choiceRequired) throw new ApiError(422, 'exam_choice_required', 'Há várias provas aptas e nenhuma padrão: escolha a prova.', examOptionSlots(exams, null));

    const open = await findOpenRoom(actor.guildId, studentDiscordId, choice.exam._id);
    if (open) throw openRoomError(open);

    const requestId = `bg:${crypto.createHash('sha256').update(`${actor.actorDiscordId}:${idempotencyKey}`).digest('hex').slice(0, 32)}`;
    // Sem nome digitado: final do ID, para diferenciar as salas no admin.
    const name = String(studentDisplayName || '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 80) || `Aluno ${studentDiscordId.slice(-4)}`;
    let created;
    try {
      created = await createRoom({
        examId: choice.exam._id,
        roomLabel: `Discord ${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
        studentName: name,
        createdVia: 'discord',
        discord: { guildId: actor.guildId, userId: studentDiscordId, operatorId: actor.actorDiscordId, operatorName: actor.actorDisplayName, requestId },
        initialProctor: { label: actor.actorDisplayName, discordUserId: actor.actorDiscordId },
      });
    } catch (err) {
      if (err && err.code === 11000) throw new ApiError(409, 'room_already_created', 'Esta solicitação já criou uma sala. Use regenerar links se precisar.');
      throw err;
    }
    const studentUrl = `${publicBaseUrl}${created.studentLink}`;
    const supervisorUrl = `${publicBaseUrl}${created.proctorLink}`;
    await logSecurityEvent('botghost_room_created', {
      meta: { roomId: String(created.room._id), examId: String(choice.exam._id), studentDiscordId, operatorId: actor.actorDiscordId },
    });
    const msg = await roomMessage(actor, created.room, choice.exam, studentDiscordId, studentUrl, supervisorUrl);
    const safe = {
      roomId: String(created.room._id),
      roomLabel: created.room.roomLabel,
      roomCode: roomCode(created.room),
      examId: String(choice.exam._id),
      examName: choice.exam.name,
      studentDiscordId,
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
// operador; os anteriores (aluno + fiscal deste operador) param de
// funcionar. Quem já está na prova não cai.
async function regenerate(actor, roomId, { publicBaseUrl }) {
  const room = await Room.findOne({ _id: roomId, discordGuildId: actor.guildId });
  if (!room) throw new ApiError(404, 'room_not_found', 'Sala não encontrada (ou não foi criada pela integração).');
  if (room.status === 'closed') throw new ApiError(409, 'room_closed', 'Esta sala foi encerrada — gere uma prova nova.');
  // Clique duplo gera dois pedidos distintos: o segundo invalidaria os links
  // que o primeiro acabou de mostrar. Pequena carência evita isso.
  const recent = room.proctorTokens.find((t) => t.discordUserId === actor.actorDiscordId && !t.revokedAt && Date.now() - new Date(t.createdAt).getTime() < 15000);
  if (recent) throw new ApiError(409, 'regenerate_too_soon', 'Os links desta sala acabaram de ser gerados. Use os que já apareceram; se precisar mesmo, tente de novo em alguns segundos.');
  const raw = generateToken();
  room.studentTokenHash = hashToken(raw);
  await room.save();
  const { proctorLink } = await addProctorLink(room._id, { label: actor.actorDisplayName, discordUserId: actor.actorDiscordId, revokePreviousForDiscordUser: true });
  const exam = await Exam.findById(room.examId).select('name durationMinutes').lean();
  const studentUrl = `${publicBaseUrl}/aluno/${raw}`;
  const supervisorUrl = `${publicBaseUrl}${proctorLink}`;
  await logSecurityEvent('botghost_links_regenerated', { meta: { roomId: String(room._id), operatorId: actor.actorDiscordId } });
  const msg = await roomMessage(actor, room, exam, room.discordUserId, studentUrl, supervisorUrl);
  const safe = { roomId: String(room._id), roomLabel: room.roomLabel, roomCode: roomCode(room), studentDiscordId: room.discordUserId };
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

module.exports = { eligibleExams, resolveExam, examOptionSlots, prepare, create, regenerate, findOpenRoom };
