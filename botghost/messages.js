const templates = require('./templates/store');
const { renderTemplate } = require('./templates/render');
const { fmtDateTime, mention } = require('./format');
const { ApiError } = require('./http');

// Monta a mensagem de um modelo publicado para devolver ao BotGhost junto
// com os dados estruturados: data.message (objeto), data.native (campos
// simples para os blocos nativos) e data.discordBodyJson (modo API).
function baseContext(actor) {
  return {
    data: fmtDateTime(new Date()),
    'operador.mencao': mention(actor.actorDiscordId),
    'operador.nome': actor.actorDisplayName,
    'operador.discordId': actor.actorDiscordId,
  };
}

async function renderForApi(templateKey, ctx, { pingIds = {}, mode = 'send' } = {}) {
  const spec = await templates.getPublished(templateKey);
  const r = renderTemplate(templateKey, spec, ctx, { pingIds, mode });
  if (!r.ok) {
    throw new ApiError(500, 'render_failed', `O modelo de mensagem "${templateKey}" ficou inválido com estes dados. Ajuste-o em Mensagens do Bot.`, { errors: r.errors.map((e) => `${e.path}: ${e.message}`).join(' | ') });
  }
  return messageData(r);
}

function messageData(r) {
  const out = { message: r.message, native: r.native, discordBodyJson: r.discordBodyJson };
  if (r.discordCallbackJson) out.discordCallbackJson = r.discordCallbackJson;
  return out;
}

// Negações também levam a mensagem pronta (modelo "Acesso negado"), para o
// BotGhost só repassar. Se nem isso der, fica o texto simples.
async function deniedMessage(actorLike, motivo) {
  try {
    return await renderForApi('access_denied', { ...baseContext(actorLike), 'acesso.motivo': motivo });
  } catch (_) {
    return {};
  }
}

module.exports = { baseContext, renderForApi, messageData, deniedMessage };
