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
  let turnConfigured = false;
  const peers = new Map(); // viewerId -> { pc, pendingCandidates, negotiating, pendingRenegotiate, failedRetries, recreateCount, disconnectTimer }
  // Fiscais que conectaram antes do aluno ter compartilhado a tela — não dá
  // para criar a PeerConnection sem tracks; ficam em espera até a captura
  // começar (flushPendingViewers), sem perder o "novo viewer" (requisito #16).
  const pendingViewerIds = new Set();

  let onStateChangeCb = () => {};
  let onCaptureEndedCb = () => {};

  // Log de diagnóstico verboso e propositalmente explícito — problema de
  // conectividade WebRTC é praticamente impossível de resolver às cegas;
  // isto é o que permite ver exatamente em que ponto uma negociação
  // específica travou (requisito #29).
  function log(viewerId, ...args) {
    console.log(`[webrtc-student ${new Date().toISOString().slice(11, 23)}] [${viewerId || '-'}]`, ...args);
  }

  function candidateSummary(candidate) {
    if (!candidate || !candidate.candidate) return 'end-of-candidates';
    const match = candidate.candidate.match(/typ (\w+)/);
    return match ? `tipo=${match[1]}` : candidate.candidate;
  }

  async function fetchIceServers() {
    const res = await fetch('/api/student/ice-servers');
    const data = await res.json();
    iceServers = data.iceServers || [];
    turnConfigured = Boolean(data.turnConfigured);
    log(null, 'ICE servers carregados. turnConfigured =', turnConfigured, iceServers.map((s) => s.urls));
    if (!turnConfigured) {
      console.warn('[webrtc-student] Nenhum servidor TURN configurado — conexões só funcionam quando STUN/P2P direto é suficiente. Em redes com NAT/firewall restritivo, a transmissão pode não conectar. Configure TURN_URLS no servidor.');
    }
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
    log(null, 'Captura de tela iniciada. track:', track && track.label, track && track.readyState);
    if (track) {
      track.onended = () => { log(null, 'track.onended disparado'); onCaptureEndedCb('ended'); };
      track.onmute = () => { log(null, 'track.onmute disparado'); onCaptureEndedCb('muted'); };
    }
    flushPendingViewers();
    return stream;
  }

  function attachTracksToPeer(pc, viewerId) {
    if (!mediaStream) return;
    for (const track of mediaStream.getTracks()) {
      pc.addTrack(track, mediaStream);
      log(viewerId, 'track adicionada à PeerConnection:', track.kind, track.label);
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
    log(viewerId, 'fechando PeerConnection (cleanup)');
    clearDisconnectTimer(peer);
    try { peer.pc.close(); } catch (_) { /* já fechado */ }
    peers.delete(viewerId);
  }

  function createPeer(viewerId) {
    log(viewerId, 'criando nova PeerConnection. iceServers:', iceServers.length, 'turnConfigured:', turnConfigured);
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

    attachTracksToPeer(pc, viewerId);

    pc.onicecandidate = (event) => {
      log(viewerId, 'onicecandidate:', candidateSummary(event.candidate));
      if (event.candidate) socket.emit('webrtc:ice', { viewerId, candidate: event.candidate });
    };

    pc.oniceconnectionstatechange = () => log(viewerId, 'iceConnectionState =', pc.iceConnectionState);
    pc.onsignalingstatechange = () => log(viewerId, 'signalingState =', pc.signalingState);
    pc.onicegatheringstatechange = () => log(viewerId, 'iceGatheringState =', pc.iceGatheringState);

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      log(viewerId, 'connectionState =', state);
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
          if (pc.connectionState === 'disconnected') {
            log(viewerId, 'ainda "disconnected" após 5s de espera — acionando recuperação');
            handleFailure(viewerId);
          }
        }, 5000);
      }

      if (state === 'failed') {
        log(viewerId, 'connectionState "failed" — acionando recuperação imediatamente');
        handleFailure(viewerId);
      }
    };

    return peer;
  }

  function handleFailure(viewerId) {
    const peer = peers.get(viewerId);
    if (!peer) { log(viewerId, 'handleFailure chamado mas não há peer registrado'); return; }

    if (peer.failedRetries < FAILED_RETRY_LIMIT) {
      peer.failedRetries += 1;
      log(viewerId, `tentativa de recuperação ${peer.failedRetries}/${FAILED_RETRY_LIMIT}: restartIce() + renegociar`);
      try { peer.pc.restartIce(); } catch (err) { log(viewerId, 'restartIce() não suportado/falhou:', err.message); }
      negotiate(viewerId);
      return;
    }

    if (peer.recreateCount >= MAX_RECREATES_PER_VIEWER) {
      // Desistimos desta PeerConnection — fechamos e removemos para não
      // deixar uma conexão zumbi (requisito #31). Recuperação a partir daqui
      // é manual: o fiscal recarrega a página, o que cria um viewerId novo.
      log(viewerId, `limite de ${MAX_RECREATES_PER_VIEWER} recriações atingido — desistindo, estado "error"`);
      closePeer(viewerId);
      onStateChangeCb(viewerId, 'error');
      return;
    }

    const recreateCount = peer.recreateCount + 1;
    log(viewerId, `recriando PeerConnection do zero (recreateCount=${recreateCount})`);
    closePeer(viewerId);
    const fresh = createPeer(viewerId);
    fresh.recreateCount = recreateCount;
    negotiate(viewerId);
  }

  async function negotiate(viewerId) {
    const peer = peers.get(viewerId);
    if (!peer) return;
    if (peer.negotiating) {
      log(viewerId, 'negociação já em andamento — marcando para renegociar em seguida');
      peer.pendingRenegotiate = true;
      return;
    }
    peer.negotiating = true;
    try {
      log(viewerId, 'criando offer...');
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      log(viewerId, 'offer criada e definida como local, enviando via socket');
      socket.emit('webrtc:offer', { viewerId, sdp: peer.pc.localDescription });
    } catch (err) {
      console.error(`[webrtc-student] [${viewerId}] falha ao negociar:`, err);
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
    if (!peer) { log(viewerId, 'answer recebida mas não há peer registrado (ignorando)'); return; }
    log(viewerId, 'answer recebida, aplicando setRemoteDescription');
    await peer.pc.setRemoteDescription(sdp);
    const pending = peer.pendingCandidates.splice(0);
    log(viewerId, `aplicando ${pending.length} ICE candidate(s) que estavam na fila`);
    for (const candidate of pending) {
      await peer.pc.addIceCandidate(candidate).catch((err) => console.error(`[webrtc-student] [${viewerId}] ICE pendente falhou:`, err));
    }
  }

  async function handleRemoteIce({ viewerId, candidate }) {
    const peer = peers.get(viewerId);
    if (!peer || !candidate) return;
    // Fila de ICE candidates que chegam antes da remoteDescription — nunca
    // descartar (requisito #19).
    if (peer.pc.remoteDescription && peer.pc.remoteDescription.type) {
      await peer.pc.addIceCandidate(candidate).catch((err) => console.error(`[webrtc-student] [${viewerId}] addIceCandidate falhou:`, err));
    } else {
      log(viewerId, 'ICE candidate chegou antes da remoteDescription — enfileirando');
      peer.pendingCandidates.push(candidate);
    }
  }

  function handleViewerJoined({ viewerId }) {
    log(viewerId, 'viewer:joined recebido');
    if (!mediaStream) {
      log(viewerId, 'ainda sem captura de tela — colocando em espera (pendingViewerIds)');
      pendingViewerIds.add(viewerId);
      onStateChangeCb(viewerId, 'awaiting-media');
      return;
    }
    if (!peers.has(viewerId)) createPeer(viewerId);
    negotiate(viewerId);
  }

  function handleViewerLeft({ viewerId }) {
    log(viewerId, 'viewer:left recebido');
    pendingViewerIds.delete(viewerId);
    closePeer(viewerId);
    onStateChangeCb(viewerId, 'left');
  }

  function flushPendingViewers() {
    for (const viewerId of Array.from(pendingViewerIds)) {
      log(viewerId, 'captura disponível agora — apresentando viewer que estava em espera');
      pendingViewerIds.delete(viewerId);
      if (!peers.has(viewerId)) createPeer(viewerId);
      negotiate(viewerId);
    }
  }

  function handleRequestRenegotiate({ viewerId }) {
    log(viewerId, 'request-renegotiate recebido do servidor');
    // Pode ser um pedido de recuperação (watchdog do fiscal, peer já
    // existe) OU um "reconectar" manual clicado por um fiscal que nunca
    // chegou a ser apresentado (corrida rara no momento da conexão) — nos
    // dois casos o resultado certo é o mesmo: garantir que esse viewer
    // tenha uma PeerConnection funcionando.
    if (!peers.has(viewerId)) {
      handleViewerJoined({ viewerId });
      return;
    }
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

    for (const [viewerId, peer] of peers) {
      const senders = peer.pc.getSenders();
      for (const sender of senders) {
        const newTrack = newStream.getTracks().find((t) => t.kind === (sender.track ? sender.track.kind : 'video'));
        if (newTrack) {
          log(viewerId, 'substituindo track (replaceTrack) após restabelecer compartilhamento');
          await sender.replaceTrack(newTrack);
        }
      }
    }

    // A captura antiga (interrompida) pode não ter sido encerrada pelo
    // navegador em todos os casos — garantimos que nenhuma track velha
    // continua ativa depois da troca.
    if (oldStream) oldStream.getTracks().forEach((t) => t.stop());
  }

  // Reinício manual e total: fecha TODAS as PeerConnections e recria do
  // zero para cada fiscal atualmente conectado, reaproveitando a mesma
  // MediaStream. Bom escape-hatch quando várias conexões parecem travadas
  // ao mesmo tempo — o aluno não precisa parar de compartilhar a tela para
  // isso, só força uma negociação nova para todo mundo.
  function restartAllConnections() {
    const viewerIds = Array.from(peers.keys());
    log(null, `reiniciando transmissão para ${viewerIds.length} fiscal(is) conectado(s)`);
    for (const viewerId of viewerIds) {
      closePeer(viewerId);
      createPeer(viewerId);
      negotiate(viewerId);
    }
    return viewerIds.length;
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
    restartAllConnections,
    stopAll,
    getMediaStream: () => mediaStream,
    onStateChange: (cb) => { onStateChangeCb = cb; },
    onCaptureEnded: (cb) => { onCaptureEndedCb = cb; },
  };
})();
