const { EventEmitter } = require('events');

// Estado ao vivo das salas — deliberadamente só em memória do processo
// (mesma decisão do projeto anterior "UPS FLUXO LIVE"): é status de
// transmissão/presença agora, não histórico; o que precisa sobreviver a um
// restart (tentativas, respostas, eventos de auditoria) já está no Mongo.
// Cada mudança emite 'change' para o roomId — sockets/adminBroadcast.js
// escuta isso e empurra atualizações em tempo real ao painel admin
// (requisito #38: realtime, não polling).
class LiveState extends EventEmitter {
  constructor() {
    super();
    this.rooms = new Map();
  }

  ensureRoom(roomId) {
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, {
        roomId,
        roomLabel: null,
        studentName: null,
        examId: null,
        examName: null,
        studentSocketId: null,
        studentOnline: false,
        attemptId: null,
        attemptStatus: null,
        currentQuestionOrder: 0,
        totalQuestions: 0,
        expiresAt: null,
        focusStatus: 'in',
        streamStatus: 'awaiting',
        proctors: new Map(), // viewerId -> { socketId, connectionId, label, connectedAt }
      });
    }
    return this.rooms.get(roomId);
  }

  patch(roomId, patch) {
    const room = this.ensureRoom(roomId);
    Object.assign(room, patch);
    this.emit('change', roomId);
    return room;
  }

  addProctor(roomId, viewerId, info) {
    const room = this.ensureRoom(roomId);
    room.proctors.set(viewerId, info);
    this.emit('change', roomId);
  }

  removeProctor(roomId, viewerId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.proctors.delete(viewerId);
    this.emit('change', roomId);
  }

  getRoom(roomId) {
    return this.rooms.get(roomId) || null;
  }

  removeRoom(roomId) {
    this.rooms.delete(roomId);
    this.emit('change', roomId);
  }

  summary(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    const timeRemainingMs = room.expiresAt ? Math.max(0, new Date(room.expiresAt).getTime() - Date.now()) : null;
    return {
      roomId: room.roomId,
      roomLabel: room.roomLabel,
      studentName: room.studentName,
      examId: room.examId,
      examName: room.examName,
      studentOnline: room.studentOnline,
      attemptStatus: room.attemptStatus,
      currentQuestionOrder: room.currentQuestionOrder,
      totalQuestions: room.totalQuestions,
      timeRemainingMs,
      focusStatus: room.focusStatus,
      streamStatus: room.streamStatus,
      proctorCount: room.proctors.size,
    };
  }

  allSummaries() {
    return Array.from(this.rooms.keys()).map((id) => this.summary(id));
  }
}

module.exports = new LiveState();
