// Saved reports. Everything here needs the admin password: reports are not public.
//   POST {password, action:"list"}                      -> {items:[{id,name,createdAt,updatedAt}]}
//   POST {password, action:"get", id}                   -> {report:{id,name,data,createdAt,updatedAt}}
//   POST {password, action:"save", id?, name, data}     -> {ok, item}   (no id = new report)
//   POST {password, action:"rename", id, name}          -> {ok, item}
//   POST {password, action:"delete", id}                -> {ok}
import crypto from 'node:crypto';
import { list, del, passwordOk, readBody, readJson, writeJson, fail } from './_blob.js';

const PREFIX = 'reports/';
const INDEX = 'reports-index.json';
const MAX_BYTES = 2_000_000;

const validId = (id) => typeof id === 'string' && /^[a-z0-9]{6,40}$/.test(id);
const cleanName = (n) => String(n || '').trim().slice(0, 200) || 'ނަމެއް ނެތް ރިޕޯޓު';

async function readIndex() {
  try {
    const j = await readJson(INDEX);
    return Array.isArray(j && j.items) ? j.items : [];
  } catch {
    return [];
  }
}
async function writeIndex(items) {
  items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  await writeJson(INDEX, { items });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  try {
    let body;
    try { body = await readBody(req); } catch { return res.status(400).json({ error: 'bad_json' }); }
    if (!process.env.ADMIN_PASSWORD) return res.status(500).json({ error: 'ADMIN_PASSWORD is not set' });
    if (!passwordOk(body.password)) return res.status(401).json({ error: 'bad_password' });
    const a = body.action;

    if (a === 'list') return res.status(200).json({ items: await readIndex() });

    if (a === 'get') {
      if (!validId(body.id)) return res.status(400).json({ error: 'bad_id' });
      const r = await readJson(PREFIX + body.id + '.json');
      if (!r) return res.status(404).json({ error: 'not_found' });
      return res.status(200).json({ report: r });
    }

    if (a === 'save') {
      if (!body.data || typeof body.data !== 'object') return res.status(400).json({ error: 'bad_data' });
      const now = new Date().toISOString();
      const items = await readIndex();
      let id = body.id;
      let existing = null;
      if (id !== undefined && id !== null && id !== '') {
        if (!validId(id)) return res.status(400).json({ error: 'bad_id' });
        existing = items.find((x) => x.id === id) || null;
      } else {
        id = Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
      }
      const item = { id, name: cleanName(body.name), createdAt: existing ? existing.createdAt : now, updatedAt: now };
      const report = { ...item, data: body.data };
      if (Buffer.byteLength(JSON.stringify(report)) > MAX_BYTES) return res.status(413).json({ error: 'too_large' });
      await writeJson(PREFIX + id + '.json', report);
      await writeIndex([item, ...items.filter((x) => x.id !== id)]);
      return res.status(200).json({ ok: true, item });
    }

    if (a === 'rename') {
      if (!validId(body.id)) return res.status(400).json({ error: 'bad_id' });
      const items = await readIndex();
      const it = items.find((x) => x.id === body.id);
      if (!it) return res.status(404).json({ error: 'not_found' });
      it.name = cleanName(body.name);
      const r = await readJson(PREFIX + body.id + '.json');
      if (r) { r.name = it.name; await writeJson(PREFIX + body.id + '.json', r); }
      await writeIndex(items);
      return res.status(200).json({ ok: true, item: it });
    }

    if (a === 'delete') {
      if (!validId(body.id)) return res.status(400).json({ error: 'bad_id' });
      const { blobs } = await list({ prefix: PREFIX + body.id + '.json' });
      if (blobs.length) await del(blobs.map((b) => b.url));
      await writeIndex((await readIndex()).filter((x) => x.id !== body.id));
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'bad_action' });
  } catch (err) {
    return fail(res, err);
  }
}
