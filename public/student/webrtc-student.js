// Lado do aluno (transmissor). Mantém UMA MediaStream de tela e UMA
// RTCPeerConnection independente POR FISCAL — nunca uma conexão só
// compartilhada entre todos (requisito #15). Cada entrada em `peers` é
// dona do seu próprio ciclo de vida (negociação, ICE, recuperação),
// isolada das demais (requisito #17).
window.StudentWebRTC = (() => {
  const MAX_RECREATES_PER_VIEWER = 3;
  const FAILED_RETRY_LIMIT = 2;

  let socket = null;
  let mediaStream = null;
  let iceServers = [];
  const peers = new Map(); // viewerId -> { pc, pendingCandidates, negotiating, pendingRenegotiate, failedRetries, recreateCount, disconnectTimer }
  // Fiscais que conectaram antes do aluno ter compartilhado a tela — não dá
  // para criar a PeerConnection sem tracks; ficam em espera até a captura
  // começar (flushPendingViewers), sem perder o "novo viewer" (requisito #16).
  const pendingViewerIds = new Set();

  let onStateChangeCb = () => {};
  let onCaptureEndedCb = () => {};

  async function fetchIceServers() {
    const res = await fetch('/api/student/ice-servers');
    const data = await res.json();
    iceServers = data.iceServers || [];
    return data;
  }

  async function startCapture() {
    // Preferir tela inteira/monitor em vez de aba, conforme requisito #14 —
    // displaySurface é uma preferência, não uma garantia (o navegador ainda
    // mostra a escolha para o usuário).
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'monitor', frameRate: { ideal: 15, max: 30 } },
      audio: false,
    });

    mediaStream = stream;
    const [track] = stream.getVideoTracks();
    if (track) {
      track.onended = () => onCaptureEndedCb('ended');
      track.onmute = () => onCaptureEndedCb('muted');
    }
    flushPendingViewers();
    return stream;
  }

  function attachTracksToPeer(pc) {
    if (!mediaStream) return;
    for (const track of mediaStream.getTracks()) {
      pc.addTrack(track, mediaStream);
    }
  }

  function clearDisconnectTimer(peer) {
    if (peer.disconnectTimer) {
      clearTimeout(peer.disconnectTimer);
      peer.disconnectTimer = null;
    }
  }

  function closePeer(viewerId) {
    const peer = peers.get(viewerId);
    if (!peer) return;
    clearDisconnectTimer(peer);
    try { peer.pc.close(); } catch (_) { /* já fechado */ }
    peers.delete(viewerId);
  }

  function createPeer(viewerId) {
    const pc = new RTCPeerConnection({ iceServers });
    const peer = {
      pc,
      pendingCandidates: [],
      negotiating: false,
      pendingRenegotiate: false,
      failedRetries: 0,
      recreateCount: 0,
      disconnectTimer: null,
    };
    peers.set(viewerId, peer);

    attachTracksToPeer(pc);

    pc.onicecandidate = (event) => {
      if (event.candidate) socket.emit('webrtc:ice', { viewerId, candidate: event.candidate });
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      onStateChangeCb(viewerId, state);

      if (state === 'connected') {
        peer.failedRetries = 0;
        peer.recreateCount = 0;
        clearDisconnectTimer(peer);
      }

      if (state === 'disconnected') {
        clearDisconnectTimer(peer);
        // Pequena janela para recuperação natural antes de agir (requisito #22).
        peer.disconnectTimer = setTimeout(() => {
          if (pc.connectionState === 'disconnected') handleFailure(viewerId);
        }, 5000);
      }

      if (state === 'failed') {
        handleFailure(viewerId);
      }
    };

    return peer;
  }

  function handleFailure(viewerId) {
    const peer = peers.get(viewerId);
    if (!peer) return;

    if (peer.failedRetries < FAILED_RETRY_LIMIT) {
      peer.failedRetries += 1;
      try { peer.pc.restartIce(); } catch (_) { /* nem todo navegador suporta */ }
      negotiate(viewerId);
      return;
    }

    if (peer.recreateCount >= MAX_RECREATES_PER_VIEWER) {
      // Desistimos desta PeerConnection — fechamos e removemos para não
      // deixar uma conexão zumbi (requisito #31). Recuperação a partir daqui
      // é manual: o fiscal recarrega a página, o que cria um viewerId novo.
      closePeer(viewerId);
      onStateChangeCb(viewerId, 'error');
      return;
    }

    const recreateCount = peer.recreateCount + 1;
    closePeer(viewerId);
    const fresh = createPeer(viewerId);
    fresh.recreateCount = recreateCount;
    negotiate(viewerId);
  }

  async function negotiate(viewerId) {
    const peer = peers.get(viewerId);
    if (!peer) return;
    if (peer.negotiating) {
      peer.pendingRenegotiate = true;
      return;
    }
    peer.negotiating = true;
    try {
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      socket.emit('webrtc:offer', { viewerId, sdp: peer.pc.localDescription });
    } catch (err) {
      console.error('[webrtc] falha ao negociar com', viewerId, err);
    } finally {
      peer.negotiating = false;
      if (peer.pendingRenegotiate) {
        peer.pendingRenegotiate = false;
        negotiate(viewerId);
      }
    }
  }

  async function handleAnswer({ viewerId, sdp }) {
    const peer = peers.get(viewerId);
    if (!peer) return;
    await peer.pc.setRemoteDescription(sdp);
    const pending = peer.pendingCandidates.splice(0);
    for (const candidate of pending) {
      await peer.pc.addIceCandidate(candidate).catch((err) => console.error('[webrtc] ICE pendente falhou', err));
    }
  }

  async function handleRemoteIce({ viewerId, candidate }) {
    const peer = peers.get(viewerId);
    if (!peer || !candidate) return;
    // Fila de ICE candidates que chegam antes da remoteDescription — nunca
    // descartar (requisito #19).
    if (peer.pc.remoteDescription && peer.pc.remoteDescription.type) {
      await peer.pc.addIceCandidate(candidate).catch((err) => console.error('[webrtc] addIceCandidate falhou', err));
    } else {
      peer.pendingCandidates.push(candidate);
    }
  }

  function handleViewerJoined({ viewerId }) {
    if (!mediaStream) {
      pendingViewerIds.add(viewerId);
      onStateChangeCb(viewerId, 'awaiting-media');
      return;
    }
    if (!peers.has(viewerId)) createPeer(viewerId);
    negotiate(viewerId);
  }

  function handleViewerLeft({ viewerId }) {
    pendingViewerIds.delete(viewerId);
    closePeer(viewerId);
    onStateChangeCb(viewerId, 'left');
  }

  function flushPendingViewers() {
    for (const viewerId of Array.from(pendingViewerIds)) {
      pendingViewerIds.delete(viewerId);
      if (!peers.has(viewerId)) createPeer(viewerId);
      negotiate(viewerId);
    }
  }

  function handleRequestRenegotiate({ viewerId }) {
    handleFailure(viewerId);
  }

  function bindSocket(activeSocket) {
    socket = activeSocket;
    socket.on('viewer:joined', handleViewerJoined);
    socket.on('viewer:left', handleViewerLeft);
    socket.on('webrtc:answer', handleAnswer);
    socket.on('webrtc:ice', handleRemoteIce);
    socket.on('request-renegotiate', handleRequestRenegotiate);
  }

  // Aluno restabeleceu o compartilhamento após interrupção — atualiza as
  // tracks em TODAS as conexões existentes sem precisar renegociar do zero
  // (requisito #26).
  async function updateStreamForAllPeers(newStream) {
    const oldStream = mediaStream;
    mediaStream = newStream;
    const [track] = newStream.getVideoTracks();
    if (track) {
      track.onended = () => onCaptureEndedCb('ended');
      track.onmute = () => onCaptureEndedCb('muted');
    }

    for (const [, peer] of peers) {
      const senders = peer.pc.getSenders();
      for (const sender of senders) {
        const newTrack = newStream.getTracks().find((t) => t.kind === (sender.track ? sender.track.kind : 'video'));
        if (newTrack) await sender.replaceTrack(newTrack);
      }
    }

    // A captura antiga (interrompida) pode não ter sido encerrada pelo
    // navegador em todos os casos — garantimos que nenhuma track velha
    // continua ativa depois da troca.
    if (oldStream) oldStream.getTracks().forEach((t) => t.stop());
  }

  function stopAll() {
    for (const viewerId of Array.from(peers.keys())) closePeer(viewerId);
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
  }

  return {
    fetchIceServers,
    startCapture,
    bindSocket,
    updateStreamForAllPeers,
    stopAll,
    getMediaStream: () => mediaStream,
    onStateChange: (cb) => { onStateChangeCb = cb; },
    onCaptureEnded: (cb) => { onCaptureEndedCb = cb; },
  };
})();
