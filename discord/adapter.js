const { PermissionFlagsBits } = require('discord.js');
const { PermanentError, discordCode } = require('./errors');

// Operações no Discord usadas pela fila e pelos fluxos. Isolado aqui para
// que o resto do código (e os testes) não dependam do discord.js — nos
// testes entra um adaptador falso com a mesma interface. Só REST por ID:
// não precisa de intents privilegiadas (lista de membros, presença,
// conteúdo de mensagens).
function createAdapter(client) {
  async function textChannel(channelId) {
    const channel = await client.channels.fetch(channelId).catch((err) => {
      if ([10003, 50001].includes(discordCode(err))) return null;
      throw err;
    });
    if (!channel || !channel.isTextBased() || !('send' in channel)) {
      throw new PermanentError(`Canal ${channelId} não encontrado ou o bot não tem acesso a ele.`);
    }
    return channel;
  }

  async function guildOf(guildId) {
    return client.guilds.cache.get(guildId) || client.guilds.fetch(guildId);
  }

  function normalizeMember(member, guild) {
    return {
      id: member.id,
      isBot: Boolean(member.user && member.user.bot),
      displayName: member.displayName,
      nickname: member.nickname || null,
      roleIds: member.roles.cache.filter((r) => r.id !== guild.id).map((r) => r.id),
      highestPosition: member.roles.highest ? member.roles.highest.position : 0,
      isOwner: guild.ownerId === member.id,
    };
  }

  return {
    isReady: () => client.isReady(),
    botUserId: () => (client.user ? client.user.id : null),

    async sendMessage(channelId, payload) {
      const channel = await textChannel(channelId);
      const msg = await channel.send(payload);
      return { id: msg.id, channelId };
    },

    async editMessage(channelId, messageId, payload) {
      const channel = await textChannel(channelId);
      const msg = await channel.messages.edit(messageId, payload);
      return { id: msg.id, channelId };
    },

    // Últimas mensagens do próprio bot no canal (precisa de "Ler histórico
    // de mensagens"). Usado só para reconciliar um envio ambíguo.
    async findRecentBotMessage(channelId, predicate, limit = 50) {
      const channel = await textChannel(channelId);
      const messages = await channel.messages.fetch({ limit });
      const found = messages.find((m) => m.author && m.author.id === client.user.id && predicate(m.content || ''));
      return found ? { id: found.id } : null;
    },

    async fetchMember(guildId, userId) {
      const guild = await guildOf(guildId);
      try {
        const member = await guild.members.fetch({ user: userId, force: true });
        return normalizeMember(member, guild);
      } catch (err) {
        if ([10007, 10013].includes(discordCode(err))) return null;
        throw err;
      }
    },

    async addRole(guildId, userId, roleId, reason) {
      const guild = await guildOf(guildId);
      await guild.members.addRole({ user: userId, role: roleId, reason });
    },

    async removeRole(guildId, userId, roleId, reason) {
      const guild = await guildOf(guildId);
      await guild.members.removeRole({ user: userId, role: roleId, reason });
    },

    async setNickname(guildId, userId, nickname, reason) {
      const guild = await guildOf(guildId);
      await guild.members.edit(userId, { nick: nickname, reason });
    },

    // Fotografia do servidor para a verificação prévia (discord/preflight.js).
    async guildSnapshot(guildId, { roleIds = [], announceChannelId = null, extraChannelIds = [] } = {}) {
      const guild = await guildOf(guildId);
      const [roles, me] = await Promise.all([guild.roles.fetch(), guild.members.fetchMe()]);
      const roleMap = {};
      for (const id of roleIds) {
        const role = roles.get(id);
        roleMap[id] = role
          ? { exists: true, name: role.name, position: role.position, managed: role.managed, mentionable: role.mentionable }
          : { exists: false };
      }

      async function channelInfo(channelId) {
        if (!channelId) return { exists: false };
        const ch = await client.channels.fetch(channelId).catch(() => null);
        if (!ch || ch.guildId !== guild.id) return { exists: false };
        const perms = ch.permissionsFor(me);
        return {
          exists: true,
          name: ch.name,
          canView: Boolean(perms && perms.has(PermissionFlagsBits.ViewChannel)),
          canSend: Boolean(perms && perms.has(PermissionFlagsBits.SendMessages)),
          canReadHistory: Boolean(perms && perms.has(PermissionFlagsBits.ReadMessageHistory)),
          canEmbed: Boolean(perms && perms.has(PermissionFlagsBits.EmbedLinks)),
          canMentionEveryone: Boolean(perms && perms.has(PermissionFlagsBits.MentionEveryone)),
        };
      }

      const channels = {};
      for (const id of extraChannelIds) channels[id] = await channelInfo(id);

      return {
        id: guild.id,
        name: guild.name,
        ownerId: guild.ownerId,
        roles: roleMap,
        bot: {
          highestPosition: me.roles.highest ? me.roles.highest.position : 0,
          perms: {
            administrator: me.permissions.has(PermissionFlagsBits.Administrator),
            manageRoles: me.permissions.has(PermissionFlagsBits.ManageRoles),
            manageNicknames: me.permissions.has(PermissionFlagsBits.ManageNicknames),
          },
        },
        announceChannel: await channelInfo(announceChannelId),
        channels,
      };
    },
  };
}

module.exports = { createAdapter };
