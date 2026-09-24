const { authorize } = require('./authz');
const { parse, COMMAND_NAME } = require('./customIds');
const { memberRoleIds, replyPrivate } = require('./interactionUtils');
const { logSecurityEvent } = require('../lib/securityLog');
const { safeErrorMessage } = require('../lib/outbox');

// Roteamento global de TODAS as interações (comando, botões, seleções,
// formulários). O estado vem do customId ou do Mongo, nunca de coletores
// em memória — botões antigos seguem funcionando depois de um reinício.
// A autorização roda aqui, antes de qualquer handler, em toda interação.

function resolveAction(interaction) {
  if (interaction.isChatInputCommand && interaction.isChatInputCommand()) {
    return interaction.commandName === COMMAND_NAME ? { action: 'panel', parts: ['cmd'] } : null;
  }
  const parts = parse(interaction.customId);
  if (!parts || !parts.length) return null;
  const head = parts[0];
  if (head === 'gen' || head === 'g') return { action: 'generate', parts };
  if (head === 'res' || head === 'r') return { action: 'results', parts };
  if (head === 'pro' || head === 'p') return { action: 'promote', parts };
  return null;
}

function createRouter({ handlers, getConfig, expectedGuildId, log = console }) {
  const lastDeniedLog = new Map();

  async function logDenied(interaction, action, auth) {
    // Evita encher o log de segurança se alguém ficar clicando sem parar.
    const key = `${interaction.user && interaction.user.id}:${action}:${auth.code}`;
    const now = Date.now();
    if (now - (lastDeniedLog.get(key) || 0) < 60000) return;
    lastDeniedLog.set(key, now);
    await logSecurityEvent('discord_unauthorized', {
      meta: {
        userId: interaction.user ? interaction.user.id : null,
        guildId: interaction.guildId || null,
        channelId: interaction.channelId || null,
        action,
        reason: auth.code,
      },
    });
  }

  return async function handleInteraction(interaction) {
    const route = resolveAction(interaction);
    if (!route) return;

    try {
      let config = null;
      try {
        config = await getConfig();
      } catch (err) {
        log.error('[discord] não foi possível ler a configuração:', safeErrorMessage(err));
      }
      const auth = authorize({
        guildId: interaction.guildId || null,
        channelId: interaction.channelId || null,
        memberRoleIds: memberRoleIds(interaction),
        action: route.action,
        expectedGuildId,
        config,
      });
      if (!auth.ok) {
        await replyPrivate(interaction, `⛔ ${auth.message}`);
        await logDenied(interaction, route.action, auth);
        return;
      }

      const handler = handlers[route.action];
      await handler(interaction, route.parts, config);
    } catch (err) {
      log.error(`[discord] erro ao tratar interação (${route.action}):`, safeErrorMessage(err));
      const message = err && err.userMessage ? `⚠️ ${err.userMessage}` : '⚠️ Algo deu errado ao processar esta ação. Tente de novo; se continuar, avise o admin do site.';
      try {
        await replyPrivate(interaction, message);
      } catch (_) { /* a interação pode ter expirado */ }
    }
  };
}

module.exports = { createRouter, resolveAction, COMMAND_NAME };
