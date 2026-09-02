const OPTION_KEYS = ['A', 'B', 'C', 'D'];

const DEFAULT_PLATFORM_NAME = 'PROVA TCEL BOMBEIROS SUL FLUXO RP';

// Paleta padrão (vermelha) — os mesmos "papéis" de cor que o UPS FLUXO LIVE
// usava em roxo, só que aqui como ponto de partida editável pelo admin
// (painel Identidade Visual), nunca mais um valor fixo no CSS.
const DEFAULT_THEME = {
  primaryColorLight: '#f87171',
  primaryColor: '#dc2626',
  primaryColorDark: '#991b1b',
  backgroundColor: '#1a0505',
  cardColor: '#2a0e0e',
  backgroundImageUrl: null,
};

module.exports = { OPTION_KEYS, DEFAULT_PLATFORM_NAME, DEFAULT_THEME };
