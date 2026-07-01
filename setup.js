#!/usr/bin/env node
// setup.js — Guided first-run setup for job-auto-apply.
//
// Walks you through everything that's unique to YOUR machine and accounts:
//   1. Detects your CPU / RAM / GPU and recommends local models that fit
//   2. Writes config.json so tailor.js + apply.js use YOUR models (no code edits)
//   3. Gets you logged into LinkedIn (and optionally Indeed)
//   4. Sets up email verification credentials
//   5. Validates your profile + master resume, lists anything missing
//
// Run it with: node setup.js   (interactive — run in your own terminal)

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync, spawnSync } = require('child_process');
const readline = require('readline');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const PROFILE_PATH = path.join(ROOT, 'applicant-profile.json');
let OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

// ── prompt helpers ──
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(r => rl.question(q, a => r(a.trim())));
async function askDefault(q, def) { const a = await ask(`  ${q} [${def}]: `); return a || def; }
async function askYN(q, def = true) {
  const a = (await ask(`  ${q} ${def ? '[Y/n]' : '[y/N]'}: `)).toLowerCase();
  return a ? a[0] === 'y' : def;
}
function hr(title) { console.log('\n' + '═'.repeat(64)); if (title) console.log('  ' + title); if (title) console.log('─'.repeat(64)); }
function line(t) { console.log('  ' + t); }

// ── hardware detection ──
function detectHardware() {
  const ramGB = Math.round(os.totalmem() / 1e9);
  const cpus = os.cpus() || [];
  const cores = cpus.length;
  const cpuModel = ((cpus[0] && cpus[0].model) || 'unknown').replace(/\s+/g, ' ').trim();
  let gpu = null;
  // NVIDIA (most reliable for VRAM)
  try {
    const out = execSync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits',
      { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (out) { const [name, vram] = out.split(',').map(s => s.trim()); gpu = { name, vramGB: Math.round(parseInt(vram) / 1024) }; }
  } catch {}
  // Windows fallback — name only (no VRAM tier)
  if (!gpu && process.platform === 'win32') {
    try {
      const out = execSync('wmic path win32_VideoController get name', { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      const name = out.split('\n').map(s => s.trim()).filter(s => s && s !== 'Name')[0];
      if (name) gpu = { name, vramGB: 0 };
    } catch {}
  }
  return { ramGB, cores, cpuModel, gpu };
}

// ── ollama ──
function ollamaGet(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get(OLLAMA_URL + pathname, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}
async function getOllamaModels() {
  try {
    const j = await ollamaGet('/api/tags');
    return (j.models || []).map(m => ({
      name: m.name,
      sizeGB: +(m.size / 1e9).toFixed(1),
      params: (m.details && m.details.parameter_size) || '',
    }));
  } catch { return null; } // null = Ollama not reachable
}

// ── model recommendation matched to hardware ──
function recommend(hw, models) {
  const local = models.filter(m => m.sizeGB > 0); // exclude cloud models (size 0)
  if (!local.length) return { tailor: '', answer: '', note: 'no local models installed' };
  const gpuStrong = hw.gpu && hw.gpu.vramGB >= 8;
  const effGB = gpuStrong ? hw.gpu.vramGB : hw.ramGB;
  const bySize = [...local].sort((a, b) => a.sizeGB - b.sizeGB);

  // Tailor = quality. Largest local model that fits a ~70% memory budget.
  const budget = Math.max(2, effGB * 0.7);
  const tailorPick = local.filter(m => m.sizeGB <= budget).sort((a, b) => b.sizeGB - a.sizeGB)[0]
    || bySize[0]; // if nothing "fits", take the smallest so it at least runs
  // Answer = speed. Smallest small model; prefer a known-fast one.
  const answerPick = bySize.find(m => /qwen2?\.?5?.*1\.5|:1\.5b|:1b|:3b|phi/i.test(m.name)) || bySize[0];

  const tier = gpuStrong ? `GPU ${hw.gpu.vramGB}GB` : (effGB >= 32 ? 'high RAM' : effGB >= 16 ? 'moderate RAM' : 'light RAM');
  return { tailor: tailorPick.name, answer: answerPick.name, effGB, tier, gpuStrong };
}

// ── profile validation (the Step 3.5 gate, runnable) ──
function validateProfile() {
  if (!fs.existsSync(PROFILE_PATH)) return { exists: false, missing: [] };
  const p = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf-8'));
  const miss = [];
  const empty = v => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
  const chk = (o, f, label) => { if (!o || empty(o[f])) miss.push(label); };
  const bool = (o, f, label) => { if (!o || typeof o[f] !== 'boolean') miss.push(label + ' (true/false)'); };
  const id = p.identity || {}, wa = p.workAuthorization || {}, eeo = p.eeo || {}, sc = p.screening || {},
    jp = p.jobPreferences || {}, ap = p.application || {}, an = p.answers || {}, ac = p.accountCredentials || {}, ec = p.emailCredentials || {};
  ['firstName', 'lastName', 'email', 'phone', 'location', 'linkedinUrl', 'country', 'address1', 'city', 'state', 'postalCode', 'phoneDeviceType', 'phoneCountryCode'].forEach(f => chk(id, f, 'identity.' + f));
  ['authorizedToWorkInUS', 'requiresSponsorship', 'willingToRelocate', 'willingToTravel'].forEach(f => bool(wa, f, 'workAuthorization.' + f));
  ['gender', 'race', 'veteran', 'disability'].forEach(f => chk(eeo, f, 'eeo.' + f));
  ['howDidYouHear'].forEach(f => chk(sc, f, 'screening.' + f));
  ['felonyConviction', 'terminated', 'previouslyWorked'].forEach(f => bool(sc, f, 'screening.' + f));
  ['roles', 'employmentTypes', 'workMode', 'locations', 'compensationType'].forEach(f => chk(jp, f, 'jobPreferences.' + f));
  ['minSalary', 'experienceYears'].forEach(f => { if (!(jp[f] > 0)) miss.push('jobPreferences.' + f + ' (>0)'); });
  if (empty(jp.salaryExpectation)) miss.push('jobPreferences.salaryExpectation');
  ['employmentType', 'workMode', 'degree', 'experienceDescription', 'shift', 'timezone', 'startDate', 'references'].forEach(f => chk(ap, f, 'application.' + f));
  if (empty(ap.languages)) miss.push('application.languages');
  ['Why this company?', 'Why this role?', 'Tell me about yourself', 'What are your salary expectations?', 'When can you start?'].forEach(f => chk(an, f, 'answers["' + f + '"]'));
  ['email', 'password'].forEach(f => chk(ac, f, 'accountCredentials.' + f));
  ['email', 'appPassword'].forEach(f => chk(ec, f, 'emailCredentials.' + f));
  return { exists: true, missing: miss, profile: p };
}

// ── main ──
async function main() {
  const checkOnly = process.argv.includes('--check'); // non-interactive: print hardware + model recommendation, exit
  if (!checkOnly) console.clear();
  hr('JOB AUTO-APPLY — GUIDED SETUP');
  line('This configures the tool for YOUR machine and YOUR accounts.');
  line('Pipeline: search jobs → tailor a resume per job (local AI) → auto-apply.');
  line('Everything runs on your computer. Nothing is sent to a cloud model.');

  const existing = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) : {};
  const config = { ollamaUrl: OLLAMA_URL, tailorModel: '', answerModel: '', ...existing };

  // ── STEP 1: Ollama + hardware + models ──
  hr('STEP 1 of 4  ·  Local AI model (matched to your hardware)');
  const hw = detectHardware();
  line(`CPU:  ${hw.cpuModel} (${hw.cores} cores)`);
  line(`RAM:  ${hw.ramGB} GB`);
  line(`GPU:  ${hw.gpu ? hw.gpu.name + (hw.gpu.vramGB ? ` (${hw.gpu.vramGB} GB VRAM)` : ' (VRAM unknown)') : 'none detected — models run on CPU'}`);

  OLLAMA_URL = checkOnly ? (config.ollamaUrl || OLLAMA_URL) : await askDefault('Ollama URL', config.ollamaUrl || 'http://localhost:11434');
  config.ollamaUrl = OLLAMA_URL;

  let models = await getOllamaModels();
  if (checkOnly) {
    const rec = models && models.length ? recommend(hw, models) : null;
    console.log('');
    line('Installed models: ' + (models && models.length ? models.map(m => m.name).join(', ') : '(none / Ollama offline)'));
    if (rec) {
      line(`Recommended tailor model: ${rec.tailor}  (tier: ${rec.tier})`);
      line(`Recommended answer model: ${rec.answer}`);
    }
    rl.close();
    return;
  }
  if (models === null) {
    console.log('');
    line('⚠ Ollama is not reachable at ' + OLLAMA_URL);
    line('  Install it from https://ollama.com/download, then in a separate terminal run:');
    line('     ollama serve');
    line('  Then pull a couple of models, e.g.:');
    line('     ollama pull qwen2.5:1.5b     (fast — for screening answers)');
    line('     ollama pull gemma3            (quality — for tailoring)');
    const retry = await askYN('Retry connection now?', true);
    if (retry) models = await getOllamaModels();
  }

  if (models && models.length) {
    console.log('');
    line('Installed models:');
    models.forEach(m => line(`   • ${m.name}  (${m.sizeGB > 0 ? m.sizeGB + ' GB' : 'cloud'}${m.params ? ', ' + m.params : ''})`));
    const rec = recommend(hw, models);
    console.log('');
    line(`Recommendation for your ${rec.tier || 'system'}:`);
    line(`   Tailoring model (quality): ${rec.tailor || '(none fit — install a larger model)'}`);
    line(`   Answering model (speed):   ${rec.answer || '(none — install qwen2.5:1.5b)'}`);
    console.log('');
    config.tailorModel = await askDefault('Use which model for resume tailoring?', config.tailorModel || rec.tailor);
    config.answerModel = await askDefault('Use which model for screening answers?', config.answerModel || rec.answer || rec.tailor);
  } else {
    line('No models available — using defaults; pull them before running the pipeline.');
    config.tailorModel = config.tailorModel || 'gemma3';
    config.answerModel = config.answerModel || 'qwen2.5:1.5b';
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    ollamaUrl: config.ollamaUrl, tailorModel: config.tailorModel, answerModel: config.answerModel,
  }, null, 2));
  line('✓ Saved config.json');

  // ── STEP 2: LinkedIn / accounts ──
  hr('STEP 2 of 4  ·  Job board accounts (yours)');
  const liCookies = path.join(ROOT, 'profiles', 'linkedin', 'session-cookies.json');
  const liLoggedIn = fs.existsSync(liCookies);
  line(`LinkedIn: ${liLoggedIn ? '✓ session saved' : '✗ not logged in'}`);
  if (!liLoggedIn || await askYN('Log into LinkedIn now (opens a browser)?', !liLoggedIn)) {
    line('Launching login — sign in, solve any checkpoint, then it saves your session…');
    rl.pause();
    spawnSync('node', [path.join(ROOT, 'login.js'), '--board', 'linkedin'], { stdio: 'inherit' });
    rl.resume();
  }
  if (await askYN('Also set up Indeed? (optional)', false)) {
    rl.pause();
    spawnSync('node', [path.join(ROOT, 'login.js'), '--board', 'indeed'], { stdio: 'inherit' });
    rl.resume();
  }

  // ── STEP 3: Email verification creds ──
  hr('STEP 3 of 4  ·  Email verification (for external career sites)');
  const v = validateProfile();
  const hasEmailCreds = v.exists && v.profile.emailCredentials && v.profile.emailCredentials.appPassword;
  line(`Auto email verification: ${hasEmailCreds ? '✓ configured' : '✗ not configured (external Workday/Greenhouse sites may need manual code entry)'}`);
  if (!hasEmailCreds) {
    line('  To enable: add a Gmail App Password to applicant-profile.json → emailCredentials.');
    line('  Create one at https://myaccount.google.com/apppasswords (needs 2-step verification).');
    line('  This lets the tool read the verification email and finish account creation itself.');
  }

  // ── STEP 4: Profile + resume validation ──
  hr('STEP 4 of 4  ·  Your profile & resume');
  if (!v.exists) {
    line('✗ No applicant-profile.json yet.');
    if (await askYN('Create it from the template now?', true)) {
      fs.copyFileSync(path.join(ROOT, 'applicant-profile.example.json'), PROFILE_PATH);
      line('✓ Created applicant-profile.json — fill it in (identity, work auth, answers, job preferences).');
      line('  An assistant can walk you through the questionnaire, or edit the file directly.');
    }
  } else if (v.missing.length === 0) {
    line('✓ Profile complete — all required fields present.');
  } else {
    line(`✗ Profile is missing ${v.missing.length} required field(s):`);
    v.missing.slice(0, 40).forEach(m => line('     - ' + m));
    line('  Fill these in applicant-profile.json before applying.');
  }
  const activeResume = v.exists ? v.profile.activeResume : null;
  const resumePath = activeResume ? path.join(ROOT, 'master-resumes', activeResume + '.json') : null;
  line(`Master resume: ${resumePath && fs.existsSync(resumePath) ? '✓ ' + activeResume + '.json' : '✗ missing — create master-resumes/<name>.json from the template'}`);

  // ── Summary ──
  hr('SETUP COMPLETE');
  line(`Models:   tailor=${config.tailorModel}  answer=${config.answerModel}`);
  line(`LinkedIn: ${fs.existsSync(liCookies) ? 'ready' : 'not logged in'}`);
  line(`Profile:  ${!v.exists ? 'created (needs filling)' : v.missing.length ? v.missing.length + ' fields missing' : 'complete'}`);
  console.log('');
  line('Next:');
  line('  1. node search.js --titles "account executive,sdr" --locations "remote,nashville"');
  line('  2. node apply.js --board linkedin --url <job-url>   (auto-tailors + applies)');
  console.log('');
  rl.close();
}

main().catch(e => { console.error(e); rl.close(); process.exit(1); });
