// Dispara o evento de webhook do BotGhost (módulo Webhooks). Formato
// oficial: POST https://api.botghost.com/webhook/{bot_id}/{event_id},
// header Authorization = API Key do módulo (sem "Bearer"), corpo
// {"variables":[{"name","variable":"{...}","value"}]}.
// Só mandamos o ID da notificação: o evento do BotGhost busca o conteúdo
// ATUAL no site (claim). HTTP 200 = evento disparado, NÃO mensagem entregue.
const WEBHOOK_URL_RE = /^https:\/\/api\.botghost\.com\/webhook\/\d{17,20}\/[A-Za-z0-9_-]{1,64}$/;

function webhookConfigProblem({ webhookUrl, webhookApiKey }) {
  if (!webhookUrl) return 'BOTGHOST_WEBHOOK_URL não definido.';
  if (!WEBHOOK_URL_RE.test(webhookUrl)) return 'BOTGHOST_WEBHOOK_URL inválida: copie a URL exata do painel Webhooks (https://api.botghost.com/webhook/...).';
  if (!webhookApiKey) return 'BOTGHOST_WEBHOOK_API_KEY não definido.';
  return null;
}

// Nunca lança. Devolve { ok, status, permanent, retryAfterMs, error }.
async function triggerWebhook({ webhookUrl, webhookApiKey, notificationId, kind, fetchImpl = fetch, timeoutMs = 10000 }) {
  const problem = webhookConfigProblem({ webhookUrl, webhookApiKey });
  if (problem) return { ok: false, status: 0, permanent: true, error: problem };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { Authorization: webhookApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        variables: [
          { name: 'ID da notificação TCEL', variable: '{tcel_notification_id}', value: String(notificationId) },
          { name: 'Tipo da notificação TCEL', variable: '{tcel_notification_kind}', value: String(kind) },
        ],
      }),
      signal: controller.signal,
    });
    if (res.status === 200 || res.status === 204) return { ok: true, status: res.status };
    const explain = {
      400: 'O BotGhost recusou o formato do pedido (400).',
      401: 'API Key do módulo Webhooks inválida ou regenerada (401). Atualize BOTGHOST_WEBHOOK_API_KEY.',
      404: 'Evento de webhook não encontrado (404): URL errada ou evento apagado.',
      405: 'Método não permitido (405).',
      429: 'Limite de requisições do BotGhost (429).',
    }[res.status] || `Resposta inesperada do BotGhost (${res.status}).`;
    const retryAfter = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
    return {
      ok: false,
      status: res.status,
      permanent: [400, 401, 404, 405].includes(res.status),
      retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null,
      error: explain,
    };
  } catch (err) {
    return { ok: false, status: 0, permanent: false, error: err && err.name === 'AbortError' ? 'Tempo esgotado ao chamar o BotGhost.' : 'Falha de rede ao chamar o BotGhost.' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { triggerWebhook, webhookConfigProblem, WEBHOOK_URL_RE };
