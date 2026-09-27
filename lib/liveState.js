const { EventEmitter } = require('events');

// Estado ao vivo das salas — deliberadamente só em memória do processo
// (mesma decisão do projeto anterior "UPS FLUXO LIVE"): é status de
// transmissão/presença agora, não histórico; o que precisa sobreviver a um
// restart (tentativas, respostas, eventos de auditoria) já está no Mongo.
// Cada mudança emite 'change' para o roomId — sockets/adminBroadcast.js
// escuta isso e empurra atualizações em tempo real ao painel admin
// (requisito #38: realtime, não polling).
const FINISHED_STATUS = new Set(['finished', 'finished_timeout']);

class LiveState extends EventEmitter {
  constructor() {
    super();
    this.rooms = new Map();
    // Salas cuja prova terminou (ou que foram encerradas/excluídas): somem
    // do painel admin (Dashboard/Monitoramento), mas o estado continua aqui
    // para quem ainda estiver conectado (fiscal vendo o fim, aluno na tela
    // final). Fica num Set à parte porque um evento atrasado de socket
    // (desconexão, foco) recria a entrada da sala via ensureRoom.
    this.hidden = new Set();
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
    this.hidden.add(roomId);
    this.emit('change', roomId);
  }

  // Prova finalizada (aluno, tempo esgotado/abandono, admin): sai do painel.
  markFinished(roomId) {
    this.hidden.add(roomId);
    this.emit('change', roomId);
  }

  // Nova tentativa na mesma sala (resultado anterior excluído): volta.
  unmarkFinished(roomId) {
    if (this.hidden.delete(roomId)) this.emit('change', roomId);
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
      // A Central de Monitoramento do admin registra o próprio socket como
      // "viewer" desta sala (igual um fiscal, tecnicamente) para poder
      // receber o vídeo — mas isso não deve inflar a contagem/lista de
      // fiscais mostrada no painel, então essas entradas ficam de fora aqui.
      proctorCount: Array.from(room.proctors.values()).filter((p) => !p.isAdminMonitor).length,
      // Set: a mesma pessoa pode ter mais de uma conexão ativa (ex.: duas
      // abas com o mesmo link) — não faz sentido listar o nome repetido.
      activeProctorNames: Array.from(new Set(
        Array.from(room.proctors.values()).filter((p) => !p.isAdminMonitor && p.label).map((p) => p.label),
      )),
    };
  }

  // Resumo para o PAINEL ADMIN: null para sala com prova já finalizada
  // (inclusive depois de um restart, quando o aluno volta à página e o
  // status da tentativa é regravado aqui).
  visibleSummary(roomId) {
    const room = this.rooms.get(roomId);
    if (!room || this.hidden.has(roomId) || FINISHED_STATUS.has(room.attemptStatus)) return null;
    return this.summary(roomId);
  }

  allSummaries() {
    return Array.from(this.rooms.keys()).map((id) => this.visibleSummary(id)).filter(Boolean);
  }
}

module.exports = new LiveState();
