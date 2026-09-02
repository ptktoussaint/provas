// Extrai o ID de 11 caracteres de qualquer formato comum de link do
// YouTube que alguém possa colar no campo "ID do vídeo" (o campo pede só o
// ID, mas colar a URL inteira é o erro mais comum e produz um embed
// inválido — sintoma clássico do "Erro 153" do player). Normalizamos aqui,
// uma vez, no momento de salvar — assim o valor guardado é sempre um ID
// puro, e o iframe embutido nunca recebe lixo.
const URL_PATTERNS = [
  /(?:youtube\.com\/watch\?v=|youtube\.com\/live\/|youtube\.com\/embed\/|youtube\.com\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
];

function extractYoutubeId(input) {
  if (!input) return null;
  const trimmed = String(input).trim();
  if (!trimmed) return null;

  for (const pattern of URL_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) return match[1];
  }

  // Já parece um ID puro (11 caracteres, alfanumérico + - _)? Usa como está.
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;

  // Não reconhecido — devolve o texto original em vez de descartar
  // silenciosamente; o player vai mostrar erro, mas pelo menos não some
  // sem explicação, e o admin ainda pode ver o que digitou.
  return trimmed;
}

module.exports = { extractYoutubeId };
