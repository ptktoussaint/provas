const session = require('express-session');
const MongoStore = require('connect-mongo');
const env = require('../config/env');
const { mongoose } = require('../config/db');

// Uma única instância de sessão é compartilhada entre o Express (HTTP) e o
// Socket.io (handshake) — ver server.js. Isso garante que admin, aluno e
// fiscal usem o mesmo mecanismo de sessão HttpOnly/Secure/SameSite, com
// dados de autorização guardados só no servidor (nunca em JWT decodificável
// no cliente).
//
// Criada só depois de connectDb() (chamada em server.js), reaproveitando o
// client nativo já conectado pelo Mongoose via clientPromise — criar aqui
// uma segunda conexão própria (o padrão mais comum do connect-mongo, com
// mongoUrl) já causou uma queda do processo em teste: se o Mongo ainda não
// estivesse de pé no instante exato em que este módulo fosse carregado, a
// tentativa de conexão paralela virava um unhandled rejection.
function createSessionMiddleware() {
  return session({
    name: 'provas_live.sid',
    secret: env.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: MongoStore.create({
      clientPromise: Promise.resolve(mongoose.connection.getClient()),
      collectionName: 'sessions',
      ttl: 8 * 60 * 60, // 8 horas
    }),
    cookie: {
      httpOnly: true,
      secure: env.cookieSecure,
      sameSite: 'lax',
      maxAge: 8 * 60 * 60 * 1000,
    },
  });
}

module.exports = createSessionMiddleware;
