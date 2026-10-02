// The author's previous judgments, used to teach the findings writer their style.
// Everything here needs the admin password: judgments are not public.
//   POST {password, action:"list"}                 -> {items:[{id,title,chars,addedAt}]}
//   POST {password, action:"add", title, text}     -> {ok, item}
//   POST {password, action:"delete", id}           -> {ok}
import crypto from 'node:crypto';
import { list, del, passwordOk, readBody, readJson, writeJson, fail } from './_blob.js';

export const PREFIX = 'judgments/';
const MAX_CHARS = 400_000;

export async function loadAll() {
  const { blobs } = await list({ prefix: PREFIX });
  const items = await Promise.all(blobs.map(async (b) => {
    try {
      const j = await readJson(b.pathname);
      return j ? { ...j, pathname: b.pathname } : null;
    } catch { return null; }
  }));
  return items.filter(Boolean).sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  try {
    let body;
    try { body = await readBody(req); } catch { return res.status(400).json({ error: 'bad_json' }); }
    if (!process.env.ADMIN_PASSWORD) return res.status(500).json({ error: 'ADMIN_PASSWORD is not set' });
    if (!passwordOk(body.password)) return res.status(401).json({ error: 'bad_password' });

    if (body.action === 'list') {
      const all = await loadAll();
      return res.status(200).json({ items: all.map(({ id, title, text, addedAt }) => ({ id, title, chars: (text || '').length, addedAt })) });
    }

    if (body.action === 'add') {
      const text = String(body.text || '').replace(/\r\n/g, '\n').trim();
      const title = String(body.title || '').trim().slice(0, 200) || 'ހުކުމް';
      if (!text) return res.status(400).json({ error: 'empty' });
      if (text.length > MAX_CHARS) return res.status(413).json({ error: 'too_large' });
      const id = Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
      const item = { id, title, text, addedAt: new Date().toISOString() };
      await writeJson(PREFIX + id + '.json', item);
      return res.status(200).json({ ok: true, item: { id, title, chars: text.length, addedAt: item.addedAt } });
    }

    if (body.action === 'delete') {
      const id = String(body.id || '');
      if (!/^[a-z0-9]+$/.test(id)) return res.status(400).json({ error: 'bad_id' });
      const { blobs } = await list({ prefix: PREFIX + id + '.json' });
      if (blobs.length) await del(blobs.map((b) => b.url));
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'bad_action' });
  } catch (err) {
    return fail(res, err);
  }
}
