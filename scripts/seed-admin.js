require('dotenv').config();
const argon2 = require('argon2');
const env = require('../config/env');
const { connectDb, mongoose } = require('../config/db');
const User = require('../models/User');

async function main() {
  if (!env.seedAdminUsername || !env.seedAdminPassword) {
    console.error('Defina SEED_ADMIN_USERNAME e SEED_ADMIN_PASSWORD no .env antes de rodar este script.');
    process.exit(1);
  }

  await connectDb();

  const existing = await User.findOne({ username: env.seedAdminUsername });
  if (existing) {
    console.log(`Admin "${env.seedAdminUsername}" já existe — nada a fazer.`);
  } else {
    const passwordHash = await argon2.hash(env.seedAdminPassword, { type: argon2.argon2id });
    await User.create({ username: env.seedAdminUsername, passwordHash, role: 'admin' });
    console.log(`Admin "${env.seedAdminUsername}" criado com sucesso.`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
