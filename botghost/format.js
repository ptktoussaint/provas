// Formatação segura de dados vindos de pessoas (nomes, NOME RP) antes de
// entrarem em mensagens do Discord montadas pelo site. Módulo puro.

function truncate(text, max) {
  const s = String(text == null ? '' : text);
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

// Nada que vire menção (@everyone, <@&cargo>), formatação markdown ou
// variável do BotGhost ({server_id} etc.) quando o texto passar pelos
// blocos do BotGhost. O zero-width space mantém o texto visualmente igual.
function userText(text, max = 80) {
  const cleaned = String(text == null ? '' : text)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/@/g, '@​')
    .replace(/\{/g, '{​')
    .replace(/\[\[/g, '[​[')
    .replace(/([\\*_`~|])/g, '\\$1')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(cleaned, max);
}

// Igual a userText, mas sem escapar markdown: para campos que o BotGhost
// coloca em título/autor de embed (onde "\_" apareceria literalmente).
function plainText(text, max = 80) {
  const cleaned = String(text == null ? '' : text)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/@/g, '@​')
    .replace(/\{/g, '{​')
    .replace(/\[\[/g, '[​[')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(cleaned, max);
}

function fmtNumber(n) {
  return Number(n || 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
}

function fmtDateTime(date) {
  if (!date) return '—';
  return new Date(date).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
}

function fmtDate(date) {
  if (!date) return '—';
  return new Date(date).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function mention(userId) {
  return userId ? `<@${userId}>` : 'não vinculado';
}

function roleMention(roleId) {
  return roleId ? `<@&${roleId}>` : '';
}

// Nome enviado pelo BotGhost. Variável não substituída ("{user_displayName[...]}")
// ou vazia vira '' — quem chama usa o nome padrão.
function displayName(value, max = 80) {
  const s = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!s || /[{}]/.test(s)) return '';
  return s.slice(0, max);
}

// Foto do Discord: só URL HTTPS do CDN oficial, da própria pessoa (o ID no
// caminho precisa ser o dela) ou o avatar padrão. Qualquer outra coisa é
// descartada — o site não tem token do Discord para buscar a foto sozinho.
const AVATAR_RE = /^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/(?:avatars\/(\d{17,20})\/(?:a_)?[a-f0-9]{32}|guilds\/\d{17,20}\/users\/(\d{17,20})\/avatars\/(?:a_)?[a-f0-9]{32}|embed\/avatars\/\d{1,2})\.(?:png|jpe?g|webp|gif)(?:\?[A-Za-z0-9=&_.-]{0,80})?$/;

function avatarUrl(value, userId) {
  const s = String(value == null ? '' : value).trim();
  if (!s || s.length > 300) return '';
  const m = s.match(AVATAR_RE);
  if (!m) return '';
  const owner = m[1] || m[2];
  if (owner && owner !== userId) return '';
  return s;
}

const PROMOTION_STATUS_LABEL = {
  completed: '✅ promovido',
  partial: '⚠️ promoção parcial',
  failed: '❌ promoção falhou',
  in_progress: '⏳ promovendo',
  pending: '⏳ promoção na fila',
  needs_review: '⚠️ promoção em revisão',
  blocked: '⛔ promoção bloqueada',
};

function promotionBadge(promo) {
  if (!promo) return 'não promovido';
  const label = PROMOTION_STATUS_LABEL[promo.status] || promo.status;
  return promo.lockKey ? label : `${label} (liberado pelo admin)`;
}

module.exports = { truncate, userText, plainText, displayName, avatarUrl, fmtNumber, fmtDateTime, fmtDate, mention, roleMention, promotionBadge, PROMOTION_STATUS_LABEL };
