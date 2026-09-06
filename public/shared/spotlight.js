// Efeito de luz que segue o cursor (ou o dedo, em toque) — usado nas telas
// de boas-vindas do aluno e do fiscal. Só atualiza duas variáveis CSS
// (--mx/--my); todo o visual (gradiente, cor, blend) fica em shared/base.css
// na classe .spotlight-layer, então segue automaticamente a cor do tema.
window.initCursorSpotlight = function initCursorSpotlight(el) {
  if (!el) return;
  function move(x, y) {
    el.style.setProperty('--mx', `${x}px`);
    el.style.setProperty('--my', `${y}px`);
  }
  window.addEventListener('mousemove', (e) => move(e.clientX, e.clientY));
  window.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (t) move(t.clientX, t.clientY);
  }, { passive: true });
};
