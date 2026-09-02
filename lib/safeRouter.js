const express = require('express');
const { asyncHandler } = require('./asyncHandler');

const WRAPPED_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'use'];

// Um express.Router() cujos get/post/put/patch/delete/use encaminham
// automaticamente handlers assíncronos por asyncHandler — nenhuma rota
// registrada aqui pode derrubar o processo com uma rejeição não tratada
// (ver lib/asyncHandler.js). Usar isto em vez de express.Router() direto em
// todos os arquivos de rotas evita ter que lembrar de envolver cada handler
// manualmente (e esquecer um único é o suficiente para reintroduzir o bug).
function createSafeRouter() {
  const router = express.Router();
  for (const method of WRAPPED_METHODS) {
    const original = router[method].bind(router);
    router[method] = (...args) => original(...args.map((arg) => (typeof arg === 'function' ? asyncHandler(arg) : arg)));
  }
  return router;
}

module.exports = { createSafeRouter };
