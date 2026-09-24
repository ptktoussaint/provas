const crypto = require('crypto');

// Anúncio de promoção, dividido em mensagens que respeitam os limites da
// API (2000 caracteres e até 100 usuários em allowed_mentions). Só a
// primeira parte pinga o cargo; as menções permitidas são exatamente os
// promovidos daquela parte + o cargo — nada além disso.
const USERS_PER_MESSAGE = 40;

function buildAnnouncementChunks({ roleId, userIds, usersPerMessage = USERS_PER_MESSAGE }) {
  const unique = Array.from(new Set(userIds));
  const chunks = [];
  for (let i = 0; i < unique.length; i += usersPerMessage) {
    const part = unique.slice(i, i + usersPerMessage);
    const first = i === 0;
    const header = `Parabéns aos promovidos para <@&${roleId}>${first ? '' : ' (continuação)'}`;
    const content = [header, ...part.map((id) => `<@${id}>`)].join('\n');
    chunks.push({
      content,
      allowedMentions: { parse: [], users: part, roles: first ? [roleId] : [] },
    });
  }
  return chunks;
}

// nonce do Discord: até 25 caracteres. Com enforce_nonce, reenviar a mesma
// mensagem (ex.: depois de uma queda entre o envio e a gravação no banco)
// devolve a mensagem já criada em vez de duplicar.
function nonceFor(key, index = 0) {
  return crypto.createHash('sha1').update(`${key}#${index}`).digest('hex').slice(0, 25);
}

module.exports = { buildAnnouncementChunks, nonceFor, USERS_PER_MESSAGE };
