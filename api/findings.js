// Writes the "ފާހަގަކުރެވުނު ކަންކަން" (findings) section of an appeal report with Claude.
// Claude researches with web search, so every link returned is a page it actually retrieved.
// The author's previous judgments (see judgments.js) are given as style examples.
// Needs ANTHROPIC_API_KEY and ADMIN_PASSWORD. Optional: ANTHROPIC_MODEL, STYLE_CHARS, MAX_SEARCHES, STEP_TOKENS.
//
// Long findings are written in steps, so there is no length limit: each request runs one Claude call
// that fits inside Vercel's time limit, saves the conversation as a job in Blob storage, and tells the
// app to call again with the job id. When Claude hits its output limit it is asked to continue exactly
// where it stopped. The app keeps calling until the job reports done.
//   POST {password, caseText, view, instructions}                       -> start writing
//   POST {password, mode:"revise", caseText, current, refs, request, history, ...} -> start a revision
//   POST {password, job}                                                -> next step of a job
// Each answer is either {done:false, job, chars} or {done:true, text, refs, note, ...}.
import crypto from 'node:crypto';
import { passwordOk, readBody, readJson, writeJson, list, del, fail } from './_blob.js';
import { loadAll } from './judgments.js';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';
const STYLE_CHARS = Number(process.env.STYLE_CHARS || 120_000);
const MAX_SEARCHES = Number(process.env.MAX_SEARCHES || 10);
const STEP_TOKENS = Number(process.env.STEP_TOKENS || 8000); // output per step; small enough to finish in time
const DEADLINE_MS = 270_000;
const MAX_STEPS = 60;
const JOBS = 'jobs/';
const CONTINUE = 'Continue the findings exactly where you stopped, mid-sentence if need be. Do not repeat anything already written, do not restart or change the paragraph numbering, and do not add any preamble.';

const RULES = `You are drafting the "ފާހަގަކުރެވުނު ކަންކަން" (findings and analysis) section of an appeal case report for a judge of the High Court of the Maldives.

Language and register
- Write in formal Dhivehi (Thaana script), in the register of Maldivian court judgments.
- If previous judgments by the author are provided, imitate their structure, phrasing, terminology, paragraph style and the positions the author takes on recurring issues. Never copy facts from those judgments into this case.

Method
- Analyse each appeal point in turn, against the lower court's decision, the parties' submissions and the outcomes the parties ask for.
- Apply the relevant law: the Constitution of the Republic of Maldives, the applicable Acts and regulations, principles of Islamic Shari'ah where Maldivian law applies them, and general principles of law.
- Support the analysis with precedents, preferring judgments of the Supreme Court and the High Court of the Maldives. Use foreign authority only where it genuinely helps, and say that it is persuasive only.
- Use web search to find and verify every statute provision, legal principle and precedent you rely on. Prefer official sources such as judiciary.gov.mv, supremecourt.mv, highcourt.gov.mv, mvlaw.gov.mv, majlis.gov.mv and agoffice.gov.mv.
- Never invent or guess a case name, case number, date, statute, section number or quotation. Rely only on authorities you found in the search results. If something could not be verified, say in the text that it needs to be checked instead of stating it as fact.
- The author's own view and points decide the direction of the findings: follow them and work them in. If the law you found points the other way, still follow the author's view, but note the difficulty respectfully.
- Finish with a concluding paragraph stating what the findings point to (for example upholding the judgment, overturning it, or sending the case back), consistent with the author's view.

Output
- Output only the finished findings text: numbered paragraphs (1. 2. 3. ...) in Dhivehi, plain text, with no markdown, no section heading, no preamble and no English commentary.
- Do not write anything before or between your searches. Write the findings only once your research is complete.`;

function styleBlock(judgments) {
  let used = 0;
  const parts = [];
  for (const j of judgments) {
    const room = STYLE_CHARS - used;
    if (room < 2000) break;
    const text = j.text.length > room ? j.text.slice(0, room) : j.text;
    parts.push(`<judgment title="${String(j.title).replace(/"/g, "'")}">\n${text}\n</judgment>`);
    used += text.length;
  }
  if (!parts.length) return null;
  return `The author's previous judgments follow. Study them for the author's writing style, structure, terminology and positions. They are examples only: do not take facts from them.\n\n${parts.join('\n\n')}`;
}

const REVISE_RULES = `
Revising
- You are given the findings already written for this case, the references they cite (numbered; markers like (1) or (2، 3) in the text point to them), and a new idea, instruction or question from the author.
- Address it inside the findings: rewrite the affected paragraphs, or add new paragraphs where they belong. Keep everything else as it is, word for word, including its reference markers.
- Never contradict, and never repeat, what the findings already say. If the author's idea would contradict an existing paragraph, revise that paragraph so the findings stay consistent, and say so in your note.
- Research any new law or precedent with web search, under the same rules as before.
- Output the complete revised findings (not only the changes), then a line containing exactly =====NOTE=====, then a short note to the author in Dhivehi: what you changed and where, or the answer to their question. If the question needs no change to the findings, return the findings unchanged and answer in the note.`;

// Keep only the references still cited in the text, renumbered 1..n in order of first use.
export function renumber(text, refs) {
  const byN = new Map(refs.map((r) => [r.n, r]));
  const order = [];
  const groupRe = /\(([\d\s،,]+)\)/g;
  for (const m of text.matchAll(groupRe)) {
    for (const k of m[1].split(/[،,\s]+/).filter(Boolean).map(Number)) {
      if (byN.has(k) && !order.includes(k)) order.push(k);
    }
  }
  const map = new Map(order.map((old, i) => [old, i + 1]));
  const out = text.replace(groupRe, (whole, inner) => {
    const nums = inner.split(/[،,\s]+/).filter(Boolean).map(Number);
    if (!nums.every((k) => map.has(k))) return whole;
    return '(' + [...new Set(nums.map((k) => map.get(k)))].join('، ') + ')';
  });
  return { text: out, refs: order.map((old) => ({ ...byN.get(old), n: map.get(old) })) };
}

async function callClaude(body, signal) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error((j.error && j.error.message) || ('Anthropic API error ' + r.status));
    e.status = r.status;
    throw e;
  }
  return j;
}

// Turn Claude's answers into plain text with (n) markers, plus a numbered list of the cited pages.
// `turns` is one content array per API response. In each response, text written before or between its
// searches is research narration and is dropped; text after its last search result is the findings.
export function assemble(turns, seedRefs = []) {
  const refs = seedRefs.map((r, i) => ({ n: i + 1, url: r.url, title: r.title || r.url }));
  const index = new Map(refs.map((r) => [r.url, r.n]));
  let text = '';
  for (const blocks of turns) {
    let lastSearch = -1;
    blocks.forEach((b, i) => { if (b.type === 'web_search_tool_result') lastSearch = i; });
    for (const b of blocks.slice(lastSearch + 1)) {
      if (b.type !== 'text') continue;
      text += b.text || '';
      if (Array.isArray(b.citations) && b.citations.length) {
        const nums = [];
        for (const c of b.citations) {
          if (!c || !c.url) continue;
          if (!index.has(c.url)) { index.set(c.url, refs.length + 1); refs.push({ n: refs.length + 1, url: c.url, title: c.title || c.url }); }
          const n = index.get(c.url);
          if (!nums.includes(n)) nums.push(n);
        }
        if (nums.length) text += ' (' + nums.join('، ') + ')';
      }
    }
  }
  return { text: text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), refs };
}

// Mark the end of the conversation so the next step reuses the cached prefix (cheaper and faster).
function withCacheMark(messages) {
  const out = messages.map((m) => ({ ...m }));
  const last = out[out.length - 1];
  if (last && last.role === 'user') {
    const content = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content.map((c) => ({ ...c }));
    content[content.length - 1] = { ...content[content.length - 1], cache_control: { type: 'ephemeral' } };
    last.content = content;
  }
  return out;
}

async function newJob(body) {
  const caseText = String(body.caseText || '').trim();
  if (!caseText) return { error: 'empty_case' };
  const revising = body.mode === 'revise';
  const current = String(body.current || '').trim();
  const ask = String(body.request || '').trim();
  const seed = Array.isArray(body.refs) ? body.refs.filter((r) => r && /^https?:\/\//.test(r.url)).map((r) => ({ url: String(r.url), title: String(r.title || r.url) })) : [];
  if (revising && (!current || !ask)) return { error: 'empty_request' };

  let judgments = [];
  try { judgments = await loadAll(); } catch (e) { console.error('Could not load judgments', e); }
  const style = styleBlock(judgments);
  const system = [{ type: 'text', text: revising ? RULES + '\n' + REVISE_RULES : RULES }];
  if (style) system.push({ type: 'text', text: style, cache_control: { type: 'ephemeral' } });

  let user = `The case (as entered in the report form):\n\n${caseText}\n\n`;
  user += body.view ? `The author's own view and the points to include:\n\n${String(body.view)}\n\n` : `The author has not given a view; analyse the case on its merits.\n\n`;
  if (body.instructions) user += `The author's standing instructions on style and positions:\n\n${String(body.instructions)}\n\n`;
  if (revising) {
    user += `The findings written so far:\n\n${current}\n\n`;
    user += seed.length ? `Their references:\n${seed.map((r, i) => `(${i + 1}) ${r.title} — ${r.url}`).join('\n')}\n\n` : 'They cite no references yet.\n\n';
    const hist = Array.isArray(body.history) ? body.history.map(String).filter(Boolean).slice(-10) : [];
    if (hist.length) user += `Earlier requests from the author, already dealt with:\n${hist.map((h) => '- ' + h).join('\n')}\n\n`;
    user += `The author's new idea, instruction or question:\n\n${ask}\n\nRevise the findings now, following the rules.`;
  } else {
    user += 'Write the findings section now, following the rules. Write them in full, however long they need to be.';
  }

  return {
    id: Date.now().toString(36) + crypto.randomBytes(5).toString('hex'),
    createdAt: new Date().toISOString(),
    revising,
    seed,
    styleJudgments: judgments.length,
    system,
    messages: [{ role: 'user', content: user }],
    turns: [],
    steps: 0,
    searches: 0,
    done: false,
  };
}

async function clearOldJobs() {
  try {
    const { blobs } = await list({ prefix: JOBS });
    const old = blobs.filter((b) => Date.now() - new Date(b.uploadedAt).getTime() > 86_400_000).map((b) => b.url);
    if (old.length) await del(old);
  } catch {}
}

// One step: a single Claude call, then save.
async function step(job, signal) {
  const r = await callClaude({
    model: MODEL,
    // after a step ran out of time, ask for less output so the next one fits
    max_tokens: Math.max(2000, Math.round(STEP_TOKENS / 2 ** (job.timeouts || 0))),
    system: job.system,
    tools: [{
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: MAX_SEARCHES,
      user_location: { type: 'approximate', timezone: 'Indian/Maldives' },
    }],
    messages: withCacheMark(job.messages),
  }, signal);

  const content = r.content || [];
  job.turns.push(content);
  job.steps += 1;
  job.searches += (r.usage && r.usage.server_tool_use && r.usage.server_tool_use.web_search_requests) || 0;

  if (r.stop_reason === 'pause_turn') {
    // Long research: hand the paused turn back unchanged and let Claude carry on.
    job.messages = [...job.messages, { role: 'assistant', content }];
  } else if (r.stop_reason === 'max_tokens') {
    // Hit the output limit for this step: ask Claude to continue exactly where it stopped.
    job.messages = [...job.messages, { role: 'assistant', content }, { role: 'user', content: CONTINUE }];
  } else {
    job.done = true;
  }
  if (!job.done && job.steps >= MAX_STEPS) job.done = true;
}

function finish(job) {
  const assembled = assemble(job.turns, job.revising ? job.seed : []);
  let text = assembled.text;
  let note = '';
  const cut = text.indexOf('=====NOTE=====');
  if (cut >= 0) { note = text.slice(cut + 14).trim(); text = text.slice(0, cut).trim(); }
  const final = renumber(text, assembled.refs);
  return { done: true, text: final.text, refs: final.refs, note, model: MODEL, steps: job.steps, searches: job.searches, styleJudgments: job.styleJudgments, stoppedEarly: job.steps >= MAX_STEPS };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
  try {
    let body;
    try { body = await readBody(req); } catch { return res.status(400).json({ error: 'bad_json' }); }
    if (!process.env.ADMIN_PASSWORD) return res.status(500).json({ error: 'ADMIN_PASSWORD is not set' });
    if (!passwordOk(body.password)) return res.status(401).json({ error: 'bad_password' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'no_api_key' });

    let job;
    if (body.job) {
      if (!/^[a-z0-9]{8,40}$/.test(String(body.job))) return res.status(400).json({ error: 'bad_job' });
      job = await readJson(JOBS + body.job + '.json');
      if (!job) return res.status(404).json({ error: 'job_not_found' });
    } else {
      job = await newJob(body);
      if (job.error) return res.status(400).json({ error: job.error });
      clearOldJobs();
    }

    if (!job.done) {
      try {
        await step(job, controller.signal);
      } catch (err) {
        // Out of time for this step: nothing was lost, the app simply asks for the same step again.
        if (err && err.name === 'AbortError') {
          job.timeouts = (job.timeouts || 0) + 1;
          if (job.timeouts > 4) return res.status(504).json({ error: 'timeout' });
          await writeJson(JOBS + job.id + '.json', job);
          return res.status(200).json({ done: false, job: job.id, chars: assemble(job.turns).text.length, retry: true });
        }
        throw err;
      }
    }

    if (!job.done) {
      await writeJson(JOBS + job.id + '.json', job);
      return res.status(200).json({ done: false, job: job.id, chars: assemble(job.turns).text.length, steps: job.steps });
    }

    const out = finish(job);
    if (!out.text) return res.status(502).json({ error: 'empty_answer', detail: 'Claude returned no findings text' });
    try { const { blobs } = await list({ prefix: JOBS + job.id }); if (blobs.length) await del(blobs.map((b) => b.url)); } catch {}
    return res.status(200).json(out);
  } catch (err) {
    if (err && err.status === 401) return res.status(500).json({ error: 'bad_api_key', detail: 'ANTHROPIC_API_KEY was rejected' });
    return fail(res, err);
  } finally {
    clearTimeout(timer);
  }
}
