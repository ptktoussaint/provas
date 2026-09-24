// IDs do Discord ("snowflakes") são inteiros de 64 bits — maiores que o
// maior inteiro exato do JavaScript (2^53). Sempre tratados como String.
const SNOWFLAKE_RE = /^\d{17,20}$/;

function isSnowflake(value) {
  return typeof value === 'string' && SNOWFLAKE_RE.test(value);
}

// Aceita "123456789012345678", "<@123456789012345678>" ou
// "<@!123456789012345678>" (menção de apelido). Devolve a String ou null.
function parseUserIdInput(input) {
  const text = String(input == null ? '' : input).trim();
  const mention = text.match(/^<@!?(\d{17,20})>$/);
  if (mention) return mention[1];
  if (SNOWFLAKE_RE.test(text)) return text;
  return null;
}

// Lista de IDs separados por vírgula/espaço/quebra de linha (campos da aba
// Discord). Devolve { ids, invalid }.
function parseIdList(input) {
  const raw = Array.isArray(input) ? input : String(input == null ? '' : input).split(/[\s,;]+/);
  const ids = [];
  const invalid = [];
  for (const item of raw) {
    const text = String(item).trim().replace(/^<[@#]&?!?(\d+)>$/, '$1');
    if (!text) continue;
    if (SNOWFLAKE_RE.test(text)) {
      if (!ids.includes(text)) ids.push(text);
    } else {
      invalid.push(text);
    }
  }
  return { ids, invalid };
}

module.exports = { isSnowflake, parseUserIdInput, parseIdList, SNOWFLAKE_RE };
