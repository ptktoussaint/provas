const { isSnowflake, parseIdList } = require('../lib/discordIds');
const { validateTemplate } = require('./nickname');

// Valida o que o admin salva na aba Discord. Pura: devolve { update, errors }.
function optionalChannel(value, label, errors) {
  const text = String(value == null ? '' : value).trim().replace(/^<#(\d+)>$/, '$1');
  if (!text) return null;
  if (!isSnowflake(text)) { errors.push(`${label}: ID inválido (use o ID numérico copiado do Discord).`); return null; }
  return text;
}

function idList(value, label, errors) {
  const { ids, invalid } = parseIdList(value);
  if (invalid.length) errors.push(`${label}: IDs inválidos (${invalid.slice(0, 3).join(', ')}).`);
  return ids;
}

function validateDiscordConfig(body = {}) {
  const errors = [];
  const roles = body.operatorRoles || {};
  const promo = body.promotion || {};

  const update = {
    panelChannelId: optionalChannel(body.panelChannelId, 'Canal do painel', errors),
    resultsChannelId: optionalChannel(body.resultsChannelId, 'Canal de resultados', errors),
    operatorRoles: {
      generate: idList(roles.generate, 'Cargos que podem gerar provas', errors),
      results: idList(roles.results, 'Cargos que podem consultar notas', errors),
      promote: idList(roles.promote, 'Cargos que podem promover', errors),
    },
    defaultExamId: body.defaultExamId ? String(body.defaultExamId) : null,
    promotion: {
      addRoleIds: idList(promo.addRoleIds, 'Cargos a adicionar', errors),
      removeRoleIds: idList(promo.removeRoleIds, 'Cargos a remover', errors),
      announceChannelId: optionalChannel(promo.announceChannelId, 'Canal de promoções', errors),
      announceRoleId: optionalChannel(promo.announceRoleId, 'Cargo mencionado no anúncio', errors),
      nicknameTemplate: String(promo.nicknameTemplate == null ? '' : promo.nicknameTemplate).trim(),
    },
  };

  if (update.defaultExamId && !/^[a-f0-9]{24}$/i.test(update.defaultExamId)) errors.push('Prova padrão inválida.');
  if (!update.promotion.addRoleIds.length) errors.push('Informe pelo menos um cargo a adicionar na promoção.');
  const overlap = update.promotion.addRoleIds.filter((id) => update.promotion.removeRoleIds.includes(id));
  if (overlap.length) errors.push(`O mesmo cargo não pode estar em "adicionar" e "remover" (${overlap.join(', ')}).`);
  if (!update.promotion.announceChannelId) errors.push('Informe o canal de promoções.');
  if (!update.promotion.announceRoleId) errors.push('Informe o cargo mencionado no anúncio.');
  const templateError = validateTemplate(update.promotion.nicknameTemplate);
  if (templateError) errors.push(templateError);

  return { update, errors };
}

module.exports = { validateDiscordConfig };
