const { MessageFlags } = require('discord.js');

// Respostas privadas (efêmeras): só quem clicou vê. Nenhuma resposta do bot
// notifica ninguém (allowed_mentions vazio), mesmo mostrando menções.
const NO_PINGS = { parse: [] };

function memberRoleIds(interaction) {
  const roles = interaction.member && interaction.member.roles;
  if (!roles) return [];
  if (Array.isArray(roles)) return roles.map(String);
  if (roles.cache) return Array.from(roles.cache.keys());
  return [];
}

function operatorName(interaction) {
  const m = interaction.member;
  return (m && (m.displayName || m.nick)) || (interaction.user && (interaction.user.globalName || interaction.user.username)) || 'Operador';
}

async function replyPrivate(interaction, payload) {
  const body = typeof payload === 'string' ? { content: payload } : payload;
  const data = { allowedMentions: NO_PINGS, ...body };
  if (interaction.deferred || interaction.replied) {
    return interaction.followUp({ ...data, flags: MessageFlags.Ephemeral });
  }
  return interaction.reply({ ...data, flags: MessageFlags.Ephemeral });
}

// Atualiza a mensagem privada em que o botão foi clicado. Se a interação
// já foi confirmada (deferUpdate), edita; senão, responde com update.
async function updatePrivate(interaction, payload) {
  const data = { allowedMentions: NO_PINGS, embeds: [], components: [], content: '', ...payload };
  if (interaction.deferred || interaction.replied) return interaction.editReply(data);
  return interaction.update(data);
}

async function deferPrivate(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
}

async function deferUpdate(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
}

module.exports = { NO_PINGS, memberRoleIds, operatorName, replyPrivate, updatePrivate, deferPrivate, deferUpdate };
