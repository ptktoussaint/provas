// Segurança & auditoria → quadro de armazenamento do cluster (atlasSize) e
// "Limpar armazenamento" (prévia obrigatória → confirmação → execução em
// lotes com progresso). Só administrador principal: o servidor recusa
// qualquer outra conta.
(() => {
  const $ = (id) => document.getElementById(id);
  if (!$('cluster-storage')) return;

  async function api(path, options = {}) {
    const res = await fetch(`/api/admin/storage${path}`, { headers: { 'Content-Type': 'application/json' }, ...options });
    let data;
    try { data = await res.json(); } catch (_) { data = { success: false, message: 'Resposta inválida do servidor.' }; }
    return { status: res.status, ...data };
  }
  function esc(str) {
    return String(str == null ? '' : str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // Horários sempre no fuso de Brasília.
  function fmtDate(d) { return d ? new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—'; }
  const MB = 1024 * 1024;
  function mb(bytes) { return bytes == null ? '—' : `${(bytes / MB).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MB`; }
  function num(n) { return Number(n || 0).toLocaleString('pt-BR'); }

  const LEVEL_STYLE = { normal: ['badge-ok', 'var(--success)'], warning: ['badge-warn', 'var(--warning)'], high: ['badge-danger', '#f97316'], critical: ['badge-danger', 'var(--danger)'] };

  function renderCluster(s) {
    const box = $('cluster-storage');
    if (!s.ok) {
      box.innerHTML = `
        <div class="stat-card" style="border-color:var(--danger)">
          <div class="stat-value" style="font-size:18px;color:var(--danger)">${esc(s.message || 'Não foi possível consultar o consumo total')}</div>
          <div class="stat-label" style="text-transform:none">Nenhum valor é mostrado para não confundir com um consumo real. Código: ${esc(s.errorCode || '—')} · tentativa em ${fmtDate(s.checkedAt)}</div>
        </div>
        <ul class="hint">${(s.guidance || []).map((g) => `<li>${esc(g)}</li>`).join('')}</ul>`;
      return;
    }
    const [badge, color] = LEVEL_STYLE[s.level] || LEVEL_STYLE.normal;
    const pct = Math.min(100, Math.max(0, s.percent));
    box.innerHTML = `
      <div class="panel-grid" style="margin-bottom:10px">
        <div class="stat-card"><div class="stat-value">${mb(s.usedBytes)}</div><div class="stat-label">Consumo total do cluster (dados + índices)</div></div>
        <div class="stat-card"><div class="stat-value">${mb(s.limitBytes)}</div><div class="stat-label">Limite do plano</div></div>
        <div class="stat-card"><div class="stat-value">${s.percent.toLocaleString('pt-BR')}%</div><div class="stat-label">Utilizado</div></div>
        <div class="stat-card"><div class="stat-value">${mb(s.remainingBytes)}</div><div class="stat-label">Espaço restante</div></div>
      </div>
      <div style="background:var(--bg-input);border:1px solid var(--border);border-radius:8px;height:18px;overflow:hidden" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
        <div style="height:100%;width:${pct}%;background:${color}"></div>
      </div>
      <p class="hint" style="margin-top:8px">
        Situação: <span class="badge ${badge}"><span class="badge-dot"></span>${esc(s.levelLabel)}</span>
        · ${num(s.databases)} banco(s) no cluster · dados ${mb(s.dataBytes)} + índices ${mb(s.indexBytes)}
        · última consulta: ${fmtDate(s.checkedAt)} (horário de Brasília)${s.cached ? ' · do cache (5 min)' : ''}${s.throttled ? ` · aguarde ${s.retryInSeconds}s para consultar de novo` : ''}
        <br>Unidade: 1 MB = 1.048.576 bytes (mesma base para consumo e limite). Normal abaixo de 70%, atenção a partir de 70%, alto a partir de 85%, crítico a partir de 95%.
      </p>`;
  }

  async function loadCluster(refresh = false) {
    const btn = $('cluster-refresh-btn');
    if (refresh) { btn.disabled = true; btn.textContent = 'Consultando...'; }
    const data = await api(`/cluster${refresh ? '?refresh=1' : ''}`);
    if (refresh) { btn.disabled = false; btn.textContent = 'Atualizar armazenamento'; }
    if (!data.success) { $('cluster-storage').innerHTML = `<p class="error-msg">${esc(data.message || 'Não foi possível consultar o consumo total')}</p>`; return; }
    renderCluster(data.storage);
  }

  // ---------- Limpeza ----------
  let preview = null;
  let pollTimer = null;
  let categories = [];
  let preservedLabels = {};

  function showStep(step) {
    for (const id of ['cleanup-step-choose', 'cleanup-step-preview', 'cleanup-step-progress']) $(id).classList.toggle('hidden', id !== step);
    $('cleanup-error').textContent = '';
  }

  function openModal() {
    preview = null;
    showStep('cleanup-step-choose');
    $('cleanup-modal-backdrop').classList.remove('hidden');
  }
  function closeModal() {
    $('cleanup-modal-backdrop').classList.add('hidden');
    preview = null;
  }

  function preservedRows(preserved) {
    const rows = Object.entries(preserved || {}).filter(([, n]) => n > 0)
      .map(([k, n]) => `<tr><td>${esc(preservedLabels[k] || k)}</td><td>${num(n)}</td></tr>`).join('');
    return rows || '<tr><td colspan="2" class="list-empty">Nenhum registro antigo precisou ser preservado.</td></tr>';
  }

  function renderPreview(p) {
    categories = p.categories || categories;
    preservedLabels = p.preservedLabels || preservedLabels;
    const c = p.preview.counts;
    const total = Object.values(c).reduce((a, b) => a + b, 0);
    const est = p.preview.estimatedBytes;
    $('cleanup-step-preview').innerHTML = `
      <h4 class="discord-subtitle">Simulação — nada foi apagado ainda</h4>
      <p>Período: <strong>mais de ${p.days} dias</strong> · data de corte: <strong>${fmtDate(p.cutoff)}</strong> (horário de Brasília). Só registros ANTERIORES a esse momento entram; o que está exatamente no corte fica.</p>
      <table class="data-table"><thead><tr><th>Categoria</th><th>Data usada</th><th>Elegíveis para apagar</th></tr></thead><tbody>
        ${categories.map((cat) => `<tr><td>${esc(cat.label)}<br><span class="hint" style="margin:0"><code>${esc(cat.collection)}</code></span></td><td><code>${esc(cat.dateField)}</code></td><td><strong>${num(c[cat.key])}</strong></td></tr>`).join('')}
      </tbody></table>
      <h4 class="discord-subtitle">Preservados (ativos, pendentes ou protegidos)</h4>
      <table class="data-table"><tbody>${preservedRows(p.preview.preserved)}</tbody></table>
      <p class="hint">${est == null ? 'Espaço a liberar: não há forma confiável de calcular — só as quantidades acima.' : `Espaço estimado a liberar: <strong>~${mb(est)}</strong> (ESTIMATIVA dos dados, sem índices; o consumo do Atlas pode não cair na mesma proporção nem na hora).`}</p>
      <p class="error-msg"><strong>Exclusão permanente.</strong> Esta prévia vale até ${fmtDate(p.expiresAt)}; depois disso, gere outra.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="small-btn secondary-btn" id="cleanup-cancel-btn">Cancelar</button>
        <button class="small-btn danger-btn" id="cleanup-confirm-btn" ${total ? '' : 'disabled'}>Confirmar limpeza</button>
      </div>
      ${total ? '' : '<p class="hint">Nada para apagar neste período.</p>'}`;
    $('cleanup-cancel-btn').addEventListener('click', closeModal);
    $('cleanup-confirm-btn').addEventListener('click', confirmCleanup);
    showStep('cleanup-step-preview');
  }

  async function runPreview(days) {
    $('cleanup-error').textContent = 'Simulando (nada é apagado)...';
    const data = await api('/cleanup/preview', { method: 'POST', body: JSON.stringify({ days }) });
    if (!data.success) { $('cleanup-error').textContent = data.message || 'Não foi possível simular.'; return; }
    preview = data.preview;
    renderPreview(preview);
  }

  async function confirmCleanup() {
    if (!preview) return;
    if (!confirm(`Apagar DEFINITIVAMENTE os históricos com mais de ${preview.days} dias (antes de ${fmtDate(preview.cutoff)})?`)) return;
    $('cleanup-confirm-btn').disabled = true;
    const data = await api('/cleanup/execute', { method: 'POST', body: JSON.stringify({ previewId: preview.id, cutoff: preview.cutoff }) });
    if (!data.success) {
      $('cleanup-error').textContent = data.message || 'Não foi possível iniciar a limpeza.';
      $('cleanup-confirm-btn').disabled = false;
      return;
    }
    preview = null;
    showStep('cleanup-step-progress');
    watchRun(data.run.id);
  }

  function renderRun(run, target) {
    categories = run.categories || categories;
    preservedLabels = run.preservedLabels || preservedLabels;
    const done = run.status !== 'running';
    const deleted = (run.result && run.result.deleted) || (run.progress && run.progress.deleted) || {};
    const statusText = { running: 'Em execução — pode fechar esta janela, a limpeza continua', done: 'Concluída', failed: 'Concluída com falhas', interrupted: 'Interrompida (o site reiniciou no meio)' }[run.status] || run.status;
    const failures = (run.result && run.result.failures) || [];
    target.innerHTML = `
      <h4 class="discord-subtitle">Limpeza de mais de ${run.days} dias — ${esc(statusText)}</h4>
      <p class="hint" style="margin-top:0">Data de corte: ${fmtDate(run.cutoff)} · início: ${fmtDate(run.startedAt)}${run.finishedAt ? ` · fim: ${fmtDate(run.finishedAt)}` : ''} · por ${esc(run.createdByName || '—')}</p>
      <table class="data-table"><thead><tr><th>Categoria</th><th>${done ? 'Apagados' : 'Apagados até agora'}</th></tr></thead><tbody>
        ${categories.map((cat) => `<tr><td>${esc(cat.label)}</td><td>${num(deleted[cat.key])}</td></tr>`).join('')}
      </tbody></table>
      ${done && run.result ? `<h4 class="discord-subtitle">Preservados</h4><table class="data-table"><tbody>${preservedRows(run.result.preserved)}</tbody></table>` : ''}
      ${failures.length ? `<p class="error-msg">Falhas: ${failures.map((f) => `${esc(f.category)} (${esc(f.message)})`).join('; ')}</p>` : ''}
      ${done ? '<p class="hint">O consumo do quadro foi atualizado. O Atlas pode demorar ou não reduzir o espaço na mesma proporção do que foi apagado.</p>' : ''}`;
  }

  function watchRun(id) {
    clearInterval(pollTimer);
    const tick = async () => {
      const data = await api(`/cleanup/runs/${encodeURIComponent(id)}`);
      if (!data.success) return;
      renderRun(data.run, $('cleanup-step-progress'));
      const banner = $('cleanup-running');
      if (data.run.status === 'running') {
        banner.classList.remove('hidden');
        renderRun(data.run, banner);
      } else {
        clearInterval(pollTimer);
        banner.classList.add('hidden');
        loadCluster(false);
        loadHistory();
      }
    };
    tick();
    pollTimer = setInterval(tick, 1500);
  }

  async function loadHistory() {
    const data = await api('/cleanup/current');
    if (!data.success) return;
    if (data.run) watchRun(data.run.id);
    const last = (data.history || [])[0];
    if (last) {
      categories = last.categories || categories;
      preservedLabels = last.preservedLabels || preservedLabels;
      const d = (last.result && last.result.deleted) || {};
      const total = Object.values(d).reduce((a, b) => a + b, 0);
      $('cleanup-history').innerHTML = `<p class="hint">Última limpeza: ${fmtDate(last.finishedAt || last.startedAt)} · mais de ${last.days} dias · ${num(total)} registro(s) apagado(s) · por ${esc(last.createdByName || '—')}${last.status !== 'done' ? ` · ${esc(last.status)}` : ''}</p>`;
    } else {
      $('cleanup-history').innerHTML = '';
    }
  }

  $('cluster-refresh-btn').addEventListener('click', () => loadCluster(true));
  $('cleanup-open-btn').addEventListener('click', openModal);
  $('cleanup-close-btn').addEventListener('click', closeModal);
  document.querySelectorAll('[data-cleanup-days]').forEach((b) => b.addEventListener('click', () => runPreview(Number(b.dataset.cleanupDays))));

  const tabBtn = document.querySelector('[data-tab="security-tab"]');
  if (tabBtn) tabBtn.addEventListener('click', () => { loadCluster(false); loadHistory(); });
})();
