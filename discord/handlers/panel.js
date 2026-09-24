const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { build } = require('../customIds');
const { deferPrivate, NO_PINGS } = require('../interactionUtils');
const { discordCode } = require('../errors');
const { logSecurityEvent } = require('../../lib/securityLog');

function buildPanelMessage() {
  const embed = new EmbedBuilder()
    .setColor(0xdc2626)
    .setTitle('🔥 Prova TCEL — Painel da equipe')
    .setDescription([
      '**Gerar Prova** — cria a sala da prova para um membro e entrega (só para você) o link do aluno e o seu link de fiscal.',
      '**Conferir resultados** — histórico de notas direto do banco do site.',
      '**Promover** — promove em lote quem já fez a prova, com revisão antes de aplicar.',
      '',
      'As respostas do bot são privadas: só quem clicou vê.',
    ].join('\n'));

  // Exatamente três botões.
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(build('gen')).setLabel('Gerar Prova').setStyle(ButtonStyle.Primary).setEmoji('📝'),
    new ButtonBuilder().setCustomId(build('res')).setLabel('Conferir resultados').setStyle(ButtonStyle.Secondary).setEmoji('📊'),
    new ButtonBuilder().setCustomId(build('pro')).setLabel('Promover').setStyle(ButtonStyle.Success).setEmoji('🎖️'),
  );
  return { embeds: [embed], components: [row], allowedMentions: NO_PINGS };
}

// /provatcel: reaproveita a mensagem de painel já publicada (edita) em vez
// de criar painéis repetidos; só publica uma nova se a antiga sumiu.
function createPanelHandler(ctx) {
  return async function handlePanel(interaction, parts, config) {
    await deferPrivate(interaction);
    const channel = await interaction.client.channels.fetch(config.panelChannelId);
    const payload = buildPanelMessage();

    const saved = config.panelMessage || {};
    if (saved.messageId && saved.channelId === config.panelChannelId) {
      try {
        await channel.messages.edit(saved.messageId, payload);
        await interaction.editReply({ content: '✅ Painel atualizado (a mensagem existente foi reaproveitada).', allowedMentions: NO_PINGS });
        await logSecurityEvent('discord_panel_updated', { meta: { userId: interaction.user.id, messageId: saved.messageId } });
        return;
      } catch (err) {
        if (discordCode(err) !== 10008) throw err;
      }
    }

    const msg = await channel.send(payload);
    await ctx.configStore.setPanelMessage(channel.id, msg.id);
    await interaction.editReply({ content: '✅ Painel publicado neste canal.', allowedMentions: NO_PINGS });
    await logSecurityEvent('discord_panel_published', { meta: { userId: interaction.user.id, messageId: msg.id } });
  };
}

module.exports = { createPanelHandler, buildPanelMessage };
