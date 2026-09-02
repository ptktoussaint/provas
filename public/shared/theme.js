// Aplica a identidade visual configurada pelo admin (nome, cores, imagem de
// fundo) em cima da paleta padrão já definida em base.css — carregado em
// toda página (admin/aluno/fiscal) antes do respectivo client.js, para que
// o nome e as cores fiquem certos desde o primeiro tela (login, link do
// aluno, link do fiscal), não só depois de autenticado.
(async () => {
  try {
    const res = await fetch('/api/theme');
    const data = await res.json();
    if (!data.success) return;

    const root = document.documentElement.style;
    const theme = data.theme || {};
    if (theme.primaryColorLight) root.setProperty('--accent-1', theme.primaryColorLight);
    if (theme.primaryColor) root.setProperty('--accent-2', theme.primaryColor);
    if (theme.primaryColorDark) root.setProperty('--accent-3', theme.primaryColorDark);
    if (theme.backgroundColor) root.setProperty('--bg-0', theme.backgroundColor);
    if (theme.cardColor) root.setProperty('--bg-card', theme.cardColor);
    root.setProperty('--bg-image', theme.backgroundImageUrl ? `url('${theme.backgroundImageUrl}')` : 'none');

    if (data.platformName) {
      const section = document.documentElement.dataset.section;
      document.title = section ? `${section} — ${data.platformName}` : data.platformName;
      document.querySelectorAll('.js-wordmark').forEach((el) => { el.textContent = data.platformName; });
    }
  } catch (err) {
    // Se a busca falhar, a página fica com a paleta padrão do base.css —
    // nunca quebra a tela por causa disso.
    console.error('[theme] falha ao carregar identidade visual', err);
  }
})();
