#!/usr/bin/env node
// build-master.js — Build ONE comprehensive "master resource" resume from the resume(s)
// a person provides. This is the superset that tailor.js pulls from: every job, every
// bullet, every skill/tool/cert/achievement — nothing trimmed. The richer this file, the
// better each tailored resume, because tailor.js selects the most relevant slice per job.
//
// Usage:
//   node build-master.js --input resume1.txt,resume2.pdf.txt --name christian
//   node build-master.js --text "paste full resume text" --name christian
//   node build-master.js --input newroles.txt --name christian --merge   # merge into existing master
//   add --set-active to also point applicant-profile.json at this master
//
// Uses the local tailorModel from config.json (quality matters; this runs once).

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = __dirname;
const CFG = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8')); } catch { return {}; } })();
const OLLAMA_BASE = (CFG.ollamaUrl || 'http://localhost:11434').replace(/\/+$/, '');
const MODEL = CFG.tailorModel || 'gemma3';

// ── CLI ──
function parseArgs() {
  const a = process.argv.slice(2);
  const o = { inputs: [], text: null, name: null, merge: false, setActive: false };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--input' && a[i + 1]) o.inputs = a[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a[i] === '--text' && a[i + 1]) o.text = a[++i];
    else if (a[i] === '--name' && a[i + 1]) o.name = a[++i];
    else if (a[i] === '--merge') o.merge = true;
    else if (a[i] === '--set-active') o.setActive = true;
  }
  if ((!o.inputs.length && !o.text) || !o.name) {
    console.error('Usage: node build-master.js --name <slug> (--input f1,f2 | --text "resume") [--merge] [--set-active]');
    process.exit(1);
  }
  return o;
}

// ── Ollama ──
function callOllama(prompt) {
  const body = JSON.stringify({ model: MODEL, prompt, stream: false, options: { temperature: 0.2, num_predict: 4096, num_ctx: 8192 } });
  return new Promise((resolve, reject) => {
    const req = http.request(OLLAMA_BASE + '/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 300000,
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d).response || ''); } catch (e) { reject(e); } }); });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama timeout (300s)')); });
    req.write(body); req.end();
  });
}

// Escape raw newlines inside JSON strings (local models emit them) — same fix as tailor.js.
function escapeCtrl(s) {
  let out = '', inStr = false, esc = false;
  for (const ch of s) {
    if (esc) { out += ch; esc = false; continue; }
    if (ch === '\\') { out += ch; esc = true; continue; }
    if (ch === '"') { inStr = !inStr; out += ch; continue; }
    if (inStr && (ch === '\n' || ch === '\r' || ch === '\t')) { out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : '\\t'; continue; }
    out += ch;
  }
  return out;
}
function parseJSON(raw) {
  let s = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i > 0 || j < s.length - 1) s = s.slice(Math.max(0, i), j + 1);
  try { return JSON.parse(s); } catch {}
  s = escapeCtrl(s);
  try { return JSON.parse(s); } catch {}
  const ob = (s.match(/{/g) || []).length, cb = (s.match(/}/g) || []).length, obr = (s.match(/\[/g) || []).length, cbr = (s.match(/\]/g) || []).length;
  for (let k = 0; k < obr - cbr; k++) s += ']';
  for (let k = 0; k < ob - cb; k++) s += '}';
  s = s.replace(/,\s*([\]}])/g, '$1');
  try { return JSON.parse(s); } catch { return null; }
}

// ── Extract ONE resume into comprehensive structured JSON ──
async function extractResume(text, idx) {
  const prompt = `Extract EVERYTHING from this resume into a single JSON object. Do NOT summarize, shorten, merge, or omit anything — capture every job, every bullet point, every skill, tool, certification, and accomplishment exactly. This is an archive, so completeness matters more than brevity.

JSON schema (output ONLY this object, no markdown, no commentary):
{"name":"","title":"","email":"","phone":"","linkedin":"","location":"","summary":"","skills":[],"tools":[],"education":"","languages":[],"certifications":[],"workHistory":[{"title":"","company":"","location":"","dates":"","bullets":[]}],"projects":[],"achievements":[]}

Rules:
- workHistory: one entry per job, in the order shown. "bullets" is an ARRAY with EVERY bullet/line for that job — do not drop any.
- skills/tools: list every distinct one mentioned anywhere.
- certifications/projects/achievements: arrays of short strings; empty array if none.
- Keep wording faithful to the resume. Do not invent facts.
- Output ONLY the JSON.

RESUME${idx != null ? ' #' + (idx + 1) : ''}:
${text.slice(0, 7000)}`;

  console.log(`  Extracting resume${idx != null ? ' #' + (idx + 1) : ''} (${text.length} chars) with ${MODEL}...`);
  const raw = await callOllama(prompt);
  const parsed = parseJSON(raw);
  if (!parsed) { console.error('  ! Failed to parse extraction; skipping this resume.'); return null; }
  return parsed;
}

// ── Merge helpers (union, dedup) ──
const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
function uniqStrings(...lists) {
  const seen = new Set(), out = [];
  for (const list of lists) for (const item of (list || [])) {
    const s = typeof item === 'string' ? item.trim() : JSON.stringify(item);
    if (s && !seen.has(norm(s))) { seen.add(norm(s)); out.push(s); }
  }
  return out;
}
function mergeJobs(...jobLists) {
  const byKey = new Map();
  for (const jobs of jobLists) for (const j of (jobs || [])) {
    const key = norm(j.company) + '|' + norm(j.title);
    const cur = byKey.get(key);
    const bullets = Array.isArray(j.bullets) ? j.bullets : String(j.bullets || '').split('\n');
    if (!cur) byKey.set(key, { title: j.title || '', company: j.company || '', location: j.location || '', dates: j.dates || '', bullets: uniqStrings(bullets) });
    else { cur.bullets = uniqStrings(cur.bullets, bullets); if (!cur.location && j.location) cur.location = j.location; if (!cur.dates && j.dates) cur.dates = j.dates; }
  }
  return [...byKey.values()];
}

// Merge N extractions (+ optional existing master) into one comprehensive master.
function mergeMasters(name, existing, extractions) {
  const all = [existing, ...extractions].filter(Boolean);
  const pick = f => { for (const m of all) if (m[f] && String(m[f]).trim()) return m[f]; return ''; };
  // longest summary wins (most complete)
  const summary = all.map(m => m.summary || '').sort((a, b) => b.length - a.length)[0] || '';
  const jobsMerged = mergeJobs(...all.map(m => (m.workHistory || []).map(j => ({
    ...j, bullets: Array.isArray(j.bullets) ? j.bullets : String(j.bullets || '').split('\n'),
  }))));
  // Existing extraSections (from a hand-authored master) are preserved.
  const extraSections = [];
  for (const m of all) for (const sec of (m.extraSections || [])) extraSections.push(sec);
  // Fold projects/certs/achievements into an extra section so they render + inform tailoring.
  const certs = uniqStrings(...all.map(m => m.certifications));
  const projects = uniqStrings(...all.map(m => m.projects));
  const achievements = uniqStrings(...all.map(m => m.achievements));
  if (certs.length) extraSections.push({ title: 'Certifications', items: certs });
  if (projects.length) extraSections.push({ title: 'Projects', items: projects });
  if (achievements.length) extraSections.push({ title: 'Achievements', items: achievements });

  return {
    id: name,
    name: pick('name'), title: pick('title'), email: pick('email'), phone: pick('phone'),
    linkedin: pick('linkedin'), location: pick('location'),
    skills: uniqStrings(...all.map(m => m.skills)),
    tools: uniqStrings(...all.map(m => m.tools)),
    education: pick('education'),
    languages: uniqStrings(...all.map(m => m.languages)),
    summary,
    // tailor.js expects bullets as a newline-joined string — join the pool here.
    workHistory: jobsMerged.map(j => ({ title: j.title, company: j.company, location: j.location, dates: j.dates, bullets: j.bullets.join('\n') })),
    extraSections,
  };
}

// ── main ──
async function main() {
  const o = parseArgs();
  const texts = [];
  for (const f of o.inputs) {
    if (!fs.existsSync(f)) { console.error('  ! Input not found: ' + f); continue; }
    texts.push(fs.readFileSync(f, 'utf-8'));
  }
  if (o.text) texts.push(o.text);
  if (!texts.length) { console.error('No readable resume inputs.'); process.exit(1); }

  console.log(`\n=== BUILD MASTER RESUME: ${o.name} ===`);
  console.log(`Inputs: ${texts.length} resume(s) | Model: ${MODEL}\n`);

  const extractions = [];
  for (let i = 0; i < texts.length; i++) {
    const e = await extractResume(texts[i], texts.length > 1 ? i : null);
    if (e) extractions.push(e);
  }
  if (!extractions.length) { console.error('Nothing extracted. Aborting.'); process.exit(1); }

  const masterPath = path.join(ROOT, 'master-resumes', o.name + '.json');
  let existing = null;
  if (o.merge && fs.existsSync(masterPath)) { existing = JSON.parse(fs.readFileSync(masterPath, 'utf-8')); console.log('  Merging into existing master...'); }

  const master = mergeMasters(o.name, existing, extractions);
  fs.mkdirSync(path.dirname(masterPath), { recursive: true });
  fs.writeFileSync(masterPath, JSON.stringify(master, null, 2));

  const bulletCount = master.workHistory.reduce((n, j) => n + j.bullets.split('\n').filter(Boolean).length, 0);
  console.log(`\n=== DONE ===`);
  console.log(`Master:  ${masterPath}`);
  console.log(`Jobs:    ${master.workHistory.length} | Bullets: ${bulletCount} | Skills: ${master.skills.length} | Tools: ${master.tools.length}`);
  console.log(`Extra sections: ${master.extraSections.map(s => s.title).join(', ') || 'none'}`);

  if (o.setActive) {
    const pp = path.join(ROOT, 'applicant-profile.json');
    if (fs.existsSync(pp)) {
      const p = JSON.parse(fs.readFileSync(pp, 'utf-8'));
      p.activeResume = o.name;
      fs.writeFileSync(pp, JSON.stringify(p, null, 2));
      console.log(`Set activeResume = "${o.name}" in applicant-profile.json`);
    }
  }
  console.log(`\nTailor from it: node tailor.js --url <job-url>   (pulls the relevant slice per job)`);
}

// ponytail: runnable check for the merge logic (no model needed)
if (require.main === module && process.argv[2] === '--selftest') {
  const m = mergeMasters('t',
    { workHistory: [{ title: 'AE', company: 'X', bullets: ['closed deals', 'hit quota'] }], skills: ['Sales', 'CRM'] },
    [{ workHistory: [{ title: 'AE', company: 'X', bullets: ['hit quota', 'built pipeline'] }], skills: ['crm', 'SaaS'] }]);
  const job = m.workHistory[0];
  const bullets = job.bullets.split('\n');
  if (m.workHistory.length !== 1) throw new Error('selftest FAIL: jobs not deduped');
  if (bullets.length !== 3) throw new Error('selftest FAIL: bullets not unioned/deduped -> ' + JSON.stringify(bullets));
  if (m.skills.length !== 3) throw new Error('selftest FAIL: skills not deduped (Sales/CRM/SaaS) -> ' + JSON.stringify(m.skills));
  console.log('build-master selftest OK: 1 job, 3 bullets, 3 skills'); process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
