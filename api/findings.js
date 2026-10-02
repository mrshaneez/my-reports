// Writes the "ފާހަގަކުރެވުނު ކަންކަން" (findings) section of an appeal report with Claude.
// Claude researches with web search, so every link returned is a page it actually retrieved.
// The author's previous judgments (see judgments.js) are given as style examples.
// Needs ANTHROPIC_API_KEY and ADMIN_PASSWORD. Optional: ANTHROPIC_MODEL, STYLE_CHARS, MAX_SEARCHES.
import { passwordOk, readBody, fail } from './_blob.js';
import { loadAll } from './judgments.js';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';
const STYLE_CHARS = Number(process.env.STYLE_CHARS || 120_000);
const MAX_SEARCHES = Number(process.env.MAX_SEARCHES || 10);
const DEADLINE_MS = 285_000;

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

// Turn Claude's final text blocks into plain text with [n] markers, plus a numbered list of the cited pages.
export function assemble(blocks) {
  let lastSearch = -1;
  blocks.forEach((b, i) => { if (b.type === 'web_search_tool_result') lastSearch = i; });
  const finalBlocks = blocks.slice(lastSearch + 1).filter((b) => b.type === 'text');
  const refs = [];
  const index = new Map();
  let text = '';
  for (const b of finalBlocks) {
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
  return { text: text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), refs };
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
    const caseText = String(body.caseText || '').trim();
    if (!caseText) return res.status(400).json({ error: 'empty_case' });

    let judgments = [];
    try { judgments = await loadAll(); } catch (e) { console.error('Could not load judgments', e); }
    const style = styleBlock(judgments);

    const system = [{ type: 'text', text: RULES }];
    if (style) system.push({ type: 'text', text: style, cache_control: { type: 'ephemeral' } });

    let user = `The case (as entered in the report form):\n\n${caseText}\n\n`;
    user += body.view ? `The author's own view and the points to include:\n\n${String(body.view)}\n\n` : `The author has not given a view; analyse the case on its merits.\n\n`;
    if (body.instructions) user += `The author's standing instructions on style and positions:\n\n${String(body.instructions)}\n\n`;
    user += 'Write the findings section now, following the rules.';

    const request = {
      model: MODEL,
      max_tokens: 16000,
      system,
      tools: [{
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: MAX_SEARCHES,
        user_location: { type: 'approximate', timezone: 'Indian/Maldives' },
      }],
      messages: [{ role: 'user', content: user }],
    };

    const all = [];
    let searches = 0;
    for (let turn = 0; turn < 6; turn++) {
      const r = await callClaude(request, controller.signal);
      all.push(...(r.content || []));
      searches += (r.usage && r.usage.server_tool_use && r.usage.server_tool_use.web_search_requests) || 0;
      if (r.stop_reason !== 'pause_turn') break;
      request.messages = [...request.messages, { role: 'assistant', content: r.content }];
    }

    const { text, refs } = assemble(all);
    if (!text) return res.status(502).json({ error: 'empty_answer', detail: 'Claude returned no findings text' });
    return res.status(200).json({ text, refs, model: MODEL, searches, styleJudgments: judgments.length });
  } catch (err) {
    if (err && err.name === 'AbortError') return res.status(504).json({ error: 'timeout' });
    if (err && err.status === 401) return res.status(500).json({ error: 'bad_api_key', detail: 'ANTHROPIC_API_KEY was rejected' });
    return fail(res, err);
  } finally {
    clearTimeout(timer);
  }
}
