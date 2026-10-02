// Stores the app's admin settings (form fields, sections, report text, standard paragraphs)
// in Vercel Blob. Works with both private and public Blob stores.
// Anyone can read the settings; saving needs the ADMIN_PASSWORD environment variable.
import { put, list, del, get } from '@vercel/blob';
import crypto from 'node:crypto';

const PREFIX = 'settings/config-';
const MAX_BYTES = 500_000;
// Try the store's likely access type first; fall back to the other one.
const ACCESS_ORDER = process.env.BLOB_ACCESS === 'public' ? ['public', 'private'] : ['private', 'public'];

function passwordOk(given) {
  const expected = process.env.ADMIN_PASSWORD || '';
  if (!expected) return false;
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

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
      return await put(PREFIX + Date.now() + '.json', json, {
        access,
        contentType: 'application/json',
        addRandomSuffix: true,
      });
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const data = await readLatest();
      return res.status(200).json({ config: (data && data.config) || null, savedAt: (data && data.savedAt) || null });
    }

    if (req.method === 'POST') {
      if (!process.env.ADMIN_PASSWORD) return res.status(500).json({ error: 'ADMIN_PASSWORD is not set' });
      let body;
      try { body = await readBody(req); } catch { return res.status(400).json({ error: 'bad_json' }); }
      if (!passwordOk(body.password)) return res.status(401).json({ error: 'bad_password' });
      if (body.check) return res.status(200).json({ ok: true });
      if (!body.config || typeof body.config !== 'object') return res.status(400).json({ error: 'bad_config' });

      const json = JSON.stringify({ config: body.config, savedAt: new Date().toISOString() });
      if (Buffer.byteLength(json) > MAX_BYTES) return res.status(413).json({ error: 'too_large' });

      const { blobs: old } = await list({ prefix: PREFIX });
      const saved = await writeNew(json);
      const stale = old.filter((b) => b.url !== saved.url).map((b) => b.url);
      if (stale.length) await del(stale);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'server_error', detail: String((err && err.message) || err) });
  }
}
