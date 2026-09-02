// Defesa em profundidade contra CSRF (requisito #45). A proteção primária já
// vem do cookie de sessão com SameSite=Lax (não é enviado em POST/PUT/DELETE
// disparado por outra origem); isto aqui é uma segunda camada barata: em
// métodos que alteram estado, se o navegador mandou Origin/Referer, eles têm
// que bater com o nosso próprio host.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function verifySameOrigin(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.get('origin');
  const referer = req.get('referer');
  const host = req.get('host');

  const sourceHost = origin ? safeHost(origin) : referer ? safeHost(referer) : null;
  if (sourceHost && sourceHost !== host) {
    return res.status(403).json({ success: false, message: 'Requisição rejeitada (origem inválida).' });
  }
  next();
}

function safeHost(url) {
  try { return new URL(url).host; } catch (_) { return null; }
}

module.exports = { verifySameOrigin };
