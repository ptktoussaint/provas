const mongoose = require('mongoose');
const env = require('./env');

async function connectDb() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(env.mongoUri, {
    serverSelectionTimeoutMS: 10000,
  });
  console.log('[db] MongoDB conectado');

  mongoose.connection.on('error', (err) => {
    console.error('[db] erro de conexão MongoDB:', err.message);
  });
  mongoose.connection.on('disconnected', () => {
    console.warn('[db] MongoDB desconectado — mongoose tentará reconectar automaticamente');
  });

  return mongoose.connection;
}

module.exports = { connectDb, mongoose };
