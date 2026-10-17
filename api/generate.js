// Vercel serverless: genera la planificación con Azure OpenAI.
// La clave de Azure vive SOLO aquí (variables de entorno de Vercel), nunca en el navegador.
// Solo usuarios con sesión iniciada en TeroClass (Supabase) pueden usarla.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ppvqkjchhejjulrdqkdr.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_D4ZATRSmyiURioJ4PvTb4A_rR_urilK';

async function getUser(token) {
  if (!token) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  return r.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o';
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-12-01-preview';
  if (!endpoint || !apiKey) {
    return res.status(500).json({ error: 'AI is not configured on the server yet (missing Azure settings in Vercel).' });
  }

  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const user = await getUser(token);
    if (!user?.id) {
      return res.status(401).json({ error: 'Please sign in again.' });
    }

    const { messages, temperature } = req.body || {};
    if (!Array.isArray(messages) || !messages.length || messages.length > 10) {
      return res.status(400).json({ error: 'Invalid request.' });
    }
    const totalChars = messages.reduce((n, m) => n + String(m?.content || '').length, 0);
    if (totalChars > 40000) {
      return res.status(400).json({ error: 'Request too long.' });
    }

    const url = `${endpoint.replace(/\/$/, '')}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({
        messages: messages.map(m => ({ role: m.role === 'system' ? 'system' : 'user', content: String(m.content || '') })),
        max_tokens: 3000,
        temperature: typeof temperature === 'number' ? Math.min(Math.max(temperature, 0), 1.2) : 0.7,
        user: user.id,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data?.error?.message || 'Azure OpenAI error' });
    }
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
