// Classifica erros vindos do Discord: permanente (não adianta repetir sem
// alguém corrigir algo — permissão, cargo/canal/membro inexistente) ou
// transitório (rede, 5xx, limite de taxa), que a fila repete com espera.

// Códigos JSON da API: 10003 canal, 10007 membro, 10008 mensagem,
// 10011 cargo, 10013 usuário, 50001 sem acesso, 50013 sem permissão,
// 50035 formulário inválido.
const PERMANENT_CODES = new Set([10003, 10004, 10007, 10008, 10011, 10013, 50001, 50013, 50035]);

class PermanentError extends Error {
  constructor(message) {
    super(message);
    this.permanent = true;
  }
}

function isPermanentError(err) {
  if (!err) return false;
  if (err.permanent === true) return true;
  if (typeof err.code === 'number' && PERMANENT_CODES.has(err.code)) return true;
  if (err.code === 'TokenInvalid') return true;
  const status = err.status || err.httpStatus;
  if (status === 429) return false;
  if (status && status >= 400 && status < 500) return true;
  return false;
}

function discordCode(err) {
  return err && typeof err.code === 'number' ? err.code : null;
}

module.exports = { PermanentError, isPermanentError, discordCode, PERMANENT_CODES };
