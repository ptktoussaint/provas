const Room = require('../models/Room');
const ExamAttempt = require('../models/ExamAttempt');
const liveState = require('../lib/liveState');
const { logExamEvent } = require('../lib/eventLog');
const { safeOn } = require('../lib/asyncHandler');

const FOCUS_EVENT_TYPES = new Set(['blur', 'focus', 'hidden', 'visible']);
const STREAM_STATUS_VALUES = new Set([
  'awaiting', 'capturing', 'connecting', 'negotiating', 'live', 'reconnecting', 'interrupted', 'error',
]);

const RENEGOTIATE_MAX_ATTEMPTS = 5;
const RENEGOTIATE_WINDOW_MS = 2 * 60 * 1000;

// Resolve o papel da conexão a partir da SESSÃO do servidor (nunca de um
// campo que o cliente possa declarar) — requisito #42.
function resolveRole(socket) {
  const session = socket.request.session;
  if (session?.admin) return { role: 'admin' };
  if (session?.student?.roomId) return { role: 'student', roomId: session.student.roomId };
  if (session?.proctor?.roomId) {
    return { role: 'proctor', roomId: session.proctor.roomId, proctorTokenId: session.proctor.proctorTokenId };
  }
  return null;
}

function registerAdmin(io, socket) {
  socket.join('admins');
  socket.emit('rooms:snapshot', liveState.allSummaries());
}

async function persistStreamEvent(attemptId, type, meta = null) {
  if (!attemptId) return;
  const update = { $push: { streamEvents: { type, at: new Date(), meta } } };
  // Só sobrescreve o status persistido quando o evento É um status de
  // transmissão válido — nunca gravar undefined/null aqui (o driver do
  // Mongo serializa `undefined` em `$set` como BSON null, o que apagaria o
  // streamStatus a cada evento que não fosse "interrupted").
  if (STREAM_STATUS_VALUES.has(type)) update.$set = { streamStatus: type };
  await ExamAttempt.findByIdAndUpdate(attemptId, update).catch(() => {});
}

function registerStudent(io, socket, room) {
  const roomId = room._id.toString();

  liveState.patch(roomId, {
    roomLabel: room.roomLabel,
    studentName: room.studentName,
    examId: room.examId.toString(),
    studentSocketId: socket.id,
    studentOnline: true,
  });

  io.to(`room:${roomId}`).except(socket.id).emit('student:online');
  logExamEvent({ roomId, actor: 'student', type: 'student_connected' });

  // O aluno acabou de (re)carregar a página — todo estado de PeerConnection
  // anterior dele foi perdido. Reapresentamos os fiscais já presentes para
  // que ele crie conexões novas para cada um (mesmo fluxo de "novo viewer").
  const liveRoom = liveState.getRoom(roomId);
  for (const [viewerId] of liveRoom.proctors) {
    socket.emit('viewer:joined', { viewerId, connectionId: viewerId });
  }

  safeOn(socket, 'webrtc:offer', ({ viewerId, sdp }) => {
    if (!liveRoom.proctors.has(viewerId)) return;
    io.to(viewerId).emit('webrtc:offer', { viewerId, connectionId: viewerId, sdp });
  });

  safeOn(socket, 'webrtc:ice', ({ viewerId, candidate }) => {
    if (!liveRoom.proctors.has(viewerId)) return;
    io.to(viewerId).emit('webrtc:ice', { viewerId, connectionId: viewerId, candidate });
  });

  safeOn(socket, 'stream:status', async ({ status }) => {
    if (!STREAM_STATUS_VALUES.has(status)) return;
    liveState.patch(roomId, { streamStatus: status });
    io.to(`room:${roomId}`).emit('stream:status', { status });
    if (status === 'interrupted') {
      io.to('admins').emit('alert', { roomId, type: 'stream_interrupted', at: Date.now() });
    }
    const current = liveState.getRoom(roomId);
    await persistStreamEvent(current.attemptId, status);
    await logExamEvent({ roomId, attemptId: current.attemptId, actor: 'student', type: `stream_${status}` });
  });

  safeOn(socket, 'focus:event', async ({ type }) => {
    if (!FOCUS_EVENT_TYPES.has(type)) return;
    const attempt = room.currentAttemptId ? await ExamAttempt.findById(room.currentAttemptId) : null;
    const isLeaving = type === 'blur' || type === 'hidden';
    const now = new Date();

    if (attempt) {
      attempt.focusEvents.push({ type, at: now });
      if (isLeaving) {
        attempt.isOutOfFocus = true;
        attempt.lastFocusLostAt = now;
      } else if (attempt.isOutOfFocus && attempt.lastFocusLostAt) {
        attempt.totalFocusLossMs += now.getTime() - new Date(attempt.lastFocusLostAt).getTime();
        attempt.isOutOfFocus = false;
      }
      await attempt.save();
    }

    const focusStatus = isLeaving ? 'out' : 'in';
    liveState.patch(roomId, { focusStatus });
    io.to(`room:${roomId}`).emit('focus:update', { status: focusStatus, at: now.getTime() });
    if (isLeaving) io.to('admins').emit('alert', { roomId, type: 'focus_lost', at: now.getTime() });
    await logExamEvent({ roomId, attemptId: room.currentAttemptId, actor: 'student', type: `focus_${type}` });
  });

  safeOn(socket, 'disconnect', async () => {
    const current = liveState.getRoom(roomId);
    if (current && current.studentSocketId === socket.id) {
      liveState.patch(roomId, { studentOnline: false, studentSocketId: null, streamStatus: 'interrupted' });
    }
    io.to(`room:${roomId}`).emit('student:disconnected');
    io.to('admins').emit('alert', { roomId, type: 'student_disconnected', at: Date.now() });
    await logExamEvent({ roomId, actor: 'student', type: 'student_disconnected' });
  });
}

function registerProctor(io, socket, room, proctorTokenId) {
  const roomId = room._id.toString();
  const viewerId = socket.id;

  liveState.addProctor(roomId, viewerId, {
    socketId: socket.id,
    connectionId: viewerId,
    proctorTokenId,
    connectedAt: Date.now(),
    renegotiateAttempts: [],
  });

  logExamEvent({ roomId, actor: 'proctor', type: 'proctor_connected', meta: { viewerId } });

  const liveRoom = liveState.getRoom(roomId);
  if (liveRoom.studentOnline && liveRoom.studentSocketId) {
    // Entrada tardia (requisito #16): pedimos ao aluno para negociar com
    // este viewer específico, qualquer que seja o momento em que ele entrou.
    io.to(liveRoom.studentSocketId).emit('viewer:joined', { viewerId, connectionId: viewerId });
  }

  safeOn(socket, 'webrtc:answer', ({ sdp }) => {
    const current = liveState.getRoom(roomId);
    if (!current?.studentSocketId) return;
    io.to(current.studentSocketId).emit('webrtc:answer', { viewerId, connectionId: viewerId, sdp });
  });

  safeOn(socket, 'webrtc:ice', ({ candidate }) => {
    const current = liveState.getRoom(roomId);
    if (!current?.studentSocketId) return;
    io.to(current.studentSocketId).emit('webrtc:ice', { viewerId, connectionId: viewerId, candidate });
  });

  // Watchdog do fiscal detectou stream congelado (getStats sem progresso).
  // O servidor aplica backoff para não gerar loop infinito de reconexão
  // (requisito #27) — depois de N tentativas na janela, para de repassar e
  // deixa o estado de erro visível para intervenção manual.
  safeOn(socket, 'webrtc:request-renegotiate', () => {
    const current = liveState.getRoom(roomId);
    const proctorInfo = current?.proctors.get(viewerId);
    if (!current?.studentSocketId || !proctorInfo) return;

    const now = Date.now();
    proctorInfo.renegotiateAttempts = proctorInfo.renegotiateAttempts.filter((t) => now - t < RENEGOTIATE_WINDOW_MS);
    if (proctorInfo.renegotiateAttempts.length >= RENEGOTIATE_MAX_ATTEMPTS) {
      socket.emit('webrtc:renegotiate-exhausted');
      return;
    }
    proctorInfo.renegotiateAttempts.push(now);
    io.to(current.studentSocketId).emit('request-renegotiate', { viewerId });
  });

  safeOn(socket, 'disconnect', () => {
    liveState.removeProctor(roomId, viewerId);
    const current = liveState.getRoom(roomId);
    if (current?.studentSocketId) {
      // O aluno deve fechar e limpar a PeerConnection deste viewer
      // especificamente, sem afetar as demais (requisitos #17, #31).
      io.to(current.studentSocketId).emit('viewer:left', { viewerId });
    }
    logExamEvent({ roomId, actor: 'proctor', type: 'proctor_disconnected', meta: { viewerId } });
  });
}

function initSockets(io) {
  liveState.on('change', (roomId) => {
    io.to('admins').emit('room:update', liveState.summary(roomId));
  });

  io.on('connection', (socket) => {
    Promise.resolve().then(async () => {
      const resolved = resolveRole(socket);
      if (!resolved) {
        socket.emit('auth:error', { message: 'Sessão inválida ou expirada.' });
        socket.disconnect(true);
        return;
      }

      if (resolved.role === 'admin') {
        registerAdmin(io, socket);
        return;
      }

      const room = await Room.findById(resolved.roomId);
      if (!room || room.status === 'closed') {
        socket.emit('auth:error', { message: 'Sala não encontrada ou encerrada.' });
        socket.disconnect(true);
        return;
      }

      socket.join(`room:${resolved.roomId}`);

      if (resolved.role === 'student') {
        registerStudent(io, socket, room);
      } else {
        registerProctor(io, socket, room, resolved.proctorTokenId);
      }
    }).catch((err) => {
      console.error('[socket:connection] erro não tratado:', err);
      socket.disconnect(true);
    });
  });
}

module.exports = { initSockets };
