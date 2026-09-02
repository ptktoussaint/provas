// Express 4 NÃO encaminha automaticamente uma Promise rejeitada vindo de um
// handler assíncrono para o middleware de erro — a rejeição fica "solta" e,
// no Node moderno, uma unhandled rejection derruba o PROCESSO INTEIRO por
// padrão. Numa plataforma com várias salas de prova simultâneas, isso
// significa que um erro isolado numa única requisição derrubaria a prova de
// todo mundo. Todo handler assíncrono de rota deve passar por aqui.
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// Mesmo problema em handlers de evento do Socket.io — não há "next" para
// encaminhar o erro, mas o efeito de uma rejeição não tratada é o mesmo
// (derrubar o processo). Aqui só logamos: um evento de socket com erro não
// deve nunca tirar do ar as outras salas.
function safeOn(socket, event, handler) {
  socket.on(event, (...args) => {
    Promise.resolve(handler(...args)).catch((err) => {
      console.error(`[socket:${event}] erro não tratado:`, err);
    });
  });
}

module.exports = { asyncHandler, safeOn };
