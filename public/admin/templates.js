// Aba "Mensagens do Bot": editor dos modelos de mensagem/embed que o site
// entrega ao BotGhost. A prévia usa só dados FICTÍCIOS (montados pelo
// servidor) e é desenhada com textContent — nunca como HTML.
(() => {
  async function api(path, options = {}) {
    const res = await fetch(`/api/admin/integration${path}`, { headers: { 'Content-Type': 'application/json' }, ...options });
    let data;
    try { data = await res.json(); } catch (_) { data = { success: false, message: 'Resposta inválida do servidor.' }; }
    return { status: res.status, ...data };
  }
  const $ = (id) => document.getElementById(id);
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children) if (c != null) node.append(c);
    return node;
  }
  function fmtDate(d) { return d ? new Date(d).toLocaleString('pt-BR') : '—'; }

  const ROLE_TARGETS = new Set(['cargoPromocao']);
  const SIMPLE_FIELDS = ['title', 'url', 'color', 'description', 'authorName', 'authorUrl', 'authorIconUrl', 'thumbnailUrl', 'imageUrl', 'footerText', 'footerIconUrl'];
  const LIMIT_FOR = { content: 'content', 'embed.title': 'title', 'embed.description': 'description', 'embed.authorName': 'author', 'embed.footerText': 'footer' };

  let catalog = null;
  let current = null;
  let fields = [];
  let dirty = false;
  let lastFocused = null;
  let previewTimer = null;

  // ---------------- Formulário <-> modelo ----------------

  function readSpec() {
    const embed = { enabled: $('tpl-embed-enabled').checked, timestamp: $('tpl-timestamp').checked, fields: fields.map((f) => ({ ...f })) };
    for (const f of SIMPLE_FIELDS) embed[f] = $(`tpl-${f}`).value;
    const users = [];
    const roles = [];
    document.querySelectorAll('#tpl-ping-targets input[type=checkbox]').forEach((cb) => {
      if (cb.checked) (ROLE_TARGETS.has(cb.value) ? roles : users).push(cb.value);
    });
    const ids = (v) => v.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
    return {
      content: $('tpl-content').value,
      embed,
      pings: { users, roles, extraUserIds: ids($('tpl-ping-users').value), extraRoleIds: ids($('tpl-ping-roles').value) },
    };
  }

  function fillForm(spec) {
    $('tpl-content').value = spec.content || '';
    const e = spec.embed || {};
    $('tpl-embed-enabled').checked = e.enabled !== false;
    $('tpl-timestamp').checked = Boolean(e.timestamp);
    for (const f of SIMPLE_FIELDS) $(`tpl-${f}`).value = e[f] || '';
    if (!$('tpl-color').value) $('tpl-color').value = '#dc2626';
    syncColorPicker();
    fields = (e.fields || []).map((f) => ({ name: f.name || '', value: f.value || '', inline: Boolean(f.inline) }));
    renderFields();
    const pings = spec.pings || {};
    const box = $('tpl-ping-targets');
    box.textContent = '';
    for (const t of current.pingTargets) {
      const checked = (ROLE_TARGETS.has(t) ? pings.roles || [] : pings.users || []).includes(t);
      const cb = el('input', { type: 'checkbox', value: t });
      cb.checked = checked;
      box.append(el('label', { className: 'tpl-check' }, cb, ` ${catalog.pingTargets[t] || t}`));
    }
    if (!current.pingTargets.length) box.append(el('p', { className: 'hint', text: current.visibility === 'private' ? 'Mensagem privada: não notifica ninguém.' : 'Este modelo não tem destinatários de notificação.' }));
    $('tpl-ping-users').value = (pings.extraUserIds || []).join(', ');
    $('tpl-ping-roles').value = (pings.extraRoleIds || []).join(', ');
    $('tpl-pings-box').classList.toggle('hidden', current.visibility === 'private');
    toggleEmbed();
    document.querySelectorAll('[data-image]').forEach((input) => checkImage(input));
    updateCounters();
  }

  function renderFields() {
    const box = $('tpl-fields');
    box.textContent = '';
    fields.forEach((f, i) => {
      const name = el('input', { value: f.name, placeholder: 'Nome do campo', 'data-path': `embed.fields.${i}.name` });
      const value = el('textarea', { rows: '2', placeholder: 'Valor do campo', 'data-path': `embed.fields.${i}.value` });
      value.value = f.value;
      name.addEventListener('input', () => { fields[i].name = name.value; changed(); });
      value.addEventListener('input', () => { fields[i].value = value.value; changed(); });
      [name, value].forEach((x) => x.addEventListener('focus', () => { lastFocused = x; }));
      const inline = el('input', { type: 'checkbox' });
      inline.checked = f.inline;
      inline.addEventListener('change', () => { fields[i].inline = inline.checked; changed(); });
      const move = (d) => () => {
        const j = i + d;
        if (j < 0 || j >= fields.length) return;
        [fields[i], fields[j]] = [fields[j], fields[i]];
        renderFields();
        changed();
      };
      box.append(el('div', { className: 'tpl-field-row' },
        el('div', { className: 'tpl-field-inputs' },
          el('div', {}, name, el('span', { className: 'tpl-count', 'data-count-for': `embed.fields.${i}.name` }), el('span', { className: 'tpl-err', 'data-err-for': `embed.fields.${i}.name` })),
          el('div', {}, value, el('span', { className: 'tpl-count', 'data-count-for': `embed.fields.${i}.value` }), el('span', { className: 'tpl-err', 'data-err-for': `embed.fields.${i}.value` }))),
        el('div', { className: 'tpl-field-actions' },
          el('label', { className: 'tpl-check' }, inline, ' lado a lado'),
          el('button', { type: 'button', className: 'small-btn secondary-btn', title: 'Subir', onclick: move(-1), text: '▲' }),
          el('button', { type: 'button', className: 'small-btn secondary-btn', title: 'Descer', onclick: move(1), text: '▼' }),
          el('button', { type: 'button', className: 'small-btn danger-btn', title: 'Remover', onclick: () => { fields.splice(i, 1); renderFields(); changed(); }, text: '✕' }))));
    });
    $('tpl-fields-count').textContent = `(${fields.length}/${catalog.limits.fields})`;
    $('tpl-field-add').disabled = fields.length >= catalog.limits.fields;
  }

  function toggleEmbed() {
    $('tpl-embed-box').classList.toggle('hidden', !$('tpl-embed-enabled').checked);
  }

  function syncColorPicker() {
    const v = $('tpl-color').value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) $('tpl-color-picker').value = v.toLowerCase();
  }

  // ---------------- Contadores, imagens, erros ----------------

  function limitOf(path) {
    const L = catalog.limits;
    if (LIMIT_FOR[path]) return L[LIMIT_FOR[path]];
    if (/\.name$/.test(path)) return L.fieldName;
    if (/\.value$/.test(path)) return L.fieldValue;
    return null;
  }

  function updateCounters() {
    document.querySelectorAll('.tpl-count[data-count-for]').forEach((span) => {
      const path = span.dataset.countFor;
      const input = document.querySelector(`[data-path="${CSS.escape(path)}"]`);
      const max = limitOf(path);
      if (!input || !max) return;
      const len = input.value.length;
      span.textContent = `${len}/${max}`;
      span.classList.toggle('over', len > max);
    });
  }

  function checkImage(input) {
    const status = document.querySelector(`[data-img-for="${CSS.escape(input.dataset.path)}"]`);
    if (!status) return;
    const url = input.value.trim();
    status.textContent = '';
    if (!url) return;
    if (!/^https:\/\//i.test(url)) { status.textContent = '✗ use um link https:// direto da imagem'; status.className = 'tpl-img-status bad'; return; }
    status.textContent = 'carregando…';
    status.className = 'tpl-img-status';
    // Carregado pelo SEU navegador, só para conferir; o servidor nunca baixa.
    const img = new Image();
    img.onload = () => { if (input.value.trim() === url) { status.textContent = `✓ imagem carregou (${img.naturalWidth}×${img.naturalHeight})`; status.className = 'tpl-img-status ok'; } };
    img.onerror = () => { if (input.value.trim() === url) { status.textContent = '✗ não carregou — precisa ser o link DIRETO do arquivo (termina em .png/.jpg/.gif/.webp)'; status.className = 'tpl-img-status bad'; } };
    img.referrerPolicy = 'no-referrer';
    img.src = url;
  }

  function showErrors(errors) {
    document.querySelectorAll('.tpl-err').forEach((s) => { s.textContent = ''; });
    const list = $('tpl-errors');
    list.textContent = '';
    for (const e of errors || []) {
      const slot = document.querySelector(`.tpl-err[data-err-for="${CSS.escape(e.path)}"]`);
      if (slot) slot.textContent = slot.textContent ? `${slot.textContent} ${e.message}` : e.message;
      list.append(el('li', { text: `${e.path}: ${e.message}` }));
    }
  }

  // ---------------- Prévia (estilo Discord, texto puro) ----------------

  // Menções viram "pílulas" só na prévia; todo o resto é texto.
  function richText(text) {
    const frag = document.createDocumentFragment();
    const re = /<(@!?|@&|#)(\d{17,20})>/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.append(document.createTextNode(text.slice(last, m.index)));
      const kind = m[1] === '@&' ? 'cargo' : m[1] === '#' ? 'canal' : 'usuário';
      frag.append(el('span', { className: 'dc-mention', text: `${m[1] === '#' ? '#' : '@'}${kind}-${m[2].slice(-4)}` }));
      last = re.lastIndex;
    }
    if (last < text.length) frag.append(document.createTextNode(text.slice(last)));
    return frag;
  }

  function previewImg(url, className) {
    if (!url || !/^https:\/\//i.test(url)) return null;
    const img = el('img', { className, alt: '', referrerpolicy: 'no-referrer' });
    img.src = url;
    img.onerror = () => { img.replaceWith(el('span', { className: `${className} dc-img-missing`, text: 'imagem não carregou' })); };
    return img;
  }

  function renderPreview(message) {
    const box = $('tpl-preview');
    box.textContent = '';
    if (!message) { box.append(el('p', { className: 'hint', text: 'Sem prévia: corrija os erros abaixo.' })); return; }
    const body = el('div', { className: 'dc-body' });
    body.append(el('div', { className: 'dc-author-line' }, el('strong', { text: 'Bot TCEL' }), el('span', { className: 'dc-bot-tag', text: 'APP' }), el('span', { className: 'dc-time', text: 'hoje' })));
    if (message.content) body.append(el('div', { className: 'dc-content' }, richText(message.content)));
    const e = (message.embeds || [])[0];
    if (e) {
      const embed = el('div', { className: 'dc-embed' });
      embed.style.borderLeftColor = `#${Number(e.color || 0).toString(16).padStart(6, '0')}`;
      const main = el('div', { className: 'dc-embed-main' });
      if (e.author && e.author.name) main.append(el('div', { className: 'dc-embed-author' }, previewImg(e.author.icon_url, 'dc-author-icon'), document.createTextNode(e.author.name)));
      if (e.title) main.append(el('div', { className: `dc-embed-title${e.url ? ' is-link' : ''}` }, richText(e.title)));
      if (e.description) main.append(el('div', { className: 'dc-embed-desc' }, richText(e.description)));
      if (e.fields && e.fields.length) {
        const grid = el('div', { className: 'dc-fields' });
        for (const f of e.fields) grid.append(el('div', { className: `dc-field${f.inline ? ' inline' : ''}` }, el('div', { className: 'dc-field-name' }, richText(f.name)), el('div', { className: 'dc-field-value' }, richText(f.value))));
        main.append(grid);
      }
      if (e.image) main.append(previewImg(e.image.url, 'dc-embed-image'));
      if (e.footer || e.timestamp) {
        main.append(el('div', { className: 'dc-embed-footer' }, e.footer ? previewImg(e.footer.icon_url, 'dc-footer-icon') : null,
          document.createTextNode([e.footer ? e.footer.text : '', e.timestamp ? new Date(e.timestamp).toLocaleString('pt-BR') : ''].filter(Boolean).join(' • '))));
      }
      embed.append(main);
      if (e.thumbnail) embed.append(previewImg(e.thumbnail.url, 'dc-thumb'));
      body.append(embed);
    }
    const am = message.allowed_mentions || { users: [], roles: [] };
    const pingText = am.users.length || am.roles.length ? `Notificaria de verdade: ${am.users.length} usuário(s), ${am.roles.length} cargo(s).` : 'Não notifica ninguém (a prévia/teste nunca notifica).';
    box.append(body, el('p', { className: 'hint', text: `${pingText} Prévia aproximada: o Discord também aplica **negrito**, _itálico_ etc.` }));
  }

  async function refreshPreview() {
    if (!current) return;
    const data = await api(`/templates/${current.key}/preview`, { method: 'POST', body: JSON.stringify({ spec: readSpec() }) });
    if (!data.success) { showErrors([{ path: 'geral', message: data.message || 'Erro na prévia.' }]); return; }
    renderPreview(data.message);
    showErrors(data.errors);
  }

  function changed() {
    dirty = true;
    updateCounters();
    clearTimeout(previewTimer);
    previewTimer = setTimeout(refreshPreview, 350);
  }

  // ---------------- Carregar / trocar modelo ----------------

  async function loadCatalog() {
    const data = await api('/templates');
    if (!data.success) return;
    catalog = data;
    const sel = $('tpl-select');
    const keep = sel.value;
    sel.textContent = '';
    for (const t of data.templates) {
      const flags = [t.visibility === 'private' ? 'privada' : 'canal', t.customized ? `v${t.publishedVersion}` : 'padrão', t.hasDraft ? 'rascunho' : null].filter(Boolean).join(' · ');
      sel.append(el('option', { value: t.key, text: `${t.label} (${flags})` }));
    }
    sel.value = keep || data.templates[0].key;
  }

  async function openTemplate(key) {
    const data = await api(`/templates/${key}`);
    if (!data.success) { $('tpl-msg').textContent = data.message || 'Erro ao carregar.'; return; }
    current = data.template;
    $('tpl-help').textContent = `${current.help}${current.allowsLinks ? ' Os links reais só aparecem na resposta privada ao operador — nunca na prévia nem no histórico.' : ''}`;
    $('tpl-meta').textContent = current.publishedVersion
      ? `Publicado: versão ${current.publishedVersion} por ${current.publishedBy || '—'} em ${fmtDate(current.publishedAt)}.${current.draftUpdatedAt && (!current.publishedAt || new Date(current.draftUpdatedAt) > new Date(current.publishedAt)) ? ` Rascunho salvo por ${current.draftUpdatedBy} em ${fmtDate(current.draftUpdatedAt)} (ainda não publicado).` : ''}`
      : 'Usando o padrão TCEL (nenhuma versão publicada ainda).';
    const vs = $('tpl-var-select');
    vs.textContent = '';
    for (const p of current.placeholders) {
      const meta = catalog.placeholders.find((x) => x.key === p) || { help: '' };
      vs.append(el('option', { value: p, text: `[[${p}]] — ${meta.help}` }));
    }
    updateVarHelp();
    const vlist = $('tpl-versions');
    vlist.textContent = '';
    for (const v of current.versions) vlist.append(el('li', { text: `v${v.version} · ${v.action === 'restore_default' ? 'restaurou o padrão' : 'publicou'} · ${v.by} · ${fmtDate(v.at)}` }));
    if (!current.versions.length) vlist.append(el('li', { className: 'hint', text: 'Nenhuma versão ainda.' }));
    fillForm(current.draft);
    dirty = false;
    $('tpl-msg').textContent = '';
    refreshPreview();
  }

  function updateVarHelp() {
    const key = $('tpl-var-select').value;
    const meta = catalog && catalog.placeholders.find((x) => x.key === key);
    $('tpl-var-help').textContent = meta ? `Exemplo fictício: ${meta.sample}` : '';
  }

  function insertAtCursor(text) {
    const target = lastFocused && document.body.contains(lastFocused) ? lastFocused : $('tpl-content');
    if (target.dataset.image || /Url$/.test(target.id || '') || target.id === 'tpl-url') {
      $('tpl-msg').textContent = 'Campos de link/imagem não aceitam variáveis nem menções.';
      return;
    }
    const start = target.selectionStart == null ? target.value.length : target.selectionStart;
    const end = target.selectionEnd == null ? target.value.length : target.selectionEnd;
    target.value = target.value.slice(0, start) + text + target.value.slice(end);
    target.focus();
    target.selectionStart = target.selectionEnd = start + text.length;
    target.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // ---------------- Ações ----------------

  async function action(path, body, okText) {
    const msg = $('tpl-msg');
    msg.textContent = 'Enviando...';
    const data = await api(`/templates/${current.key}${path}`, { method: path === '/draft' ? 'PUT' : 'POST', body: JSON.stringify(body || {}) });
    if (!data.success) {
      msg.textContent = data.message || 'Erro.';
      if (data.errors) showErrors(data.errors);
      return false;
    }
    msg.textContent = okText(data);
    return true;
  }

  $('tpl-save').addEventListener('click', async () => {
    if (await action('/draft', { spec: readSpec() }, (d) => (d.errors && d.errors.length ? `Rascunho salvo, mas ainda tem ${d.errors.length} erro(s) — não dá para publicar assim.` : '✓ Rascunho salvo (ainda não vale para o bot).'))) {
      dirty = false;
      await loadCatalog();
    }
  });
  $('tpl-publish').addEventListener('click', async () => {
    if (!confirm('Publicar este modelo? Ele passa a valer para as PRÓXIMAS mensagens. Mensagens antigas não mudam.')) return;
    if (await action('/publish', { spec: readSpec() }, (d) => `✓ Publicado (versão ${d.version}).`)) {
      dirty = false;
      await loadCatalog();
      await openTemplate(current.key);
      $('tpl-msg').textContent = '✓ Publicado. Vale para as próximas mensagens.';
    }
  });
  $('tpl-restore').addEventListener('click', async () => {
    if (!confirm('Restaurar o modelo padrão TCEL? Isso publica o padrão (fica registrado no histórico).')) return;
    if (await action('/restore-default', {}, (d) => `✓ Padrão restaurado (versão ${d.version}).`)) {
      await loadCatalog();
      await openTemplate(current.key);
    }
  });
  $('tpl-test').addEventListener('click', async () => {
    if (dirty && !confirm('O teste usa a versão PUBLICADA. Você tem alterações não publicadas — enviar o teste mesmo assim?')) return;
    if (!confirm('Enviar um teste para o canal de TESTE configurado? Dados fictícios, sem notificar ninguém.')) return;
    await action('/test', {}, (d) => `✓ ${d.message}`);
  });

  // ---------------- Eventos ----------------

  document.querySelectorAll('#tpl-form [data-path]').forEach((input) => {
    input.addEventListener('focus', () => { lastFocused = input; });
    input.addEventListener('input', changed);
    if (input.dataset.image) input.addEventListener('change', () => checkImage(input));
  });
  $('tpl-color').addEventListener('input', syncColorPicker);
  $('tpl-color-picker').addEventListener('input', () => { $('tpl-color').value = $('tpl-color-picker').value; changed(); });
  $('tpl-embed-enabled').addEventListener('change', () => { toggleEmbed(); changed(); });
  $('tpl-timestamp').addEventListener('change', changed);
  $('tpl-ping-targets').addEventListener('change', changed);
  $('tpl-ping-users').addEventListener('input', changed);
  $('tpl-ping-roles').addEventListener('input', changed);
  $('tpl-field-add').addEventListener('click', () => {
    if (fields.length >= catalog.limits.fields) return;
    fields.push({ name: 'Campo', value: 'Valor', inline: false });
    renderFields();
    changed();
  });
  $('tpl-var-select').addEventListener('change', updateVarHelp);
  $('tpl-var-insert').addEventListener('click', () => insertAtCursor(`[[${$('tpl-var-select').value}]]`));
  $('tpl-mention-insert').addEventListener('click', () => {
    const id = $('tpl-mention-id').value.trim();
    if (!/^\d{17,20}$/.test(id)) { $('tpl-msg').textContent = 'ID inválido: use o número de 17 a 20 dígitos copiado do Discord.'; return; }
    const type = $('tpl-mention-type').value;
    insertAtCursor(type === 'role' ? `<@&${id}>` : type === 'channel' ? `<#${id}>` : `<@${id}>`);
  });
  $('tpl-select').addEventListener('change', async () => {
    if (dirty && !confirm('Há alterações não salvas neste modelo. Trocar mesmo assim?')) { $('tpl-select').value = current.key; return; }
    await openTemplate($('tpl-select').value);
  });
  document.querySelector('[data-tab="templates-tab"]').addEventListener('click', async () => {
    if (current && dirty) return;
    await loadCatalog();
    if (catalog) await openTemplate($('tpl-select').value);
  });
})();
