// The app's admin settings (form fields, sections, report text, standard paragraphs, AI instructions),
// stored in Vercel Blob. Reading and saving both need a sign-in (see login.js).
//   POST {password, action:"get"}   -> {config, savedAt}
//   POST {password, check:true}     -> {ok}
//   POST {password, config}         -> {ok}            (save)
import { put, list, del, get } from '@vercel/blob';
import { ACCESS_ORDER, passwordOk, readBody, fail } from './_blob.js';

const PREFIX = 'settings/config-';
const MAX_BYTES = 500_000;

async function readLatest() {
  const { blobs } = await list({ prefix: PREFIX });
  if (!blobs.length) return null;
  blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  const latest = blobs[0];
  let lastErr;
  for (const access of ACCESS_ORDER) {
    try {
      const r = await get(latest.pathname, { access, useCache: false });
      if (r && r.stream) return JSON.parse(await new Response(r.stream).text());
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Could not read the saved settings');
}

async function writeNew(json) {
  let lastErr;
  for (const access of ACCESS_ORDER) {
    try {
      return await put(PREFIX + Date.now() + '.json', json, { access, contentType: 'application/json', addRandomSuffix: true });
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  try {
    if (!process.env.ADMIN_PASSWORD) return res.status(500).json({ error: 'ADMIN_PASSWORD is not set' });
    let body;
    try { body = await readBody(req); } catch { return res.status(400).json({ error: 'bad_json' }); }
    if (!passwordOk(body.password)) return res.status(401).json({ error: 'bad_password' });
    if (body.check) return res.status(200).json({ ok: true });

    if (body.action === 'get') {
      const data = await readLatest();
      return res.status(200).json({ config: (data && data.config) || null, savedAt: (data && data.savedAt) || null });
    }

    if (!body.config || typeof body.config !== 'object') return res.status(400).json({ error: 'bad_config' });
    const json = JSON.stringify({ config: body.config, savedAt: new Date().toISOString() });
    if (Buffer.byteLength(json) > MAX_BYTES) return res.status(413).json({ error: 'too_large' });
    const { blobs: old } = await list({ prefix: PREFIX });
    const saved = await writeNew(json);
    const stale = old.filter((b) => b.url !== saved.url).map((b) => b.url);
    if (stale.length) await del(stale);
    return res.status(200).json({ ok: true });
  } catch (err) {
    return fail(res, err);
  }
}
