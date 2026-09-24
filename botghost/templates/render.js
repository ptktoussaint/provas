const { TEMPLATES, PLACEHOLDERS } = require('./catalog');

// Renderização e validação dos modelos de mensagem. Funções puras.
//
// Regras de segurança:
// - Variáveis [[...]] são substituídas UMA vez, a partir de dados montados
//   pelo servidor; nada é avaliado como código e um valor que contenha
//   "[[x]]" não é expandido de novo.
// - Cada modelo só aceita as suas variáveis; links de prova só no modelo
//   privado de sala.
// - Campos de URL não aceitam variáveis e só aceitam https público.
// - allowed_mentions é sempre explícito (parse vazio): só notifica quem o
//   admin liberou E aparece no texto fora do embed. Edição e teste nunca
//   notificam ninguém.

const LIMITS = {
  content: 2000,
  title: 256,
  description: 4096,
  fields: 25,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
  author: 256,
  embedTotal: 6000,
  url: 2048,
};

const PH_RE = /\[\[([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)*)\]\]/g;
const URL_FIELDS = ['url', 'authorUrl', 'authorIconUrl', 'thumbnailUrl', 'imageUrl', 'footerIconUrl'];
const TEXT_FIELDS = ['title', 'description', 'authorName', 'footerText'];
const SNOWFLAKE = /^\d{17,20}$/;

function str(v) {
  return v == null ? '' : String(v);
}

// Aceita o que vier do editor e devolve sempre a mesma forma.
function normalizeSpec(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const e = r.embed && typeof r.embed === 'object' ? r.embed : {};
  const p = r.pings && typeof r.pings === 'object' ? r.pings : {};
  const list = (x) => (Array.isArray(x) ? x.map(str).map((s) => s.trim()).filter(Boolean) : []);
  return {
    content: str(r.content),
    embed: {
      enabled: e.enabled !== false,
      title: str(e.title), description: str(e.description), url: str(e.url).trim(), color: str(e.color || '#dc2626').trim(),
      authorName: str(e.authorName), authorUrl: str(e.authorUrl).trim(), authorIconUrl: str(e.authorIconUrl).trim(),
      thumbnailUrl: str(e.thumbnailUrl).trim(), imageUrl: str(e.imageUrl).trim(),
      footerText: str(e.footerText), footerIconUrl: str(e.footerIconUrl).trim(),
      timestamp: Boolean(e.timestamp),
      fields: Array.isArray(e.fields) ? e.fields.slice(0, 50).map((f) => ({ name: str(f && f.name), value: str(f && f.value), inline: Boolean(f && f.inline) })) : [],
    },
    pings: { users: list(p.users), roles: list(p.roles), extraUserIds: list(p.extraUserIds), extraRoleIds: list(p.extraRoleIds) },
  };
}

// URL de imagem/link: https, endereço público, sem usuário/senha. Não é
// feito nenhum download aqui (evita o servidor buscar URLs de terceiros).
function urlProblem(value) {
  if (!value) return null;
  if (value.length > LIMITS.url) return 'URL longa demais.';
  if (value.includes('[[')) return 'Campos de URL não aceitam variáveis.';
  let u;
  try { u = new URL(value); } catch (_) { return 'URL inválida.'; }
  if (u.protocol !== 'https:') return 'Use um link https://.';
  if (u.username || u.password) return 'A URL não pode conter usuário/senha.';
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return 'Endereço interno não é permitido.';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':') || host.startsWith('[')) return 'Use um nome de domínio público, não um endereço IP.';
  if (!host.includes('.')) return 'Domínio inválido.';
  return null;
}

function textSlots(spec) {
  const slots = [['content', spec.content]];
  if (spec.embed.enabled) {
    for (const f of TEXT_FIELDS) slots.push([`embed.${f}`, spec.embed[f]]);
    spec.embed.fields.forEach((f, i) => {
      slots.push([`embed.fields.${i}.name`, f.name]);
      slots.push([`embed.fields.${i}.value`, f.value]);
    });
  }
  return slots;
}

// Validação do modelo (antes de salvar/publicar): variáveis, URLs, cor,
// quantidade de campos e notificações. Os limites de tamanho são
// conferidos DEPOIS de preencher (ver renderTemplate).
function validateSpec(key, rawSpec) {
  const def = TEMPLATES[key];
  const errors = [];
  if (!def) return [{ path: 'key', message: 'Modelo desconhecido.' }];
  const spec = normalizeSpec(rawSpec);
  const allowed = new Set(def.placeholders);

  for (const [path, text] of textSlots(spec)) {
    const leftovers = text.replace(PH_RE, '');
    if (leftovers.includes('[[') || leftovers.includes(']]')) errors.push({ path, message: 'Há "[[" ou "]]" que não forma uma variável válida.' });
    for (const m of text.matchAll(PH_RE)) {
      const name = m[1];
      if (!PLACEHOLDERS[name]) errors.push({ path, message: `Variável desconhecida: [[${name}]].` });
      else if (PLACEHOLDERS[name].sensitive && !def.allowsLinks) errors.push({ path, message: `[[${name}]] só pode ser usado no modelo privado "Sala criada".` });
      else if (!allowed.has(name)) errors.push({ path, message: `[[${name}]] não está disponível neste modelo.` });
    }
  }

  if (spec.embed.enabled) {
    for (const f of URL_FIELDS) {
      const p = urlProblem(spec.embed[f]);
      if (p) errors.push({ path: `embed.${f}`, message: p });
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(spec.embed.color)) errors.push({ path: 'embed.color', message: 'Cor inválida (use #RRGGBB).' });
    if (spec.embed.fields.length > LIMITS.fields) errors.push({ path: 'embed.fields', message: `No máximo ${LIMITS.fields} campos.` });
    spec.embed.fields.forEach((f, i) => {
      if (!f.name.trim()) errors.push({ path: `embed.fields.${i}.name`, message: 'O campo precisa de um nome.' });
      if (!f.value.trim()) errors.push({ path: `embed.fields.${i}.value`, message: 'O campo precisa de um valor.' });
    });
    if (!spec.embed.title.trim() && !spec.embed.description.trim() && !spec.embed.authorName.trim()) {
      errors.push({ path: 'embed', message: 'O embed precisa de título, descrição ou autor (ou desligue o embed).' });
    }
    if (spec.embed.authorIconUrl && !spec.embed.authorName.trim()) errors.push({ path: 'embed.authorIconUrl', message: 'Ícone do autor exige nome do autor.' });
    if (spec.embed.footerIconUrl && !spec.embed.footerText.trim()) errors.push({ path: 'embed.footerIconUrl', message: 'Ícone do rodapé exige texto do rodapé.' });
  }
  if (!spec.content.trim() && !spec.embed.enabled) errors.push({ path: 'content', message: 'A mensagem precisa de texto ou de um embed.' });

  const targets = new Set(def.pingTargets || []);
  if (def.visibility === 'private' && (spec.pings.users.length || spec.pings.roles.length || spec.pings.extraUserIds.length || spec.pings.extraRoleIds.length)) {
    errors.push({ path: 'pings', message: 'Mensagens privadas não notificam ninguém.' });
  }
  for (const t of [...spec.pings.users, ...spec.pings.roles]) {
    if (!targets.has(t)) errors.push({ path: 'pings', message: `Notificação "${t}" não disponível neste modelo.` });
  }
  for (const id of [...spec.pings.extraUserIds, ...spec.pings.extraRoleIds]) {
    if (!SNOWFLAKE.test(id)) errors.push({ path: 'pings', message: `ID inválido para notificação: ${id}.` });
  }
  return errors;
}

function fill(text, ctx, path, errors) {
  return text.replace(PH_RE, (m, name) => {
    if (Object.prototype.hasOwnProperty.call(ctx, name)) return str(ctx[name]);
    errors.push({ path, message: `Sem valor para [[${name}]].` });
    return '';
  });
}

function mentionedUsers(text) {
  return new Set(Array.from(text.matchAll(/<@!?(\d{17,20})>/g), (m) => m[1]));
}
function mentionedRoles(text) {
  return new Set(Array.from(text.matchAll(/<@&(\d{17,20})>/g), (m) => m[1]));
}

function computeAllowedMentions(spec, content, pingIds, mode) {
  const none = { parse: [], users: [], roles: [] };
  if (mode === 'edit' || mode === 'test') return none;
  const users = mentionedUsers(content);
  const roles = mentionedRoles(content);
  const allowUsers = new Set();
  const allowRoles = new Set();
  for (const t of spec.pings.users) for (const id of (pingIds[t] || [])) if (users.has(id)) allowUsers.add(id);
  for (const t of spec.pings.roles) for (const id of (pingIds[t] || [])) if (roles.has(id)) allowRoles.add(id);
  for (const id of spec.pings.extraUserIds) if (users.has(id)) allowUsers.add(id);
  for (const id of spec.pings.extraRoleIds) if (roles.has(id)) allowRoles.add(id);
  return { parse: [], users: Array.from(allowUsers).slice(0, 100), roles: Array.from(allowRoles).slice(0, 100) };
}

function checkLimits(message, errors) {
  if (message.content.length > LIMITS.content) errors.push({ path: 'content', message: `Texto com ${message.content.length} caracteres (máximo ${LIMITS.content}).` });
  const e = message.embeds[0];
  if (!e) {
    if (!message.content.trim()) errors.push({ path: 'content', message: 'A mensagem ficou vazia depois de preencher as variáveis.' });
    return;
  }
  let total = 0;
  const chk = (path, value, max) => {
    const len = value ? value.length : 0;
    total += len;
    if (len > max) errors.push({ path, message: `${len} caracteres (máximo ${max}).` });
  };
  chk('embed.title', e.title, LIMITS.title);
  chk('embed.description', e.description, LIMITS.description);
  chk('embed.authorName', e.author && e.author.name, LIMITS.author);
  chk('embed.footerText', e.footer && e.footer.text, LIMITS.footer);
  (e.fields || []).forEach((f, i) => {
    chk(`embed.fields.${i}.name`, f.name, LIMITS.fieldName);
    chk(`embed.fields.${i}.value`, f.value, LIMITS.fieldValue);
    if (!f.name.trim()) errors.push({ path: `embed.fields.${i}.name`, message: 'Nome do campo ficou vazio depois de preencher.' });
    if (!f.value.trim()) errors.push({ path: `embed.fields.${i}.value`, message: 'Valor do campo ficou vazio depois de preencher.' });
  });
  if (total > LIMITS.embedTotal) errors.push({ path: 'embed', message: `Embed com ${total} caracteres no total (máximo ${LIMITS.embedTotal}).` });
  if (!e.title && !e.description && !(e.author && e.author.name) && !(e.fields || []).length) {
    errors.push({ path: 'embed', message: 'O embed ficou vazio depois de preencher as variáveis.' });
  }
}

// JSON para "Send an API Request" (modo API): "{" e "}" DENTRO de textos
// viram { / } — o Discord lê igual, e o BotGhost não confunde
// com variáveis dele.
function toBotGhostJson(obj) {
  const OPEN = '';
  const CLOSE = '';
  const walk = (v) => {
    if (typeof v === 'string') return v.replace(/\{/g, OPEN).replace(/\}/g, CLOSE);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(obj)).split(OPEN).join('\\u007b').split(CLOSE).join('\\u007d');
}

function nativeSlots(message, spec) {
  const e = message.embeds[0] || null;
  const fieldsText = e && e.fields ? e.fields.map((f) => `**${f.name}**\n${f.value}`).join('\n\n') : '';
  const descriptionWithFields = e ? [e.description || '', fieldsText].filter(Boolean).join('\n\n') : '';
  return {
    content: message.content,
    hideEmbed: e ? 'false' : 'true',
    title: e ? e.title || '' : '',
    description: e ? e.description || '' : '',
    descriptionWithFields,
    url: e ? e.url || '' : '',
    color: e ? String(e.color) : '',
    colorHex: spec.embed.color,
    authorName: e && e.author ? e.author.name : '',
    authorUrl: e && e.author ? e.author.url || '' : '',
    authorIconUrl: e && e.author ? e.author.icon_url || '' : '',
    thumbnailUrl: e && e.thumbnail ? e.thumbnail.url : '',
    imageUrl: e && e.image ? e.image.url : '',
    footerText: e && e.footer ? e.footer.text : '',
    footerIconUrl: e && e.footer ? e.footer.icon_url || '' : '',
    timestamp: e && e.timestamp ? e.timestamp : '',
    fieldCount: String(e && e.fields ? e.fields.length : 0),
    fieldsText,
    allowedUserIds: message.allowed_mentions.users.join(','),
    allowedRoleIds: message.allowed_mentions.roles.join(','),
  };
}

// Preenche e valida. mode: 'send' | 'edit' | 'test'. pingIds: IDs reais
// por alvo de notificação, ex. { aluno: ['123...'], cargoPromocao: ['456...'] }.
function renderTemplate(key, rawSpec, ctx, { mode = 'send', pingIds = {}, now = new Date() } = {}) {
  const def = TEMPLATES[key];
  const spec = normalizeSpec(rawSpec);
  const errors = [];
  if (!def) return { ok: false, errors: [{ path: 'key', message: 'Modelo desconhecido.' }] };

  const content = fill(spec.content, ctx, 'content', errors);
  const message = { content, embeds: [], allowed_mentions: null };
  if (spec.embed.enabled) {
    const e = spec.embed;
    const embed = {
      title: fill(e.title, ctx, 'embed.title', errors) || undefined,
      description: fill(e.description, ctx, 'embed.description', errors) || undefined,
      url: e.url || undefined,
      color: parseInt(e.color.replace('#', ''), 16) || 0,
    };
    const authorName = fill(e.authorName, ctx, 'embed.authorName', errors);
    if (authorName) embed.author = { name: authorName, url: e.authorUrl || undefined, icon_url: e.authorIconUrl || undefined };
    if (e.thumbnailUrl) embed.thumbnail = { url: e.thumbnailUrl };
    if (e.imageUrl) embed.image = { url: e.imageUrl };
    const footerText = fill(e.footerText, ctx, 'embed.footerText', errors);
    if (footerText) embed.footer = { text: footerText, icon_url: e.footerIconUrl || undefined };
    if (e.timestamp) embed.timestamp = new Date(now).toISOString();
    if (e.fields.length) {
      embed.fields = e.fields.map((f, i) => ({
        name: fill(f.name, ctx, `embed.fields.${i}.name`, errors),
        value: fill(f.value, ctx, `embed.fields.${i}.value`, errors),
        inline: f.inline,
      }));
    }
    message.embeds.push(JSON.parse(JSON.stringify(embed)));
  }
  message.allowed_mentions = computeAllowedMentions(spec, content, pingIds, mode);
  checkLimits(message, errors);

  const out = { ok: errors.length === 0, errors, message, visibility: def.visibility };
  if (!out.ok) return out;
  out.native = nativeSlots(message, spec);
  if (out.native.descriptionWithFields.length > LIMITS.description) {
    out.native.descriptionWithFields = '';
    out.nativeWarning = 'Descrição + campos passam de 4096 caracteres no modo nativo; use o modo API.';
  }
  out.discordBodyJson = toBotGhostJson(message);
  if (def.visibility === 'private') {
    out.discordCallbackJson = toBotGhostJson({ type: 4, data: { ...message, flags: 64 } });
  }
  return out;
}

// Listas longas: tenta páginas cada vez menores até caber nos limites —
// nunca corta nota, usuário ou link no meio.
function renderPaged(key, spec, buildCtx, { sizes = [10, 8, 6, 4, 2, 1], ...opts } = {}) {
  let last = null;
  for (const size of sizes) {
    const { ctx, pingIds, meta } = buildCtx(size);
    const r = renderTemplate(key, spec, ctx, { ...opts, pingIds });
    if (r.ok) return { ...r, pageSize: size, meta };
    last = { ...r, pageSize: size, meta };
    if (!r.errors.every((e) => /caracteres/.test(e.message))) break;
  }
  return last;
}

module.exports = {
  LIMITS, PH_RE, normalizeSpec, validateSpec, renderTemplate, renderPaged, urlProblem, toBotGhostJson, computeAllowedMentions,
};
