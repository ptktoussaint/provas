const { REST, Routes, PermissionsBitField, PermissionFlagsBits, OAuth2Scopes } = require('discord.js');
const { buildCommands } = require('./commands');

// Registro do /provatcel SOMENTE no servidor configurado. Usa "criar ou
// atualizar por nome" (POST por comando) em vez do PUT em massa: nunca
// apaga outros comandos — nem de outros bots, nem outros deste aplicativo.
// Usado pelo script `npm run discord` e pelo botão da aba Discord do admin.

// Permissões pedidas no convite do bot.
const BOT_PERMISSIONS = new PermissionsBitField([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageNicknames,
]);

function inviteUrl({ clientId, guildId }) {
  const scopes = [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands].join('%20');
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=${scopes}&permissions=${BOT_PERMISSIONS.bitfield}&guild_id=${guildId}&disable_guild_select=true`;
}

async function registerGuildCommands({ token, clientId, guildId }) {
  const rest = new REST({ version: '10' }).setToken(token);
  const saved = [];
  for (const command of buildCommands()) {
    const out = await rest.post(Routes.applicationGuildCommands(clientId, guildId), { body: command });
    saved.push({ name: out.name, id: out.id });
  }
  return saved;
}

function explainRegisterError(err) {
  if (err && err.status === 401) return 'O token do bot parece inválido. Gere um novo em Developer Portal → Bot → Reset Token e atualize DISCORD_BOT_TOKEN.';
  if (err && (err.code === 50001 || err.status === 403)) return 'O bot ainda não está no servidor (ou foi convidado sem "applications.commands"). Use o link de convite e tente de novo.';
  if (err && err.status === 404) return 'DISCORD_CLIENT_ID ou DISCORD_GUILD_ID parecem errados.';
  return null;
}

module.exports = { registerGuildCommands, inviteUrl, explainRegisterError, BOT_PERMISSIONS };
