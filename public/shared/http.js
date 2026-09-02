// fetch() nunca expira sozinho — se a rede ou o servidor travar, uma
// requisição normal fica pendente para sempre e a tela trava num estado de
// "carregando" sem nenhuma mensagem (foi exatamente o que aconteceu com as
// telas de identificação do aluno/fiscal). Este helper força um limite de
// tempo e sempre devolve algo utilizável para a UI, nunca deixando a
// Promise pendurada indefinidamente.
window.fetchJson = async function fetchJson(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    let data;
    try { data = await res.json(); } catch (_) { data = { success: false, message: 'Resposta inválida do servidor.' }; }
    return { status: res.status, ...data };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { success: false, message: 'O servidor demorou demais para responder. Verifique sua conexão e tente novamente.', timedOut: true };
    }
    return { success: false, message: 'Erro de conexão. Verifique sua internet e tente novamente.' };
  } finally {
    clearTimeout(timer);
  }
};
