// Efeito de fagulhas de fogo (tema bombeiro) para as telas de boas-vindas.
// Cada fagulha é um <div> criado, animado via CSS (@keyframes fire-spark-rise
// em shared/base.css) e removido sozinho ao terminar — sem canvas, sem lib.
window.FireSparks = (() => {
  function spawnSpark(container) {
    const spark = document.createElement('div');
    spark.className = 'fire-spark';
    const size = 2 + Math.random() * 3;
    const duration = 2.6 + Math.random() * 2.2;
    const drift = (Math.random() - 0.5) * 70;
    spark.style.left = `${Math.random() * 100}%`;
    spark.style.width = `${size}px`;
    spark.style.height = `${size}px`;
    spark.style.setProperty('--drift', `${drift}px`);
    spark.style.animationDuration = `${duration}s`;
    spark.addEventListener('animationend', () => spark.remove());
    container.appendChild(spark);
  }

  // Retorna uma função para parar o efeito — chamar sempre que a tela sair
  // de cena, para não continuar gastando ciclos com uma tela escondida.
  function start(container, { intervalMs = 220, perTick = 1 } = {}) {
    if (!container) return () => {};
    const timer = setInterval(() => {
      for (let i = 0; i < perTick; i += 1) spawnSpark(container);
    }, intervalMs);
    return () => {
      clearInterval(timer);
      container.innerHTML = '';
    };
  }

  return { start };
})();
