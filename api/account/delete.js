// Vercel serverless: a person deletes their own account (TC-21, rights of access / erasure; 2026-10).
//   POST /api/account/delete  {confirm: "DELETE"}     Authorization: Bearer <the person's own Supabase session token>
// Needs SUPABASE_SERVICE_ROLE_KEY (only the service role can delete an Auth user); without it → 501 and the app tells the
// person to write to the contact address. The database decides first (account_delete_check with the person's token: the
// super admin and the last admin of a main institution can't). Deleting the Auth user removes the profile, saved classes and
// consents (on delete cascade); records that belong to an institution (enrollments it loaded, attendance) lose the link.
import { getUser, bearer, SUPABASE_URL, SUPABASE_KEY } from '../_lib/livekit.js';
import { serviceKey, serviceHeaders } from '../_lib/billing.js';
import { timedFetch } from '../_lib/mail.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader?.('Cache-Control', 'no-store');
  const token = bearer(req);
  let user = null;
  try { user = await getUser(token); } catch { user = null; }
  if (!user?.id) return res.status(401).json({ error: 'Please sign in again.', code: 'auth' });
  if (req.body?.confirm !== 'DELETE') return res.status(400).json({ error: 'Invalid request.', code: 'invalid' });
  const key = serviceKey();
  if (!key) return res.status(501).json({ configured: false, error: 'Account deletion is not enabled yet. Write to us and we will delete it.', code: 'not_configured' });
  let check = null;
  try {
    const r = await timedFetch(`${SUPABASE_URL}/rest/v1/rpc/account_delete_check`, {
      method: 'POST', headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
    check = r.ok ? await r.json() : null;
  } catch { check = null; }
  if (!check) return res.status(503).json({ error: 'Could not check your account. Please try again.', code: 'check' });
  if (!check.ok) return res.status(409).json({ error: check.reason === 'last_admin' ? 'You are the last admin of your institution: make someone else admin first.' : 'This account cannot be deleted here.', code: check.reason || 'blocked' });
  try {
    const r = await timedFetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(user.id)}`, { method: 'DELETE', headers: serviceHeaders(key) });
    if (!r.ok) { console.error(`account/delete: auth admin delete failed (HTTP ${r.status})`); return res.status(502).json({ error: 'Could not delete the account. Please try again or write to us.', code: 'upstream' }); }
  } catch { return res.status(502).json({ error: 'Could not delete the account. Please try again or write to us.', code: 'upstream' }); }
  return res.status(200).json({ deleted: true });
}
