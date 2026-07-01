// fit-score.js — Score a job description against your master resume.
// Returns a 0-100 fit score + matched skills/keywords.
//
// Usage:
//   node fit-score.js --jd "job.txt"
//   node fit-score.js --url "https://linkedin.com/jobs/view/..."
//   node fit-score.js --text "paste JD text"

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
// Load resume name from applicant-profile.json, fallback to example.json
const PROFILE_PATH = path.join(ROOT, 'applicant-profile.json');
const PROFILE = fs.existsSync(PROFILE_PATH) ? JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf-8')) : {};
const RESUME_NAME = PROFILE.activeResume || 'example';
const MASTER = JSON.parse(fs.readFileSync(path.join(ROOT, 'master-resumes', RESUME_NAME + '.json'), 'utf-8'));

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { jdFile: null, url: null, text: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--jd' && args[i+1]) opts.jdFile = args[++i];
    else if (args[i] === '--url' && args[i+1]) opts.url = args[++i];
    else if (args[i] === '--text' && args[i+1]) opts.text = args[++i];
  }
  if (!opts.jdFile && !opts.url && !opts.text) {
    console.error('Usage: node fit-score.js --jd <file> | --url <url> | --text "JD"');
    process.exit(1);
  }
  return opts;
}

function extractKeywords(text) {
  const stopWords = new Set([
    'the','a','an','and','or','but','in','on','at','to','for','of','with','by','from',
    'as','is','are','was','were','be','been','being','have','has','had','do','does','did',
    'will','would','could','should','may','might','must','can','this','that','these','those',
    'i','you','he','she','it','we','they','what','which','who','when','where','why','how',
    'all','each','every','both','few','more','most','other','some','such','no','nor','not',
    'only','own','same','so','than','too','very','just','also','about','if','then','else',
    'our','your','their','its','my','me','us','them','him','her','get','got','make','made',
    'go','going','new','one','two','per','via','etc','including','within','across','through',
    'during','before','after','above','below','up','down','out','over','under','again',
    'further','here','there','now','job','role','position','work','working','team','teams',
    'company','companies','candidate','candidates','employee','employees','year','years',
    'experience','required','preferred','qualifications','responsibilities','requirements',
    'plus','strong','ability','must','excellent','great','good','skills','looking','seeking',
    'join','help','build','using','able','we','our','you','your','their','will','shall',
  ]);
  const words = text.toLowerCase().replace(/[^a-z0-9\s+#.]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));
  const phrases = [];
  for (let i = 0; i < words.length - 1; i++) {
    if (!stopWords.has(words[i]) && !stopWords.has(words[i+1])) {
      phrases.push(words[i] + ' ' + words[i+1]);
    }
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

  const roleKeywords = ['sales','account','executive','business','development','representative',
    'sdr','bdr','ae','inside','field','technology','saas','cloud','infrastructure'];
  const jdLower = jdText.toLowerCase();
  const roleMatches = roleKeywords.filter(k => jdLower.includes(k));

  // ── REQUIREMENTS PENALTY ──
  // Check JD required years of experience vs profile experience
  // e.g. "Minimum 5 years of B2B sales experience" → require 5, profile has 3 → penalty
  const profileYears = PROFILE.jobPreferences?.experienceYears || 0;
  const reqYearsMatch = jdText.match(/(?:minimum|min\.?|at least)\s+(\d+)\s*(?:\+?\s*)?years?\s*(?:of\s+)?(?:b2b\s+)?(?:sales\s+)?experience/i);
  let reqYears = 0;
  let yearsPenalty = 0;
  if (reqYearsMatch) {
    reqYears = parseInt(reqYearsMatch[1]);
    if (profileYears > 0 && profileYears < reqYears) {
      yearsPenalty = -15 * (reqYears - profileYears) / reqYears;
      yearsPenalty = Math.max(yearsPenalty, -20); // cap at -20
    }
  }

  // Check for required industry experience that the profile doesn't have
  // e.g. "3 years of healthcare BPO experience" → if resume doesn't mention healthcare/BPO → penalty
  const industryReqMatch = jdText.match(/(\d+)\s*\+?\s*years?\s*(?:of\s+)?experience\s*(?:in|within|with)\s+(?:the\s+)?(\w+(?:\s+\w+){0,3})/i);
  let industryPenalty = 0;
  let requiredIndustry = '';
  if (industryReqMatch) {
    requiredIndustry = industryReqMatch[2].toLowerCase().trim();
    // Check if resume/profile mentions this industry
    const profileText = (resumeText + ' ' + JSON.stringify(PROFILE).toLowerCase()).toLowerCase();
    const industryWords = requiredIndustry.split(/\s+/).filter(w => w.length > 3);
    const hasIndustryMatch = industryWords.some(w => profileText.includes(w));
    if (!hasIndustryMatch && industryWords.length > 0) {
      industryPenalty = -10;
    }
  }

  // ── SALARY MATCH BONUS ──
  // If JD mentions salary and it meets minimum, add bonus
  let salaryBonus = 0;
  const salaryMatch = jdText.match(/\$([\d,]+)k?\s*(?:\/yr)?\s*(?:-|to)\s*\$([\d,]+)k?\s*(?:\/yr)?/i);
  if (salaryMatch) {
    const minSalaryInJD = parseInt(salaryMatch[1].replace(/,/g, '')) * (salaryMatch[1].includes('K') || salaryMatch[1].length <= 3 ? 1000 : 1);
    const profileMin = PROFILE.jobPreferences?.minSalary || 0;
    if (minSalaryInJD >= profileMin) salaryBonus = 5;
  }

  const keywordScore = Math.min(overlap.length / 15 * 40, 40);
  const skillScore = Math.min(skillMatches.length / 5 * 25, 25);
  const roleScore = Math.min(roleMatches.length / 4 * 35, 35);
  const total = Math.max(0, Math.round(keywordScore + skillScore + roleScore + yearsPenalty + industryPenalty + salaryBonus));

  let verdict = 'LOW';
  if (total >= 70) verdict = 'HIGH';
  else if (total >= 45) verdict = 'MEDIUM';

  return {
    score: total,
    verdict,
    breakdown: {
      keywordOverlap: Math.round(keywordScore),
      skillMatch: Math.round(skillScore),
      roleMatch: Math.round(roleScore),
      requirementsPenalty: Math.round(yearsPenalty + industryPenalty),
      salaryBonus: salaryBonus,
    },
    matchedKeywords: overlap.slice(0, 20),
    matchedSkills: skillMatches,
    roleMatches,
    topJdKeywords: jdKeywords.slice(0, 20).map(k => k.word),
    requirements: {
      requiredYears: reqYears,
      profileYears: profileYears,
      yearsPenalty: Math.round(yearsPenalty),
      requiredIndustry: requiredIndustry || '(none)',
      industryPenalty: Math.round(industryPenalty),
    },
  };
}

function printResult(jdText, url) {
  const result = scoreFit(jdText);
  const matchSkills = result.matchedSkills.length ? result.matchedSkills.join(', ') : '(none)';
  const roleMatch = result.roleMatches.length ? result.roleMatches.join(', ') : '(none)';

  console.log('\n=====================================');
  console.log('  FIT SCORE REPORT');
  console.log('=====================================');
  console.log('Resume: ' + MASTER.name + ' — ' + MASTER.title);
  if (url) console.log('Job URL: ' + url);
  console.log('Score:  ' + result.score + '/100  [' + result.verdict + ']');
  console.log('');
  console.log('Breakdown:');
  console.log('  Keyword overlap:    ' + result.breakdown.keywordOverlap + '/40');
  console.log('  Skill match:        ' + result.breakdown.skillMatch + '/25');
  console.log('  Role match:         ' + result.breakdown.roleMatch + '/35');
  if (result.breakdown.requirementsPenalty) console.log('  Requirements penalty: ' + result.breakdown.requirementsPenalty);
  if (result.breakdown.salaryBonus) console.log('  Salary bonus:       +' + result.breakdown.salaryBonus);
  console.log('');
  if (result.requirements.requiredYears > 0) {
    console.log('Requirements check:');
    console.log('  Required: ' + result.requirements.requiredYears + ' years (profile has ' + result.requirements.profileYears + ') → penalty: ' + result.requirements.yearsPenalty);
    if (result.requirements.requiredIndustry !== '(none)') {
      console.log('  Required industry: "' + result.requirements.requiredIndustry + '" → penalty: ' + result.requirements.industryPenalty);
    }
    console.log('');
  }
  console.log('Matched keywords:');
  console.log('  ' + (result.matchedKeywords.join(', ') || '(none)'));
  console.log('');
  console.log('Matched skills:');
  console.log('  ' + matchSkills);
  console.log('');
  console.log('Role indicators:');
  console.log('  ' + roleMatch);
  console.log('');
  console.log('Top JD keywords:');
  console.log('  ' + result.topJdKeywords.join(', '));
  console.log('=====================================\n');
}

function main() {
  const opts = parseArgs();
  let jdText = opts.text || '';
  if (opts.jdFile) {
    jdText = fs.readFileSync(opts.jdFile, 'utf-8');
    printResult(jdText);
  } else if (opts.url) {
    const { chromium } = require('playwright');
    (async () => {
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);
      const text = await page.evaluate(() => document.body.innerText);
      await browser.close();
      printResult(text, opts.url);
    })();
  } else {
    printResult(jdText);
  }
}

main();
