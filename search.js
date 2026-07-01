// search.js — Search LinkedIn and Indeed for jobs matching user preferences,
// score each against your resume, and output a ranked list.
//
// Usage:
//   node search.js --portals "linkedin,indeed" --fields "technology,saas,cloud" --titles "account executive,sdr,bdr" --locations "remote,nashville" --max 50
//
// Requires login profiles to exist (run login.js first for each portal).

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
// Load resume from applicant-profile.json, fallback to example.json
const PROFILE_PATH = path.join(ROOT, 'applicant-profile.json');
const PROFILE_DATA = fs.existsSync(PROFILE_PATH) ? JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf-8')) : {};
const RESUME_NAME = PROFILE_DATA.activeResume || 'example';
const MASTER = JSON.parse(fs.readFileSync(path.join(ROOT, 'master-resumes', RESUME_NAME + '.json'), 'utf-8'));
const PROFILE = JSON.parse(fs.readFileSync(path.join(ROOT, 'applicant-profile.json'), 'utf-8'));

// ── CLI ──
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { portals: 'linkedin,indeed', fields: '', titles: '', locations: 'remote', max: 50, minScore: 30 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--portals' && args[i+1]) opts.portals = args[++i];
    else if (args[i] === '--fields' && args[i+1]) opts.fields = args[++i];
    else if (args[i] === '--titles' && args[i+1]) opts.titles = args[++i];
    else if (args[i] === '--locations' && args[i+1]) opts.locations = args[++i];
    else if (args[i] === '--max' && args[i+1]) opts.max = parseInt(args[++i]);
    else if (args[i] === '--min-score' && args[i+1]) opts.minScore = parseInt(args[++i]);
  }
  return opts;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Keyword extraction (same as fit-score.js) ──
function extractKeywords(text) {
  const stopWords = new Set(['the','a','an','and','or','but','in','on','at','to','for','of','with','by','from','as','is','are','was','were','be','been','being','have','has','had','do','does','did','will','would','could','should','may','might','must','can','this','that','these','those','i','you','he','she','it','we','they','what','which','who','when','where','why','how','all','each','every','both','few','more','most','other','some','such','no','nor','not','only','own','same','so','than','too','very','just','also','about','if','then','else','our','your','their','its','my','me','us','them','him','her','get','got','make','made','go','going','new','one','two','per','via','etc','including','within','across','through','during','before','after','above','below','up','down','out','over','under','again','further','here','there','now','job','role','position','work','working','team','teams','company','companies','candidate','candidates','employee','employees','year','years','experience','required','preferred','qualifications','responsibilities','requirements','plus','strong','ability','must','excellent','great','good','skills','looking','seeking','join','help','build','using','able']);
  const words = text.toLowerCase().replace(/[^a-z0-9\s+#.]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));
  const phrases = [];
  for (let i = 0; i < words.length - 1; i++) {
    if (!stopWords.has(words[i]) && !stopWords.has(words[i+1])) phrases.push(words[i] + ' ' + words[i+1]);
  }
  const freq = {};
  for (const w of [...words, ...phrases]) freq[w] = (freq[w] || 0) + 1;
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).map(([word, count]) => ({ word, count }));
}

function scoreFit(jdText) {
  const jdKeywords = extractKeywords(jdText);
  const resumeText = JSON.stringify(MASTER).toLowerCase();
  const resumeKeywords = extractKeywords(resumeText);
  const jdWords = new Set(jdKeywords.map(k => k.word));
  const resumeWords = new Set(resumeKeywords.map(k => k.word));
  const overlap = [...jdWords].filter(w => resumeWords.has(w));
  const skillsLower = MASTER.skills.map(s => s.toLowerCase());
  const toolsLower = (MASTER.tools || []).map(t => t.toLowerCase());
  const allResumeSkills = [...skillsLower, ...toolsLower];
  const skillMatches = [];
  for (const kw of jdKeywords.slice(0, 50)) {
    for (const skill of allResumeSkills) {
      if (skill.includes(kw.word) || kw.word.includes(skill.split(':')[0].trim())) {
        if (!skillMatches.includes(skill)) skillMatches.push(skill);
      }
    }
  }
  const roleKeywords = ['sales','account','executive','business','development','representative','sdr','bdr','ae','inside','field','technology','saas','cloud','infrastructure'];
  const jdLower = jdText.toLowerCase();
  const roleMatches = roleKeywords.filter(k => jdLower.includes(k));
  const keywordScore = Math.min(overlap.length / 15 * 40, 40);
  const skillScore = Math.min(skillMatches.length / 5 * 25, 25);
  const roleScore = Math.min(roleMatches.length / 4 * 35, 35);
  return Math.round(keywordScore + skillScore + roleScore);
}

// ── LinkedIn Search ──
async function searchLinkedIn(context, keywords, location, maxResults) {
  const jobs = [];
  const page = await context.newPage();

  // Build search URL
  const searchUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(keywords)}&location=${encodeURIComponent(location)}&f_AL=true`;

  console.log('  [LinkedIn] Searching: ' + keywords + ' in ' + location);
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await delay(3000);

  // Check if logged in
  const loginCheck = await page.$('input[name="session_key"], .sign-in-form, .authwall');
  if (loginCheck) {
    console.log('  [LinkedIn] NOT LOGGED IN. Run: node login.js --board linkedin');
    await page.close();
    return jobs;
  }

  // Scroll to load more results
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 1000));
    await delay(2000);
  }

  // Extract job listings
  const listings = await page.$$eval('.jobs-search__results-list li, .job-card-container, [data-job-id]', els => {
    return els.map(el => {
      // ponytail: LinkedIn migrated from h3/.job-search-card__* to artdeco-entity-lockup classes
      const titleEl = el.querySelector('.artdeco-entity-lockup__title strong, .artdeco-entity-lockup__title a, a.job-card-container__link strong, h3 a, h3');
      const companyEl = el.querySelector('.artdeco-entity-lockup__subtitle span:not(.visually-hidden), .job-card-container__company-name, h4 a, h4');
      const locationEl = el.querySelector('.artdeco-entity-lockup__caption, .job-card-container__metadata-item, ul.job-card-container__metadata-wrapper li:first-child span');
      const linkEl = el.querySelector('a.job-card-container__link, a[href*="/jobs/view/"]');
      // ponytail: data-job-id is always present; href is lazily set by JS and often empty
      // Also strip tracking params (they expire — pitfall 21)
      const jobId = el.getAttribute('data-job-id') || (el.querySelector('[data-job-id]') || {}).getAttribute?.('data-job-id') ||
        (linkEl && linkEl.href ? linkEl.href.match(/\/jobs\/view\/(\d+)/)?.[1] : null);

      // Check for Easy Apply indicator
      const easyApplyEl = el.querySelector('.job-search-card__easy-apply, [class*="easy-apply"]');

      return {
        title: titleEl ? titleEl.textContent.trim() : '',
        company: companyEl ? companyEl.textContent.trim() : '',
        location: locationEl ? locationEl.textContent.trim() : '',
        url: jobId ? 'https://www.linkedin.com/jobs/view/' + jobId + '/' : '',
        easyApply: !!easyApplyEl
      };
    }).filter(j => j.title && j.url);
  });

  console.log('  [LinkedIn] Found ' + listings.length + ' job listings');

  // For each listing, try to get the JD text for scoring
  for (let i = 0; i < Math.min(listings.length, maxResults); i++) {
    const job = listings[i];
    console.log('  [LinkedIn] (' + (i+1) + '/' + Math.min(listings.length, maxResults) + ') ' + job.company + ' — ' + job.title);

    let jdText = '';
    try {
      // Click the job to load its details in the side panel
      await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await delay(2000);

      // Extract JD text
      jdText = await page.evaluate(() => {
        const el = document.querySelector('.jobs-description__content, .jobs-box__html-content, [class*="job-view"], main, article') || document.body;
        return el ? el.innerText : '';
      });
    } catch (e) {
      console.log('    Could not load JD: ' + e.message.slice(0, 100));
    }

    const score = scoreFit(jdText || job.title + ' ' + job.company);
    jobs.push({
      ...job,
      portal: 'linkedin',
      score,
      jdText: jdText.slice(0, 5000)
    });

    // Small delay between job views
    await delay(1000);
  }

  await page.close();
  return jobs;
}

// ── Indeed Search ──
async function searchIndeed(context, keywords, location, maxResults) {
  const jobs = [];
  const page = await context.newPage();

  const searchUrl = `https://www.indeed.com/jobs?q=${encodeURIComponent(keywords)}&l=${encodeURIComponent(location)}`;

  console.log('  [Indeed] Searching: ' + keywords + ' in ' + location);
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await delay(3000);

  // Check if logged in
  const loginCheck = await page.$('#login-email, input[name="__email"], .gnav-LoginButton');
  const loggedIn = await page.$('.gnav-UserMenu, [data-testid="user-menu"]');
  if (loginCheck && !loggedIn) {
    console.log('  [Indeed] NOT LOGGED IN. Run: node login.js --board indeed');
    await page.close();
    return jobs;
  }

  // Extract job listings
  const listings = await page.$$eval('.job_seen_beacon, .result, .jobsearch-ResultsList li, [data-tn-component="organicJob"]', els => {
    return els.map(el => {
      const titleEl = el.querySelector('h2 a, .jobTitle, .jobsearch-SerpJobCard h2 a, [id*="job-title"]');
      const companyEl = el.querySelector('.companyName, .jobsearch-CompanyInfoContent, [data-testid="company-name"]');
      const locationEl = el.querySelector('.companyLocation, .jobsearch-CompanyInfoContent, [data-testid="text-location"]');
      const linkEl = el.querySelector('a[href*="/jobs/"], a[href*="indeed.com/rc/clk"], h2 a');

      return {
        title: titleEl ? titleEl.textContent.trim() : '',
        company: companyEl ? companyEl.textContent.trim() : '',
        location: locationEl ? locationEl.textContent.trim() : '',
        url: linkEl ? linkEl.href : '',
        easyApply: false
      };
    }).filter(j => j.title);
  });

  console.log('  [Indeed] Found ' + listings.length + ' job listings');

  // For each listing, get JD text
  for (let i = 0; i < Math.min(listings.length, maxResults); i++) {
    const job = listings[i];
    console.log('  [Indeed] (' + (i+1) + '/' + Math.min(listings.length, maxResults) + ') ' + job.company + ' — ' + job.title);

    let jdText = '';
    try {
      if (job.url) {
        await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await delay(2000);
        jdText = await page.evaluate(() => {
          const el = document.querySelector('#jobDescriptionText, .jobsearch-JobComponent-description, [class*="description"], main, article') || document.body;
          return el ? el.innerText : '';
        });
      }
    } catch (e) {
      console.log('    Could not load JD: ' + e.message.slice(0, 100));
    }

    const score = scoreFit(jdText || job.title + ' ' + job.company);
    jobs.push({
      ...job,
      portal: 'indeed',
      score,
      jdText: jdText.slice(0, 5000)
    });

    await delay(1000);
  }

  await page.close();
  return jobs;
}

// ── Main ──
async function main() {
  const opts = parseArgs();
  const portals = opts.portals.split(',').map(p => p.trim().toLowerCase());

  // Build search keywords from fields + titles
  const keywords = [opts.titles, opts.fields].filter(Boolean).join(' ').trim() || 'sales representative';

  console.log('\n=== JOB SEARCH ===');
  console.log('Portals: ' + portals.join(', '));
  console.log('Keywords: ' + keywords);
  console.log('Locations: ' + opts.locations);
  console.log('Max results per portal: ' + opts.max);
  console.log('');

  const allJobs = [];

  for (const portal of portals) {
    const profileDir = path.join(ROOT, 'profiles', portal);
    if (!fs.existsSync(profileDir) || fs.readdirSync(profileDir).length === 0) {
      console.log('\n[' + portal + '] No login profile found. Run: node login.js --board ' + portal);
      continue;
    }

    console.log('\n--- Searching ' + portal + ' ---');
    const browser = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      viewport: { width: 1280, height: 900 },
      args: ['--disable-blink-features=AutomationControlled', '--no-first-run'],
    });

    await browser.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    try {
      // Search for each location
      const locations = opts.locations.split(',').map(l => l.trim());
      for (const loc of locations) {
        let jobs;
        if (portal === 'linkedin') {
          jobs = await searchLinkedIn(browser, keywords, loc, opts.max);
        } else if (portal === 'indeed') {
          jobs = await searchIndeed(browser, keywords, loc, opts.max);
        }
        if (jobs) allJobs.push(...jobs);
      }
    } finally {
      await browser.close();
    }
  }

  // Sort by score (highest first)
  allJobs.sort((a, b) => b.score - a.score);

  // Filter by minimum score
  const filtered = allJobs.filter(j => j.score >= opts.minScore);

  // Cap at max total
  const final = filtered.slice(0, opts.max);

  // Save results
  const dateStr = new Date().toISOString().slice(0, 10);
  const outDir = path.join(ROOT, 'output', dateStr + '-search');
  fs.mkdirSync(outDir, { recursive: true });

  const resultsPath = path.join(outDir, 'search-results.json');
  // Strip jdText from saved results to keep file manageable
  const cleanResults = final.map(j => ({
    rank: 0, // will be assigned below
    title: j.title,
    company: j.company,
    location: j.location,
    url: j.url,
    portal: j.portal,
    score: j.score,
    easyApply: j.easyApply,
  }));

  cleanResults.forEach((j, i) => { j.rank = i + 1; });

  fs.writeFileSync(resultsPath, JSON.stringify(cleanResults, null, 2));

  // Print ranked list
  console.log('\n=== JOB RANKING — ' + final.length + ' jobs found ===\n');
  for (const job of cleanResults) {
    console.log('  ' + job.rank + '. [' + job.score + '] ' + job.title + ' — ' + job.company + ' (' + job.location + ') — ' + job.portal);
    console.log('     ' + job.url);
  }

  console.log('\nResults saved to: ' + resultsPath);
  console.log('Total jobs found: ' + allJobs.length);
  console.log('After filtering (min score ' + opts.minScore + '): ' + filtered.length);
  console.log('Final list: ' + final.length);
}

main().catch(e => { console.error(e); process.exit(1); });
