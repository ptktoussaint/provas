// Lado do fiscal (receptor). Uma única RTCPeerConnection própria — nunca
// compartilhada com outros fiscais, cada aba/sessão do professor é
// independente mesmo assistindo o mesmo aluno (requisito #17).
window.ProctorWebRTC = (() => {
  const WATCHDOG_INTERVAL_MS = 5000;
  const FROZEN_AFTER_CHECKS = 3; // ~15s sem progresso de frames/bytes
  const DISCONNECT_GRACE_MS = 5000;

  let socket = null;
  let pc = null;
  let iceServers = [];
  let turnConfigured = false;
  let pendingCandidates = [];
  let disconnectTimer = null;
  let watchdogTimer = null;
  let statsBaseline = null;
  let frozenStrikes = 0;

  let onStateChangeCb = () => {};
  let onTrackCb = () => {};

  // Log de diagnóstico verboso — sem isso, um problema de conectividade
  // WebRTC é praticamente impossível de resolver às cegas (requisito #29).
  function log(...args) {
    console.log(`[webrtc-proctor ${new Date().toISOString().slice(11, 23)}]`, ...args);
  }

  function candidateSummary(candidate) {
    if (!candidate || !candidate.candidate) return 'end-of-candidates';
    const match = candidate.candidate.match(/typ (\w+)/);
    return match ? `tipo=${match[1]}` : candidate.candidate;
  }

  async function fetchIceServers() {
    const res = await fetch('/api/proctor/ice-servers');
    const data = await res.json();
    iceServers = data.iceServers || [];
    turnConfigured = Boolean(data.turnConfigured);
    log('ICE servers carregados. turnConfigured =', turnConfigured, iceServers.map((s) => s.urls));
    if (!turnConfigured) {
      console.warn('[webrtc-proctor] Nenhum servidor TURN configurado — se a conexão direta (STUN/P2P) não for possível na rede do aluno ou do fiscal, a transmissão não vai conectar. Configure TURN_URLS no servidor.');
    }
    return data;
  }

  function teardown() {
    log('teardown() — encerrando PeerConnection e limpando estado');
    if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null; }
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
    statsBaseline = null;
    frozenStrikes = 0;
    pendingCandidates = [];
    if (pc) {
      try { pc.close(); } catch (_) { /* já fechado */ }
      pc = null;
    }
  }

  function createPeerConnection() {
    teardown();
    log('criando nova PeerConnection. iceServers:', iceServers.length, 'turnConfigured:', turnConfigured);
    pc = new RTCPeerConnection({ iceServers });

    pc.onicecandidate = (event) => {
      log('onicecandidate:', candidateSummary(event.candidate));
      if (event.candidate) socket.emit('webrtc:ice', { candidate: event.candidate });
    };

    pc.oniceconnectionstatechange = () => log('iceConnectionState =', pc.iceConnectionState);
    pc.onsignalingstatechange = () => log('signalingState =', pc.signalingState);
    pc.onicegatheringstatechange = () => log('iceGatheringState =', pc.iceGatheringState);

    pc.ontrack = (event) => {
      log('ontrack recebida:', event.track.kind, event.track.readyState, 'streams:', event.streams.length);
      onTrackCb(event.streams[0]);
      onStateChangeCb('negotiating');
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      log('connectionState =', state);

      if (state === 'connected') {
        if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null; }
        startWatchdog();
        // Ainda não é "ao vivo" de verdade até o watchdog confirmar frames
        // chegando — evita declarar sucesso só porque o estado diz "connected"
        // (requisito #18).
        onStateChangeCb('connecting-verify');
        return;
      }

      if (state === 'disconnected') {
        onStateChangeCb('reconnecting');
        if (!disconnectTimer) {
          disconnectTimer = setTimeout(() => {
            if (pc && pc.connectionState === 'disconnected') {
              log('ainda "disconnected" após', DISCONNECT_GRACE_MS, 'ms — pedindo renegociação');
              requestRenegotiate();
            }
          }, DISCONNECT_GRACE_MS);
        }
        return;
      }

      if (state === 'failed') {
        log('connectionState "failed" — pedindo renegociação imediatamente');
        onStateChangeCb('reconnecting');
        requestRenegotiate();
        return;
      }

      if (state === 'closed') {
        onStateChangeCb('interrupted');
      }
    };

    return pc;
  }

  function requestRenegotiate() {
    log('emitindo webrtc:request-renegotiate para o servidor');
    stopWatchdog();
    socket.emit('webrtc:request-renegotiate');
  }

  function stopWatchdog() {
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
    statsBaseline = null;
    frozenStrikes = 0;
  }

  // Nunca confiar só em connectionState === "connected" (requisito #18):
  // checamos getStats() periodicamente por progresso real de frames/bytes.
  function startWatchdog() {
    stopWatchdog();
    log('watchdog iniciado (checagem a cada', WATCHDOG_INTERVAL_MS, 'ms)');
    watchdogTimer = setInterval(async () => {
      if (!pc || pc.connectionState !== 'connected') return;

      const stats = await pc.getStats().catch((err) => { log('getStats() falhou:', err.message); return null; });
      if (!stats) return;

      let framesDecoded = 0;
      let bytesReceived = 0;
      let candidatePairInfo = null;
      stats.forEach((report) => {
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          framesDecoded = report.framesDecoded || 0;
          bytesReceived = report.bytesReceived || 0;
        }
        if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
          candidatePairInfo = report;
        }
      });

      let pairSummary = 'nenhum par nomeado ainda';
      if (candidatePairInfo) {
        const local = stats.get(candidatePairInfo.localCandidateId);
        const remote = stats.get(candidatePairInfo.remoteCandidateId);
        pairSummary = `local=${local ? local.candidateType : '?'} remoto=${remote ? remote.candidateType : '?'}`;
      }
      log('watchdog tick: framesDecoded=', framesDecoded, 'bytesReceived=', bytesReceived, 'par ICE:', pairSummary);

      // framesDecoded ainda em zero: nenhum frame foi decodificado até
      // agora, então não há evidência nenhuma de vídeo (nem a favor, nem
      // contra) — não declaramos "live" apenas por causa do
      // connectionState, mas também não é ainda um congelamento (requisito
      // #18: só um "connected" sem frames de verdade é que conta).
      if (framesDecoded === 0 && bytesReceived === 0) {
        statsBaseline = null;
        frozenStrikes = 0;
        return;
      }

      if (!statsBaseline) {
        // Primeira leitura com dado real: framesDecoded > 0 aqui já prova
        // que pelo menos um frame chegou e foi decodificado.
        statsBaseline = { framesDecoded, bytesReceived };
        onStateChangeCb('live');
        return;
      }

      const progressed = framesDecoded > statsBaseline.framesDecoded || bytesReceived > statsBaseline.bytesReceived;
      statsBaseline = { framesDecoded, bytesReceived };

      if (progressed) {
        frozenStrikes = 0;
        onStateChangeCb('live');
      } else {
        frozenStrikes += 1;
        log('sem progresso de frames/bytes — frozenStrikes =', frozenStrikes, '/', FROZEN_AFTER_CHECKS);
        if (frozenStrikes >= FROZEN_AFTER_CHECKS) {
          frozenStrikes = 0;
          onStateChangeCb('reconnecting');
          requestRenegotiate();
        }
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  async function handleOffer({ sdp }) {
    log('webrtc:offer recebida');
    if (!pc) createPeerConnection();
    onStateChangeCb('negotiating');
    await pc.setRemoteDescription(sdp);

    const pending = pendingCandidates.splice(0);
    log(`aplicando ${pending.length} ICE candidate(s) que estavam na fila`);
    for (const candidate of pending) {
      await pc.addIceCandidate(candidate).catch((err) => console.error('[webrtc-proctor] ICE pendente falhou:', err));
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    log('answer criada e enviada');
    socket.emit('webrtc:answer', { sdp: pc.localDescription });

    // Uma renegociação pedida pelo watchdog (stream congelado) pode não
    // mudar o connectionState (ele podia já estar "connected" o tempo
    // todo) — nesse caso onconnectionstatechange nunca dispara de novo, e
    // sem isto o watchdog ficaria parado para sempre após a 1ª detecção.
    if (pc.connectionState === 'connected' && !watchdogTimer) startWatchdog();
  }

  async function handleIce({ candidate }) {
    if (!candidate) return;
    if (pc && pc.remoteDescription && pc.remoteDescription.type) {
      await pc.addIceCandidate(candidate).catch((err) => console.error('[webrtc-proctor] addIceCandidate falhou:', err));
    } else {
      log('ICE candidate do aluno chegou antes da remoteDescription — enfileirando');
      pendingCandidates.push(candidate);
    }
  }

  function handleRenegotiateExhausted() {
    // O servidor já não vai mais repassar pedidos de renegociação para esta
    // sessão (backoff esgotado) — paramos o watchdog local para não ficar
    // tentando de novo a cada ciclo sem chance real de sucesso (requisito
    // #27: número máximo de tentativas, não loop infinito).
    log('servidor sinalizou backoff esgotado (webrtc:renegotiate-exhausted) — parando watchdog');
    stopWatchdog();
    onStateChangeCb('error');
  }

  function bindSocket(activeSocket) {
    socket = activeSocket;
    socket.on('webrtc:offer', handleOffer);
    socket.on('webrtc:ice', handleIce);
    socket.on('webrtc:renegotiate-exhausted', handleRenegotiateExhausted);
    socket.on('student:disconnected', () => { log('student:disconnected recebido'); onStateChangeCb('interrupted'); });
  }

  function stop() {
    teardown();
  }

  return {
    fetchIceServers,
    createPeerConnection,
    bindSocket,
    stop,
    onStateChange: (cb) => { onStateChangeCb = cb; },
    onTrack: (cb) => { onTrackCb = cb; },
  };
})();
