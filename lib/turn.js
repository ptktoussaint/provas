const crypto = require('crypto');
const env = require('../config/env');

// Gera credenciais TURN efêmeras compatíveis com o mecanismo
// "use-auth-secret" do coturn (username = "<expiry>:<label>", credential =
// HMAC-SHA1 em base64), em vez de embutir usuário/senha fixos no cliente
// (requisito #21/#49 — nunca expor credencial permanente).
function buildIceServers(label = 'viewer') {
  const iceServers = env.stunUrls.map((url) => ({ urls: url }));

  if (env.turnUrls.length && env.turnSecret) {
    const expiry = Math.floor(Date.now() / 1000) + env.turnCredentialTtlSeconds;
    const username = `${expiry}:${label}`;
    const credential = crypto
      .createHmac('sha1', env.turnSecret)
      .update(username)
      .digest('base64');

    iceServers.push({
      urls: env.turnUrls,
      username,
      credential,
    });
  }

  return {
    iceServers,
    turnConfigured: Boolean(env.turnUrls.length && env.turnSecret),
  };
}

module.exports = { buildIceServers };
