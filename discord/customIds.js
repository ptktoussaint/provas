// IDs dos componentes (botões, seleções, formulários). Todo estado
// necessário vai no próprio ID ou num documento do Mongo referenciado por
// ele — nunca em memória —, então botões antigos continuam funcionando
// depois de um reinício do servidor. Limite do Discord: 100 caracteres.
const PREFIX = 'ptc';
const COMMAND_NAME = 'provatcel';
const MAX_LENGTH = 100;

function build(...parts) {
  const id = [PREFIX, ...parts.map((p) => (p === null || p === undefined || p === '' ? '-' : String(p)))].join(':');
  if (id.length > MAX_LENGTH) throw new Error(`customId longo demais (${id.length})`);
  return id;
}

function parse(customId) {
  if (typeof customId !== 'string') return null;
  const parts = customId.split(':');
  if (parts[0] !== PREFIX) return null;
  return parts.slice(1).map((p) => (p === '-' ? null : p));
}

module.exports = { build, parse, PREFIX, MAX_LENGTH, COMMAND_NAME };
