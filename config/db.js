const mongoose = require('mongoose');
const env = require('./env');

async function connectDb() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(env.mongoUri, {
    serverSelectionTimeoutMS: 10000,
    ...(env.mongoDbName ? { dbName: env.mongoDbName } : {}),
  });
  // Só o NOME do banco (nunca a URI, que tem usuário/senha): é o que confirma
  // nos Logs do Render que o site abriu o banco certo.
  console.log(`[db] MongoDB conectado — banco em uso: "${mongoose.connection.name}"${env.mongoDbName ? ' (MONGODB_DB_NAME)' : ''}`);

  mongoose.connection.on('error', (err) => {
    console.error('[db] erro de conexão MongoDB:', err.message);
  });
  mongoose.connection.on('disconnected', () => {
    console.warn('[db] MongoDB desconectado — mongoose tentará reconectar automaticamente');
  });

  return mongoose.connection;
}

module.exports = { connectDb, mongoose };
