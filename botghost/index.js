const env = require('../config/env');
const { createIntegrationRouter } = require('./routes');
const { NotificationDispatcher } = require('./dispatcher');

// Integração com o bot hospedado no BotGhost. O site NÃO conecta no
// Discord (sem Gateway, sem token do bot): o BotGhost chama a API
// autenticada daqui e o site avisa o BotGhost pelo webhook oficial.

const BASE_PATH = '/api/integrations/botghost';
let dispatcher = null;

function getEnv() {
  return env.botghost;
}

// Precisa ser montado ANTES do express.json global, da sessão e do CSRF de
// /api (server.js): rota máquina-a-máquina, sem cookie.
function mountIntegration(app) {
  app.use(BASE_PATH, createIntegrationRouter({
    getEnv,
    getPublicBaseUrl: () => env.publicBaseUrl,
    onNotificationCreated: () => { if (dispatcher) dispatcher.kick(); },
  }));
}

// Só liga o despachante se a integração estiver ligada. Roda enquanto o
// site estiver acordado; ao subir, retoma pendências do Mongo.
function startIntegration({ log = console } = {}) {
  const e = getEnv();
  if (!e.enabled) {
    log.log('[botghost] integração desligada (BOTGHOST_INTEGRATION_ENABLED != true).');
    return null;
  }
  dispatcher = new NotificationDispatcher({ getEnv, log });
  dispatcher.start();
  log.log(`[botghost] integração ligada; avisos por webhook ${e.notificationsEnabled ? 'ligados' : 'desligados'}.`);
  return dispatcher;
}

async function stopIntegration() {
  if (dispatcher) await dispatcher.stop();
  dispatcher = null;
}

function kickDispatcher() {
  if (dispatcher) dispatcher.kick();
}

module.exports = { mountIntegration, startIntegration, stopIntegration, kickDispatcher, BASE_PATH };
