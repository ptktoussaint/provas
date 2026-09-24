const { validateRpInput, validateTemplate } = require('./nickname');

// Verificação prévia de uma promoção em lote, ANTES de mexer em qualquer
// membro. Função pura: recebe uma fotografia do servidor (cargos, posições,
// permissões do bot, canal de anúncio), dos membros e dos resultados, e
// devolve o que bloqueia e o que só merece aviso. A regra é não iniciar
// nenhuma operação que já se sabe que vai falhar.

function checkGlobal({ config, guild }) {
  const errors = [];
  const warnings = [];
  const promo = config.promotion || {};
  const addRoleIds = promo.addRoleIds || [];
  const removeRoleIds = promo.removeRoleIds || [];

  if (!addRoleIds.length) errors.push('Nenhum cargo a adicionar foi configurado.');
  const templateError = validateTemplate(promo.nicknameTemplate);
  if (templateError) errors.push(templateError);

  const bot = guild.bot || {};
  const perms = bot.perms || {};
  if (!perms.administrator && !perms.manageRoles) errors.push('O bot não tem a permissão "Gerenciar cargos" no servidor.');
  if (!perms.administrator && !perms.manageNicknames) errors.push('O bot não tem a permissão "Gerenciar apelidos" no servidor.');

  for (const roleId of [...addRoleIds, ...removeRoleIds]) {
    const role = guild.roles[roleId];
    if (!role || !role.exists) { errors.push(`O cargo ${roleId} não existe neste servidor.`); continue; }
    if (roleId === guild.id) { errors.push('O cargo @everyone não pode ser usado na promoção.'); continue; }
    if (role.managed) errors.push(`O cargo "${role.name}" é gerenciado por uma integração e não pode ser atribuído pelo bot.`);
    if (role.position >= bot.highestPosition) {
      errors.push(`O cargo "${role.name}" está acima (ou na mesma altura) do cargo mais alto do bot. Arraste o cargo do bot para cima dele em Configurações do servidor → Cargos.`);
    }
  }

  const channel = guild.announceChannel || {};
  if (!promo.announceChannelId) errors.push('O canal de anúncio de promoções não foi configurado.');
  else if (!channel.exists) errors.push('O canal de anúncio de promoções não existe neste servidor (ou o bot não consegue vê-lo).');
  else {
    if (!channel.canView) errors.push('O bot não consegue ver o canal de anúncio de promoções.');
    if (!channel.canSend) errors.push('O bot não pode enviar mensagens no canal de anúncio de promoções.');
  }

  const announceRole = guild.roles[promo.announceRoleId];
  if (!promo.announceRoleId) errors.push('O cargo mencionado no anúncio não foi configurado.');
  else if (!announceRole || !announceRole.exists) errors.push(`O cargo do anúncio (${promo.announceRoleId}) não existe neste servidor.`);
  else if (!announceRole.mentionable && !channel.canMentionEveryone) {
    warnings.push(`O cargo "${announceRole.name}" não é mencionável e o bot não tem a permissão "Mencionar @everyone, @here e todos os cargos" no canal de anúncio: o anúncio vai mostrar o cargo, mas sem notificar quem tem esse cargo.`);
  }

  return { errors, warnings };
}

function checkEntry({ entry, config, guild }) {
  const errors = [];
  const warnings = [];
  const promo = config.promotion || {};
  const addRoleIds = promo.addRoleIds || [];
  const removeRoleIds = promo.removeRoleIds || [];
  const bot = guild.bot || {};
  let needsReReview = false;
  let removedResult = false;

  const r = entry.result;
  if (!r || !r.exists || r.deleted) { errors.push('O resultado escolhido foi excluído ou não existe mais.'); removedResult = true; }
  else if (!r.finished) errors.push('O resultado escolhido não é de uma prova finalizada.');
  else if (r.discordUserId !== entry.userId || r.guildId !== guild.id) { errors.push('O resultado escolhido não está mais vinculado a este usuário.'); removedResult = true; }
  else if (entry.selection && r.revision !== entry.selection.revisionAtSelection) {
    needsReReview = true;
    warnings.push(`O resultado mudou desde a seleção (nota agora: ${r.effectiveScore}).`);
  }

  if (entry.alreadyPromoted) errors.push('Este usuário já foi promovido por esta integração (use a resolução administrativa no site se precisar promover de novo).');

  const m = entry.member;
  if (!m) errors.push('Este usuário não está mais no servidor.');
  else {
    if (m.isBot) errors.push('Este usuário é um bot.');
    if (entry.userId === guild.ownerId) errors.push('O bot não pode alterar o apelido do dono do servidor. Promova essa pessoa manualmente.');
    if (m.highestPosition >= bot.highestPosition) {
      errors.push('O cargo mais alto deste membro está acima (ou na mesma altura) do cargo mais alto do bot — o Discord não deixa o bot alterar o apelido dele.');
    }
  }

  const rp = validateRpInput({ nome: entry.nomeRP, idRP: entry.idRP, template: promo.nicknameTemplate });
  if (!entry.nomeRP || !entry.idRP) errors.push('NOME RP e ID RP ainda não foram preenchidos.');
  else if (!rp.ok) errors.push(...rp.errors);

  let preexisting = false;
  if (m && addRoleIds.length) {
    const has = addRoleIds.filter((id) => m.roleIds.includes(id));
    if (has.length === addRoleIds.length) {
      preexisting = true;
      warnings.push('Já possui todos os cargos de promoção (atribuídos fora do bot). Será ajustado, mas NÃO entra no anúncio automático.');
    } else if (has.length) {
      warnings.push('Já possui parte dos cargos de promoção (atribuídos fora do bot). Confira o estado atual do membro.');
    }
  }

  const plan = m ? {
    add: addRoleIds.filter((id) => !m.roleIds.includes(id)),
    remove: removeRoleIds.filter((id) => m.roleIds.includes(id)),
    nickname: rp.nickname,
  } : null;

  return { userId: entry.userId, errors, warnings, nickname: rp.nickname, preexisting, needsReReview, removedResult, plan };
}

function preflightPromotion({ config, guild, entries }) {
  const global = checkGlobal({ config, guild });
  const results = entries.map((entry) => checkEntry({ entry, config, guild }));
  const ok = global.errors.length === 0 && results.length > 0 && results.every((e) => e.errors.length === 0);
  return { ok, globalErrors: global.errors, globalWarnings: global.warnings, entries: results };
}

module.exports = { preflightPromotion, checkGlobal, checkEntry };
