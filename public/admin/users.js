// Aba "Logins/senhas" (só administrador principal — o servidor recusa as
// chamadas de qualquer outra conta). Contas criadas aqui são sempre
// restritas; senhas nunca voltam do servidor.
(() => {
  async function api(path, options = {}) {
    const res = await fetch(`/api/admin/users${path}`, { headers: { 'Content-Type': 'application/json' }, ...options });
    let data;
    try { data = await res.json(); } catch (_) { data = { success: false, message: 'Resposta inválida do servidor.' }; }
    return { status: res.status, ...data };
  }
  function esc(str) {
    return String(str == null ? '' : str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtDate(d) { return d ? new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—'; }
  const $ = (id) => document.getElementById(id);
  if (!$('users-tab')) return;

  let users = [];

  function msg(text, isError = false) {
    const el = $('users-msg');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = isError ? 'var(--danger)' : '';
  }

  function render() {
    const tbody = $('users-tbody');
    if (!tbody) return;
    tbody.innerHTML = users.map((u) => {
      const primary = u.role === 'primary';
      const role = primary ? '<span class="badge badge-ok"><span class="badge-dot"></span>Administrador principal</span>' : '<span class="badge badge-neutral"><span class="badge-dot"></span>Restrito</span>';
      const status = u.active ? '<span class="badge badge-ok"><span class="badge-dot"></span>Ativo</span>' : '<span class="badge badge-danger"><span class="badge-dot"></span>Desativado</span>';
      const actions = primary ? '<span class="hint" style="margin:0">Acesso completo (não editável aqui)</span>' : `
        <button class="small-btn secondary-btn" data-user-edit="${esc(u.id)}">Editar</button>
        <button class="small-btn secondary-btn" data-user-password="${esc(u.id)}">Redefinir senha</button>
        <button class="small-btn ${u.active ? 'danger-btn' : ''}" data-user-active="${esc(u.id)}" data-next="${u.active ? '0' : '1'}">${u.active ? 'Desativar' : 'Ativar'}</button>`;
      return `<tr><td>${esc(u.displayName || '—')}</td><td><code>${esc(u.username)}</code></td><td>${role}</td><td>${status}</td><td>${fmtDate(u.lastLoginAt)}</td><td class="td-actions">${actions}</td></tr>`;
    }).join('') || '<tr><td colspan="6" class="list-empty">Nenhum acesso.</td></tr>';
  }

  async function load() {
    const data = await api('');
    if (!data.success) { msg(data.message || 'Não foi possível carregar os acessos.', true); return; }
    users = data.users;
    render();
  }

  function hideForms() {
    $('user-edit-form').classList.add('hidden');
    $('user-password-form').classList.add('hidden');
  }

  $('user-create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = $('user-create-msg');
    out.textContent = '';
    const data = await api('', { method: 'POST', body: JSON.stringify({ displayName: $('user-create-name').value, username: $('user-create-username').value, password: $('user-create-password').value }) });
    if (!data.success) { out.textContent = data.message || 'Não foi possível criar.'; return; }
    $('user-create-form').reset();
    msg(`Acesso restrito criado para ${data.user.displayName} (login: ${data.user.username}).`);
    await load();
  });

  $('users-tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const id = btn.dataset.userEdit || btn.dataset.userPassword || btn.dataset.userActive;
    const user = users.find((u) => u.id === id);
    if (!user) return;
    hideForms();
    if (btn.dataset.userEdit) {
      $('user-edit-id').value = user.id;
      $('user-edit-name').value = user.displayName || '';
      $('user-edit-username').value = user.username;
      $('user-edit-form').classList.remove('hidden');
      $('user-edit-name').focus();
    } else if (btn.dataset.userPassword) {
      $('user-password-id').value = user.id;
      $('user-password-label').textContent = `Nova senha de ${user.displayName || user.username}`;
      $('user-password-form').reset();
      $('user-password-id').value = user.id;
      $('user-password-form').classList.remove('hidden');
      $('user-password-new').focus();
    } else if (btn.dataset.userActive) {
      const activate = btn.dataset.next === '1';
      if (!activate && !confirm(`Desativar o acesso de ${user.displayName || user.username}? A pessoa é desconectada na hora e não consegue mais entrar.`)) return;
      const data = await api(`/${encodeURIComponent(user.id)}/active`, { method: 'POST', body: JSON.stringify({ active: activate }) });
      msg(data.success ? (activate ? 'Acesso ativado.' : 'Acesso desativado e sessões encerradas.') : (data.message || 'Não foi possível alterar.'), !data.success);
      await load();
    }
  });

  $('user-edit-cancel').addEventListener('click', hideForms);
  $('user-password-cancel').addEventListener('click', hideForms);

  $('user-edit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('user-edit-id').value;
    const data = await api(`/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ displayName: $('user-edit-name').value, username: $('user-edit-username').value }) });
    if (!data.success) { msg(data.message || 'Não foi possível salvar.', true); return; }
    hideForms();
    msg('Acesso atualizado.');
    await load();
  });

  $('user-password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('user-password-id').value;
    const password = $('user-password-new').value;
    if (password !== $('user-password-confirm').value) { msg('As duas senhas não são iguais.', true); return; }
    const data = await api(`/${encodeURIComponent(id)}/password`, { method: 'POST', body: JSON.stringify({ password }) });
    $('user-password-form').reset();
    if (!data.success) { msg(data.message || 'Não foi possível redefinir.', true); return; }
    hideForms();
    msg('Senha redefinida. As sessões abertas dessa pessoa foram encerradas.');
    await load();
  });

  const tabBtn = document.querySelector('[data-tab="users-tab"]');
  if (tabBtn) tabBtn.addEventListener('click', load);
})();
