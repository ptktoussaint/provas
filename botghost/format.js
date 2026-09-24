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

module.exports = { truncate, userText, fmtNumber, fmtDateTime, fmtDate, mention, roleMention, promotionBadge, PROMOTION_STATUS_LABEL };
