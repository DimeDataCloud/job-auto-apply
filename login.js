// login.js — Opens a VISIBLE browser with a persistent profile so you can
// log in to LinkedIn or Indeed once. The session (cookies, localStorage, etc.)
// is saved to profiles/<board>/ and reused by apply.js for auto-applying.
//
// Usage:
//   node login.js --board linkedin
//   node login.js --board indeed
//
// The browser stays open until you press Enter in the terminal. Log in
// normally, complete any 2FA/CAPTCHA, wait for the feed/search page to load,
// then press Enter to close and save the session.

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

const LOGIN_URLS = {
  linkedin: 'https://www.linkedin.com/login',
  indeed: 'https://secure.indeed.com/account/login',
  generic: 'about:blank',  // Generic profile — no login needed, used for external career sites
};

function parseArgs() {
  const args = process.argv.slice(2);
  let board = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--board' && args[i+1]) board = args[++i];
  }
  if (!board || !LOGIN_URLS[board]) {
    console.error('Usage: node login.js --board linkedin|indeed|generic');
    process.exit(1);
  }
  return board;
}

async function main() {
  const board = parseArgs();
  const profileDir = path.join(ROOT, 'profiles', board);
  fs.mkdirSync(profileDir, { recursive: true });

  console.log(`\n=== Login setup: ${board} ===`);
  console.log(`Profile dir: ${profileDir}`);
  console.log(`Login URL: ${LOGIN_URLS[board]}`);
  console.log('');

  const browser = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  const page = await browser.newPage();

  if (board === 'generic') {
    console.log('Generic profile created. No login needed — this profile is used');
    console.log('for external career sites (Workday, Greenhouse, etc.) where');
    console.log('account creation is handled during the application process.');
    console.log('Profile dir: ' + profileDir);
    await browser.close();
    return;
  }
  console.log(`Navigating to ${LOGIN_URLS[board]}...`);
  await page.goto(LOGIN_URLS[board], { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('');
  console.log('========================================');
  console.log('  LOG IN NOW in the browser window');
  console.log('  Complete any 2FA / CAPTCHA');
  console.log('  Wait for the feed/search page to load');
  console.log('  Then come back here and press Enter');
  console.log('========================================');
  console.log('');

  // Wait for user to press Enter
  await new Promise(resolve => {
    process.stdin.resume();
    process.stdin.once('data', resolve);
  });

  // Save cookies metadata for verification
  const cookies = await browser.cookies();
  const cookiePath = path.join(profileDir, 'session-cookies.json');
  fs.writeFileSync(cookiePath, JSON.stringify(cookies, null, 2));
  console.log(`Saved ${cookies.length} cookies to ${cookiePath}`);
  console.log(`Session saved. You can now run: node apply.js --board ${board} --url <job-url>`);

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
