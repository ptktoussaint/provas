(() => {
  async function api(path, options = {}) {
    const res = await fetch(`/api/admin${path}`, {
      headers: options.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
      ...options,
    });
    let data;
    try { data = await res.json(); } catch (_) { data = { success: false, message: 'Resposta inválida do servidor.' }; }
    return { status: res.status, ...data };
  }

  // Precisa escapar aspas também (não só < > &) porque este valor é usado
  // tanto em texto quanto dentro de atributos HTML (value="..."). O truque
  // via textContent/innerHTML não escapa aspas, o que quebrava o formulário
  // de edição sempre que uma questão tinha " no texto.
  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleString('pt-BR');
  }

  function fmtDuration(ms) {
    if (ms == null) return '—';
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
    const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
    const s = String(totalSeconds % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }

  // ---------------- Primeiro acesso (criar admin) ----------------
  document.getElementById('setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('setup-username').value.trim();
    const password = document.getElementById('setup-password').value;
    const errorEl = document.getElementById('setup-error');
    const data = await api('/setup-first-admin', { method: 'POST', body: JSON.stringify({ username, password }) });
    if (!data.success) { errorEl.textContent = data.message || 'Não foi possível criar o administrador.'; return; }
    document.getElementById('admin-username').textContent = data.username;
    document.getElementById('setup-screen').classList.add('hidden');
    enterApp();
  });

  // ---------------- Login ----------------
  const loginForm = document.getElementById('login-form');
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    const errorEl = document.getElementById('login-error');
    const data = await api('/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    if (!data.success) { errorEl.textContent = data.message || 'Falha no login.'; return; }
    document.getElementById('admin-username').textContent = data.username;
    enterApp();
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' });
    location.reload();
  });

  async function boot() {
    const setupStatus = await api('/setup-status');
    if (setupStatus.success && setupStatus.needsSetup) {
      document.getElementById('setup-screen').classList.remove('hidden');
      return;
    }

    const data = await api('/me');
    if (data.success) {
      document.getElementById('admin-username').textContent = data.admin.username;
      enterApp();
    } else {
      document.getElementById('login-screen').classList.remove('hidden');
    }
  }

  function enterApp() {
    document.getElementById('setup-screen').classList.add('hidden');
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app-screen').classList.remove('hidden');
    connectSocket();
    loadAll();
  }

  // ---------------- Tabs ----------------
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
      document.getElementById(btn.dataset.tab).classList.remove('hidden');
    });
  });

  function loadAll() {
    loadDashboard();
    loadLiveRooms();
    loadSettings();
    loadExams();
    loadResults();
    loadSecurityLogs();
  }

  // ---------------- Socket (tempo real) ----------------
  const liveRooms = new Map();

  function connectSocket() {
    const socket = io();
    socket.on('connect_error', (err) => console.error('[socket] connect_error', err));
    socket.on('rooms:snapshot', (rooms) => {
      liveRooms.clear();
      for (const r of rooms) if (r) liveRooms.set(r.roomId, r);
      renderLiveRooms();
    });
    socket.on('room:update', (room) => {
      if (!room) return;
      liveRooms.set(room.roomId, room);
      renderLiveRooms();
      loadDashboard();
    });
    socket.on('alert', () => loadDashboard());
  }

  // ---------------- Dashboard ----------------
  async function loadDashboard() {
    const data = await api('/dashboard');
    if (!data.success) return;
    const stats = [
      ['Provas em andamento', data.dashboard.examsInProgress],
      ['Provas finalizadas', data.dashboard.examsFinished],
      ['Salas ativas', data.dashboard.roomsActive],
      ['Alunos online', data.dashboard.studentsOnline],
      ['Professores conectados', data.dashboard.proctorsConnected],
      ['Transmissões ativas', data.dashboard.transmissionsLive],
      ['Alertas de foco', data.dashboard.focusAlerts],
    ];
    document.getElementById('dashboard-stats').innerHTML = stats.map(([label, value]) => `
      <div class="stat-card"><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>
    `).join('');
  }

  async function loadLiveRooms() {
    const data = await api('/rooms/live');
    if (!data.success) return;
    for (const r of data.rooms) liveRooms.set(r.roomId, r);
    renderLiveRooms();
  }

  const STREAM_LABEL = { awaiting: 'Aguardando', capturing: 'Capturando', connecting: 'Conectando', negotiating: 'Negociando', live: 'Transmitindo', reconnecting: 'Reconectando', interrupted: 'Interrompida', error: 'Erro' };

  function renderLiveRooms() {
    const el = document.getElementById('live-rooms-list');
    const rooms = Array.from(liveRooms.values()).filter(Boolean);
    if (rooms.length === 0) { el.innerHTML = '<p class="list-empty">Nenhuma sala com atividade no momento.</p>'; return; }

    el.innerHTML = rooms.map((r) => {
      const streamCls = r.streamStatus === 'live' ? 'badge-ok' : r.streamStatus === 'interrupted' || r.streamStatus === 'error' ? 'badge-danger' : 'badge-neutral';
      const focusCls = r.focusStatus === 'out' ? 'badge-warn' : 'badge-ok';
      const timeLabel = r.timeRemainingMs != null ? fmtDuration(r.timeRemainingMs) : '—';
      return `
      <div class="item-row live-room-card">
        <div class="live-room-top">
          <strong>${escapeHtml(r.roomLabel || r.roomId)} — ${escapeHtml(r.studentName || '')}</strong>
          <span class="badge ${r.studentOnline ? 'badge-ok' : 'badge-neutral'}"><span class="badge-dot"></span>${r.studentOnline ? 'Online' : 'Offline'}</span>
        </div>
        <div class="live-room-badges">
          <span class="badge ${streamCls}"><span class="badge-dot"></span>${STREAM_LABEL[r.streamStatus] || r.streamStatus}</span>
          <span class="badge ${focusCls}"><span class="badge-dot"></span>${r.focusStatus === 'out' ? 'Fora da tela' : 'Na prova'}</span>
          <span class="badge badge-neutral"><span class="badge-dot"></span>Questão ${r.currentQuestionOrder || 0}/${r.totalQuestions || 0}</span>
          <span class="badge badge-neutral"><span class="badge-dot"></span>${timeLabel} restante</span>
          <span class="badge badge-neutral"><span class="badge-dot"></span>${r.proctorCount} fiscal(is)</span>
        </div>
        <div class="live-room-badges">
          <button class="small-btn secondary-btn" data-live-student-link="${r.roomId}">🔗 Link do aluno</button>
          <button class="small-btn secondary-btn" data-live-add-proctor="${r.roomId}">+ Link do fiscal</button>
        </div>
      </div>`;
    }).join('');

    el.querySelectorAll('[data-live-student-link]').forEach((btn) => btn.addEventListener('click', async () => {
      if (!confirm('Isso gera um novo link do aluno e invalida o link anterior (quem já estiver na prova NÃO é desconectado). Continuar?')) return;
      const data = await api(`/rooms/${btn.dataset.liveStudentLink}/regenerate-student-link`, { method: 'POST' });
      if (!data.success) { alert(data.message || 'Erro.'); return; }
      flashLink('Link do aluno (mostrado apenas uma vez — copie agora)', location.origin + data.studentLink);
    }));
    el.querySelectorAll('[data-live-add-proctor]').forEach((btn) => btn.addEventListener('click', async () => {
      const label = prompt('Rótulo do fiscal (ex.: Professor João):', 'Fiscal');
      if (label === null) return;
      const data = await api(`/rooms/${btn.dataset.liveAddProctor}/proctor-tokens`, { method: 'POST', body: JSON.stringify({ label }) });
      if (!data.success) { alert(data.message || 'Erro.'); return; }
      flashLink(`Link do fiscal "${label}" (mostrado apenas uma vez)`, location.origin + data.proctorLink);
    }));
  }

  // ---------------- Configurações da plataforma e identidade visual ----------------
  function applyThemePreview(theme) {
    const root = document.documentElement.style;
    if (theme.primaryColorLight) root.setProperty('--accent-1', theme.primaryColorLight);
    if (theme.primaryColor) root.setProperty('--accent-2', theme.primaryColor);
    if (theme.primaryColorDark) root.setProperty('--accent-3', theme.primaryColorDark);
    if (theme.backgroundColor) root.setProperty('--bg-0', theme.backgroundColor);
    if (theme.cardColor) root.setProperty('--bg-card', theme.cardColor);
    root.setProperty('--bg-image', theme.backgroundImageUrl ? `url('${theme.backgroundImageUrl}')` : 'none');
  }

  async function loadSettings() {
    const data = await api('/settings');
    if (!data.success) return;
    document.getElementById('settings-platform-name').value = data.settings.platformName || '';
    document.getElementById('settings-intro-video').value = data.settings.introVideoYoutubeId || '';

    const theme = data.settings.theme || {};
    document.getElementById('theme-primary-color').value = theme.primaryColor || '#dc2626';
    document.getElementById('theme-primary-color-dark').value = theme.primaryColorDark || '#991b1b';
    document.getElementById('theme-primary-color-light').value = theme.primaryColorLight || '#f87171';
    document.getElementById('theme-background-color').value = theme.backgroundColor || '#1a0505';
    document.getElementById('theme-card-color').value = theme.cardColor || '#2a0e0e';
    applyThemePreview(theme);
  }

  document.getElementById('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = await api('/settings', {
      method: 'PUT',
      body: JSON.stringify({
        platformName: document.getElementById('settings-platform-name').value,
        introVideoYoutubeId: document.getElementById('settings-intro-video').value,
      }),
    });
    if (data.success) document.querySelectorAll('.js-wordmark').forEach((el) => { el.textContent = data.settings.platformName; });
  });

  document.getElementById('theme-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const theme = {
      primaryColor: document.getElementById('theme-primary-color').value,
      primaryColorDark: document.getElementById('theme-primary-color-dark').value,
      primaryColorLight: document.getElementById('theme-primary-color-light').value,
      backgroundColor: document.getElementById('theme-background-color').value,
      cardColor: document.getElementById('theme-card-color').value,
    };
    const data = await api('/settings', { method: 'PUT', body: JSON.stringify({ theme }) });
    if (data.success) applyThemePreview(data.settings.theme);
  });

  document.getElementById('theme-reset-btn').addEventListener('click', async () => {
    if (!confirm('Restaurar as cores para o padrão da plataforma?')) return;
    const data = await api('/settings', { method: 'PUT', body: JSON.stringify({ resetTheme: true }) });
    if (data.success) loadSettings();
  });

  document.getElementById('settings-background-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = document.getElementById('settings-background-file').files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('background', file);
    const data = await api('/settings/background', { method: 'POST', body: formData });
    if (data.success) applyThemePreview(data.settings.theme);
  });

  document.getElementById('remove-background-btn').addEventListener('click', async () => {
    const data = await api('/settings/background', { method: 'DELETE' });
    if (data.success) applyThemePreview(data.settings.theme);
  });

  document.getElementById('settings-logo-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = document.getElementById('settings-logo-file').files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('logo', file);
    await api('/settings/logo', { method: 'POST', body: formData });
  });

  // ---------------- Provas ----------------
  let examsCache = [];
  let selectedExamId = null;

  async function loadExams() {
    const data = await api('/exams');
    if (!data.success) return;
    examsCache = data.exams;
    renderExams();
    renderRoomExamSelect();
    renderResultsExamFilter();
  }

  document.getElementById('exam-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      name: document.getElementById('exam-name').value.trim(),
      questionCount: Number(document.getElementById('exam-question-count').value),
      pointsPerQuestion: Number(document.getElementById('exam-points').value),
      durationMinutes: Number(document.getElementById('exam-duration').value),
      introVideoYoutubeId: document.getElementById('exam-intro-video').value.trim() || null,
    };
    const data = await api('/exams', { method: 'POST', body: JSON.stringify(payload) });
    if (data.success) { e.target.reset(); document.getElementById('exam-question-count').value = 50; document.getElementById('exam-points').value = 2; document.getElementById('exam-duration').value = 120; loadExams(); }
    else alert(data.message || 'Erro ao criar prova.');
  });

  function renderExams() {
    const el = document.getElementById('exams-list');
    if (examsCache.length === 0) { el.innerHTML = '<p class="list-empty">Nenhuma prova cadastrada.</p>'; return; }
    el.innerHTML = examsCache.map((exam) => `
      <div class="item-row">
        <div>
          <strong>${escapeHtml(exam.name)}</strong>
          <div class="room-item-meta">${exam.questionCount} questões · ${exam.pointsPerQuestion} pts/questão · ${exam.durationMinutes} min</div>
        </div>
        <div class="room-item-actions">
          <span class="badge ${exam.active ? 'badge-ok' : 'badge-neutral'}"><span class="badge-dot"></span>${exam.active ? 'Ativa' : 'Inativa'}</span>
          <button class="small-btn secondary-btn" data-toggle-exam="${exam._id}" data-active="${exam.active}">${exam.active ? 'Desativar' : 'Ativar'}</button>
          <button class="small-btn" data-view-questions="${exam._id}" data-name="${escapeHtml(exam.name)}">Questões</button>
        </div>
      </div>
    `).join('');

    el.querySelectorAll('[data-toggle-exam]').forEach((btn) => btn.addEventListener('click', async () => {
      await api(`/exams/${btn.dataset.toggleExam}`, { method: 'PUT', body: JSON.stringify({ active: btn.dataset.active !== 'true' }) });
      loadExams();
    }));
    el.querySelectorAll('[data-view-questions]').forEach((btn) => btn.addEventListener('click', () => {
      selectedExamId = btn.dataset.viewQuestions;
      document.getElementById('questions-exam-name').textContent = btn.dataset.name;
      document.getElementById('questions-section').classList.remove('hidden');
      loadQuestions();
    }));
  }

  // ---------------- Banco de questões ----------------
  let questionsCache = [];

  async function loadQuestions() {
    if (!selectedExamId) return;
    const data = await api(`/exams/${selectedExamId}/questions`);
    if (!data.success) return;
    questionsCache = data.questions;
    renderQuestions();
  }

  function questionFormHtml(existing) {
    const opts = existing ? existing.options : [{ key: 'A', text: '' }, { key: 'B', text: '' }, { key: 'C', text: '' }, { key: 'D', text: '' }];
    const correct = existing ? existing.correctKey : 'A';
    return `
      <div class="question-form" id="question-form">
        <textarea id="qf-text" rows="2" placeholder="Texto da pergunta">${existing ? escapeHtml(existing.text) : ''}</textarea>
        ${opts.map((o) => `
          <div class="opt-row">
            <input type="radio" name="qf-correct" value="${o.key}" ${o.key === correct ? 'checked' : ''} />
            <span>${o.key}</span>
            <input type="text" class="qf-opt" data-key="${o.key}" placeholder="Alternativa ${o.key}" value="${escapeHtml(o.text)}" />
          </div>
        `).join('')}
        <div>
          <button type="button" id="qf-save" class="small-btn">${existing ? 'Salvar alterações' : 'Adicionar questão'}</button>
          <button type="button" id="qf-cancel" class="small-btn secondary-btn">Cancelar</button>
        </div>
        <p class="error-msg" id="qf-error"></p>
      </div>`;
  }

  function bindQuestionForm(container, existingId) {
    container.querySelector('#qf-cancel').addEventListener('click', () => { container.innerHTML = ''; container.remove(); });
    container.querySelector('#qf-save').addEventListener('click', async () => {
      const text = container.querySelector('#qf-text').value.trim();
      const options = Array.from(container.querySelectorAll('.qf-opt')).map((inp) => ({ key: inp.dataset.key, text: inp.value.trim() }));
      const correctKey = container.querySelector('input[name="qf-correct"]:checked')?.value;
      const errorEl = container.querySelector('#qf-error');
      if (!text || options.some((o) => !o.text) || !correctKey) { errorEl.textContent = 'Preencha a pergunta, as 4 alternativas e marque a correta.'; return; }

      const payload = { text, options, correctKey };
      const data = existingId
        ? await api(`/questions/${existingId}`, { method: 'PUT', body: JSON.stringify(payload) })
        : await api(`/exams/${selectedExamId}/questions`, { method: 'POST', body: JSON.stringify(payload) });

      if (!data.success) { errorEl.textContent = data.message || 'Erro ao salvar.'; return; }
      loadQuestions();
    });
  }

  document.getElementById('new-question-btn').addEventListener('click', () => {
    const list = document.getElementById('questions-list');
    const wrapper = document.createElement('div');
    wrapper.innerHTML = questionFormHtml(null);
    list.prepend(wrapper.firstElementChild);
    bindQuestionForm(list.firstElementChild, null);
  });

  document.getElementById('import-csv-btn').addEventListener('click', async () => {
    const statusEl = document.getElementById('import-csv-status');
    const fileInput = document.getElementById('import-csv-file');
    const file = fileInput.files[0];
    if (!selectedExamId) { statusEl.textContent = 'Selecione uma prova antes de importar.'; return; }
    if (!file) { statusEl.textContent = 'Escolha um arquivo CSV primeiro.'; return; }

    statusEl.textContent = 'Importando...';
    const csvText = await file.text();
    const data = await api(`/exams/${selectedExamId}/questions/import`, { method: 'POST', body: JSON.stringify({ csvText }) });

    if (!data.success) {
      statusEl.textContent = data.message || 'Erro ao importar.';
      return;
    }

    const errorCount = (data.errors || []).length;
    statusEl.textContent = errorCount > 0
      ? `${data.imported} questão(ões) importada(s). ${errorCount} linha(s) com problema: ${data.errors.map((e) => `linha ${e.row} (${e.reason})`).join('; ')}`
      : `${data.imported} questão(ões) importada(s) com sucesso.`;

    fileInput.value = '';
    loadQuestions();
  });

  function renderQuestions() {
    const el = document.getElementById('questions-list');
    if (questionsCache.length === 0) { el.innerHTML = '<p class="list-empty">Nenhuma questão cadastrada nesta prova.</p>'; return; }

    el.innerHTML = questionsCache.map((q) => `
      <div class="item-row question-item" data-question-id="${q._id}">
        <div class="q-text">${escapeHtml(q.text)}</div>
        <div class="q-options">
          ${q.options.map((o) => `<span class="${o.key === q.correctKey ? 'correct' : ''}">${o.key} — ${escapeHtml(o.text)}${o.key === q.correctKey ? ' ✓' : ''}</span>`).join('')}
        </div>
        <div class="q-actions">
          <span class="badge ${q.active ? 'badge-ok' : 'badge-neutral'}"><span class="badge-dot"></span>${q.active ? 'Ativa' : 'Inativa'}</span>
          <button class="small-btn secondary-btn" data-edit="${q._id}">Editar</button>
          <button class="small-btn secondary-btn" data-duplicate="${q._id}">Duplicar</button>
          <button class="small-btn secondary-btn" data-toggle="${q._id}" data-active="${q.active}">${q.active ? 'Desativar' : 'Ativar'}</button>
          <button class="small-btn danger-btn" data-delete="${q._id}">Excluir</button>
        </div>
      </div>
    `).join('');

    el.querySelectorAll('[data-edit]').forEach((btn) => btn.addEventListener('click', () => {
      const q = questionsCache.find((x) => x._id === btn.dataset.edit);
      const row = btn.closest('.item-row');
      const wrapper = document.createElement('div');
      wrapper.innerHTML = questionFormHtml(q);
      const formEl = wrapper.firstElementChild;
      // replaceWith move o nó para fora de `wrapper` — reler
      // wrapper.firstElementChild depois disso dá null, porque wrapper já
      // ficou vazio. Guardar a referência antes é o que faz o formulário
      // realmente ganhar os listeners de Salvar/Cancelar.
      row.replaceWith(formEl);
      bindQuestionForm(formEl, q._id);
    }));
    el.querySelectorAll('[data-duplicate]').forEach((btn) => btn.addEventListener('click', async () => {
      await api(`/questions/${btn.dataset.duplicate}/duplicate`, { method: 'POST' });
      loadQuestions();
    }));
    el.querySelectorAll('[data-toggle]').forEach((btn) => btn.addEventListener('click', async () => {
      await api(`/questions/${btn.dataset.toggle}/active`, { method: 'PATCH', body: JSON.stringify({ active: btn.dataset.active !== 'true' }) });
      loadQuestions();
    }));
    el.querySelectorAll('[data-delete]').forEach((btn) => btn.addEventListener('click', async () => {
      if (!confirm('Excluir esta questão permanentemente?')) return;
      await api(`/questions/${btn.dataset.delete}`, { method: 'DELETE' });
      loadQuestions();
    }));
  }

  // ---------------- Salas ----------------
  function renderRoomExamSelect() {
    const sel = document.getElementById('room-exam-select');
    sel.innerHTML = examsCache.filter((e) => e.active).map((e) => `<option value="${e._id}">${escapeHtml(e.name)}</option>`).join('');
  }

  document.getElementById('room-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      examId: document.getElementById('room-exam-select').value,
      roomLabel: document.getElementById('room-label').value.trim(),
      studentName: document.getElementById('room-student-name').value.trim(),
    };
    const data = await api('/rooms', { method: 'POST', body: JSON.stringify(payload) });
    if (!data.success) { alert(data.message || 'Erro ao criar sala.'); return; }
    e.target.reset();
    flashLink('Link do aluno (mostrado apenas uma vez — copie agora)', location.origin + data.studentLink);
    loadRooms();
  });

  function flashLink(label, url) {
    // Só mantém um aviso de link por vez — antes eles se acumulavam no
    // topo da aba a cada sala/fiscal criado.
    document.querySelectorAll('.flash-link-box').forEach((el) => el.remove());

    const box = document.createElement('div');
    box.className = 'panel-section flash-link-box';
    box.innerHTML = `
      <div class="panel-section-header">
        <strong>${escapeHtml(label)}</strong>
        <button class="small-btn secondary-btn" data-dismiss style="margin:0">✕</button>
      </div>
      <div class="link-box"><input readonly value="${escapeHtml(url)}" /><button class="small-btn" data-copy>Copiar</button></div>`;
    box.querySelector('[data-copy]').addEventListener('click', () => navigator.clipboard.writeText(url));
    box.querySelector('[data-dismiss]').addEventListener('click', () => box.remove());
    // Prepende na aba visível no momento — os botões de link aparecem tanto
    // na aba "Salas" quanto nos cartões da aba "Dashboard" (salas ao vivo).
    const activeTab = document.querySelector('.tab-panel:not(.hidden)') || document.getElementById('rooms-tab');
    activeTab.prepend(box);
  }

  let roomsCache = [];
  async function loadRooms() {
    const data = await api('/rooms');
    if (!data.success) return;
    roomsCache = data.rooms;
    renderRooms();
  }

  function renderRooms() {
    const el = document.getElementById('rooms-list');
    if (roomsCache.length === 0) { el.innerHTML = '<p class="list-empty">Nenhuma sala criada.</p>'; return; }

    el.innerHTML = roomsCache.map((r) => {
      // Tokens revogados somem da lista — é exatamente isso que "excluir"
      // significa aqui (o servidor mantém o registro só para auditoria).
      const activeTokens = r.proctorTokens.filter((t) => !t.revokedAt);
      return `
      <div class="item-row room-item" data-room-id="${r._id}">
        <div class="room-item-header">
          <strong>${escapeHtml(r.roomLabel)} — ${escapeHtml(r.studentName)}</strong>
          <span class="badge badge-neutral"><span class="badge-dot"></span>${r.status}</span>
        </div>
        <div class="room-item-meta">${escapeHtml(r.examId && r.examId.name ? r.examId.name : '')} · ${activeTokens.length} fiscal(is) ativo(s)</div>
        <div class="room-item-actions">
          <button class="small-btn secondary-btn" data-get-student-link="${r._id}">🔗 Link do aluno</button>
          <button class="small-btn secondary-btn" data-add-proctor="${r._id}">+ Link do fiscal</button>
          ${r.status !== 'closed' ? `<button class="small-btn danger-btn" data-close-room="${r._id}">Encerrar sala</button>` : ''}
          <button class="small-btn danger-btn" data-delete-room="${r._id}" title="Excluir sala (a nota fica salva em Resultados)">✕ Excluir sala</button>
        </div>
        <div class="room-item-actions" data-proctor-list>
          ${activeTokens.map((t) => `<span class="badge badge-ok"><span class="badge-dot"></span>${escapeHtml(t.label)}</span><button class="small-btn secondary-btn" data-revoke-token="${r._id}:${t._id}" title="Excluir este link">✕</button>`).join('')}
        </div>
      </div>`;
    }).join('');

    el.querySelectorAll('[data-get-student-link]').forEach((btn) => btn.addEventListener('click', async () => {
      if (!confirm('Isso gera um novo link do aluno e invalida o link anterior (quem já estiver na prova NÃO é desconectado). Continuar?')) return;
      const data = await api(`/rooms/${btn.dataset.getStudentLink}/regenerate-student-link`, { method: 'POST' });
      if (!data.success) { alert(data.message || 'Erro.'); return; }
      flashLink('Link do aluno (mostrado apenas uma vez — copie agora)', location.origin + data.studentLink);
    }));
    el.querySelectorAll('[data-add-proctor]').forEach((btn) => btn.addEventListener('click', async () => {
      const label = prompt('Rótulo do fiscal (ex.: Professor João):', 'Fiscal');
      if (label === null) return;
      const data = await api(`/rooms/${btn.dataset.addProctor}/proctor-tokens`, { method: 'POST', body: JSON.stringify({ label }) });
      if (!data.success) { alert(data.message || 'Erro.'); return; }
      flashLink(`Link do fiscal "${label}" (mostrado apenas uma vez)`, location.origin + data.proctorLink);
      loadRooms();
    }));
    el.querySelectorAll('[data-close-room]').forEach((btn) => btn.addEventListener('click', async () => {
      if (!confirm('Encerrar esta sala? O aluno e os fiscais serão desconectados.')) return;
      await api(`/rooms/${btn.dataset.closeRoom}/close`, { method: 'POST' });
      loadRooms();
    }));
    el.querySelectorAll('[data-delete-room]').forEach((btn) => btn.addEventListener('click', async () => {
      if (!confirm('Excluir esta sala? A nota e o histórico da prova continuam salvos na aba Resultados. Essa ação não pode ser desfeita (o link deixa de funcionar).')) return;
      const data = await api(`/rooms/${btn.dataset.deleteRoom}`, { method: 'DELETE' });
      if (!data.success) { alert(data.message || 'Erro ao excluir.'); return; }
      loadRooms();
    }));
    el.querySelectorAll('[data-revoke-token]').forEach((btn) => btn.addEventListener('click', async () => {
      const [roomId, tokenId] = btn.dataset.revokeToken.split(':');
      await api(`/rooms/${roomId}/proctor-tokens/${tokenId}`, { method: 'DELETE' });
      loadRooms();
    }));
  }

  // ---------------- Resultados & auditoria ----------------
  function renderResultsExamFilter() {
    const sel = document.getElementById('results-exam-filter');
    sel.innerHTML = '<option value="">Todas as provas</option>' + examsCache.map((e) => `<option value="${e._id}">${escapeHtml(e.name)}</option>`).join('');
    sel.onchange = () => loadResults();
  }

  async function loadResults() {
    const examId = document.getElementById('results-exam-filter').value;
    const qs = examId ? `?examId=${examId}` : '';
    const data = await api(`/results${qs}`);
    if (!data.success) return;

    const tbody = document.getElementById('results-tbody');
    if (data.attempts.length === 0) { tbody.innerHTML = '<tr><td colspan="9" class="list-empty">Nenhum resultado ainda.</td></tr>'; return; }

    // Sala + horário de início aparecem sempre, mesmo com nomes repetidos
    // entre tentativas — cada linha é uma tentativa de uma sala específica,
    // nunca se sobrescrevem entre si.
    tbody.innerHTML = data.attempts.map((a) => `
      <tr>
        <td>${escapeHtml(a.roomId ? a.roomId.studentName : a.studentName)}${a.roomId ? '' : ' <span class="hint">(sala excluída)</span>'}</td>
        <td>${escapeHtml((a.roomId ? a.roomId.roomLabel : a.roomLabel) || '—')}</td>
        <td>${escapeHtml(a.examId ? a.examId.name : '')}</td>
        <td>${a.status === 'in_progress' ? '—' : a.score}</td>
        <td>${a.status === 'in_progress' ? '—' : a.correctCount}</td>
        <td>${a.status === 'in_progress' ? '—' : a.wrongCount}</td>
        <td>${fmtDate(a.startedAt)}</td>
        <td><span class="badge ${a.status === 'in_progress' ? 'badge-warn' : 'badge-ok'}"><span class="badge-dot"></span>${a.status}</span></td>
        <td>
          <button class="small-btn secondary-btn" data-detail="${a._id}">Detalhes</button>
          <button class="small-btn danger-btn" data-delete-result="${a._id}">Apagar nota</button>
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('[data-detail]').forEach((btn) => btn.addEventListener('click', () => openDetail(btn.dataset.detail)));
    tbody.querySelectorAll('[data-delete-result]').forEach((btn) => btn.addEventListener('click', async () => {
      if (!window.confirm('Apagar esta nota permanentemente? A sala volta a ficar disponível para uma nova tentativa. Essa ação não pode ser desfeita.')) return;
      const data2 = await api(`/results/${btn.dataset.deleteResult}`, { method: 'DELETE' });
      if (!data2.success) { alert(data2.message || 'Erro ao apagar.'); return; }
      loadResults();
    }));
  }

  async function openDetail(attemptId, filter = 'all') {
    const qs = filter !== 'all' ? `?filter=${filter}` : '';
    const data = await api(`/results/${attemptId}${qs}`);
    if (!data.success) { alert(data.message); return; }

    const a = data.attempt;
    const summary = `
      <div class="detail-grid">
        <div class="stat-card"><div class="stat-value">${a.score}</div><div class="stat-label">Nota</div></div>
        <div class="stat-card"><div class="stat-value">${a.correctCount}</div><div class="stat-label">Acertos</div></div>
        <div class="stat-card"><div class="stat-value">${a.wrongCount}</div><div class="stat-label">Erros</div></div>
        <div class="stat-card"><div class="stat-value">${a.unansweredCount}</div><div class="stat-label">Não respondidas</div></div>
        <div class="stat-card"><div class="stat-value">${fmtDuration(a.totalFocusLossMs)}</div><div class="stat-label">Tempo fora da tela</div></div>
        <div class="stat-card"><div class="stat-value">${(a.streamEvents || []).filter((s) => s.type === 'interrupted').length}</div><div class="stat-label">Interrupções de transmissão</div></div>
      </div>
      <p class="hint">Início: ${fmtDate(a.startedAt)} · Fim: ${fmtDate(a.finishedAt)}</p>
      <div class="audit-filters">
        ${['all', 'correct', 'wrong', 'unanswered'].map((f) => `<button class="small-btn ${f === filter ? '' : 'secondary-btn'}" data-filter="${f}">${{ all: 'Todas', correct: 'Corretas', wrong: 'Erradas', unanswered: 'Não respondidas' }[f]}</button>`).join('')}
      </div>
      <div id="audit-questions"></div>
    `;

    document.getElementById('modal-content').innerHTML = summary;
    document.getElementById('audit-questions').innerHTML = data.questions.map((q) => `
      <div class="audit-question">
        <div class="q-order">Questão ${q.order}</div>
        <div class="q-text">${escapeHtml(q.text)}</div>
        ${q.options.map((o) => `<div class="audit-option ${o.key === q.selectedKey ? 'is-selected' : ''} ${o.key === q.correctKey ? 'is-correct' : ''}">${o.key} — ${escapeHtml(o.text)}${o.key === q.correctKey ? ' (gabarito)' : ''}${o.key === q.selectedKey ? ' ← resposta do aluno' : ''}</div>`).join('')}
        <p class="hint" style="margin-top:6px">${q.isCorrect === null ? 'Não respondida' : q.isCorrect ? '🟢 CORRETA' : '🔴 ERRADA'}${q.answeredAt ? ' · ' + fmtDate(q.answeredAt) : ''}</p>
      </div>
    `).join('');

    document.getElementById('modal-content').querySelectorAll('[data-filter]').forEach((btn) => btn.addEventListener('click', () => openDetail(attemptId, btn.dataset.filter)));

    document.getElementById('detail-modal-backdrop').classList.remove('hidden');
  }

  document.getElementById('close-modal-btn').addEventListener('click', () => document.getElementById('detail-modal-backdrop').classList.add('hidden'));

  // ---------------- Segurança ----------------
  async function loadSecurityLogs() {
    const data = await api('/security-logs');
    if (!data.success) return;
    const tbody = document.getElementById('security-logs-tbody');
    tbody.innerHTML = data.logs.map((l) => `
      <tr><td>${fmtDate(l.at)}</td><td>${escapeHtml(l.type)}</td><td>${escapeHtml(l.ip || '—')}</td><td>${escapeHtml(JSON.stringify(l.meta || {}))}</td></tr>
    `).join('') || '<tr><td colspan="4" class="list-empty">Sem eventos.</td></tr>';
  }

  // ---------------- Boot ----------------
  loadRoomsOnTabOpen();
  function loadRoomsOnTabOpen() {
    document.querySelector('[data-tab="rooms-tab"]').addEventListener('click', loadRooms);
    // Resultados e Segurança também recarregam ao abrir a aba — sem isso,
    // uma lista carregada uma vez no boot podia ficar defasada (ex.: exibir
    // uma nota que já foi excluída em outra ação), levando a erros como
    // "Tentativa não encontrada" ao clicar em Detalhes de uma linha velha.
    document.querySelector('[data-tab="results-tab"]').addEventListener('click', loadResults);
    document.querySelector('[data-tab="security-tab"]').addEventListener('click', loadSecurityLogs);
  }

  boot();
})();
