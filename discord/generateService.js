const mongoose = require('mongoose');
const Room = require('../models/Room');
const Exam = require('../models/Exam');
const Question = require('../models/Question');
const DiscordRequest = require('../models/DiscordRequest');
const { createRoom, addProctorLink } = require('../lib/rooms');
const { generateToken, hashToken } = require('../lib/tokens');
const { isDuplicateKeyError } = require('../lib/outbox');
const { logSecurityEvent } = require('../lib/securityLog');

// Regras de negócio do "Gerar Prova", separadas das telas do Discord.
// Sempre usa os mesmos serviços do painel admin (lib/rooms.js).

const REQUEST_TTL_MS = 30 * 60 * 1000;
const OPEN_ROOM_STATUSES = ['pending', 'active'];

// Prova padrão configurada → se não houver (ou estiver inativa) e existir
// só uma ativa, usa essa → se houver várias, o operador escolhe.
function resolveExam(defaultExamId, activeExams) {
  if (!activeExams.length) return { examId: null, needsChoice: false, error: 'no_active_exam' };
  if (defaultExamId) {
    const found = activeExams.find((e) => String(e._id) === String(defaultExamId));
    if (found) return { examId: String(found._id), needsChoice: false };
  }
  if (activeExams.length === 1) return { examId: String(activeExams[0]._id), needsChoice: false };
  return { examId: null, needsChoice: true };
}

// "Apta" = ativa E com pelo menos uma questão ativa no banco; sem isso a
// sala seria criada mas a prova não conseguiria começar.
async function listActiveExams() {
  const withQuestions = await Question.distinct('examId', { active: true });
  return Exam.find({ active: true, _id: { $in: withQuestions } }).select('name questionCount durationMinutes').sort({ createdAt: -1 }).lean();
}

async function findOpenRoom({ guildId, userId, examId }) {
  if (!examId) return null;
  return Room.findOne({ discordGuildId: guildId, discordUserId: userId, examId, status: { $in: OPEN_ROOM_STATUSES } })
    .sort({ createdAt: -1 }).lean();
}

function sanitizeStudentName(name) {
  return String(name == null ? '' : name).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

async function createRequest({ guildId, operatorId, operatorName, targetUserId, studentName, examId }) {
  return DiscordRequest.create({
    guildId,
    operatorId,
    operatorName,
    targetUserId,
    studentName: sanitizeStudentName(studentName) || 'Aluno',
    examId: examId || null,
    expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
  });
}

function userError(message) {
  return Object.assign(new Error(message), { userMessage: message });
}

async function loadRequest(reqId, { guildId, operatorId }) {
  if (!mongoose.Types.ObjectId.isValid(reqId)) throw userError('Solicitação inválida.');
  const req = await DiscordRequest.findOne({ _id: reqId, guildId });
  if (!req) throw userError('Solicitação não encontrada.');
  if (req.operatorId !== operatorId) throw userError('Esta solicitação pertence a outro operador.');
  return req;
}

// Serializa confirmações para o mesmo usuário/prova dentro do processo
// (uma única instância ativa): dois operadores clicando ao mesmo tempo não
// criam duas salas abertas para a mesma pessoa.
const locks = new Map();
async function withLock(key, fn) {
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((r) => { release = r; });
  const chained = previous.then(() => current);
  locks.set(key, chained);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === chained) locks.delete(key);
  }
}

function roomLabelFor(req) {
  return `Discord ${String(req._id).slice(-5).toUpperCase()}`;
}

// Confirma a criação da sala. Idempotente: clique repetido/reenvio nunca
// cria outra sala (transição atômica pending → creating + índice único de
// discordRequestId na sala).
async function confirmRequest(reqId, { guildId, operatorId, publicBaseUrl }) {
  const base = await loadRequest(reqId, { guildId, operatorId });
  return withLock(`${guildId}:${base.targetUserId}`, async () => {
    const now = new Date();
    const claimed = await DiscordRequest.findOneAndUpdate(
      { _id: base._id, status: 'pending', expiresAt: { $gt: now }, examId: { $ne: null } },
      { $set: { status: 'creating' } },
      { new: true },
    );
    if (!claimed) {
      const req = await DiscordRequest.findById(base._id);
      if (req.status === 'done' || req.status === 'creating') {
        const room = await Room.findOne({ discordRequestId: String(req._id) }).lean();
        return { kind: 'already', room, req };
      }
      if (req.status === 'cancelled') return { kind: 'cancelled', req };
      if (req.expiresAt <= now) return { kind: 'expired', req };
      return { kind: 'no_exam', req };
    }

    const revert = () => DiscordRequest.updateOne({ _id: claimed._id, status: 'creating' }, { $set: { status: 'pending' } });
    try {
      const exam = await Exam.findById(claimed.examId);
      const hasQuestions = exam && await Question.exists({ examId: exam._id, active: true });
      if (!exam || !exam.active || !hasQuestions) { await revert(); return { kind: 'exam_inactive', req: claimed }; }

      const open = await findOpenRoom({ guildId, userId: claimed.targetUserId, examId: claimed.examId });
      if (open) { await revert(); return { kind: 'open_room', room: open, req: claimed }; }

      const created = await createRoom({
        examId: claimed.examId,
        roomLabel: roomLabelFor(claimed),
        studentName: claimed.studentName,
        createdVia: 'discord',
        discord: {
          guildId,
          userId: claimed.targetUserId,
          operatorId,
          operatorName: claimed.operatorName,
          requestId: String(claimed._id),
        },
        initialProctor: { label: claimed.operatorName || 'Fiscal', discordUserId: operatorId },
      });

      await DiscordRequest.updateOne({ _id: claimed._id }, { $set: { status: 'done', roomId: created.room._id } });
      await logSecurityEvent('discord_room_created', {
        meta: { roomId: created.room._id.toString(), examId: String(claimed.examId), targetUserId: claimed.targetUserId, operatorId },
      });
      return {
        kind: 'created',
        req: claimed,
        room: created.room,
        exam,
        studentUrl: `${publicBaseUrl}${created.studentLink}`,
        proctorUrl: `${publicBaseUrl}${created.proctorLink}`,
      };
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        await DiscordRequest.updateOne({ _id: claimed._id }, { $set: { status: 'done' } });
        const room = await Room.findOne({ discordRequestId: String(claimed._id) }).lean();
        return { kind: 'already', room, req: claimed };
      }
      await revert();
      throw err;
    }
  });
}

// Regeneração EXPLÍCITA dos links de uma sala criada pelo Discord: invalida
// o link do aluno anterior e o link de fiscal anterior deste operador.
// `expectedPrefix` amarra o botão ao estado mostrado — clique repetido não
// regenera duas vezes.
async function regenerateLinks(roomId, { guildId, operatorId, operatorName, expectedPrefix, publicBaseUrl }) {
  if (!mongoose.Types.ObjectId.isValid(roomId)) return { kind: 'not_found' };
  const room = await Room.findOne({ _id: roomId, discordGuildId: guildId });
  if (!room) return { kind: 'not_found' };
  if (room.status === 'closed') return { kind: 'closed', room };
  if (!/^[a-f0-9]{12}$/.test(String(expectedPrefix || '')) || !room.studentTokenHash.startsWith(expectedPrefix)) {
    return { kind: 'stale', room };
  }

  const rawStudent = generateToken();
  const rotated = await Room.findOneAndUpdate(
    { _id: room._id, studentTokenHash: room.studentTokenHash },
    { $set: { studentTokenHash: hashToken(rawStudent) } },
    { new: true },
  );
  if (!rotated) return { kind: 'stale', room };

  const { proctorLink } = await addProctorLink(room._id, { label: operatorName || 'Fiscal', discordUserId: operatorId, revokePreviousForDiscordUser: true });
  await logSecurityEvent('discord_links_regenerated', { meta: { roomId: room._id.toString(), operatorId } });
  return {
    kind: 'ok',
    room: rotated,
    studentUrl: `${publicBaseUrl}/aluno/${rawStudent}`,
    proctorUrl: `${publicBaseUrl}${proctorLink}`,
  };
}

module.exports = {
  resolveExam, listActiveExams, findOpenRoom, createRequest, loadRequest, confirmRequest, regenerateLinks,
  sanitizeStudentName, userError, REQUEST_TTL_MS,
};
