// Anúncio de promoção dividido em partes que cabem nos limites do Discord
// (2000 caracteres no texto e até 100 usuários em allowed_mentions). Cada
// parte vira uma notificação própria (entregue e confirmada separadamente).
const USERS_PER_MESSAGE = 40;

function chunkUserIds(userIds, size = USERS_PER_MESSAGE) {
  const unique = Array.from(new Set(userIds));
  const chunks = [];
  for (let i = 0; i < unique.length; i += size) chunks.push(unique.slice(i, i + size));
  return chunks;
}

module.exports = { chunkUserIds, USERS_PER_MESSAGE };
