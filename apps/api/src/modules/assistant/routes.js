const SYSTEM_PROMPT = `أنت المساعد الذكي للمحاسب برو. أجب بالعربية الواضحة وافهم اللهجة العراقية.
في هذه النسخة لا تملك وصولاً إلى سجلات الشركة ولا صلاحية لتنفيذ عمليات. لا تدّع أنك بحثت أو أضفت أو عدّلت أو رحّلت شيئاً. لا تخترع أسماء أو أرصدة أو أسعاراً أو أرقام قيود. عند طلب بيانات من النظام، وضّح أنك تحتاج إلى ربط أداة البحث. لا تعتمد قيوداً ولا حركات مالية أو مخزنية.`;

const GROQ_API_URL = 'https://api.groq.com/openai/v1';

const modelConfig = () => ({
  apiKey: String(process.env.GROQ_API_KEY || '').trim(),
  model: String(process.env.AI_ASSISTANT_GROQ_MODEL || 'openai/gpt-oss-20b').trim()
});

function error(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

export function installAssistantRoutes(app, { authenticate }) {
  app.get('/api/v1/assistant/status', authenticate, async (_req, res) => {
    const config = modelConfig();
    if (!config.apiKey || !config.model) return res.json({ available: false, configured: false, model: config.model || null });
    try {
      const response = await fetch(`${GROQ_API_URL}/models`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) return res.json({ available: false, configured: true, model: config.model });
      const data = await response.json().catch(() => ({}));
      const models = Array.isArray(data.data) ? data.data.map(item => String(item.id || '')) : [];
      return res.json({ available: models.includes(config.model), configured: true, model: config.model });
    } catch {
      return res.json({ available: false, configured: true, model: config.model });
    }
  });

  app.post('/api/v1/assistant/chat', authenticate, async (req, res) => {
    const config = modelConfig();
    if (!config.apiKey || !config.model) return error(res, 503, 'ASSISTANT_NOT_CONFIGURED', 'المساعد السحابي لم يُربط بعد');
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
      const response = await fetch(`${GROQ_API_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...clean],
          max_completion_tokens: 1200
        }),
        signal: AbortSignal.timeout(45000)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 429) return error(res, 429, 'ASSISTANT_RATE_LIMITED', 'وصل المساعد إلى حد الاستخدام المؤقت؛ حاول بعد قليل');
        if ([401, 403].includes(response.status)) return error(res, 503, 'ASSISTANT_PROVIDER_AUTH', 'تعذر اعتماد مفتاح المساعد السحابي');
        return error(res, 503, 'ASSISTANT_MODEL_UNAVAILABLE', 'تعذر الحصول على رد من المساعد السحابي');
      }
      const answer = String(data.choices?.[0]?.message?.content || '').trim().slice(0, 6000);
      if (!answer) return error(res, 502, 'ASSISTANT_EMPTY_REPLY', 'لم يصل رد صالح من المساعد السحابي');
      return res.json({ answer, model: config.model });
    } catch {
      return error(res, 503, 'ASSISTANT_MODEL_UNAVAILABLE', 'تعذر الاتصال بالمساعد السحابي الآن');
    }
  });
}
