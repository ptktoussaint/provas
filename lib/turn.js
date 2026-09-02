const crypto = require('crypto');
const env = require('../config/env');

// Suporta dois jeitos de configurar TURN, porque cada provedor entrega de um
// jeito diferente:
// 1. TURN_SECRET (HMAC efêmero, mecanismo "use-auth-secret" do coturn) —
//    para quem administra o próprio servidor coturn.
// 2. TURN_USERNAME + TURN_CREDENTIAL (fixos) — para provedores prontos que
//    só dão usuário/senha permanentes (ex.: Open Relay Project/Metered,
//    plano gratuito). Menos "seguro" no sentido de rotação, mas é o que
//    esses provedores oferecem, e ainda assim nunca fica exposto de forma
//    permanente no HTML — só é entregue via API autenticada por sessão.
function buildIceServers(label = 'viewer') {
  const iceServers = env.stunUrls.map((url) => ({ urls: url }));

  if (env.turnUrls.length && env.turnSecret) {
    const expiry = Math.floor(Date.now() / 1000) + env.turnCredentialTtlSeconds;
    const username = `${expiry}:${label}`;
    const credential = crypto
      .createHmac('sha1', env.turnSecret)
      .update(username)
      .digest('base64');

    iceServers.push({ urls: env.turnUrls, username, credential });
  } else if (env.turnUrls.length && env.turnUsername && env.turnCredential) {
    iceServers.push({ urls: env.turnUrls, username: env.turnUsername, credential: env.turnCredential });
  }

  return {
    iceServers,
    turnConfigured: Boolean(env.turnUrls.length && (env.turnSecret || (env.turnUsername && env.turnCredential))),
  };
}

module.exports = { buildIceServers };
