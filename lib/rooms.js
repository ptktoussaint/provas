const Room = require('../models/Room');
const Exam = require('../models/Exam');
const { generateToken, hashToken } = require('./tokens');

// Serviço único de criação de salas/links — usado tanto pelo painel admin
// (routes/admin.js) quanto pelo bot do Discord, para que as duas origens
// gerem exatamente o mesmo tipo de sala. O token puro só existe no retorno
// destas funções; o banco guarda apenas o hash.

function studentPath(rawToken) {
  return `/aluno/${rawToken}`;
}

function proctorPath(rawToken) {
  return `/professor/${rawToken}`;
}

async function createRoom({
  examId, roomLabel, studentName, createdBy = null, createdVia = 'admin',
  discord = null, initialProctor = null,
}) {
  const exam = await Exam.findById(examId);
  if (!exam) throw Object.assign(new Error('Prova não encontrada.'), { status: 404 });

  const rawStudentToken = generateToken();
  const doc = {
    examId,
    roomLabel: String(roomLabel).trim(),
    studentName: String(studentName).trim(),
    studentTokenHash: hashToken(rawStudentToken),
    createdBy,
    createdVia,
  };

  let rawProctorToken = null;
  if (initialProctor) {
    rawProctorToken = generateToken();
    doc.proctorTokens = [{
      label: initialProctor.label || 'Fiscal',
      tokenHash: hashToken(rawProctorToken),
      discordUserId: initialProctor.discordUserId || null,
    }];
  }

  if (discord) {
    doc.discordGuildId = discord.guildId;
    doc.discordUserId = discord.userId;
    doc.discordOperator = { id: discord.operatorId || null, name: discord.operatorName || null };
    if (discord.supervisor) doc.supervisor = { discordUserId: discord.supervisor.discordUserId, displayName: discord.supervisor.displayName || null };
    if (discord.studentAvatarUrl) doc.studentAvatarUrl = discord.studentAvatarUrl;
    if (discord.examGroup) doc.examGroup = discord.examGroup;
    if (discord.requestId) doc.discordRequestId = discord.requestId;
  }

  const room = await Room.create(doc);
  return {
    room,
    exam,
    studentLink: studentPath(rawStudentToken),
    proctorLink: rawProctorToken ? proctorPath(rawProctorToken) : null,
  };
}

// Emite um token novo para o aluno, invalidando o anterior. Quem já estava
// em prova não é desconectado (a sessão guarda o roomId, não o token).
async function regenerateStudentLink(roomId) {
  const rawToken = generateToken();
  const room = await Room.findByIdAndUpdate(roomId, { studentTokenHash: hashToken(rawToken) }, { new: true });
  if (!room) throw Object.assign(new Error('Sala não encontrada.'), { status: 404 });
  return { room, studentLink: studentPath(rawToken) };
}

async function addProctorLink(roomId, { label, discordUserId = null, revokePreviousForDiscordUser = false } = {}) {
  const room = await Room.findById(roomId);
  if (!room) throw Object.assign(new Error('Sala não encontrada.'), { status: 404 });

  if (revokePreviousForDiscordUser && discordUserId) {
    for (const t of room.proctorTokens) {
      if (t.discordUserId === discordUserId && !t.revokedAt) t.revokedAt = new Date();
    }
  }

  const rawToken = generateToken();
  room.proctorTokens.push({ label: label ? String(label).trim() : 'Fiscal', tokenHash: hashToken(rawToken), discordUserId });
  await room.save();
  return { room, proctorLink: proctorPath(rawToken), tokenId: room.proctorTokens[room.proctorTokens.length - 1]._id };
}

module.exports = { createRoom, regenerateStudentLink, addProctorLink, studentPath, proctorPath };
