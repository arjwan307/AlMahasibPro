const SYSTEM_PROMPT = `أنت المساعد الذكي للمحاسب برو. أجب بالعربية الواضحة، وافهم اللهجة العراقية.
في هذه النسخة لا تملك وصولاً إلى سجلات الشركة ولا صلاحية لتنفيذ عمليات. لا تدّع أنك بحثت أو أضفت أو عدّلت أو رحّلت شيئاً. لا تخترع أسماء أو أرصدة أو أسعاراً أو أرقام قيود. عند طلب بيانات من النظام، وضّح أنك تحتاج إلى ربط أداة البحث. لا تعتمد قيوداً ولا حركات مالية أو مخزنية.`;

const modelConfig = () => ({
  baseUrl: String(process.env.AI_ASSISTANT_OLLAMA_URL || 'http://127.0.0.1:11434').trim().replace(/\/+$/, ''),
  model: String(process.env.AI_ASSISTANT_MODEL || 'qwen3:4b').trim(),
  apiKey: String(process.env.AI_ASSISTANT_LOCAL_API_KEY || '').trim()
});

function safeBaseUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url;
  } catch { return null; }
}

function error(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

export function installAssistantRoutes(app, { authenticate }) {
  app.get('/api/v1/assistant/status', authenticate, async (req, res) => {
    const config = modelConfig();
    const base = safeBaseUrl(config.baseUrl);
    if (!base || !config.model) return res.json({ available: false, configured: false, model: null });
    try {
      const response = await fetch(new URL('/api/tags', base), {
        headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
        signal: AbortSignal.timeout(1800)
      });
      if (!response.ok) return res.json({ available: false, configured: true, model: config.model });
      const data = await response.json().catch(() => ({}));
      const models = Array.isArray(data.models) ? data.models.map(item => String(item.name || '')) : [];
      return res.json({ available: models.includes(config.model), configured: true, model: config.model });
    } catch {
      return res.json({ available: false, configured: true, model: config.model });
    }
  });

  app.post('/api/v1/assistant/chat', authenticate, async (req, res) => {
    const config = modelConfig();
    const base = safeBaseUrl(config.baseUrl);
    if (!base) return error(res, 503, 'ASSISTANT_MODEL_UNAVAILABLE', 'تعذر الاتصال بمحرك المساعد المحلي');
    const messages = Array.isArray(req.body?.messages) ? req.body.messages.slice(-12) : [];
    const clean = messages
      .filter(message => ['user', 'assistant'].includes(message?.role))
      .map(message => ({ role: message.role, content: String(message.content || '').trim().slice(0, 4000) }))
      .filter(message => message.content);
    if (!clean.length || clean.at(-1).role !== 'user') return error(res, 400, 'ASSISTANT_MESSAGE_REQUIRED', 'اكتب رسالة للمساعد');
    if (clean.reduce((total, message) => total + message.content.length, 0) > 12000) {
      return error(res, 413, 'ASSISTANT_CONTEXT_TOO_LONG', 'اختصر المحادثة ثم أعد المحاولة');
    }
    try {
      const response = await fetch(new URL('/api/chat', base), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
        body: JSON.stringify({ model: config.model, stream: false, messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...clean] }),
        signal: AbortSignal.timeout(45000)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return error(res, 503, 'ASSISTANT_MODEL_UNAVAILABLE', 'تعذر الحصول على رد من محرك المساعد');
      const answer = String(data.message?.content || '').trim().slice(0, 6000);
      if (!answer) return error(res, 502, 'ASSISTANT_EMPTY_REPLY', 'لم يصل رد صالح من محرك المساعد');
      return res.json({ answer, model: config.model });
    } catch {
      return error(res, 503, 'ASSISTANT_MODEL_UNAVAILABLE', 'محرك المساعد غير متاح الآن');
    }
  });
}
