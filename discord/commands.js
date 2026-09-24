const { SlashCommandBuilder, InteractionContextType, ApplicationIntegrationType } = require('discord.js');
const { COMMAND_NAME } = require('./customIds');

// Definição do /provatcel. Registrado só no servidor configurado, pelo
// script `npm run discord` (scripts/discord-register.js). Não funciona em
// mensagens diretas (contexts = Guild).
function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName(COMMAND_NAME)
      .setDescription('Publica (ou atualiza) o painel da Prova TCEL neste canal da equipe.')
      .setContexts(InteractionContextType.Guild)
      .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
      .toJSON(),
  ];
}

module.exports = { buildCommands };
