(() => {
  const studentToken = location.pathname.split('/').filter(Boolean)[1] || '';

  const screens = ['identify-screen', 'welcome-screen', 'intro-screen', 'share-screen', 'unsupported-screen', 'exam-screen', 'finished-screen', 'error-screen'];
  function showScreen(id) {
    // Sair da tela do vídeo por qualquer caminho (botão, erro, sala
    // encerrada) sempre para a reprodução — sem isto o <video> continuava
    // tocando com áudio em segundo plano depois do aluno já ter avançado.
    if (id !== 'intro-screen') stopIntroVideo();
    for (const s of screens) document.getElementById(s).classList.toggle('hidden', s !== id);
  }

  function stopIntroVideo() {
    const frame = document.getElementById('intro-video-frame');
    const video = frame && frame.querySelector('video');
    if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
  }

  function showError(message) {
    document.getElementById('error-message').textContent = message;
    showScreen('error-screen');
  }

  let socket = null;
  let examInfo = null;
  let attempt = null;
  let clockOffset = 0;
  let currentIndex = 0;
  let timerInterval = null;
  let examEnded = false;

  // ---------- Passo 1: identificação automática pelo link ----------
  // O link já foi gerado pelo admin especificamente para este aluno — não
  // pede mais confirmação de nome, entra direto ao abrir a página.
  async function autoIdentify() {
    const errorEl = document.getElementById('identify-error');
    const hintEl = document.querySelector('#identify-screen .hint');

    // Se estiver demorando muito (ex.: servidor "acordando" após ficar
    // inativo), avisa em vez de deixar o texto estático parado sem
    // nenhuma explicação.
    const slowTimer = setTimeout(() => {
      if (hintEl) hintEl.textContent = 'Isso está demorando mais que o normal — aguarde, o servidor pode estar iniciando...';
    }, 6000);

    const data = await window.fetchJson('/api/student/identify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentToken }),
    }, 20000);
    clearTimeout(slowTimer);

    if (!data.success) {
      errorEl.textContent = data.message || 'Não foi possível acessar esta sala.';
      return;
    }

    examInfo = data.exam;
    document.getElementById('intro-exam-name').textContent = data.exam.name;
    document.getElementById('intro-student-name').textContent = `${data.room.studentName} — ${data.room.roomLabel}`;
    document.getElementById('welcome-student-name').textContent = data.room.studentName || 'candidato(a)';
    document.getElementById('welcome-exam-name').textContent = data.exam.name || 'prova';

    // Mostra os últimos dígitos do ID da sala de forma sempre visível — o
    // fiscal e o aluno precisam estar na MESMA sala para a transmissão
    // funcionar; comparar visualmente aqui resolve em segundos casos em que
    // os dois links geraram/apontam para salas diferentes.
    if (data.room.roomId) {
      const idBadge = document.getElementById('room-id-badge');
      idBadge.classList.remove('hidden');
      idBadge.innerHTML = `<span class="badge-dot"></span>Sala #${data.room.roomId.slice(-6)}`;
    }

    connectSocket();

    // Requisito #57: verificar suporte antes de deixar prosseguir.
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      showScreen('unsupported-screen');
      return;
    }

    showScreen('welcome-screen');
  }
  autoIdentify();

  function renderIntroVideo(videoUrl) {
    const frame = document.getElementById('intro-video-frame');
    frame.innerHTML = `<video src="${videoUrl}" controls playsinline></video>`;
  }

  // O botão "INICIAR PROVA" da tela de boas-vindas só existe uma vez —
  // decide aqui se existe vídeo para mostrar antes da sala de
  // compartilhamento, sem exigir nenhuma etapa extra do aluno quando o
  // admin não anexou nenhum vídeo a esta prova.
  document.getElementById('welcome-start-btn').addEventListener('click', () => {
    if (examInfo && examInfo.introVideoUrl) {
      renderIntroVideo(examInfo.introVideoUrl);
      showScreen('intro-screen');
    } else {
      showScreen('share-screen');
    }
  });

  document.getElementById('intro-continue-btn').addEventListener('click', () => {
    showScreen('share-screen');
  });

  // Efeito de luz que segue o cursor na tela de boas-vindas — só a posição
  // (--mx/--my) muda aqui, o visual (gradiente, cor, blend) fica todo em
  // CSS. Também responde a toque, para não deixar a tela "morta" em tablets.
  const welcomeSpotlight = document.getElementById('welcome-spotlight');
  function moveSpotlight(x, y) {
    welcomeSpotlight.style.setProperty('--mx', `${x}px`);
    welcomeSpotlight.style.setProperty('--my', `${y}px`);
  }
  window.addEventListener('mousemove', (e) => moveSpotlight(e.clientX, e.clientY));
  window.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (t) moveSpotlight(t.clientX, t.clientY);
  }, { passive: true });

  // ---------- Socket ----------
  // Indicador sempre visível (sem precisar abrir o DevTools) de que o
  // navegador do aluno realmente conseguiu abrir uma conexão com o
  // servidor — essencial para diferenciar "o aluno nunca conectou" de "o
  // aluno conectou mas o fiscal não foi avisado" ao investigar falhas de
  // transmissão relatadas em campo.
  function setConnBadge(text, cls) {
    const el = document.getElementById('conn-status');
    el.classList.remove('hidden');
    el.className = `badge ${cls} conn-status`;
    el.innerHTML = `<span class="badge-dot"></span>${text}`;
  }

  function connectSocket() {
    socket = io();
    window.StudentWebRTC.bindSocket(socket);
    setConnBadge('Conectando ao servidor...', 'badge-neutral');

    socket.on('connect', () => { console.log(`[socket] conectado. id=${socket.id}`); setConnBadge('Conectado ao servidor', 'badge-ok'); });
    socket.on('disconnect', (reason) => { console.log(`[socket] desconectado. motivo="${reason}"`); setConnBadge(`Sem conexão (${reason})`, 'badge-danger'); });
    socket.on('reconnect_attempt', (n) => { console.log(`[socket] tentando reconectar (tentativa ${n})...`); setConnBadge(`Reconectando... (tentativa ${n})`, 'badge-warn'); });
    socket.on('reconnect', (n) => { console.log(`[socket] reconectado após ${n} tentativa(s). novo id=${socket.id}`); setConnBadge('Conectado ao servidor', 'badge-ok'); });
    socket.on('connect_error', (err) => { console.error('[socket] connect_error', err.message); setConnBadge('Erro ao conectar ao servidor', 'badge-danger'); });
    socket.on('auth:error', () => showError('Sua sessão expirou. Acesse novamente pelo link da sua sala.'));
    socket.on('room:closed', () => {
      cleanupAndStop();
      showError('Esta sala foi encerrada.');
    });
    socket.on('attempt:finished', ({ reason }) => {
      if (examEnded) return;
      finalizeUi(reason);
    });
  }

  // ---------- Passo 2: compartilhamento de tela ----------
  document.getElementById('share-start-btn').addEventListener('click', async () => {
    const errorEl = document.getElementById('share-error');
    errorEl.textContent = '';
    try {
      await window.StudentWebRTC.fetchIceServers();
      const stream = await window.StudentWebRTC.startCapture();

      const preview = document.getElementById('share-preview');
      const previewVideo = document.getElementById('share-preview-video');
      previewVideo.srcObject = stream;
      preview.classList.remove('hidden');

      socket.emit('stream:status', { status: 'capturing' });
      document.getElementById('share-status-hint').textContent = 'Tela compartilhada com sucesso.';
      document.getElementById('share-begin-exam-btn').classList.remove('hidden');
      document.getElementById('share-start-btn').classList.add('hidden');
    } catch (err) {
      if (err && err.name === 'NotAllowedError') {
        errorEl.textContent = 'É necessário permitir o compartilhamento da tela para continuar.';
      } else {
        errorEl.textContent = 'Não foi possível iniciar o compartilhamento de tela. Tente novamente.';
      }
    }
  });

  document.getElementById('share-begin-exam-btn').addEventListener('click', async () => {
    const btn = document.getElementById('share-begin-exam-btn');
    btn.disabled = true;
    try {
      const res = await fetch('/api/student/start', { method: 'POST' });
      const data = await res.json();
      if (!data.success) {
        document.getElementById('share-error').textContent = data.message || 'Não foi possível iniciar a prova.';
        btn.disabled = false;
        return;
      }

      if (data.finished) {
        finalizeUi('already-finished');
        return;
      }

      attempt = data.attempt;
      clockOffset = data.serverTime - Date.now();
      currentIndex = Math.max(0, attempt.questions.findIndex((q) => !q.selectedKey));
      if (currentIndex === -1) currentIndex = 0;

      socket.emit('stream:status', { status: 'live' });
      startFocusTracking();
      startTimer();
      renderQuestion();
      showScreen('exam-screen');
    } catch (err) {
      document.getElementById('share-error').textContent = 'Erro de conexão. Tente novamente.';
      btn.disabled = false;
    }
  });

  document.getElementById('resume-share-btn').addEventListener('click', async () => {
    try {
      const stream = await window.StudentWebRTC.startCapture();
      await window.StudentWebRTC.updateStreamForAllPeers(stream);
      socket.emit('stream:status', { status: 'live' });
      document.getElementById('share-alert-banner').classList.add('hidden');
    } catch (err) {
      // usuário cancelou o novo compartilhamento — banner continua visível
    }
  });

  document.getElementById('restart-broadcast-btn').addEventListener('click', () => {
    const count = window.StudentWebRTC.restartAllConnections();
    window.alert(count > 0
      ? `Transmissão reiniciada para ${count} fiscal(is) conectado(s).`
      : 'Nenhum fiscal conectado no momento — nada para reiniciar.');
  });

  window.StudentWebRTC.onCaptureEnded(() => {
    if (examEnded) return;
    socket && socket.emit('stream:status', { status: 'interrupted' });
    document.getElementById('share-alert-banner').classList.remove('hidden');
  });

  // ---------- Cronômetro (server-authoritative) ----------
  function startTimer() {
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      const remainingMs = new Date(attempt.expiresAt).getTime() - (Date.now() + clockOffset);
      if (remainingMs <= 0) {
        clearInterval(timerInterval);
        document.getElementById('timer-value').textContent = '00:00:00';
        finishExam('timeout');
        return;
      }
      renderTimer(remainingMs);
    }, 1000);
  }

  function renderTimer(remainingMs) {
    const totalSeconds = Math.floor(remainingMs / 1000);
    const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
    const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
    const s = String(totalSeconds % 60).padStart(2, '0');
    const el = document.getElementById('timer-value');
    el.textContent = `${h}:${m}:${s}`;
    el.classList.toggle('low', totalSeconds < 300);
  }

  // ---------- Perda de foco (requisito #36) ----------
  function startFocusTracking() {
    document.addEventListener('visibilitychange', () => {
      socket.emit('focus:event', { type: document.hidden ? 'hidden' : 'visible' });
    });
    window.addEventListener('blur', () => socket.emit('focus:event', { type: 'blur' }));
    window.addEventListener('focus', () => socket.emit('focus:event', { type: 'focus' }));
  }

  // ---------- Prova ----------
  function renderQuestion() {
    const q = attempt.questions[currentIndex];
    document.getElementById('question-count').textContent = `Questão ${q.order} de ${attempt.totalQuestions}`;
    document.getElementById('question-text').textContent = q.text;

    const optionsList = document.getElementById('options-list');
    optionsList.innerHTML = '';
    for (const opt of q.options) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'option-btn' + (q.selectedKey === opt.key ? ' selected' : '');
      btn.innerHTML = `<span class="option-key">${opt.key}</span><span>${escapeHtml(opt.text)}</span>`;
      btn.addEventListener('click', () => selectAnswer(opt.key));
      optionsList.appendChild(btn);
    }

    renderGrid();
    document.getElementById('prev-btn').disabled = currentIndex === 0;
    document.getElementById('next-btn').disabled = currentIndex === attempt.questions.length - 1;
  }

  function renderGrid() {
    const grid = document.getElementById('question-grid');
    grid.innerHTML = '';
    attempt.questions.forEach((q, idx) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'question-dot' + (q.selectedKey ? ' answered' : '') + (idx === currentIndex ? ' current' : '');
      dot.textContent = q.order;
      dot.addEventListener('click', () => { currentIndex = idx; renderQuestion(); });
      grid.appendChild(dot);
    });
  }

  async function selectAnswer(key) {
    const answeredIndex = currentIndex;
    const q = attempt.questions[answeredIndex];
    const wasAlreadyAnswered = Boolean(q.selectedKey);
    q.selectedKey = key;
    renderQuestion();

    try {
      const res = await fetch('/api/student/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: q.order, selectedKey: key }),
      });
      const data = await res.json();
      if (!data.success) {
        if (/tempo/i.test(data.message || '')) finalizeUi('timeout');
        return;
      }

      // Avança automaticamente só na primeira resposta desta questão (não
      // quando o aluno só está trocando de alternativa numa já respondida)
      // e só se ele ainda estiver olhando para essa mesma questão.
      if (!wasAlreadyAnswered && currentIndex === answeredIndex && answeredIndex < attempt.questions.length - 1) {
        setTimeout(() => {
          if (currentIndex === answeredIndex) {
            currentIndex = answeredIndex + 1;
            renderQuestion();
          }
        }, 350);
      }
    } catch (err) {
      // Falha de rede momentânea — a seleção fica marcada localmente e o
      // aluno pode reenviar trocando de alternativa; sem isso não há como
      // garantir autosave sem uma fila de retry mais elaborada.
    }
  }

  document.getElementById('prev-btn').addEventListener('click', () => {
    if (currentIndex > 0) { currentIndex -= 1; renderQuestion(); }
  });
  document.getElementById('next-btn').addEventListener('click', () => {
    if (currentIndex < attempt.questions.length - 1) { currentIndex += 1; renderQuestion(); }
  });

  document.getElementById('finish-btn').addEventListener('click', () => {
    const unanswered = attempt.questions.filter((q) => !q.selectedKey).length;
    if (unanswered > 0) {
      window.alert(`Você ainda não respondeu ${unanswered} questão(ões). Responda todas as questões antes de finalizar a prova.`);
      return;
    }
    if (window.confirm('Deseja realmente finalizar a prova? Esta ação não pode ser desfeita.')) {
      finishExam('manual');
    }
  });

  async function finishExam(reason) {
    if (examEnded) return;
    examEnded = true;
    clearInterval(timerInterval);
    try {
      await fetch('/api/student/finish', { method: 'POST' });
    } catch (err) { /* ignore — o servidor também finaliza por timeout via varredura */ }
    finalizeUi(reason);
  }

  function finalizeUi() {
    examEnded = true;
    clearInterval(timerInterval);
    window.StudentWebRTC.stopAll();
    if (socket) socket.disconnect();
    showScreen('finished-screen');
  }

  function cleanupAndStop() {
    examEnded = true;
    clearInterval(timerInterval);
    window.StudentWebRTC.stopAll();
    if (socket) socket.disconnect();
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
})();
