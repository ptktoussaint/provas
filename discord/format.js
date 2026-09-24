// Textos e limites do Discord (valores atuais da API). Módulo puro.
const LIMITS = {
  content: 2000,
  embedDescription: 4096,
  embedTitle: 256,
  selectOptions: 25,
  selectLabel: 100,
  selectDescription: 100,
  selectValue: 100,
  placeholder: 150,
  modalTitle: 45,
  label: 45,
  labelDescription: 100,
  buttonLabel: 80,
  allowedMentionUsers: 100,
};

function truncate(text, max) {
  const s = String(text == null ? '' : text);
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

// Nomes vindos de pessoas (nome do aluno, NOME RP) aparecem em mensagens:
// sem formatação markdown e sem nada que vire menção.
function safeName(text, max = 60) {
  const cleaned = String(text == null ? '' : text)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/@/g, '@​')
    .replace(/([\\*_`~|])/g, '\\$1')
    .trim();
  return truncate(cleaned, max);
}

function fmtNumber(n) {
  return Number(n || 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
}

function unixSeconds(date) {
  return Math.floor(new Date(date).getTime() / 1000);
}

function mention(userId) {
  return `<@${userId}>`;
}

// Texto da mensagem no canal de resultados. A primeira linha segue
// exatamente o formato pedido; a linha pequena de baixo identifica a
// tentativa (também usada para reconciliar um envio ambíguo).
function resultNotificationContent({ attemptId, discordUserId, score, maxScore, examName, adjusted, deleted }) {
  const marker = `-# Tentativa \`${attemptId}\``;
  if (deleted) {
    return `Resultado removido: ${mention(discordUserId)} — Prova: ${safeName(examName, 100)}\n${marker} · removido pelo admin`;
  }
  const main = `Prova finalizada: ${mention(discordUserId)} — Nota: ${fmtNumber(score)} / ${fmtNumber(maxScore)} — Prova: ${safeName(examName, 100)}`;
  return `${main}\n${marker}${adjusted ? ' · nota ajustada pelo admin' : ''}`;
}

function resultMarker(attemptId) {
  return `Tentativa \`${attemptId}\``;
}

const PROMOTION_STATUS_LABEL = {
  completed: '✅ promovido',
  partial: '⚠️ promoção parcial',
  failed: '❌ promoção falhou',
  in_progress: '⏳ promovendo',
  pending: '⏳ promoção na fila',
};

function promotionBadge(promo) {
  if (!promo) return 'não promovido';
  const label = PROMOTION_STATUS_LABEL[promo.status] || promo.status;
  return promo.lockKey ? label : `${label} (liberado pelo admin)`;
}

module.exports = {
  LIMITS, truncate, safeName, fmtNumber, unixSeconds, mention, resultNotificationContent, resultMarker,
  promotionBadge, PROMOTION_STATUS_LABEL,
};
