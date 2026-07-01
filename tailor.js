// tailor.js — Tailor your resume for a specific job description.
// Calls Ollama (glm-5.2:cloud) to rewrite summary + bullets + skills,
// then renders through the master HTML template and produces PDF.
//
// Usage:
//   node tailor.js --jd "path/to/job-description.txt" [--company "X" --title "Y"]
//   node tailor.js --url "https://linkedin.com/jobs/view/..." [--company "X" --title "Y"]
//   node tailor.js --text "paste JD text" [--company "X" --title "Y"]

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const ROOT = __dirname;
// Load resume name from applicant-profile.json, fallback to example.json
const PROFILE_PATH = path.join(ROOT, 'applicant-profile.json');
const PROFILE_DATA = fs.existsSync(PROFILE_PATH) ? JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf-8')) : {};
const RESUME_NAME = PROFILE_DATA.activeResume || 'example';
const MASTER = JSON.parse(fs.readFileSync(path.join(ROOT, 'master-resumes', RESUME_NAME + '.json'), 'utf-8'));
const OLLAMA_URL = 'http://localhost:11434/api/generate';
const MODEL = 'gemma3:latest';

// ── CLI ──
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { jdFile: null, url: null, text: null, company: 'Unknown Company', title: 'Unknown Role' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--jd' && args[i+1]) opts.jdFile = args[++i];
    else if (args[i] === '--url' && args[i+1]) opts.url = args[++i];
    else if (args[i] === '--text' && args[i+1]) opts.text = args[++i];
    else if (args[i] === '--company' && args[i+1]) opts.company = args[++i];
    else if (args[i] === '--title' && args[i+1]) opts.title = args[++i];
  }
  if (!opts.jdFile && !opts.url && !opts.text) {
    console.error('Usage: node tailor.js --jd <file> | --url <url> | --text "JD" [--company "X" --title "Y"]');
    process.exit(1);
  }
  return opts;
}

// ── Fetch JD from URL ──
async function fetchJobFromUrl(url) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    const title = await page.$eval('h1', el => el.textContent.trim()).catch(() => '');
    const bodyText = await page.evaluate(() => {
      const el = document.querySelector('[class*="job"], [class*="description"], main, article') || document.body;
      return el ? el.innerText : document.body.innerText;
    });
    return { title, text: bodyText.slice(0, 8000) };
  } finally {
    await browser.close();
  }
}

// ── Call Ollama ──
async function callOllama(prompt) {
  const body = JSON.stringify({
    model: MODEL,
    prompt,
    stream: false,
    options: { temperature: 0.6, num_predict: 4096, num_ctx: 8192 }
  });
  return new Promise((resolve, reject) => {
    const req = http.request(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 300000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Ollama parse error: ' + data.slice(0, 500))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama timeout (300s)')); });
    req.write(body);
    req.end();
  });
}

// ── Build prompt — only ask for rewritten bullets/summary/skills/title ──
function buildPrompt(master, jobTitle, companyName, jdText) {
  const workHistoryStr = master.workHistory.map((w, i) =>
    `JOB ${i+1}: ${w.title} | ${w.company} | ${w.dates}\n  ${w.bullets.replace(/\n/g, ' ')}`
  ).join('\n\n');

  return `You are a resume tailoring assistant. Rewrite the resume content to match the target job. Output ONLY a valid JSON object — no markdown, no code fences, no explanation.

JSON schema:
{"title":"tailored headline","summary":"2-3 sentence summary","bullets":["bullets for job 1 (newline-separated)","bullets for job 2","bullets for job 3"],"skills":["skill1","skill2","..."]}

Target Job: ${jobTitle} at ${companyName}
Job Description: ${jdText.slice(0, 2000)}

Current Resume:
Name: ${master.name}
Title: ${master.title}
Skills: ${master.skills.join(', ')}

Work History:
${workHistoryStr}

Rules:
- Rewrite the summary to align with the target job
- Rewrite each job's bullets to emphasize relevance to the target job, but keep them truthful
- DO NOT include any numbers, metrics, percentages, dollar amounts, or quantified statistics anywhere in the resume — EXCEPT for dates (e.g. "Oct 2025", "2024", "3,000-5,000 viewers" is NOT allowed). No fabricated metrics. No "doubled revenue by 40%" or "closed $2M in deals". Only use qualitative descriptions.
- The bullets array must have exactly ${master.workHistory.length} strings, one per job, each containing 3-4 bullet points separated by newlines
- Reorder skills to put job-relevant first. Include ALL original skills. Add at most 1-2 new ones from the JD.
- Output ONLY the JSON`;
}

// ── Parse Ollama response with repair ──
function parseJSON(raw) {
  // Strip markdown wrappers
  let s = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  try { return JSON.parse(s); } catch (e) {}
  // Repair: close unclosed brackets/braces, remove trailing commas
  let openB = (s.match(/{/g) || []).length;
  let closeB = (s.match(/}/g) || []).length;
  let openBr = (s.match(/\[/g) || []).length;
  let closeBr = (s.match(/\]/g) || []).length;
  for (let i = 0; i < openBr - closeBr; i++) s += ']';
  for (let i = 0; i < openB - closeB; i++) s += '}';
  s = s.replace(/,\s*([\]}])/g, '$1');
  try { return JSON.parse(s); } catch (e2) { return null; }
}

// ── HTML template (clean professional resume style) ──
function renderHTML(tailored, master) {
  const skills = (tailored.skills || master.skills).map(s => `      <li>${s}</li>`).join('\n');
  const workHtml = master.workHistory.map((w, i) => {
    const bulletText = tailored.bullets && tailored.bullets[i] ? tailored.bullets[i] : w.bullets;
    const bulletLines = bulletText.split('\n').filter(b => b.trim()).map(b => `          <li>${b.trim().replace(/^[-*\u2022]\s*/, '')}</li>`).join('\n');
    return `        <div class="job">
          <div class="job-title">${w.title}</div>
          <div class="job-company">${w.company} \u2014 ${w.dates}</div>
          <ul class="job-bullets">
${bulletLines}
          </ul>
        </div>`;
  }).join('\n');

  const tools = master.tools.map(t => `      <li>${t}</li>`).join('\n');
  const extra = (master.extraSections || []).map(sec => {
    const items = sec.items.map(i => `          <li>${i}</li>`).join('\n');
    return `      <h3>${sec.title}</h3>\n      <ul class="extra-items">\n${items}\n      </ul>`;
  }).join('\n');

  const headline = tailored.title || master.title;
  const summary = tailored.summary || master.summary;
  const education = master.education;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${master.name} \u2014 Tailored Resume</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
  body { font-family: 'Inter', Arial, sans-serif; background: #dde3eb; display: flex; justify-content: center; padding: 36px 20px; }
  .resume { display: flex; width: 816px; min-height: 1056px; overflow: hidden; background: #ffffff; box-shadow: 0 10px 50px rgba(0,0,0,0.2); border-top: 5px solid #0076CE; }
  .left { width: 248px; min-width: 248px; background: #0D2137; padding: 22px 18px 8px; display: flex; flex-direction: column; }
  .left-name { font-size: 23px; font-weight: 800; color: #ffffff; letter-spacing: 1.5px; text-transform: uppercase; line-height: 1.2; }
  .left-role { font-size: 10.5px; font-weight: 600; color: #0076CE; letter-spacing: 2px; text-transform: uppercase; margin-top: 7px; }
  .left-divider { border: none; border-top: 1px solid rgba(255,255,255,0.1); margin: 14px 0; }
  .section-label { font-size: 9px; font-weight: 700; color: #0076CE; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 8px; }
  .contact-item { font-size: 9.5px; color: rgba(255,255,255,0.85); margin-bottom: 5px; line-height: 1.4; }
  .skills-list { list-style: none; }
  .skills-list li { font-size: 9.5px; color: rgba(255,255,255,0.85); margin-bottom: 5px; line-height: 1.3; padding-left: 10px; position: relative; }
  .skills-list li::before { content: '\\25AA'; position: absolute; left: 0; color: #0076CE; }
  .right { flex: 1; padding: 22px 24px; display: flex; flex-direction: column; }
  .summary { font-size: 10px; color: #333; line-height: 1.5; margin-bottom: 16px; }
  .section-header { font-size: 12px; font-weight: 700; color: #0D2137; text-transform: uppercase; letter-spacing: 1px; border-bottom: 2px solid #0076CE; padding-bottom: 4px; margin-bottom: 12px; }
  .job { margin-bottom: 14px; }
  .job-title { font-size: 11px; font-weight: 700; color: #0D2137; }
  .job-company { font-size: 9.5px; font-weight: 500; color: #555; margin-bottom: 5px; }
  .job-bullets { list-style: none; padding-left: 0; }
  .job-bullets li { font-size: 9.5px; color: #333; line-height: 1.4; margin-bottom: 4px; padding-left: 12px; position: relative; }
  .job-bullets li::before { content: '\\2022'; position: absolute; left: 0; color: #0076CE; }
  .extra-items { list-style: none; padding-left: 0; }
  .extra-items li { font-size: 9.5px; color: #333; line-height: 1.4; margin-bottom: 6px; padding-left: 12px; position: relative; }
  .extra-items li::before { content: '\\2022'; position: absolute; left: 0; color: #0076CE; }
  h3 { font-size: 11px; font-weight: 700; color: #0D2137; margin-bottom: 5px; }
  @media print { body { background: #fff; padding: 0; } .resume { box-shadow: none; border-top: none; } }
</style>
</head>
<body>
  <div class="resume">
    <div class="left">
      <div class="left-name">${master.name}</div>
      <div class="left-role">${headline}</div>
      <hr class="left-divider">
      <div class="section-label">Contact</div>
      <div class="contact-item">${master.phone}</div>
      <div class="contact-item">${master.email}</div>
      <div class="contact-item">${master.location}</div>
      <div class="contact-item">${master.linkedin}</div>
      <hr class="left-divider">
      <div class="section-label">Core Skills</div>
      <ul class="skills-list">
${skills}
      </ul>
      <hr class="left-divider">
      <div class="section-label">Technology</div>
      <ul class="skills-list">
${tools}
      </ul>
      <hr class="left-divider">
      <div class="section-label">Education</div>
      <div class="contact-item">${education}</div>
    </div>
    <div class="right">
      <div class="section-header">Professional Summary</div>
      <div class="summary">${summary}</div>
      <div class="section-header">Professional Experience</div>
${workHtml}
      <div class="section-header">Technology Fluency</div>
${extra}
    </div>
  </div>
</body>
</html>`;
}

// ── Main ──
async function main() {
  const opts = parseArgs();

  let jdText = opts.text || '';
  let jobTitle = opts.title;
  let companyName = opts.company;

  if (opts.jdFile) {
    jdText = fs.readFileSync(opts.jdFile, 'utf-8');
  } else if (opts.url) {
    console.log('Fetching job from ' + opts.url + '...');
    const fetched = await fetchJobFromUrl(opts.url);
    jdText = fetched.text;
    if (fetched.title && jobTitle === 'Unknown Role') jobTitle = fetched.title;
  }

  console.log('Job: ' + jobTitle + ' at ' + companyName);
  console.log('JD length: ' + jdText.length + ' chars');

  const prompt = buildPrompt(MASTER, jobTitle, companyName, jdText);
  console.log('Calling Ollama (' + MODEL + ')...');
  const result = await callOllama(prompt);

  let tailored = parseJSON(result.response || '');
  if (!tailored) {
    console.error('Failed to parse Ollama output');
    console.error('Raw: ' + (result.response || '').slice(0, 2000));
    process.exit(1);
  }
  console.log('Tailored content received');

  // Merge AI output with master structure
  const merged = {
    title: tailored.title || MASTER.title,
    summary: tailored.summary || MASTER.summary,
    bullets: tailored.bullets || [],
    skills: tailored.skills || MASTER.skills,
    workHistory: MASTER.workHistory.map((w, i) => ({
      ...w,
      bullets: tailored.bullets && tailored.bullets[i] ? tailored.bullets[i] : w.bullets,
    })),
  };

  // Output dir
  const dateStr = new Date().toISOString().slice(0, 10);
  const slug = companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const outDir = path.join(ROOT, 'output', dateStr + '-' + slug);
  fs.mkdirSync(outDir, { recursive: true });

  // Save JSON
  fs.writeFileSync(path.join(outDir, 'tailored.json'), JSON.stringify({
    tailored: merged, jobInfo: { title: jobTitle, company: companyName, jdText: jdText.slice(0, 5000) }
  }, null, 2));

  // Render HTML
  const html = renderHTML(merged, MASTER);
  const htmlPath = path.join(outDir, 'resume.html');
  fs.writeFileSync(htmlPath, html);

  // PDF via Playwright
  const pdfPath = path.join(outDir, 'resume.pdf');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('file:///' + htmlPath.replace(/\\/g, '/'), { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.pdf({ path: pdfPath, format: 'Letter', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  await browser.close();

  console.log('\n=== DONE ===');
  console.log('Output:  ' + outDir);
  console.log('JSON:    ' + path.join(outDir, 'tailored.json'));
  console.log('HTML:    ' + htmlPath);
  console.log('PDF:     ' + pdfPath);
}

main().catch(e => { console.error(e); process.exit(1); });
