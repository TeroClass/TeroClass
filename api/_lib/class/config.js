// Vercel serverless: tells the browser whether the live classroom is connected.
// Only a boolean — never URLs or keys. While false, the app uses the Demo provider.
import { livekitEnv } from '../livekit.js';

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ configured: livekitEnv().configured });
}
