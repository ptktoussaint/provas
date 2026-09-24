// Autorização de TODA interação do bot (comando, botão, seleção,
// formulário, confirmação). Função pura: recebe o que a interação diz
// (servidor, canal, cargos atuais do membro) e a configuração, e decide.
// Regra de ouro: configuração ausente BLOQUEIA — nunca libera para todos.

const ACTION_LABELS = {
  panel: 'publicar o painel',
  generate: 'gerar provas',
  results: 'consultar resultados',
  promote: 'promover',
};

function deny(code, message) {
  return { ok: false, code, message };
}

function rolesForAction(config, action) {
  const roles = (config && config.operatorRoles) || {};
  if (action === 'panel') {
    return Array.from(new Set([...(roles.generate || []), ...(roles.results || []), ...(roles.promote || [])]));
  }
  return roles[action] || [];
}

function authorize({ guildId, channelId, memberRoleIds, action, expectedGuildId, config }) {
  if (!ACTION_LABELS[action]) return deny('unknown_action', 'Ação desconhecida.');
  if (!guildId) return deny('dm', 'Este bot só funciona dentro do servidor autorizado — não em mensagens diretas.');
  if (!expectedGuildId) return deny('not_configured', 'O servidor autorizado (DISCORD_GUILD_ID) não está configurado no site.');
  if (guildId !== expectedGuildId) return deny('wrong_guild', 'Este servidor não está autorizado a usar este bot.');
  if (!config) return deny('not_configured', 'A integração ainda não foi configurada no painel admin do site.');
  if (!config.panelChannelId) return deny('not_configured', 'O canal do painel ainda não foi configurado no painel admin do site (aba Discord).');
  if (channelId !== config.panelChannelId) return deny('wrong_channel', `Use o bot somente no canal do painel: <#${config.panelChannelId}>.`);

  const allowed = rolesForAction(config, action);
  if (!allowed.length) {
    return deny('not_configured', `Nenhum cargo de operador foi configurado para ${ACTION_LABELS[action]} (aba Discord do site).`);
  }
  const memberRoles = Array.isArray(memberRoleIds) ? memberRoleIds : [];
  if (!memberRoles.some((id) => allowed.includes(id))) {
    return deny('forbidden', `Você não tem um cargo autorizado para ${ACTION_LABELS[action]}.`);
  }
  return { ok: true };
}

module.exports = { authorize, rolesForAction, ACTION_LABELS };
