// Registra (ou atualiza) o comando /provatcel SOMENTE no servidor
// configurado. Pode rodar quantas vezes quiser; nunca apaga outros comandos
// (ver discord/registerCommands.js). O mesmo registro também pode ser feito
// pelo botão "Registrar /provatcel" da aba Discord do painel admin.
//
// Uso: npm run discord
// Precisa de DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID e DISCORD_GUILD_ID no
// ambiente (ou no arquivo .env). Não precisa do MongoDB.
require('dotenv').config();
const { registerGuildCommands, inviteUrl, explainRegisterError, BOT_PERMISSIONS } = require('../discord/registerCommands');
const { isSnowflake } = require('../lib/discordIds');

async function main() {
  const token = process.env.DISCORD_BOT_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.DISCORD_GUILD_ID;
  const missing = [];
  if (!token) missing.push('DISCORD_BOT_TOKEN');
  if (!isSnowflake(clientId || '')) missing.push('DISCORD_CLIENT_ID');
  if (!isSnowflake(guildId || '')) missing.push('DISCORD_GUILD_ID');
  if (missing.length) {
    console.error(`Faltando ou inválido: ${missing.join(', ')}. Veja DISCORD-SETUP.md.`);
    process.exit(1);
  }

  const saved = await registerGuildCommands({ token, clientId, guildId });
  for (const c of saved) console.log(`✔ /${c.name} registrado no servidor ${guildId} (id do comando ${c.id}).`);
  console.log('\nLink para convidar o bot (se ainda não estiver no servidor):');
  console.log(inviteUrl({ clientId, guildId }));
  console.log(`\nPermissões pedidas no convite (${BOT_PERMISSIONS.bitfield}): Ver canais, Enviar mensagens, Inserir links, Ler histórico, Gerenciar cargos, Gerenciar apelidos.`);
}

main().catch((err) => {
  const msg = String((err && err.message) || err).replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}/g, '[token]');
  console.error('Falha ao registrar o comando:', msg);
  const hint = explainRegisterError(err);
  if (hint) console.error(`→ ${hint}`);
  process.exit(1);
});
