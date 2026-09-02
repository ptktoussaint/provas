(() => {
  const proctorToken = location.pathname.split('/').filter(Boolean)[1] || '';

  const screens = ['loading-screen', 'room-screen', 'finished-screen', 'error-screen'];
  function showScreen(id) {
    for (const s of screens) document.getElementById(s).classList.toggle('hidden', s !== id);
  }
  function showError(message) {
    document.getElementById('error-message').textContent = message;
    showScreen('error-screen');
  }
  function showFinished(message) {
    if (message) document.getElementById('finished-message').textContent = message;
    window.ProctorWebRTC.stop();
    if (socket) socket.disconnect();
    showScreen('finished-screen');
  }

  const STREAM_LABELS = {
    'awaiting-media': ['Aguardando aluno compartilhar', 'badge-neutral'],
    'connecting-verify': ['Conectando...', 'badge-neutral'],
    negotiating: ['Negociando conexão...', 'badge-neutral'],
    live: ['Transmitindo', 'badge-ok'],
    reconnecting: ['Reconectando...', 'badge-warn'],
    interrupted: ['Interrompida', 'badge-danger'],
    error: ['Erro — necessária intervenção manual', 'badge-danger'],
    left: ['Encerrada', 'badge-neutral'],
  };

  let socket = null;
  let expiresAt = null;
  let clockOffset = 0;
  let timerInterval = null;

  function setBadge(id, text, cls) {
    const el = document.getElementById(id);
    el.className = `badge ${cls}`;
    el.innerHTML = `<span class="badge-dot"></span>${text}`;
  }

  function setStreamBadge(state) {
    const [label, cls] = STREAM_LABELS[state] || [state, 'badge-neutral'];
    setBadge('badge-stream', label, cls);
    document.getElementById('video-overlay').classList.toggle('hidden', state === 'live');
  }

  async function init() {
    const hintEl = document.querySelector('#loading-screen .hint');
    const slowTimer = setTimeout(() => {
      if (hintEl) hintEl.textContent = 'Isso está demorando mais que o normal — aguarde, o servidor pode estar iniciando...';
    }, 6000);

    try {
      const data = await window.fetchJson('/api/proctor/identify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proctorToken }),
      }, 20000);
      clearTimeout(slowTimer);

      if (!data.success) {
        showError(data.message || 'Link inválido.');
        return;
      }

      document.getElementById('room-title').textContent = data.room.roomLabel;
      document.getElementById('room-sub').textContent = `Aluno: ${data.room.studentName}${data.exam.name ? ' — ' + data.exam.name : ''}`;

      await window.ProctorWebRTC.fetchIceServers();

      window.ProctorWebRTC.onTrack((stream) => {
        document.getElementById('remote-video').srcObject = stream;
        const playPromise = document.getElementById('remote-video').play();
        if (playPromise) playPromise.catch(() => document.getElementById('unmute-btn').classList.remove('hidden'));
      });
      window.ProctorWebRTC.onStateChange(setStreamBadge);
      setStreamBadge('awaiting-media');

      connectSocket();
      await loadStatus();
      showScreen('room-screen');
    } catch (err) {
      clearTimeout(slowTimer);
      showError('Erro de conexão. Recarregue a página para tentar novamente.');
    }
  }

  function connectSocket() {
    socket = io();
    window.ProctorWebRTC.bindSocket(socket);

    socket.on('connect_error', (err) => console.error('[socket] connect_error', err));
    socket.on('auth:error', () => showError('Sua sessão expirou. Acesse novamente pelo link do fiscal.'));
    socket.on('room:closed', () => { window.ProctorWebRTC.stop(); showError('Esta sala foi encerrada.'); });

    socket.on('exam:progress', ({ currentQuestionOrder, totalQuestions }) => {
      setBadge('badge-question', `Questão ${currentQuestionOrder}/${totalQuestions}`, 'badge-neutral');
    });

    socket.on('stream:status', ({ status }) => {
      // Sinal auto-reportado pelo aluno — o estado "de verdade" continua
      // vindo do watchdog local (onStateChange), mas isso já cobre o caso
      // de interrupção manual antes mesmo de qualquer PeerConnection existir.
      if (status === 'interrupted') setStreamBadge('interrupted');
    });

    socket.on('focus:update', ({ status }) => {
      if (status === 'out') setBadge('badge-focus', 'FORA DA TELA DA PROVA', 'badge-warn');
      else setBadge('badge-focus', 'NA PROVA', 'badge-ok');
    });

    socket.on('student:disconnected', () => {
      setBadge('badge-attempt', 'Aluno desconectado', 'badge-danger');
    });
    socket.on('student:online', () => {
      setBadge('badge-attempt', 'REALIZANDO PROVA', 'badge-ok');
    });

    socket.on('attempt:finished', ({ reason } = {}) => {
      clearInterval(timerInterval);
      const message = reason === 'timeout'
        ? 'O tempo da prova acabou. A fiscalização desta sala foi encerrada.'
        : 'O aluno finalizou a prova. A fiscalização desta sala foi encerrada.';
      showFinished(message);
    });
  }

  async function loadStatus() {
    const res = await fetch('/api/proctor/status');
    const data = await res.json();
    if (!data.success) return;

    if (data.progress) {
      setBadge('badge-attempt', data.progress.status === 'in_progress' ? 'REALIZANDO PROVA' : 'PROVA FINALIZADA', data.progress.status === 'in_progress' ? 'badge-ok' : 'badge-neutral');
      setBadge('badge-question', `Questão ${data.progress.answeredCount}/${data.progress.totalQuestions}`, 'badge-neutral');
      if (data.progress.status === 'in_progress') {
        expiresAt = data.progress.expiresAt;
        clockOffset = data.serverTime ? data.serverTime - Date.now() : 0;
        startTimer();
      }
    } else {
      setBadge('badge-attempt', 'Aguardando início da prova', 'badge-neutral');
    }

    if (data.live) {
      setBadge('badge-focus', data.live.focusStatus === 'out' ? 'FORA DA TELA DA PROVA' : 'NA PROVA', data.live.focusStatus === 'out' ? 'badge-warn' : 'badge-ok');
      if (!data.live.studentOnline) setBadge('badge-attempt', 'Aluno offline', 'badge-danger');
    }
  }

  function startTimer() {
    clearInterval(timerInterval);
    if (!expiresAt) return;
    timerInterval = setInterval(() => {
      const remainingMs = new Date(expiresAt).getTime() - (Date.now() + clockOffset);
      if (remainingMs <= 0) {
        clearInterval(timerInterval);
        document.getElementById('timer-value').textContent = '00:00:00';
        return;
      }
      const totalSeconds = Math.floor(remainingMs / 1000);
      const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
      const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
      const s = String(totalSeconds % 60).padStart(2, '0');
      document.getElementById('timer-value').textContent = `${h}:${m}:${s}`;
    }, 1000);
  }

  document.getElementById('unmute-btn').addEventListener('click', () => {
    const video = document.getElementById('remote-video');
    video.muted = false;
    video.play().catch(() => {});
    document.getElementById('unmute-btn').classList.add('hidden');
  });

  init();
})();
