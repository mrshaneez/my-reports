// Shared helpers for the API routes (files starting with "_" are not deployed as routes).
// Works with both private and public Vercel Blob stores.
import { put, list, del, get } from '@vercel/blob';
import crypto from 'node:crypto';

export { list, del };

export const ACCESS_ORDER = process.env.BLOB_ACCESS === 'public' ? ['public', 'private'] : ['private', 'public'];

export function passwordOk(given) {
  const expected = process.env.ADMIN_PASSWORD || '';
  if (!expected) return false;
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

export async function readJson(pathname) {
  let lastErr;
  for (const access of ACCESS_ORDER) {
    try {
      const r = await get(pathname, { access, useCache: false });
      if (r && r.stream) return JSON.parse(await new Response(r.stream).text());
      if (r === null) return null;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Could not read ' + pathname);
}

export async function writeJson(pathname, obj) {
  const body = JSON.stringify(obj);
  let lastErr;
  for (const access of ACCESS_ORDER) {
    try {
      return await put(pathname, body, { access, contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true });
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

export function fail(res, err) {
  console.error(err);
  return res.status(500).json({ error: 'server_error', detail: String((err && err.message) || err) });
}
