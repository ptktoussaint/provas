// Aba "Discord" do painel admin: situação do bot, configuração, fila de
// envios e promoções. Mesma API autenticada do resto do painel.
(() => {
  async function api(path, options = {}) {
    const res = await fetch(`/api/admin/discord${path}`, { headers: { 'Content-Type': 'application/json' }, ...options });
    let data;
    try { data = await res.json(); } catch (_) { data = { success: false, message: 'Resposta inválida do servidor.' }; }
    return { status: res.status, ...data };
  }

  function esc(str) {
    return String(str == null ? '' : str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtDate(d) { return d ? new Date(d).toLocaleString('pt-BR') : '—'; }
  const $ = (id) => document.getElementById(id);

  const STATUS_TEXT = {
    disabled: ['Desligado (DISCORD_ENABLED não é "true")', 'badge-neutral'],
    misconfigured: ['Faltam variáveis de ambiente', 'badge-danger'],
    connecting: ['Conectando...', 'badge-warn'],
    ready: ['Conectado', 'badge-ok'],
    reconnecting: ['Reconectando...', 'badge-warn'],
    error: ['Erro', 'badge-danger'],
    stopped: ['Parado', 'badge-neutral'],
  };
  const KIND_TEXT = { result_sync: 'Aviso de resultado', promotion_execute: 'Promoção (cargos/apelido)', promotion_announce: 'Anúncio de promoção' };
  const TASK_STATUS = { pending: ['Pendente', 'badge-warn'], processing: ['Processando', 'badge-warn'], done: ['Concluída', 'badge-ok'], failed: ['Falhou', 'badge-danger'], superseded: ['Substituída', 'badge-neutral'] };
  const PROMO_STATUS = { pending: ['Na fila', 'badge-warn'], in_progress: ['Executando', 'badge-warn'], completed: ['Concluída', 'badge-ok'], partial: ['Parcial', 'badge-danger'], failed: ['Falhou', 'badge-danger'] };

  function badge([text, cls]) {
    return `<span class="badge ${cls}"><span class="badge-dot"></span>${esc(text)}</span>`;
  }

  async function loadStatus() {
    const data = await api('/status');
    if (!data.success) return;
    const rt = data.runtime;
    const cards = [
      ['Bot', badge(STATUS_TEXT[rt.status] || [rt.status, 'badge-neutral']) + (rt.botTag ? `<br><span class="hint">${esc(rt.botTag)}</span>` : '')],
      ['Servidor (DISCORD_GUILD_ID)', data.env.guildId ? `<code>${esc(data.env.guildId)}</code>${rt.guildFound === false ? '<br><span class="error-msg">bot não está neste servidor</span>' : ''}` : '<span class="error-msg">não definido</span>'],
      ['Token do bot', data.env.hasToken ? '✓ definido (nunca exibido)' : '<span class="error-msg">não definido</span>'],
      ['Tarefas pendentes', String((data.tasks.pending || 0) + (data.tasks.processing || 0))],
      ['Tarefas com falha', String(data.tasks.failed || 0)],
    ];
    $('discord-status').innerHTML = cards.map(([label, value]) => `<div class="stat-card"><div class="stat-label">${esc(label)}</div><div style="margin-top:6px">${value}</div></div>`).join('');

    const hints = [];
    if (rt.lastError) hints.push(`Último erro do bot (${fmtDate(rt.lastErrorAt)}): ${esc(rt.lastError)}`);
    else if (data.lastConfigError) hints.push(`Último erro registrado (${fmtDate(data.lastConfigErrorAt)}): ${esc(data.lastConfigError)}`);
    if (rt.lastReadyAt) hints.push(`Conectou pela última vez em ${fmtDate(rt.lastReadyAt)}.`);
    hints.push(`Links gerados pelo bot usam: <code>${esc(data.env.publicBaseUrl)}</code>${data.env.publicBaseUrlIsHttps ? '' : ' ⚠ não é HTTPS (normal só em teste local)'}.`);
    $('discord-status-hint').innerHTML = hints.join('<br>');
    const invite = $('discord-invite-link');
    if (data.env.inviteUrl) { invite.href = data.env.inviteUrl; invite.classList.remove('hidden'); } else invite.classList.add('hidden');
  }

  $('discord-register-btn').addEventListener('click', async () => {
    const msg = $('discord-register-msg');
    msg.textContent = 'Registrando...';
    const data = await api('/register-commands', { method: 'POST' });
    msg.textContent = data.success
      ? `✓ Registrado: ${data.commands.map((c) => '/' + c.name).join(', ')}. Pode levar alguns segundos para aparecer no Discord.`
      : (data.message || 'Erro ao registrar.');
  });

  async function loadConfig() {
    const data = await api('/config');
    if (!data.success) return;
    const c = data.config;
    $('dc-panel-channel').value = c.panelChannelId || '';
    $('dc-results-channel').value = c.resultsChannelId || '';
    $('dc-roles-generate').value = c.operatorRoles.generate.join(', ');
    $('dc-roles-results').value = c.operatorRoles.results.join(', ');
    $('dc-roles-promote').value = c.operatorRoles.promote.join(', ');
    $('dc-add-roles').value = c.promotion.addRoleIds.join(', ');
    $('dc-remove-roles').value = c.promotion.removeRoleIds.join(', ');
    $('dc-announce-channel').value = c.promotion.announceChannelId || '';
    $('dc-announce-role').value = c.promotion.announceRoleId || '';
    $('dc-nickname-template').value = c.promotion.nicknameTemplate || '';
    $('dc-default-exam').innerHTML = '<option value="">(sem padrão — usa a única ativa, ou o operador escolhe)</option>'
      + data.exams.map((e) => `<option value="${e._id}" ${String(e._id) === String(c.defaultExamId) ? 'selected' : ''}>${esc(e.name)}${e.active ? '' : ' (inativa)'}</option>`).join('');
  }

  $('discord-config-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('discord-config-msg');
    msg.textContent = 'Salvando...';
    const body = {
      panelChannelId: $('dc-panel-channel').value,
      resultsChannelId: $('dc-results-channel').value,
      operatorRoles: {
        generate: $('dc-roles-generate').value,
        results: $('dc-roles-results').value,
        promote: $('dc-roles-promote').value,
      },
      defaultExamId: $('dc-default-exam').value || null,
      promotion: {
        addRoleIds: $('dc-add-roles').value,
        removeRoleIds: $('dc-remove-roles').value,
        announceChannelId: $('dc-announce-channel').value,
        announceRoleId: $('dc-announce-role').value,
        nicknameTemplate: $('dc-nickname-template').value,
      },
    };
    const data = await api('/config', { method: 'PUT', body: JSON.stringify(body) });
    msg.textContent = data.success ? '✓ Configuração salva.' : (data.message || 'Erro ao salvar.');
    if (data.success) loadConfig();
  });

  $('discord-verify-btn').addEventListener('click', async () => {
    const out = $('discord-verify-result');
    out.innerHTML = '<p class="hint">Verificando no Discord...</p>';
    const data = await api('/verify', { method: 'POST' });
    if (!data.success) { out.innerHTML = `<p class="error-msg">${esc(data.message || 'Não foi possível verificar.')}</p>`; return; }
    const s = data.snapshot;
    const lines = [];
    lines.push(`<strong>Servidor:</strong> ${esc(s.name)} · cargo mais alto do bot na posição ${s.bot.highestPosition} · Gerenciar cargos: ${s.bot.perms.manageRoles || s.bot.perms.administrator ? '✓' : '✗'} · Gerenciar apelidos: ${s.bot.perms.manageNicknames || s.bot.perms.administrator ? '✓' : '✗'}`);
    for (const [id, ch] of Object.entries(s.channels || {})) {
      lines.push(`Canal <code>${esc(id)}</code>: ${ch.exists ? `#${esc(ch.name)} — ver ${ch.canView ? '✓' : '✗'}, enviar ${ch.canSend ? '✓' : '✗'}, embeds ${ch.canEmbed ? '✓' : '✗'}, histórico ${ch.canReadHistory ? '✓' : '✗'}` : '✗ não encontrado'}`);
    }
    const a = s.announceChannel;
    lines.push(`Canal de promoções: ${a.exists ? `#${esc(a.name)} — enviar ${a.canSend ? '✓' : '✗'}, mencionar cargos ${a.canMentionEveryone ? '✓' : '(depende do cargo ser mencionável)'}` : '✗ não encontrado'}`);
    for (const [id, r] of Object.entries(s.roles || {})) {
      lines.push(`Cargo <code>${esc(id)}</code>: ${r.exists ? `${esc(r.name)} (posição ${r.position}${r.managed ? ', gerenciado por integração' : ''}${r.mentionable ? ', mencionável' : ''})` : '✗ não existe'}`);
    }
    const pc = data.promotionCheck;
    const verdict = pc.errors.length
      ? `<p class="error-msg">Promoção NÃO funcionaria agora:<br>${pc.errors.map(esc).join('<br>')}</p>`
      : '<p class="hint">✓ Cargos, permissões e canal de promoção OK.</p>';
    const warns = pc.warnings.length ? `<p class="hint">⚠ ${pc.warnings.map(esc).join('<br>⚠ ')}</p>` : '';
    out.innerHTML = `<div class="panel-section" style="margin-top:12px"><p class="hint" style="margin-top:0">${lines.join('<br>')}</p>${verdict}${warns}</div>`;
  });

  async function loadTasks() {
    const status = $('discord-tasks-filter').value;
    const data = await api(`/tasks${status ? `?status=${encodeURIComponent(status)}` : ''}`);
    if (!data.success) return;
    const tbody = $('discord-tasks-tbody');
    tbody.innerHTML = data.tasks.map((t) => `
      <tr>
        <td>${fmtDate(t.updatedAt)}</td>
        <td>${esc(KIND_TEXT[t.kind] || t.kind)}</td>
        <td>${badge(TASK_STATUS[t.status] || [t.status, 'badge-neutral'])}</td>
        <td>${t.attempts}/${t.maxAttempts}</td>
        <td><span class="hint">${esc(t.lastError || t.note || '')}</span></td>
        <td>${t.status === 'failed' ? `<button class="small-btn secondary-btn" data-retry-task="${t._id}">Reprocessar</button>` : ''}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="list-empty">Nenhuma tarefa.</td></tr>';
    tbody.querySelectorAll('[data-retry-task]').forEach((btn) => btn.addEventListener('click', async () => {
      const res = await api(`/tasks/${btn.dataset.retryTask}/retry`, { method: 'POST' });
      if (!res.success) alert(res.message || 'Erro.');
      loadTasks();
    }));
  }

  async function loadPromotions() {
    const data = await api('/promotions');
    if (!data.success) return;
    const tbody = $('discord-promotions-tbody');
    tbody.innerHTML = data.promotions.map((p) => {
      const steps = p.steps.map((s) => `${s.status === 'done' ? '✓' : s.status === 'failed' ? '✗' : '…'} ${s.type === 'setNickname' ? 'apelido' : `${s.type === 'addRole' ? '+' : '−'}${esc(s.roleId)}`}${s.error ? ` (${esc(s.error)})` : ''}`).join('<br>');
      const released = p.resolvedAdministratively && p.resolvedAdministratively.at;
      return `
      <tr>
        <td>${fmtDate(p.createdAt)}</td>
        <td><code>${esc(p.discordUserId)}</code><br><span class="hint">operador ${esc(p.operatorId)}</span></td>
        <td>${esc(p.nickname)}</td>
        <td>${badge(PROMO_STATUS[p.status] || [p.status, 'badge-neutral'])}${p.announced ? '<br><span class="hint">anunciado</span>' : ''}${p.preexisting ? '<br><span class="hint">já tinha os cargos (sem anúncio)</span>' : ''}${released ? `<br><span class="hint">liberado em ${fmtDate(p.resolvedAdministratively.at)}: ${esc(p.resolvedAdministratively.reason)}</span>` : ''}</td>
        <td><span class="hint">${steps}</span></td>
        <td>
          ${['partial', 'failed'].includes(p.status) ? `<button class="small-btn secondary-btn" data-resume-promo="${p._id}">Retomar pendentes</button>` : ''}
          ${p.lockKey && !['pending', 'in_progress'].includes(p.status) ? `<button class="small-btn danger-btn" data-release-promo="${p._id}" title="Permite promover esta pessoa de novo pelo bot. Não mexe em cargos.">Liberar nova promoção</button>` : ''}
        </td>
      </tr>`;
    }).join('') || '<tr><td colspan="6" class="list-empty">Nenhuma promoção ainda.</td></tr>';

    tbody.querySelectorAll('[data-resume-promo]').forEach((btn) => btn.addEventListener('click', async () => {
      if (!confirm('Retomar só as etapas que ficaram pendentes/falharam? O bot confere o estado atual do membro antes de cada etapa.')) return;
      const res = await api(`/promotions/${btn.dataset.resumePromo}/resume`, { method: 'POST' });
      if (!res.success) alert(res.message || 'Erro.');
      loadPromotions();
    }));
    tbody.querySelectorAll('[data-release-promo]').forEach((btn) => btn.addEventListener('click', async () => {
      const reason = prompt('Resolução administrativa: esta pessoa poderá ser promovida de novo pelo bot. Nenhum cargo é alterado agora.\nMotivo (obrigatório):');
      if (reason === null) return;
      const res = await api(`/promotions/${btn.dataset.releasePromo}/release`, { method: 'POST', body: JSON.stringify({ reason }) });
      if (!res.success) alert(res.message || 'Erro.');
      loadPromotions();
    }));
  }

  function loadAll() {
    loadStatus();
    loadConfig();
    loadTasks();
    loadPromotions();
  }

  $('discord-refresh-btn').addEventListener('click', () => { loadStatus(); loadTasks(); loadPromotions(); });
  $('discord-tasks-filter').addEventListener('change', loadTasks);
  document.querySelector('[data-tab="discord-tab"]').addEventListener('click', loadAll);
})();
