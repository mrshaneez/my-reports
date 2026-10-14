// Sign in. For now there is one user, the admin, who signs in with ADMIN_PASSWORD.
//   POST {password, remember}  -> {token, user, expiresAt}   (remember: 30 days, otherwise 12 hours)
//   POST {token, check:true}   -> {ok, user}                 (is this sign-in still valid?)
import { isPassword, makeToken, tokenUser, readBody } from './_blob.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  let body;
  try { body = await readBody(req); } catch { return res.status(400).json({ error: 'bad_json' }); }
  if (!process.env.ADMIN_PASSWORD) return res.status(500).json({ error: 'ADMIN_PASSWORD is not set' });

  if (body.check) {
    const user = tokenUser(body.token);
    return user ? res.status(200).json({ ok: true, user }) : res.status(401).json({ error: 'signed_out' });
  }

  if (!isPassword(body.password)) {
    await new Promise((r) => setTimeout(r, 600)); // slow down guessing
    return res.status(401).json({ error: 'bad_password' });
  }
  const t = makeToken('admin', body.remember ? 30 : 0.5);
  return res.status(200).json({ token: t.token, user: 'admin', expiresAt: t.expiresAt });
}
