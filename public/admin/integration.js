// Aba "Integração BotGhost" do painel admin: situação, configuração, fila
// de avisos e promoções. Mesma API autenticada do resto do painel.
(() => {
  async function api(path, options = {}) {
    const res = await fetch(`/api/admin/integration${path}`, { headers: { 'Content-Type': 'application/json' }, ...options });
    let data;
    try { data = await res.json(); } catch (_) { data = { success: false, message: 'Resposta inválida do servidor.' }; }
    return { status: res.status, ...data };
  }

  function esc(str) {
    return String(str == null ? '' : str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtDate(d) { return d ? new Date(d).toLocaleString('pt-BR') : '—'; }
  const $ = (id) => document.getElementById(id);

  const KIND_TEXT = { result: 'Aviso de resultado', promotion_announcement: 'Anúncio de promoção', template_test: 'Teste de mensagem', panel_update: 'Atualização do painel' };
  const NOTIF_STATUS = {
    pending: ['Na fila', 'badge-warn'],
    dispatched: ['Webhook disparado (aguardando BotGhost)', 'badge-warn'],
    claimed: ['BotGhost publicando', 'badge-warn'],
    delivered: ['Entregue', 'badge-ok'],
    failed: ['Falhou', 'badge-danger'],
    ambiguous: ['Ambíguo — conferir canal', 'badge-danger'],
    cancelled: ['Cancelado', 'badge-neutral'],
  };
  const PROMO_STATUS = {
    pending: ['Na fila', 'badge-warn'],
    in_progress: ['Executando', 'badge-warn'],
    completed: ['Concluída', 'badge-ok'],
    partial: ['Parcial', 'badge-danger'],
    failed: ['Falhou', 'badge-danger'],
    needs_review: ['Precisa de revisão', 'badge-danger'],
    blocked: ['Bloqueada', 'badge-neutral'],
  };

  function badge([text, cls]) {
    return `<span class="badge ${cls}"><span class="badge-dot"></span>${esc(text)}</span>`;
  }
  function yes(v, okText = '✓ definido (nunca exibido)') {
    return v ? okText : '<span class="error-msg">não definido</span>';
  }

  async function loadStatus() {
    const data = await api('/status');
    if (!data.success) return;
    const e = data.env;
    const s = data.status || {};
    const n = data.notifications || {};
    const cards = [
      ['Integração', e.enabled ? badge(['Ligada', 'badge-ok']) : badge(['Desligada (BOTGHOST_INTEGRATION_ENABLED)', 'badge-neutral'])],
      ['Chave do site (BOTGHOST_SITE_API_KEY)', e.siteApiKeyDefined ? (e.siteApiKeyStrong ? '✓ definida (nunca exibida)' : '<span class="error-msg">curta demais (mín. 32)</span>') : yes(false)],
      ['Servidor autorizado', e.allowedGuildId ? `<code>${esc(e.allowedGuildId)}</code>` : '<span class="error-msg">não definido</span>'],
      ['Avisos por webhook', e.notificationsEnabled ? (e.webhookProblem ? `<span class="error-msg">${esc(e.webhookProblem)}</span>` : badge(['Ligados', 'badge-ok'])) : badge(['Desligados', 'badge-neutral'])],
      ['Último pedido autenticado do BotGhost', s.lastAuthAt ? `${fmtDate(s.lastAuthAt)}<br><span class="hint">${esc(s.lastAuthRoute || '')}</span>` : 'nenhum ainda'],
      ['Última confirmação de entrega (ack)', s.lastAckAt ? fmtDate(s.lastAckAt) : 'nenhuma ainda'],
      ['Avisos pendentes', String((n.pending || 0) + (n.dispatched || 0) + (n.claimed || 0))],
      ['Avisos com problema', String((n.failed || 0) + (n.ambiguous || 0))],
    ];
    $('ig-status').innerHTML = cards.map(([label, value]) => `<div class="stat-card"><div class="stat-label">${esc(label)}</div><div style="margin-top:6px">${value}</div></div>`).join('');
    const hints = [];
    hints.push(`Endereço da API para o BotGhost: <code>${esc(e.apiBaseUrl)}</code>${e.publicBaseUrlIsHttps ? '' : ' ⚠ não é HTTPS (normal só em teste local)'}.`);
    if (s.lastWebhookOkAt) hints.push(`Último webhook aceito pelo BotGhost: ${fmtDate(s.lastWebhookOkAt)} (aceito ≠ entregue).`);
    if (s.lastWebhookError) hints.push(`Último erro do webhook (${fmtDate(s.lastWebhookErrorAt)}): ${esc(s.lastWebhookError)}`);
    hints.push(data.panelMessage && data.panelMessage.messageId
      ? `Painel registrado: mensagem <code>${esc(data.panelMessage.messageId)}</code> no canal <code>${esc(data.panelMessage.channelId)}</code>.`
      : 'Painel ainda não registrado (o fluxo /provatcel do BotGhost registra na primeira publicação).');
    $('ig-status-hint').innerHTML = hints.join('<br>');
  }

  $('ig-panel-update-btn').addEventListener('click', async () => {
    const msg = $('ig-panel-msg');
    msg.textContent = 'Enviando...';
    const data = await api('/panel/update', { method: 'POST' });
    msg.textContent = data.success ? '✓ Atualização na fila: o BotGhost vai editar a mensagem do painel (confira a fila abaixo).' : (data.message || 'Erro.');
    loadNotifications();
  });

  async function loadConfig() {
    const data = await api('/config');
    if (!data.success) return;
    const c = data.config;
    $('ig-ops-generate').value = c.operatorIds.generate.join(', ');
    $('ig-ops-results').value = c.operatorIds.results.join(', ');
    $('ig-ops-promote').value = c.operatorIds.promote.join(', ');
    $('ig-ch-panel').value = c.channels.panel || '';
    $('ig-ch-results').value = c.channels.results || '';
    $('ig-ch-test').value = c.channels.test || '';
    $('ig-add-roles').value = c.promotion.addRoleIds.join(', ');
    $('ig-remove-roles').value = c.promotion.removeRoleIds.join(', ');
    $('ig-announce-channel').value = c.promotion.announceChannelId || '';
    $('ig-announce-role').value = c.promotion.announceRoleId || '';
    $('ig-nickname-template').value = c.promotion.nicknameTemplate || '';
    $('ig-default-exam').innerHTML = '<option value="">(sem padrão — usa a única apta, ou o operador escolhe)</option>'
      + data.exams.map((e) => `<option value="${esc(e._id)}" ${String(e._id) === String(c.defaultExamId) ? 'selected' : ''}>${esc(e.name)}${e.active ? '' : ' (inativa)'}</option>`).join('');
  }

  $('ig-config-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const msg = $('ig-config-msg');
    msg.textContent = 'Salvando...';
    const body = {
      operatorIds: { generate: $('ig-ops-generate').value, results: $('ig-ops-results').value, promote: $('ig-ops-promote').value },
      defaultExamId: $('ig-default-exam').value || null,
      channels: { panel: $('ig-ch-panel').value, results: $('ig-ch-results').value, test: $('ig-ch-test').value },
      promotion: {
        addRoleIds: $('ig-add-roles').value,
        removeRoleIds: $('ig-remove-roles').value,
        announceChannelId: $('ig-announce-channel').value,
        announceRoleId: $('ig-announce-role').value,
        nicknameTemplate: $('ig-nickname-template').value,
      },
    };
    const data = await api('/config', { method: 'PUT', body: JSON.stringify(body) });
    msg.textContent = data.success ? '✓ Configuração salva.' : (data.message || 'Erro ao salvar.');
    if (data.success) loadConfig();
  });

  let notifPage = 0;
  async function loadNotifications() {
    const status = $('ig-notif-filter').value;
    const q = new URLSearchParams({ page: String(notifPage) });
    if (status) q.set('status', status);
    const data = await api(`/notifications?${q}`);
    if (!data.success) return;
    const tbody = $('ig-notif-tbody');
    tbody.innerHTML = data.items.map((n) => {
      const detail = [];
      if (n.kind === 'promotion_announcement' && n.payload && n.payload.userIds) detail.push(`${n.payload.userIds.length} promovido(s), parte ${Number(n.chunkIndex || 0) + 1}`);
      if (n.templateKey) detail.push(`modelo ${n.templateKey}`);
      if (n.message && n.message.messageId) detail.push(`mensagem ${n.message.messageId}`);
      if (n.lastError) detail.push(n.lastError);
      const actions = [];
      if (['failed', 'pending'].includes(n.status)) actions.push(`<button class="small-btn secondary-btn" data-retry="${esc(n._id)}">Reprocessar agora</button>`);
      if (n.status === 'ambiguous') {
        actions.push(`<button class="small-btn secondary-btn" data-amb-delivered="${esc(n._id)}" title="A mensagem está no canal: informe o ID dela">Já está no canal</button>`);
        actions.push(`<button class="small-btn danger-btn" data-amb-resend="${esc(n._id)}" title="Só se você conferiu que a mensagem NÃO saiu">Reenviar</button>`);
      }
      return `
      <tr>
        <td>${fmtDate(n.updatedAt)}</td>
        <td>${esc(KIND_TEXT[n.kind] || n.kind)}</td>
        <td>${badge(NOTIF_STATUS[n.status] || [n.status, 'badge-neutral'])}</td>
        <td>${n.dispatchAttempts}/${n.maxDispatchAttempts}</td>
        <td><span class="hint">${esc(detail.join(' · '))}</span></td>
        <td>${actions.join(' ')}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="6" class="list-empty">Nenhum aviso.</td></tr>';
    $('ig-notif-page').textContent = `Página ${data.page + 1} de ${data.pages} · ${data.total} aviso(s)`;
    $('ig-notif-prev').disabled = data.page <= 0;
    $('ig-notif-next').disabled = data.page >= data.pages - 1;

    tbody.querySelectorAll('[data-retry]').forEach((btn) => btn.addEventListener('click', async () => {
      const res = await api(`/notifications/${btn.dataset.retry}/retry`, { method: 'POST' });
      if (!res.success) alert(res.message || 'Erro.');
      loadNotifications();
    }));
    tbody.querySelectorAll('[data-amb-delivered]').forEach((btn) => btn.addEventListener('click', async () => {
      const messageId = prompt('Confira o canal. Se a mensagem está lá, cole o ID dela (botão direito → Copiar ID da mensagem):');
      if (!messageId) return;
      const res = await api(`/notifications/${btn.dataset.ambDelivered}/resolve-ambiguous`, { method: 'POST', body: JSON.stringify({ mode: 'delivered', messageId: messageId.trim() }) });
      if (!res.success) alert(res.message || 'Erro.');
      loadNotifications();
    }));
    tbody.querySelectorAll('[data-amb-resend]').forEach((btn) => btn.addEventListener('click', async () => {
      if (!confirm('Reenviar SÓ se você conferiu o canal e a mensagem NÃO está lá. Se estiver, isso cria uma mensagem duplicada. Continuar?')) return;
      const res = await api(`/notifications/${btn.dataset.ambResend}/resolve-ambiguous`, { method: 'POST', body: JSON.stringify({ mode: 'resend' }) });
      if (!res.success) alert(res.message || 'Erro.');
      loadNotifications();
    }));
  }

  async function loadPromotions() {
    const data = await api('/promotions');
    if (!data.success) return;
    const tbody = $('ig-promotions-tbody');
    tbody.innerHTML = data.items.map((p) => {
      const steps = p.steps.map((s) => `${s.status === 'done' ? '✓' : s.status === 'failed' ? '✗' : '…'} ${s.type === 'setNickname' ? 'apelido' : `${s.type === 'addRole' ? '+' : '−'}${esc(s.roleId)}`}${s.alreadyInPlace ? ' (já estava)' : ''}${s.error ? ` (${esc(s.error)})` : ''}`).join('<br>');
      const released = p.resolvedAdministratively && p.resolvedAdministratively.at;
      const notes = [];
      if (p.announced) notes.push('anunciado');
      if (p.preexisting) notes.push('já tinha os cargos (sem anúncio)');
      if (p.reviewReason) notes.push(esc(p.reviewReason));
      if (p.conflict) notes.push(`⚠ ${esc(p.conflict)}`);
      if (released) notes.push(`liberado em ${fmtDate(p.resolvedAdministratively.at)}: ${esc(p.resolvedAdministratively.reason)}`);
      return `
      <tr>
        <td>${fmtDate(p.createdAt)}</td>
        <td><code>${esc(p.discordUserId)}</code><br><span class="hint">ID RP ${esc(p.idRP)} · operador ${esc(p.operatorId)}</span></td>
        <td>${esc(p.nickname)}</td>
        <td>${badge(PROMO_STATUS[p.status] || [p.status, 'badge-neutral'])}${notes.length ? `<br><span class="hint">${notes.join('<br>')}</span>` : ''}</td>
        <td><span class="hint">${steps}</span></td>
        <td>
          ${['partial', 'failed'].includes(p.status) ? `<button class="small-btn secondary-btn" data-resume="${esc(p._id)}">Retomar pendentes</button>` : ''}
          ${p.status === 'needs_review' && p.preexisting ? `<button class="small-btn secondary-btn" data-accept="${esc(p._id)}" title="Conferi o membro: aplicar só o que falta (apelido), sem anúncio">Aceitar estado atual</button>` : ''}
          ${p.active && !['pending', 'in_progress'].includes(p.status) ? `<button class="small-btn danger-btn" data-release="${esc(p._id)}" title="Permite promover esta pessoa de novo pelo bot. Não mexe em cargos.">Liberar nova promoção</button>` : ''}
        </td>
      </tr>`;
    }).join('') || '<tr><td colspan="6" class="list-empty">Nenhuma promoção ainda.</td></tr>';

    tbody.querySelectorAll('[data-resume]').forEach((btn) => btn.addEventListener('click', async () => {
      if (!confirm('Retomar só as etapas que falharam? O BotGhost confere o estado atual do membro antes de agir; o operador continua pelo botão no Discord.')) return;
      const res = await api(`/promotions/${btn.dataset.resume}/resume`, { method: 'POST' });
      alert(res.message || (res.success ? 'OK' : 'Erro.'));
      loadPromotions();
    }));
    tbody.querySelectorAll('[data-accept]').forEach((btn) => btn.addEventListener('click', async () => {
      if (!confirm('Você conferiu no Discord que os cargos atuais estão corretos? O bot vai aplicar só o que falta, sem anúncio.')) return;
      const res = await api(`/promotions/${btn.dataset.accept}/accept-external-state`, { method: 'POST' });
      alert(res.message || (res.success ? 'OK' : 'Erro.'));
      loadPromotions();
    }));
    tbody.querySelectorAll('[data-release]').forEach((btn) => btn.addEventListener('click', async () => {
      const reason = prompt('Resolução administrativa: esta pessoa poderá ser promovida de novo pelo bot. Nenhum cargo é alterado agora.\nMotivo (obrigatório):');
      if (reason === null) return;
      const res = await api(`/promotions/${btn.dataset.release}/release`, { method: 'POST', body: JSON.stringify({ reason }) });
      if (!res.success) alert(res.message || 'Erro.');
      loadPromotions();
    }));
  }

  // Chave gerada só no navegador (crypto.getRandomValues): nunca vai para
  // o servidor, nem fica salva.
  $('ig-keygen-btn').addEventListener('click', () => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const key = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    $('ig-keygen-out').value = key;
    $('ig-keygen-msg').textContent = 'Chave gerada (43 caracteres). Ela some ao sair desta página.';
  });
  $('ig-keygen-copy').addEventListener('click', async () => {
    const v = $('ig-keygen-out').value;
    if (!v) return;
    try { await navigator.clipboard.writeText(v); $('ig-keygen-msg').textContent = '✓ Copiada.'; } catch (_) { $('ig-keygen-out').select(); $('ig-keygen-msg').textContent = 'Selecione e copie com Ctrl+C.'; }
  });

  function loadAll() {
    loadStatus();
    loadConfig();
    loadNotifications();
    loadPromotions();
  }

  $('ig-refresh-btn').addEventListener('click', () => { loadStatus(); loadNotifications(); loadPromotions(); });
  $('ig-notif-filter').addEventListener('change', () => { notifPage = 0; loadNotifications(); });
  $('ig-notif-prev').addEventListener('click', () => { notifPage = Math.max(0, notifPage - 1); loadNotifications(); });
  $('ig-notif-next').addEventListener('click', () => { notifPage += 1; loadNotifications(); });
  document.querySelector('[data-tab="integration-tab"]').addEventListener('click', loadAll);
})();
