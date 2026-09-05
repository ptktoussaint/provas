// Central de Monitoramento: mesma lógica de recepção de vídeo do
// public/proctor/webrtc-proctor.js, mas com UMA RTCPeerConnection POR SALA
// observada em vez de uma só — o admin pode assistir várias transmissões
// simultâneas com um único socket (ver comentário em sockets/index.js
// registerAdmin). Tudo aqui é indexado por roomId.
window.AdminMonitor = (() => {
  const WATCHDOG_INTERVAL_MS = 5000;
  const FROZEN_AFTER_CHECKS = 3;
  const DISCONNECT_GRACE_MS = 5000;

  let socket = null;
  let iceServers = [];
  let turnConfigured = false;
  const connections = new Map(); // roomId -> { pc, pendingCandidates, disconnectTimer, watchdogTimer, statsBaseline, frozenStrikes }

  let onStreamCb = () => {};
  let onStateChangeCb = () => {};

  function log(roomId, ...args) {
    console.log(`[admin-monitor ${new Date().toISOString().slice(11, 23)}] [${roomId}]`, ...args);
  }

  async function fetchIceServers() {
    const res = await fetch('/api/admin/ice-servers');
    const data = await res.json();
    iceServers = data.iceServers || [];
    turnConfigured = Boolean(data.turnConfigured);
    log('-', 'ICE servers carregados. turnConfigured =', turnConfigured);
    return data;
  }

  function ensureConnection(roomId) {
    let conn = connections.get(roomId);
    if (!conn) {
      conn = { pc: null, pendingCandidates: [], disconnectTimer: null, watchdogTimer: null, statsBaseline: null, frozenStrikes: 0 };
      connections.set(roomId, conn);
    }
    return conn;
  }

  function teardown(roomId) {
    const conn = connections.get(roomId);
    if (!conn) return;
    if (conn.disconnectTimer) { clearTimeout(conn.disconnectTimer); conn.disconnectTimer = null; }
    if (conn.watchdogTimer) { clearInterval(conn.watchdogTimer); conn.watchdogTimer = null; }
    conn.statsBaseline = null;
    conn.frozenStrikes = 0;
    conn.pendingCandidates = [];
    if (conn.pc) {
      try { conn.pc.close(); } catch (_) { /* já fechado */ }
      conn.pc = null;
    }
  }

  function createPeerConnection(roomId) {
    teardown(roomId);
    const conn = ensureConnection(roomId);
    log(roomId, 'criando PeerConnection. iceServers:', iceServers.length);
    const pc = new RTCPeerConnection({ iceServers });
    conn.pc = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate) socket.emit('webrtc:ice', { roomId, candidate: event.candidate });
    };

    pc.ontrack = (event) => {
      log(roomId, 'ontrack recebida:', event.track.kind);
      onStreamCb(roomId, event.streams[0]);
      onStateChangeCb(roomId, 'negotiating');
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      log(roomId, 'connectionState =', state);

      if (state === 'connected') {
        if (conn.disconnectTimer) { clearTimeout(conn.disconnectTimer); conn.disconnectTimer = null; }
        startWatchdog(roomId);
        onStateChangeCb(roomId, 'connecting-verify');
        return;
      }

      if (state === 'disconnected') {
        onStateChangeCb(roomId, 'reconnecting');
        if (!conn.disconnectTimer) {
          conn.disconnectTimer = setTimeout(() => {
            if (conn.pc && conn.pc.connectionState === 'disconnected') requestRenegotiate(roomId);
          }, DISCONNECT_GRACE_MS);
        }
        return;
      }

      if (state === 'failed') {
        onStateChangeCb(roomId, 'reconnecting');
        requestRenegotiate(roomId);
        return;
      }

      if (state === 'closed') onStateChangeCb(roomId, 'interrupted');
    };

    return conn;
  }

  function requestRenegotiate(roomId) {
    stopWatchdog(roomId);
    socket.emit('webrtc:request-renegotiate', { roomId });
  }

  function stopWatchdog(roomId) {
    const conn = connections.get(roomId);
    if (!conn) return;
    if (conn.watchdogTimer) { clearInterval(conn.watchdogTimer); conn.watchdogTimer = null; }
    conn.statsBaseline = null;
    conn.frozenStrikes = 0;
  }

  function startWatchdog(roomId) {
    stopWatchdog(roomId);
    const conn = connections.get(roomId);
    if (!conn) return;
    conn.watchdogTimer = setInterval(async () => {
      if (!conn.pc || conn.pc.connectionState !== 'connected') return;
      const stats = await conn.pc.getStats().catch(() => null);
      if (!stats) return;

      let framesDecoded = 0;
      let bytesReceived = 0;
      stats.forEach((report) => {
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          framesDecoded = report.framesDecoded || 0;
          bytesReceived = report.bytesReceived || 0;
        }
      });

      if (framesDecoded === 0 && bytesReceived === 0) {
        conn.statsBaseline = null;
        conn.frozenStrikes = 0;
        return;
      }

      if (!conn.statsBaseline) {
        conn.statsBaseline = { framesDecoded, bytesReceived };
        onStateChangeCb(roomId, 'live');
        return;
      }

      const progressed = framesDecoded > conn.statsBaseline.framesDecoded || bytesReceived > conn.statsBaseline.bytesReceived;
      conn.statsBaseline = { framesDecoded, bytesReceived };

      if (progressed) {
        conn.frozenStrikes = 0;
        onStateChangeCb(roomId, 'live');
      } else {
        conn.frozenStrikes += 1;
        if (conn.frozenStrikes >= FROZEN_AFTER_CHECKS) {
          conn.frozenStrikes = 0;
          onStateChangeCb(roomId, 'reconnecting');
          requestRenegotiate(roomId);
        }
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  async function handleOffer({ roomId, sdp }) {
    // Mensagem de uma sala que não estamos mais observando (ex.: chegou
    // depois de já termos saído da aba) — ignora, não recria nada.
    if (!connections.has(roomId)) return;
    log(roomId, 'webrtc:offer recebida');
    let conn = connections.get(roomId);
    if (!conn.pc) conn = createPeerConnection(roomId);
    onStateChangeCb(roomId, 'negotiating');
    await conn.pc.setRemoteDescription(sdp);

    const pending = conn.pendingCandidates.splice(0);
    for (const candidate of pending) {
      await conn.pc.addIceCandidate(candidate).catch((err) => console.error(`[admin-monitor] [${roomId}] ICE pendente falhou:`, err));
    }

    const answer = await conn.pc.createAnswer();
    await conn.pc.setLocalDescription(answer);
    socket.emit('webrtc:answer', { roomId, sdp: conn.pc.localDescription });

    if (conn.pc.connectionState === 'connected' && !conn.watchdogTimer) startWatchdog(roomId);
  }

  async function handleIce({ roomId, candidate }) {
    const conn = connections.get(roomId);
    if (!conn || !candidate) return;
    if (conn.pc && conn.pc.remoteDescription && conn.pc.remoteDescription.type) {
      await conn.pc.addIceCandidate(candidate).catch((err) => console.error(`[admin-monitor] [${roomId}] addIceCandidate falhou:`, err));
    } else {
      conn.pendingCandidates.push(candidate);
    }
  }

  function handleRenegotiateExhausted({ roomId }) {
    stopWatchdog(roomId);
    onStateChangeCb(roomId, 'error');
  }

  function bindSocket(activeSocket) {
    socket = activeSocket;
    socket.on('webrtc:offer', handleOffer);
    socket.on('webrtc:ice', handleIce);
    socket.on('webrtc:renegotiate-exhausted', handleRenegotiateExhausted);
  }

  function watchRoom(roomId) {
    if (connections.has(roomId)) return;
    ensureConnection(roomId);
    socket.emit('admin:watch-room', { roomId });
  }

  function unwatchRoom(roomId) {
    if (!connections.has(roomId)) return;
    teardown(roomId);
    connections.delete(roomId);
    socket.emit('admin:unwatch-room', { roomId });
    onStateChangeCb(roomId, 'left');
  }

  function unwatchAll() {
    for (const roomId of Array.from(connections.keys())) unwatchRoom(roomId);
  }

  function isWatching(roomId) {
    return connections.has(roomId);
  }

  return {
    fetchIceServers,
    bindSocket,
    watchRoom,
    unwatchRoom,
    unwatchAll,
    isWatching,
    onStream: (cb) => { onStreamCb = cb; },
    onStateChange: (cb) => { onStateChangeCb = cb; },
  };
})();
