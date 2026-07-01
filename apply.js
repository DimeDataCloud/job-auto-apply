// apply.js — Universal auto-apply engine.
// Works on LinkedIn, Indeed, and external career sites (Workday, Greenhouse,
// Lever, Taleo, iCIMS, and generic forms). Detects the platform, fills forms,
// uploads resume, handles multi-page wizards, creates accounts when needed,
// auto-reads verification emails, and pauses for CAPTCHA.
//
// Usage:
//   node apply.js --url "https://..." --resume "output/.../resume.pdf"
//   node apply.js --url "https://..." --resume "output/.../resume.pdf" --headless
//   node apply.js --url "https://..." --resume "output/.../resume.pdf" --email "x@y.com" --password "pass123"
//
// The --email and --password args are used for account creation on external
// sites that require registration before applying.
//
// Email verification: If a site sends a verification email after account
// creation, apply.js reads it automatically via IMAP using the
// emailCredentials from applicant-profile.json (Gmail App Password).
// It extracts the verification link/code and completes the verification.

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PROFILE = JSON.parse(fs.readFileSync(path.join(ROOT, 'applicant-profile.json'), 'utf-8'));

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { url: null, resume: null, headless: false, email: null, password: null, board: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i+1]) opts.url = args[++i];
    else if (args[i] === '--resume' && args[i+1]) opts.resume = args[++i];
    else if (args[i] === '--email' && args[i+1]) opts.email = args[++i];
    else if (args[i] === '--password' && args[i+1]) opts.password = args[++i];
    else if (args[i] === '--board' && args[i+1]) opts.board = args[++i];
    else if (args[i] === '--headless') opts.headless = true;
  }
  if (!opts.url) {
    console.error('Usage: node apply.js --url <job-url> --resume <pdf-path> [--email x@y.com --password pass --board linkedin|indeed|generic] [--headless]');
    process.exit(1);
  }
  // Auto-fill email/password from applicant-profile.json if not passed via CLI
  const acctCreds = PROFILE.accountCredentials || {};
  if (!opts.email && acctCreds.email) {
    opts.email = acctCreds.email;
    console.log('Using account email from profile: ' + opts.email);
  }
  if (!opts.password && acctCreds.password) {
    opts.password = acctCreds.password;
  }
  return opts;
}

async function screenshot(page, dir, name) {
  const p = path.join(dir, name + '.png');
  await page.screenshot({ path: p, fullPage: false });
  console.log('  screenshot: ' + name + '.png');
}

async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── CAPTCHA DETECTION ──
async function checkCaptcha(page) {
  const selectors = [
    'iframe[src*="recaptcha"]','iframe[src*="hcaptcha"]','iframe[src*="turnstile"]',
    'iframe[title*="captcha"]','iframe[title*="reCAPTCHA"]','.captcha','#captcha',
    '[data-captcha]','iframe[title*="challenge"]',
  ];
  for (const sel of selectors) {
    if (await page.$(sel)) return sel;
  }
  return null;
}

async function waitForCaptchaSolve(page) {
  console.log('\n  *** CAPTCHA DETECTED ***');
  console.log('  Please solve it in the browser window, then press Enter here.');
  await page.bringToFront().catch(() => {});
  await new Promise(resolve => { process.stdin.resume(); process.stdin.once('data', resolve); });
  await delay(2000);
  const still = await checkCaptcha(page);
  if (still) { console.log('  CAPTCHA still detected. Please solve it.'); return false; }
  console.log('  CAPTCHA cleared. Continuing...');
  return true;
}

// ── PLATFORM DETECTION ──
function detectPlatform(url, page) {
  const u = url.toLowerCase();
  if (u.includes('linkedin.com')) return 'linkedin';
  if (u.includes('indeed.com')) return 'indeed';
  if (u.includes('myworkdayjobs.com') || u.includes('workday')) return 'workday';
  if (u.includes('greenhouse.io') || u.includes('greenhouse.com')) return 'greenhouse';
  if (u.includes('lever.co')) return 'lever';
  if (u.includes('taleo') || u.includes('oraclecloud')) return 'taleo';
  if (u.includes('icims.com')) return 'icims';
  if (u.includes('careers.labcorp.com') || u.includes('labcorp')) return 'workday';
  if (u.includes('paycor.com')) return 'paycor';
  if (u.includes('welovealfa.com')) return 'alfasoftware';
  return 'generic';
}

// ── UNIVERSAL SMART DROPDOWN HANDLER ──
// Handles both standard <select> and custom combobox dropdowns (Workday, Greenhouse, generic).
// Tries in order:
//   1. Standard <select> with selectOption()
//   2. Custom combobox: click trigger -> wait for popup -> click option by text
//   3. Workday-specific: data-automation-id based selectors
async function fillDropdown(page, fieldLabel, optionText, container) {
  const root = container || page;
  const delay = ms => new Promise(r => setTimeout(r, ms));

  // Strategy 1: Standard <select> — find by associated label or aria-label
  const selectSelectors = [
    `select[aria-label*="${fieldLabel}" i]`,
    `select[name*="${fieldLabel.toLowerCase().replace(/[^a-z0-9]/g,'')}" i]`,
  ];
  // Also try finding select near a label element
  const labelEls = await root.$$(`label, span, div`).catch(() => []);
  for (const label of labelEls.slice(0, 50)) {
    try {
      const text = (await label.textContent()).trim().replace('*', '').toLowerCase();
      if (text === fieldLabel.toLowerCase() || text === fieldLabel.toLowerCase().replace('*', '')) {
        const forId = await label.getAttribute('for');
        if (forId) {
          const sel = await root.$(`select#${forId}`);
          if (sel) {
            const opts = await sel.$$('option');
            for (let i = 1; i < opts.length; i++) {
              const optText = (await opts[i].textContent()).toLowerCase();
              if (optText.includes(optionText.toLowerCase())) {
                await sel.selectOption({ index: i });
                console.log('    Selected: ' + (await opts[i].textContent()).trim().slice(0, 60));
                return true;
              }
            }
            // If no exact match, pick first non-empty
            await sel.selectOption({ index: 1 });
            console.log('    Selected (first option): ' + (await opts[1].textContent()).trim().slice(0, 60));
            return true;
          }
        }
      }
    } catch (e) {}
  }

  // Strategy 2: Custom combobox — click the trigger element showing "Select One" or "0 items selected"
  // Find the label first, then find the dropdown trigger near it
  const triggerHandle = await root.evaluateHandle((label) => {
    // Find the label text element
    const allEls = document.querySelectorAll('span, div, label, p, [data-automation-id*="label"]');
    for (const el of allEls) {
      if (el.children.length > 0) continue;
      const text = el.textContent.trim().replace('*', '');
      if (text.toLowerCase() === label.toLowerCase()) {
        // Found the label — walk up to find the dropdown trigger
        let parent = el.parentElement;
        for (let i = 0; i < 6 && parent; i++) {
          // Workday: look for [data-automation-id] on clickable elements
          const trigger = parent.querySelector(
            '[data-automation-id*="select"]:not([data-automation-id*="label"]), ' +
            '[data-automation-id*="combobox"], [data-automation-id*="dropdown"], ' +
            '[role="combobox"], [role="listbox"], ' +
            'div[class*="css-"][tabindex], ' +
            'input[readonly], ' +
            '[data-automation-id*="selectedItemList"]'
          );
          if (trigger) return trigger;
          // Also check siblings
          const next = el.nextElementSibling || (parent && parent.querySelector('[data-automation-id*="select"]'));
          if (next && next !== el) return next;
          parent = parent.parentElement;
        }
        return null;
      }
    }
    return null;
  }, fieldLabel);

  const triggerExists = await triggerHandle.evaluate(el => !!el).catch(() => false);
  if (!triggerExists) {
    console.log('    No dropdown trigger found for: ' + fieldLabel);
    return false;
  }

  // Click the trigger to open the popup
  try {
    await triggerHandle.click({ force: true });
  } catch (e) {
    console.log('    Trigger click failed: ' + e.message.slice(0, 80));
    return false;
  }
  await delay(1000);

  // Now find and click the option in the popup
  // Workday popups render options as [data-automation-id*="option"] or [role="option"]
  const optionSelectors = [
    '[data-automation-id*="option"]',
    '[role="option"]',
    '[role="listitem"]',
    'li[class*="css-"]',
    'div[class*="option"]',
    'li[tabindex]',
    '[data-automation-id*="selectItem"]',
  ];

  for (const sel of optionSelectors) {
    try {
      const options = await page.$$(sel);
      if (options.length === 0) continue;

      for (const opt of options) {
        try {
          const text = (await opt.textContent()).trim();
          if (text.toLowerCase().includes(optionText.toLowerCase())) {
            await opt.click({ force: true });
            console.log('    Selected: ' + text.slice(0, 60));
            await delay(500);
            return true;
          }
        } catch (e) {}
      }

      // No exact match — pick first visible option
      for (const opt of options) {
        try {
          const visible = await opt.isVisible().catch(() => true);
          if (visible) {
            const text = (await opt.textContent()).trim();
            if (text && text.length > 1 && text.length < 200) {
              await opt.click({ force: true });
              console.log('    Selected (first): ' + text.slice(0, 60));
              await delay(500);
              return true;
            }
          }
        } catch (e) {}
      }
    } catch (e) {}
  }

  // Close the popup if nothing matched
  await page.keyboard.press('Escape').catch(() => {});
  console.log('    No option found for "' + optionText + '" in dropdown: ' + fieldLabel);
  return false;
}

// ── FIND ALL UNFILLED DROPDOWNS ON A PAGE ──
// Scans for dropdown triggers that show "Select One", "0 items selected", or empty combobox values
async function findUnfilledDropdowns(page, container) {
  const root = container || page;
  return await root.evaluate(() => {
    const results = [];
    // Skip patterns — text that is NOT a field label
    const skipText = ['Select One', 'items selected', 'step ', 'current step', 'Afghanistan', 'Albania', 'Algeria',
      'Error:', 'error', 'required', 'Save and', 'Continue', 'Next', 'Submit', 'Review',
      'United States of America (+1)', '1 item selected', '0 items selected',
      'My Information', 'My Experience', 'Application Questions', 'Voluntary Disclosures',
      'Self Identify', 'Review', 'Create Account', 'Sign In', 'English',
      'Careers Home', 'Candidate Home', 'Back to Job Posting'];

    // Look for elements showing "Select One" or "0 items selected"
    const allEls = document.querySelectorAll('span, div, [data-automation-id]');
    for (const el of allEls) {
      if (el.children.length > 0) continue;
      const text = el.textContent.trim();
      if (text === 'Select One' || text === '0 items selected' || text === 'items selected') {
        // Find the field label by walking up — look for a label-like sibling/parent
        let parent = el.parentElement;
        let label = '';
        for (let i = 0; i < 6 && parent; i++) {
          // Look for elements that look like field labels
          const candidates = parent.querySelectorAll('span, div, label, p, [data-automation-id*="label"]');
          for (const l of candidates) {
            if (l === el) continue;
            if (l.children.length > 0) continue;
            const lt = l.textContent.trim().replace('*', '');
            // Must be 3-60 chars, not a skip pattern, not a country name, not a number
            if (lt.length >= 3 && lt.length <= 60 &&
                !skipText.some(s => lt.toLowerCase().includes(s.toLowerCase())) &&
                !lt.match(/^\d/) && // not starting with a number
                !lt.includes('+1') && // not a phone code
                !lt.includes('United States') && // not a country
                (lt.endsWith('*') || lt.includes('?') || /^[A-Z]/.test(lt))) { // looks like a label
              label = lt;
              break;
            }
          }
          if (label) break;
          parent = parent.parentElement;
        }
        if (label) results.push({ label, triggerText: text });
      }
    }
    // Also look for empty standard <select> elements
    document.querySelectorAll('select').forEach(sel => {
      if (sel.selectedIndex <= 0) {
        let label = '';
        const id = sel.id;
        if (id) {
          const labelEl = document.querySelector('label[for="' + id + '"]');
          if (labelEl) label = labelEl.textContent.trim().replace('*', '');
        }
        if (!label) label = sel.getAttribute('aria-label') || sel.getAttribute('name') || '';
        if (label && !skipText.some(s => label.includes(s))) {
          results.push({ label, triggerText: 'empty-select', isStandard: true });
        }
      }
    });
    // Deduplicate by label
    const seen = new Set();
    return results.filter(r => {
      if (seen.has(r.label)) return false;
      seen.add(r.label);
      return true;
    });
  });
}

// ── SMART DROPDOWN VALUE MAPPER ──
// Maps field labels to appropriate values from the applicant profile
function getDropdownValue(fieldLabel, profile) {
  const label = fieldLabel.toLowerCase();
  const id = profile.identity || {};
  const screening = profile.screening || {};
  const eeo = profile.eeo || {};
  const app = profile.application || {};
  const wa = profile.workAuthorization || {};
  const jp = profile.jobPreferences || {};

  if (label.includes('how did you hear') || label.includes('hear about')) return screening.howDidYouHear || '';
  if (label.includes('state') && !label.includes('united')) return id.state || '';
  if (label.includes('phone') && label.includes('device')) return id.phoneDeviceType || '';
  if (label.includes('country') && label.includes('phone')) return id.phoneCountryCode || '';
  if (label.includes('country') && !label.includes('phone')) return id.country || '';
  if (label.includes('gender') || label.includes('sex')) return eeo.gender || '';
  if (label.includes('race') || label.includes('ethnic')) return eeo.race || '';
  if (label.includes('veteran')) return eeo.veteran || '';
  if (label.includes('disability')) return eeo.disability || '';
  if (label.includes('employment') && label.includes('type')) return app.employmentType || jp.employmentTypes?.[0] || '';
  if (label.includes('work') && label.includes('mode')) return app.workMode || jp.workMode?.[0] || '';
  if (label.includes('source')) return screening.howDidYouHear || '';
  if (label.includes('relationship') || label.includes('referral')) return screening.previouslyWorked ? 'Yes' : 'No';
  if (label.includes('degree') || label.includes('education')) return app.degree || '';
  if (label.includes('experience')) return app.experienceDescription || '';
  if (label.includes('salary') || label.includes('compensation')) return jp.salaryExpectation || '';
  if (label.includes('authorized') || label.includes('eligible')) return wa.authorizedToWorkInUS ? 'Yes' : 'No';
  if (label.includes('sponsorship') || label.includes('visa')) return wa.requiresSponsorship ? 'Yes' : 'No';
  if (label.includes('relocate')) return wa.willingToRelocate ? 'Yes' : 'No';
  if (label.includes('travel')) return wa.willingToTravel ? 'Yes' : 'No';
  if (label.includes('start') || label.includes('availability')) return app.startDate || jp.noticePeriod || '';
  if (label.includes('shift')) return app.shift || '';
  if (label.includes('timezone')) return app.timezone || '';
  if (label.includes('language')) return (app.languages || []).join(', ') || '';
  // Default — return empty so we skip rather than fill wrong
  return '';
}

// ── GREENHOUSE FORM HANDLER ──
// Greenhouse job boards have inline forms with standard HTML inputs.
// Fields: #first_name, #last_name, #email, phone (with country selector),
// resume file upload, custom questions (salary, EEO), reCAPTCHA.
async function applyGreenhouse(page, opts, outDir) {
  console.log('\n[Greenhouse]');
  const id = PROFILE.identity || {};
  const screening = PROFILE.screening || {};
  const eeo = PROFILE.eeo || {};

  // The form may already be visible, or we may need to click "Apply"
  let applyBtn = await page.$('a:has-text("Apply"), button:has-text("Apply"), #apply_button, button:has-text("Become")');
  if (applyBtn) {
    const text = (await applyBtn.textContent()).trim();
    console.log('  Clicking: ' + text);
    await applyBtn.click({ force: true });
    await delay(3000);
  }

  // Fill first name
  const firstNameEl = await page.$('#first_name, input[name="first_name"], input[aria-label*="First Name"]');
  if (firstNameEl) { await firstNameEl.click({ clickCount: 3 }); await firstNameEl.fill(id.firstName || ''); console.log('  Filled first name'); }

  // Fill last name
  const lastNameEl = await page.$('#last_name, input[name="last_name"], input[aria-label*="Last Name"]');
  if (lastNameEl) { await lastNameEl.click({ clickCount: 3 }); await lastNameEl.fill(id.lastName || ''); console.log('  Filled last name'); }

  // Fill email
  const emailEl = await page.$('#email, input[name="email"], input[type="email"], input[aria-label*="Email"]');
  if (emailEl) { await emailEl.click({ clickCount: 3 }); await emailEl.fill(id.email || (opts.email || '')); console.log('  Filled email'); }

  // Fill phone — Greenhouse uses a custom phone input with country selector
  const phoneEl = await page.$('input[type="tel"], input[name="phone"], input[aria-label*="phone"]');
  if (phoneEl) {
    await phoneEl.click({ clickCount: 3 });
    await phoneEl.fill(id.phone || '').catch(() => {});
    console.log('  Filled phone');
  }

  // Upload resume
  if (opts.resume && fs.existsSync(opts.resume)) {
    const fileInputs = await page.$$('input[type="file"]');
    for (const fi of fileInputs) {
      try {
        await fi.setInputFiles(opts.resume);
        console.log('  Uploaded resume: ' + opts.resume);
        await delay(2000);
        break;
      } catch (e) {}
    }
  }

  // Fill custom questions — Greenhouse uses named text inputs and textareas
  // Salary expectations
  const salaryEl = await page.$('input[name*="salary"], textarea[name*="salary"], [aria-label*="salary"]');
  if (salaryEl) {
    const salary = PROFILE.jobPreferences?.salaryExpectation || '';
    await salaryEl.click({ clickCount: 3 });
    await salaryEl.fill(salary);
    console.log('  Filled salary expectation');
  }

  // Fill any textarea custom questions
  const textareas = await page.$$('textarea:visible');
  for (const ta of textareas) {
    try {
      const ariaLabel = (await ta.getAttribute('aria-label') || '').toLowerCase();
      const name = (await ta.getAttribute('name') || '').toLowerCase();
      const currentVal = await ta.inputValue().catch(() => '');
      if (currentVal) continue;

      if (ariaLabel.includes('why') || name.includes('why') || ariaLabel.includes('cover') || name.includes('cover')) {
        const cover = PROFILE.answers?.['Why this company?'] || PROFILE.answers?.['Why this role?'] || '';
        await ta.fill(cover);
        console.log('  Filled: ' + ariaLabel.slice(0, 40));
      } else if (ariaLabel.includes('salary') || name.includes('salary')) {
        await ta.fill(PROFILE.jobPreferences?.salaryExpectation || '');
        console.log('  Filled salary');
      } else {
        // Generic textarea — fill with a short answer
        await ta.fill('N/A');
        console.log('  Filled: ' + ariaLabel.slice(0, 40));
      }
    } catch (e) {}
  }

  // Fill select dropdowns (EEO questions)
  const selects = await page.$$('select:visible');
  for (const sel of selects) {
    try {
      const selText = (await sel.textContent() || '').toLowerCase();
      const options = await sel.$$('option');
      const optionTexts = await Promise.all(options.map(o => o.textContent().catch(() => '')));

      if (selText.includes('gender') || selText.includes('sex')) {
        for (let i = 0; i < optionTexts.length; i++) {
          if (eeo.gender && optionTexts[i].toLowerCase().includes(eeo.gender.toLowerCase())) {
            await sel.selectOption({ index: i }); console.log('  Selected gender'); break;
          }
        }
      } else if (selText.includes('race') || selText.includes('ethnic') || selText.includes('hispanic')) {
        for (let i = 0; i < optionTexts.length; i++) {
          if (eeo.race && optionTexts[i].toLowerCase().includes(eeo.race.toLowerCase())) {
            await sel.selectOption({ index: i }); console.log('  Selected race'); break;
          }
        }
      } else if (selText.includes('veteran')) {
        for (let i = 0; i < optionTexts.length; i++) {
          if (eeo.veteran && optionTexts[i].toLowerCase().includes(eeo.veteran.toLowerCase())) {
            await sel.selectOption({ index: i }); console.log('  Selected veteran status'); break;
          }
        }
      } else if (selText.includes('disability')) {
        for (let i = 0; i < optionTexts.length; i++) {
          if (eeo.disability && optionTexts[i].toLowerCase().includes(eeo.disability.toLowerCase())) {
            await sel.selectOption({ index: i }); console.log('  Selected disability status'); break;
          }
        }
      } else {
        // Generic select — pick first non-empty option
        for (let i = 1; i < optionTexts.length; i++) {
          try { await sel.selectOption({ index: i }); console.log('  Selected: ' + optionTexts[i].trim().slice(0, 40)); break; } catch (e) {}
        }
      }
    } catch (e) {}
  }

  // Fill any remaining unfilled dropdowns (custom comboboxes)
  const ghDrops = await findUnfilledDropdowns(page);
  if (ghDrops.length > 0) {
    console.log('  Found ' + ghDrops.length + ' unfilled dropdowns');
    for (const dd of ghDrops) {
      const value = getDropdownValue(dd.label, PROFILE);
      if (value) {
        console.log('  Dropdown: ' + dd.label + ' -> ' + value);
        await fillDropdown(page, dd.label, value);
      }
    }
  }

  // Auto-approve all consent checkboxes
  const checkboxes = await page.$$('[role="checkbox"]:visible, input[type="checkbox"]:visible');
  for (const cb of checkboxes) {
    try {
      const isChecked = await cb.isChecked().catch(() => false);
      if (isChecked) continue;
      const l = (await cb.getAttribute('aria-label') || '').toLowerCase();
      if (l.includes('consent') || l.includes('agree') || l.includes('acknowledge') || l.includes('authorize')) {
        await cb.click({ force: true });
        console.log('  Auto-approved: ' + l.slice(0, 60));
      }
    } catch (e) {}
  }

  // Check for CAPTCHA
  const captcha = await checkCaptcha(page);
  if (captcha) {
    console.log('\n  *** CAPTCHA DETECTED on Greenhouse ***');
    console.log('  Cannot auto-solve. Application needs manual CAPTCHA completion.');
    await page.screenshot({ path: path.join(outDir, 'greenhouse-captcha.png') });
    return { status: 'captcha_needed', platform: 'greenhouse' };
  }

  await page.screenshot({ path: path.join(outDir, 'greenhouse-filled.png') });

  // Click submit button
  const submitSelectors = [
    'button:has-text("Submit")', 'button:has-text("Send")', 'button:has-text("Apply")',
    'button:has-text("Become")', 'button[type="submit"]', '#submit_app',
    'button:has-text("Submit Application")',
  ];
  for (const sel of submitSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        const disabled = await btn.isDisabled().catch(() => false);
        if (!disabled) {
          const text = (await btn.textContent()).trim();
          console.log('  Clicking submit: ' + text);
          await btn.click({ force: true });
          await delay(5000);
          
          // Check if submitted
          const afterText = await page.evaluate(() => document.body ? document.body.innerText.toLowerCase() : '');
          if (afterText.includes('thank you') || afterText.includes('submitted') || afterText.includes('received') || afterText.includes('application has been')) {
            console.log('  APPLICATION SUBMITTED!');
            await page.screenshot({ path: path.join(outDir, 'greenhouse-submitted.png') });
            return { status: 'submitted', platform: 'greenhouse' };
          }
          console.log('  Submit clicked. Checking result...');
          await page.screenshot({ path: path.join(outDir, 'greenhouse-after-submit.png') });
          return { status: 'submitted', platform: 'greenhouse' };
        }
      }
    } catch (e) {}
  }

  console.log('  Could not find submit button');
  return { status: 'no_submit_button', platform: 'greenhouse' };
}

// ── LEVER FORM HANDLER ──
// Lever has a simple form: name, email, resume upload, optional questions.
async function applyLever(page, opts, outDir) {
  console.log('\n[Lever]');
  const id = PROFILE.identity || {};

  // Fill name (Lever uses a single name field or first/last)
  const nameEl = await page.$('input[name="name"], input[aria-label*="name"]');
  if (nameEl) {
    await nameEl.click({ clickCount: 3 });
    await nameEl.fill(id.firstName + ' ' + id.lastName);
    console.log('  Filled name');
  } else {
    const fnEl = await page.$('input[name*="first"], input[aria-label*="First"]');
    if (fnEl) { await fnEl.click({ clickCount: 3 }); await fnEl.fill(id.firstName || ''); console.log('  Filled first name'); }
    const lnEl = await page.$('input[name*="last"], input[aria-label*="Last"]');
    if (lnEl) { await lnEl.click({ clickCount: 3 }); await lnEl.fill(id.lastName || ''); console.log('  Filled last name'); }
  }

  // Fill email
  const emailEl = await page.$('input[type="email"], input[name="email"], input[aria-label*="email"]');
  if (emailEl) { await emailEl.click({ clickCount: 3 }); await emailEl.fill(id.email || ''); console.log('  Filled email'); }

  // Fill phone
  const phoneEl = await page.$('input[type="tel"], input[name="phone"], input[aria-label*="phone"]');
  if (phoneEl) { await phoneEl.click({ clickCount: 3 }); await phoneEl.fill(id.phone || ''); console.log('  Filled phone'); }

  // Upload resume
  if (opts.resume && fs.existsSync(opts.resume)) {
    const fileInputs = await page.$$('input[type="file"]');
    for (const fi of fileInputs) {
      try { await fi.setInputFiles(opts.resume); console.log('  Uploaded resume'); await delay(2000); break; } catch (e) {}
    }
  }

  // Fill any custom questions (textareas, selects)
  const textareas = await page.$$('textarea:visible');
  for (const ta of textareas) {
    try {
      const v = await ta.inputValue().catch(() => '');
      if (v) continue;
      const label = (await ta.getAttribute('aria-label') || await ta.getAttribute('placeholder') || '').toLowerCase();
      if (label.includes('why')) await ta.fill(PROFILE.answers?.['Why this company?'] || 'N/A');
      else if (label.includes('salary')) await ta.fill(PROFILE.jobPreferences?.salaryExpectation || '');
      else await ta.fill('N/A');
      console.log('  Filled: ' + label.slice(0, 40));
    } catch (e) {}
  }

  const selects = await page.$$('select:visible');
  for (const sel of selects) {
    try { const opts2 = await sel.$$('option'); for (let i = 1; i < opts2.length; i++) { try { await sel.selectOption({ index: i }); break; } catch (e) {} } } catch (e) {}
  }

  // Check for CAPTCHA
  const captcha = await checkCaptcha(page);
  if (captcha) {
    return { status: 'captcha_needed', platform: 'lever' };
  }

  // Submit
  const submitBtn = await page.$('button:has-text("Submit"), button:has-text("Apply"), button[type="submit"]');
  if (submitBtn) {
    await submitBtn.click({ force: true });
    await delay(5000);
    const afterText = await page.evaluate(() => document.body ? document.body.innerText.toLowerCase() : '');
    if (afterText.includes('thank') || afterText.includes('submitted') || afterText.includes('received')) {
      console.log('  APPLICATION SUBMITTED!');
      return { status: 'submitted', platform: 'lever' };
    }
    return { status: 'submitted', platform: 'lever' };
  }
  return { status: 'no_submit_button', platform: 'lever' };
}

// ── VERIFICATION CODE ENTRY ──
// Handles multiple UI patterns for entering verification codes:
//   1. Single input field (most common)
//   2. Separate digit boxes (one input per digit — Workday, some banks)
//   3. OTP/pin grid inputs
//   4. Textarea
async function enterVerificationCode(page, code) {
  console.log('  Entering verification code: ' + code);

  // Strategy 1: Single input field by name/label/attributes
  const singleInputSelectors = [
    'input[name*="code"]', 'input[name*="otp"]', 'input[name*="verify"]',
    'input[name*="verification"]', 'input[name*="pin"]', 'input[name*="token"]',
    'input[aria-label*="code"]', 'input[aria-label*="verification"]',
    'input[aria-label*="otp"]', 'input[aria-label*="verify"]',
    'input[placeholder*="code"]', 'input[placeholder*="verification"]',
    'input[placeholder*="otp"]', 'input[placeholder*="enter"]',
    'input[data-automation-id*="code"]', 'input[data-automation-id*="otp"]',
    'input[data-automation-id*="verification"]', 'input[data-automation-id*="verify"]',
    'input[type="text"][maxlength="4"]', 'input[type="text"][maxlength="5"]',
    'input[type="text"][maxlength="6"]', 'input[type="text"][maxlength="7"]',
    'input[type="text"][maxlength="8"]',
    'input[type="tel"][maxlength="4"]', 'input[type="tel"][maxlength="6"]',
    'input[type="number"]',
  ];

  for (const sel of singleInputSelectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        const visible = await el.isVisible().catch(() => true);
        if (!visible) continue;
        await el.click({ clickCount: 3 });
        await el.fill(code);
        console.log('  Entered code into single field: ' + sel);
        await delay(500);

        // Look for a submit/verify/confirm button
        const submitSelectors = [
          'button:has-text("Verify")', 'button:has-text("Submit")', 'button:has-text("Confirm")',
          'button:has-text("Continue")', 'button:has-text("Next")', 'button:has-text("Complete")',
          'button:has-text("Apply")', 'button[type="submit"]',
          '[data-automation-id*="submit"]', '[data-automation-id*="verify"]',
          '[data-automation-id*="continue"]', '[data-automation-id*="next"]',
        ];
        for (const ssel of submitSelectors) {
          try {
            const btn = await page.$(ssel);
            if (btn) {
              const disabled = await btn.isDisabled().catch(() => false);
              if (!disabled) { await btn.click(); console.log('  Clicked submit: ' + ssel); await delay(3000); break; }
            }
          } catch (e) {}
        }
        return true;
      }
    } catch (e) {}
  }

  // Strategy 2: Separate digit boxes (one input per digit)
  // Look for a group of inputs with maxlength=1 that are adjacent
  const digitInputs = await page.$$('input[maxlength="1"]:visible, input[data-automation-id*="digit"], input[class*="digit"], input[class*="otp-digit"], input[class*="code-input"]');
  if (digitInputs.length >= 4 && digitInputs.length <= 8) {
    console.log('  Found ' + digitInputs.length + ' separate digit input boxes');
    for (let i = 0; i < Math.min(code.length, digitInputs.length); i++) {
      try {
        await digitInputs[i].click();
        await digitInputs[i].fill(code[i]);
        await delay(100);
      } catch (e) {}
    }
    console.log('  Entered code across digit boxes');

    // Some sites auto-submit when all digits are entered; wait a moment
    await delay(2000);

    // Otherwise look for a submit button
    const submitBtn = await page.$('button:has-text("Verify"), button:has-text("Submit"), button:has-text("Confirm"), button:has-text("Continue"), button[type="submit"], [data-automation-id*="submit"], [data-automation-id*="verify"]');
    if (submitBtn) {
      const disabled = await submitBtn.isDisabled().catch(() => false);
      if (!disabled) { await submitBtn.click(); console.log('  Clicked submit after digit entry'); await delay(3000); }
    }
    return true;
  }

  // Strategy 3: Textarea
  const textarea = await page.$('textarea[name*="code"], textarea[aria-label*="code"], textarea[aria-label*="verification"], textarea[placeholder*="code"]');
  if (textarea) {
    await textarea.click({ clickCount: 3 });
    await textarea.fill(code);
    console.log('  Entered code into textarea');
    await delay(500);
    const submitBtn = await page.$('button:has-text("Verify"), button:has-text("Submit"), button:has-text("Confirm"), button[type="submit"]');
    if (submitBtn) { await submitBtn.click(); await delay(3000); }
    return true;
  }

  // Strategy 4: Look for any visible text input on the page that we haven't tried
  const anyInput = await page.$('input[type="text"]:visible, input[type="tel"]:visible, input[type="number"]:visible');
  if (anyInput) {
    try {
      await anyInput.click({ clickCount: 3 });
      await anyInput.fill(code);
      console.log('  Entered code into fallback visible input');
      await delay(500);
      const submitBtn = await page.$('button:has-text("Verify"), button:has-text("Submit"), button:has-text("Confirm"), button:has-text("Continue"), button[type="submit"]');
      if (submitBtn) { await submitBtn.click(); await delay(3000); }
      return true;
    } catch (e) {}
  }

  console.log('  WARNING: Could not find a verification code input field on the page');
  console.log('  The code was: ' + code + ' — you may need to enter it manually');
  return false;
}

// ── ACCOUNT CREATION DETECTION ──
async function checkAccountCreation(page, context, opts) {
  // Detect signup/register/create account pages
  const signupSelectors = [
    'input[name*="password"]:not([type="hidden"])',
    'input[type="password"]',
    'button:has-text("Create Account")','button:has-text("Sign Up")',
    'button:has-text("Register")','button:has-text("Create account")',
    'a:has-text("Create Account")','a:has-text("Sign Up")',
    'a:has-text("Register")','a:has-text("Create account")',
    'text=/create.*account/i','text=/sign.*up/i','text=/register/i',
  ];

  // Check if we're on a login/signup page
  const pageText = await page.evaluate(() => document.body ? document.body.innerText.toLowerCase() : '');
  const isSignup = pageText.includes('create account') || pageText.includes('sign up') ||
                   pageText.includes('register') || pageText.includes('new user') ||
                   pageText.includes('first time') || pageText.includes('don\'t have an account');

  // Check for password field (signup pages have these, browse pages don't)
  const hasPasswordField = await page.$('input[type="password"]:not([type="hidden"])');

  if (isSignup || (hasPasswordField && !pageText.includes('sign in'))) {
    console.log('\n  *** ACCOUNT CREATION DETECTED ***');
    console.log('  This site requires an account before applying.');

    if (!opts.email || !opts.password) {
      console.log('\n  Email and password not provided via CLI args.');
      console.log('  Please provide them now to create the account:');
      console.log('  (or solve it manually in the browser if you prefer)');

      // Check if there's a "continue as guest" or "apply without account" option
      const guestBtn = await page.$('a:has-text("Continue as guest"), button:has-text("Continue"), a:has-text("Apply without"), button:has-text("Skip")');
      if (guestBtn) {
        console.log('  Found a "Continue" option — trying to proceed without account...');
        await guestBtn.click();
        await delay(3000);
        return { status: 'skipped_account' };
      }

      // Pause for user to handle manually if no email/password
      console.log('\n  No account credentials available. Please create an account manually in the browser,');
      console.log('  then press Enter to continue with the application.');
      await page.bringToFront().catch(() => {});
      await new Promise(resolve => { process.stdin.resume(); process.stdin.once('data', resolve); });
      await delay(2000);
      return { status: 'manual_account' };
    }

    console.log('  Creating account with: ' + opts.email);

    // Fill email field
    const emailSelectors = [
      'input[name*="email"]','input[type="email"]','input[id*="email"]',
      'input[placeholder*="email"]','input[aria-label*="email"]',
    ];
    for (const sel of emailSelectors) {
      try {
        const el = await page.$(sel);
        if (el) { await el.click({ clickCount: 3 }); await el.fill(opts.email); console.log('  Filled email: ' + opts.email); break; }
      } catch (e) {}
    }

    // Fill password field
    const passwordSelectors = [
      'input[type="password"]','input[name*="password"]','input[id*="password"]',
    ];
    for (const sel of passwordSelectors) {
      try {
        const el = await page.$(sel);
        if (el) { await el.click({ clickCount: 3 }); await el.fill(opts.password); console.log('  Filled password'); break; }
      } catch (e) {}
    }

    // Fill confirm password if present
    const confirmSelectors = [
      'input[name*="confirm"]','input[name*="verify"]','input[id*="confirm"]',
      'input[placeholder*="confirm"]',
    ];
    for (const sel of confirmSelectors) {
      try {
        const el = await page.$(sel);
        if (el) { await el.click({ clickCount: 3 }); await el.fill(opts.password); console.log('  Filled confirm password'); break; }
      } catch (e) {}
    }

    // Fill first/last name if present (signup forms often ask)
    const id = PROFILE.identity;
    const firstNameSelectors = ['input[name*="first"]','input[id*="first"]','input[placeholder*="first"]'];
    for (const sel of firstNameSelectors) {
      try { const el = await page.$(sel); if (el) { await el.click({clickCount:3}); await el.fill(id.firstName); console.log('  Filled first name'); break; } } catch (e) {}
    }
    const lastNameSelectors = ['input[name*="last"]','input[id*="last"]','input[placeholder*="last"]'];
    for (const sel of lastNameSelectors) {
      try { const el = await page.$(sel); if (el) { await el.click({clickCount:3}); await el.fill(id.lastName); console.log('  Filled last name'); break; } } catch (e) {}
    }

    await delay(1000);

    // Check for CAPTCHA before submitting
    const captcha = await checkCaptcha(page);
    if (captcha) { await waitForCaptchaSolve(page); }

    // Click create account / sign up / register button
    const submitSelectors = [
      'button:has-text("Create Account")','button:has-text("Sign Up")','button:has-text("Register")',
      'button:has-text("Create account")','button:has-text("Submit")','button[type="submit"]',
    ];
    for (const sel of submitSelectors) {
      try {
        const el = await page.$(sel);
        if (el) { const text = await el.textContent(); await el.click(); console.log('  Clicked: ' + text.trim()); await delay(3000); break; }
      } catch (e) {}
    }

    // Check for email verification
    const verifyText = await page.evaluate(() => document.body ? document.body.innerText.toLowerCase() : '');
    const needsVerification = verifyText.includes('verification') || verifyText.includes('verify your email') ||
                               verifyText.includes('check your email') || verifyText.includes('verify your account') ||
                               verifyText.includes('confirm your email') || verifyText.includes('activate your account') ||
                               verifyText.includes('we sent') || verifyText.includes('verification link') ||
                               verifyText.includes('verification code') || verifyText.includes('one-time') ||
                               verifyText.includes('otp') || verifyText.includes('enter the code');

    if (needsVerification) {
      console.log('\n  *** EMAIL VERIFICATION REQUIRED ***');
      console.log('  A verification email has been sent to ' + opts.email);

      const emailCreds = PROFILE.emailCredentials || {};
      const hasImap = emailCreds.email && emailCreds.appPassword;

      if (hasImap) {
        console.log('  Auto-reading verification email via IMAP...');

        try {
          const { fetchEmails } = require('./email-reader.js');
          const sinceMinutes = 5; // check last 5 minutes
          const verifyEmails = await fetchEmails({
            email: emailCreds.email,
            password: emailCreds.appPassword,
            since: sinceMinutes,
          });

          // Find the verification email
          const recent = verifyEmails.filter(e => {
            const text = (e.subject + ' ' + e.preview).toLowerCase();
            return text.includes('verify') || text.includes('verification') ||
                   text.includes('confirm') || text.includes('activate') ||
                   text.includes('account') || text.includes('workday') ||
                   text.includes('welcome') || text.includes('code') ||
                   e.links.length > 0 || e.codes.length > 0;
          }).sort((a, b) => new Date(b.date) - new Date(a.date));

          if (recent.length > 0) {
            const email = recent[0];
            console.log('  Found verification email: ' + email.subject);
            console.log('  From: ' + email.from);
            console.log('  Links: ' + email.links.length + ', Codes: ' + email.codes.length);

            if (email.links && email.links.length > 0) {
              // Try to find a verification link (not an unsubscribe link)
              const verifyLinks = email.links.filter(l =>
                !l.includes('unsubscribe') && !l.includes('privacy') && !l.includes('terms')
              );
              const link = verifyLinks[0] || email.links[0];
              console.log('  Opening verification link: ' + link.slice(0, 100));
              await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 });
              await delay(3000);
              console.log('  Navigated to verification URL: ' + page.url());

              const afterVerifyText = await page.evaluate(() => document.body ? document.body.innerText.toLowerCase() : '');
              if (afterVerifyText.includes('verified') || afterVerifyText.includes('confirmed') ||
                  afterVerifyText.includes('activated') || afterVerifyText.includes('success') ||
                  afterVerifyText.includes('thank you') || afterVerifyText.includes('complete')) {
                console.log('  Email verified successfully!');
                return { status: 'account_created', verified: true };
              }
              console.log('  Verification link opened. Continuing...');
              return { status: 'account_created', verified: true };
            }

            if (email.codes && email.codes.length > 0) {
              // Enter verification code into the page
              const code = email.codes[0];
              console.log('  Found verification code: ' + code);
              await enterVerificationCode(page, code);
              return { status: 'account_created', verified: true };
            }
          } else {
            console.log('  No verification email found yet. Waiting 30s and retrying...');
            await delay(30000);
            const retry = await fetchEmails({
              email: emailCreds.email,
              password: emailCreds.appPassword,
              since: 10,
            });
            const retryRecent = retry.filter(e => {
              const text = (e.subject + ' ' + e.preview).toLowerCase();
              return text.includes('verify') || text.includes('verification') ||
                     text.includes('confirm') || text.includes('activate') ||
                     text.includes('workday') || text.includes('code') || e.links.length > 0;
            }).sort((a, b) => new Date(b.date) - new Date(a.date));

            if (retryRecent.length > 0) {
              const retryEmail = retryRecent[0];
              if (retryEmail.links && retryEmail.links.length > 0) {
                const link = retryEmail.links.filter(l => !l.includes('unsubscribe')).pop() || retryEmail.links[0];
                console.log('  Found verification link on retry: ' + link.slice(0, 100));
                await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await delay(3000);
                return { status: 'account_created', verified: true };
              }
              if (retryEmail.codes && retryEmail.codes.length > 0) {
                console.log('  Found verification code on retry: ' + retryEmail.codes[0]);
                await enterVerificationCode(page, retryEmail.codes[0]);
                return { status: 'account_created', verified: true };
              }
            }
            console.log('  Still no verification email found after retry.');
          }
        } catch (e) {
          console.log('  IMAP reading failed: ' + e.message);
        }

        // Fallback: wait for manual verification
        console.log('\n  Could not auto-read email. Please verify manually:');
        console.log('  1. Check ' + opts.email + ' for a verification email');
        console.log('  2. Click the verification link or enter the code');
        console.log('  3. Press Enter here to continue');
        await page.bringToFront().catch(() => {});
        await new Promise(resolve => { process.stdin.resume(); process.stdin.once('data', resolve); });
        await delay(2000);
      } else {
        // No IMAP credentials configured — ask user to verify manually
        console.log('\n  No IMAP credentials configured for auto-reading.');
        console.log('  To enable auto-verification, add emailCredentials to applicant-profile.json');
        console.log('  (Gmail App Password from https://myaccount.google.com/apppasswords)');
        console.log('\n  Please verify manually:');
        console.log('  1. Check ' + opts.email + ' for a verification email');
        console.log('  2. Click the verification link or enter the code');
        console.log('  3. Press Enter here to continue');
        await page.bringToFront().catch(() => {});
        await new Promise(resolve => { process.stdin.resume(); process.stdin.once('data', resolve); });
        await delay(2000);
      }
    }

    console.log('  Account creation step completed');
    return { status: 'account_created' };
  }

  return null; // not a signup page
}

// ── UNIVERSAL FIELD FILLER ──
// Tries multiple strategies to find and fill a field by semantic label
async function fillSmart(page, fieldType, value, container) {
  const root = container || page;

  // Strategy 1: Common name attributes
  const namePatterns = {
    firstName: ['firstname','first_name','fname','given_name','givenname'],
    lastName: ['lastname','last_name','lname','family_name','familyname','surname'],
    fullName: ['fullname','full_name','name','applicant_name','candidate_name'],
    email: ['email','email_address','e-mail','user_email','login'],
    phone: ['phone','phone_number','mobile','telephone','tel','cell','contact_number','primary_phone'],
    address: ['address','street','address1','mailing_address','location_address'],
    city: ['city','town','locality'],
    state: ['state','province','region'],
    zip: ['zip','zip_code','postal','postal_code','postcode'],
    country: ['country','nation'],
    linkedin: ['linkedin','linkedin_url','linkedin_profile','website','url','portfolio','github','blog'],
    coverLetter: ['cover_letter','coverletter','message','comments','additional_info','why'],
    salary: ['salary','compensation','expected_salary','salary_expectation','desired_salary','pay'],
  };

  // Strategy 2: aria-label / placeholder / label text
  const labelKeywords = {
    firstName: ['first name','given name'],
    lastName: ['last name','family name','surname'],
    fullName: ['full name','your name','name'],
    email: ['email','e-mail'],
    phone: ['phone','mobile','telephone','cell'],
    address: ['address','street'],
    city: ['city','town'],
    state: ['state','province'],
    zip: ['zip','postal'],
    country: ['country'],
    linkedin: ['linkedin','website','url','portfolio','github'],
    coverLetter: ['cover letter','message','comments','additional','why'],
    salary: ['salary','compensation','pay','desired'],
  };

  // Try name attribute patterns
  const names = namePatterns[fieldType] || [];
  for (const name of names) {
    try {
      const el = await root.$(`input[name*="${name}"]:not([type="hidden"]):not([type="file"]), textarea[name*="${name}"], select[name*="${name}"]`);
      if (el) {
        const currentVal = await el.inputValue().catch(() => '');
        if (currentVal && currentVal.trim()) continue;
        await el.click({ clickCount: 3 });
        if (el.tagName.toLowerCase() === 'select' || (await el.getAttribute('type')) === 'select') {
          // Handle select
          await el.selectOption(value);
        } else {
          await el.fill(value);
        }
        return true;
      }
    } catch (e) {}
  }

  // Try aria-label / placeholder
  const keywords = labelKeywords[fieldType] || [];
  for (const kw of keywords) {
    try {
      const el = await root.$(`input[aria-label*="${kw}" i]:not([type="hidden"]):not([type="file"]), input[placeholder*="${kw}" i]:not([type="hidden"]), textarea[aria-label*="${kw}" i], textarea[placeholder*="${kw}" i]`);
      if (el) {
        const currentVal = await el.inputValue().catch(() => '');
        if (currentVal && currentVal.trim()) continue;
        await el.click({ clickCount: 3 });
        await el.fill(value);
        return true;
      }
    } catch (e) {}
  }

  // Strategy 3: Find label elements and match to their associated inputs
  for (const kw of keywords) {
    try {
      const labels = await root.$$('label, [class*="label"], [class*="field-label"]');
      for (const label of labels) {
        const labelText = (await label.textContent()).toLowerCase().trim();
        if (labelText.includes(kw)) {
          // Find the for attribute or sibling input
          const forId = await label.getAttribute('for');
          let input = null;
          if (forId) {
            input = await root.$('#' + forId);
          }
          if (!input) {
            input = await label.$('.., input, textarea, select');
            if (input && (await input.tagName).toLowerCase() === 'label') input = null;
          }
          if (!input) {
            // Try next sibling
            const parent = await label.evaluateHandle(el => el.parentElement);
            input = await parent.$('input, textarea, select');
          }
          if (input) {
            const currentVal = await input.inputValue().catch(() => '');
            if (currentVal && currentVal.trim()) continue;
            await input.click({ clickCount: 3 });
            await input.fill(value);
            return true;
          }
        }
      }
    } catch (e) {}
  }

  return false;
}

// ── UNIVERSAL FORM FILLER ──
async function fillAllFields(page, opts, container) {
  const id = PROFILE.identity;
  const root = container || page;
  let filled = 0;

  // Core identity fields
  const fields = [
    ['firstName', id.firstName],
    ['lastName', id.lastName],
    ['fullName', id.firstName + ' ' + id.lastName],
    ['email', id.email],
    ['phone', id.phone],
    ['address', id.address1 || id.location],
    ['city', id.city || ''],
    ['state', id.state || ''],
    ['zip', id.postalCode || ''],
    ['country', id.country || 'United States'],
    ['linkedin', id.linkedinUrl],
  ];

  // Add cover letter from answers if available
  const answers = PROFILE.answers || {};
  if (answers['Why this company?'] || answers['Tell me about yourself']) {
    const coverText = answers['Why this company?'] || answers['Tell me about yourself'];
    fields.push(['coverLetter', coverText.slice(0, 2000)]);
  }

  // Add salary expectation if available
  if (PROFILE.jobPreferences && PROFILE.jobPreferences.salaryExpectation) {
    fields.push(['salary', PROFILE.jobPreferences.salaryExpectation]);
  }

  for (const [fieldType, value] of fields) {
    const result = await fillSmart(page, fieldType, value, root);
    if (result) { console.log('    Filled ' + fieldType); filled++; await delay(300); }
  }

  // Fill work authorization radio/checkbox/select questions
  await fillScreeningQuestions(page, root);

  // Fill all unfilled dropdowns (standard + custom combobox)
  const unfilledDrops = await findUnfilledDropdowns(page, root);
  if (unfilledDrops.length > 0) {
    console.log('  Found ' + unfilledDrops.length + ' unfilled dropdowns');
    for (const dd of unfilledDrops) {
      const value = getDropdownValue(dd.label, PROFILE);
      if (value) {
        console.log('    Dropdown: ' + dd.label + ' -> ' + value);
        const success = await fillDropdown(page, dd.label, value, root);
        if (success) filled++;
      } else {
        console.log('    Dropdown: ' + dd.label + ' -> SKIP (no value mapped)');
      }
    }
  }

  return filled;
}

// ── SCREENING QUESTIONS HANDLER ──
async function fillScreeningQuestions(page, container) {
  const root = container || page;
  const wa = PROFILE.workAuthorization || {};
  const eeo = PROFILE.eeo || {};
  const screening = PROFILE.screening || {};

  // Find all radio groups and checkboxes
  const questions = await root.$$('fieldset, [role="group"], .form-question, [class*="question"]');

  for (const q of questions) {
    try {
      const qText = (await q.textContent()).toLowerCase();

      // Work authorization
      if (qText.includes('authorized') || qText.includes('legally') || qText.includes('eligible to work')) {
        const yesRadio = await q.$('input[type="radio"][value*="yes" i], input[type="radio"][value*="true" i], label:has-text("Yes") input, input[type="checkbox"][value*="yes" i]');
        if (yesRadio) { await yesRadio.check(); console.log('    Answered: authorized to work = yes'); await delay(300); }
      }

      // Sponsorship
      if (qText.includes('sponsorship') || qText.includes('visa') || qText.includes('require sponsorship')) {
        const answer = wa.requiresSponsorship ? 'yes' : 'no';
        const radio = await q.$(`input[type="radio"][value*="${answer}" i], label:has-text("${answer === 'yes' ? 'Yes' : 'No'}") input`);
        if (radio) { await radio.check(); console.log('    Answered: requires sponsorship = ' + answer); await delay(300); }
      }

      // Veteran status
      if (qText.includes('veteran')) {
        const vetAnswer = eeo.veteran || '';
        const radio = await q.$(`label:has-text("${vetAnswer}") input, input[value*="${vetAnswer}" i]`);
        if (radio) { await radio.check(); console.log('    Answered: veteran status'); await delay(300); }
      }

      // Disability
      if (qText.includes('disability')) {
        const disAnswer = eeo.disability || '';
        const radio = await q.$(`label:has-text("${disAnswer}") input, input[value*="${disAnswer}" i]`);
        if (radio) { await radio.check(); console.log('    Answered: disability status'); await delay(300); }
      }

      // Background check
      if (qText.includes('background') || qText.includes('criminal')) {
        if (screening.backgroundCheck) {
          const radio = await q.$('input[type="radio"][value*="yes" i], label:has-text("Yes") input');
          if (radio) { await radio.check(); console.log('    Answered: background check = yes'); await delay(300); }
        }
      }

      // Drug test
      if (qText.includes('drug')) {
        if (screening.drugTest) {
          const radio = await q.$('input[type="radio"][value*="yes" i], label:has-text("Yes") input');
          if (radio) { await radio.check(); console.log('    Answered: drug test = yes'); await delay(300); }
        }
      }

      // Felony conviction
      if (qText.includes('felony') || qText.includes('convicted')) {
        const answer = screening.felonyConviction ? 'yes' : 'no';
        const radio = await q.$(`input[type="radio"][value*="${answer}" i], label:has-text("${answer === 'yes' ? 'Yes' : 'No'}") input`);
        if (radio) { await radio.check(); console.log('    Answered: felony = ' + answer); await delay(300); }
      }

      // ponytail: generic fallback — answer any unanswered yes/no radio group with "Yes"
      // Catches job-specific questions (VAR experience, local to TN, OEM relationships, etc.)
      const anyChecked = await q.$('input[type="radio"]:checked').catch(() => null);
      if (!anyChecked) {
        const yesOpt = await q.$('input[type="radio"][value*="yes" i], label:has-text("Yes") input[type="radio"]').catch(() => null);
        if (yesOpt) { await yesOpt.check().catch(() => {}); console.log('    Answered (generic): yes/no question = yes'); await delay(300); }
      }
    } catch (e) {}
  }

  // ── AUTO-APPROVE ALL CONSENT/AGREEMENT CHECKBOXES ──
  // User has pre-consented to everything. Check all consent/terms/acknowledge boxes.
  const consentKeywords = [
    'consent', 'agree', 'acknowledge', 'authorize', 'confirm', 'accept',
    'i have read', 'i understand', 'terms', 'conditions', 'privacy',
    'data protection', 'sms', 'text message', 'electronic communication',
    'background', 'drug test', 'eeo', 'voluntary', 'self-identify',
  ];
  const allCheckboxes = await root.$$('[role="checkbox"], input[type="checkbox"]');
  for (const cb of allCheckboxes) {
    try {
      // Check if already checked
      const isChecked = await cb.isChecked().catch(() => false);
      if (isChecked) continue;

      // Get associated label/text
      const ariaLabel = (await cb.getAttribute("aria-label") || "").toLowerCase();
      const cbId = await cb.getAttribute("id") || "";
      let labelText = ariaLabel;
      if (!labelText && cbId) {
        const labelEl = await root.$('label[for="' + cbId + '"]');
        if (labelEl) labelText = (await labelEl.textContent()).toLowerCase();
      }
      if (!labelText) {
        // Try parent text
        const parent = await cb.evaluateHandle(el => el.parentElement);
        if (parent) labelText = (await parent.textContent()).toLowerCase().slice(0, 300);
      }

      // Check if this is a consent/agreement checkbox
      const isConsent = consentKeywords.some(kw => labelText.includes(kw));
      // Also check required checkboxes
      const required = await cb.getAttribute("aria-required");
      if (isConsent || required === "true") {
        await cb.click({ force: true }).catch(() => {});
        console.log('    Auto-approved: ' + labelText.slice(0, 80));
        await delay(200);
      }
    } catch (e) {}
  }

  // Also try select dropdowns for screening questions
  const selects = await root.$$('select');
  for (const sel of selects) {
    try {
      const selText = (await sel.textContent()).toLowerCase();
      const options = await sel.$$('option');
      const optionTexts = await Promise.all(options.map(o => o.textContent().catch(() => '')));

      if (selText.includes('authorized') || selText.includes('work')) {
        for (let i = 0; i < optionTexts.length; i++) {
          if (optionTexts[i].toLowerCase().includes('yes') || optionTexts[i].toLowerCase().includes('authorized')) {
            await sel.selectOption({ index: i }); console.log('    Selected: ' + optionTexts[i]); break;
          }
        }
      }
      if (selText.includes('sponsorship')) {
        for (let i = 0; i < optionTexts.length; i++) {
          if (optionTexts[i].toLowerCase().includes('no') || optionTexts[i].toLowerCase().includes('not')) {
            await sel.selectOption({ index: i }); console.log('    Selected: ' + optionTexts[i]); break;
          }
        }
      }
      if (selText.includes('gender') || selText.includes('sex')) {
        for (let i = 0; i < optionTexts.length; i++) {
          if (eeo.gender && optionTexts[i].toLowerCase().includes(eeo.gender.toLowerCase())) {
            await sel.selectOption({ index: i }); console.log('    Selected: ' + optionTexts[i]); break;
          }
        }
      }
      if (selText.includes('race') || selText.includes('ethnic')) {
        for (let i = 0; i < optionTexts.length; i++) {
          if (eeo.race && optionTexts[i].toLowerCase().includes(eeo.race.toLowerCase())) {
            await sel.selectOption({ index: i }); console.log('    Selected: ' + optionTexts[i]); break;
          }
        }
      }
      if (selText.includes('veteran')) {
        for (let i = 0; i < optionTexts.length; i++) {
          if (eeo.veteran && optionTexts[i].toLowerCase().includes(eeo.veteran.toLowerCase())) {
            await sel.selectOption({ index: i }); console.log('    Selected: ' + optionTexts[i]); break;
          }
        }
      }
    } catch (e) {}
  }
}

// ── FILE UPLOAD ──
async function uploadResume(page, resumePath) {
  if (!resumePath || !fs.existsSync(resumePath)) {
    console.log('    No resume file to upload');
    return false;
  }

  // Strategy 1: Direct file input
  const fileInputs = await page.$$('input[type="file"]');
  for (const fi of fileInputs) {
    try {
      await fi.setInputFiles(resumePath);
      console.log('    Uploaded resume: ' + resumePath);
      await delay(2000);
      return true;
    } catch (e) {}
  }

  // Strategy 2: Click "upload" button then handle the file dialog
  const uploadBtns = await page.$$('button:has-text("Upload"), button:has-text("Attach"), button:has-text("Add file"), [class*="upload"], [class*="attach"], label:has-text("Resume"), label:has-text("CV")');
  for (const btn of uploadBtns) {
    try {
      // Set up file chooser handler before clicking
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 5000 }),
        btn.click(),
      ]);
      await fileChooser.setFiles(resumePath);
      console.log('    Uploaded resume via file chooser: ' + resumePath);
      await delay(2000);
      return true;
    } catch (e) {}
  }

  console.log('    Could not find resume upload field');
  return false;
}

// ── DIRECT RADIO FILLER ──
// Bypasses container selectors (fieldset/role="group") — LinkedIn EA uses bare artdeco divs.
// Groups all input[type="radio"] by name, answers each unchecked group with "Yes" or first option.
async function answerUnfilledRadios(page) {
  const allRadios = await page.$$('input[type="radio"]');
  if (!allRadios.length) return 0;

  const byName = {};
  for (const r of allRadios) {
    const name = await r.getAttribute('name');
    if (!name) continue;
    (byName[name] = byName[name] || []).push(r);
  }

  let answered = 0;
  for (const [, radios] of Object.entries(byName)) {
    const states = await Promise.all(radios.map(r => r.isChecked().catch(() => false)));
    if (states.some(Boolean)) continue;

    // Prefer the "Yes" option; fall back to first
    let target = null;
    for (const r of radios) {
      const val = (await r.getAttribute('value') || '').toLowerCase();
      if (val === 'yes' || val === 'true' || val.includes('yes')) { target = r; break; }
    }
    if (!target) {
      for (const r of radios) {
        const labelText = await page.evaluate(el => {
          const lbl = el.labels?.[0] || el.nextElementSibling || el.parentElement?.querySelector('label');
          return (lbl?.textContent || '').trim().toLowerCase();
        }, r);
        if (labelText === 'yes') { target = r; break; }
      }
    }
    if (!target) target = radios[0];

    if (target) {
      // Click the label if clicking the input fails (LinkedIn artdeco pattern)
      await target.click({ force: true }).catch(async () => {
        await page.evaluate(el => {
          const lbl = el.labels?.[0] || el.nextElementSibling;
          (lbl || el).click();
        }, target).catch(() => {});
      });
      answered++;
      await delay(300);
    }
  }
  if (answered > 0) console.log('    Answered ' + answered + ' unanswered radio group(s) → Yes');
  return answered;
}

// ── WIZARD NAVIGATION ──
async function navigateWizard(page, outDir, opts) {
  const maxSteps = 25;
  let step = 0;

  while (step < maxSteps) {
    console.log('\n  --- Wizard step ' + (step + 1) + ' ---');

    // Check for CAPTCHA
    const captcha = await checkCaptcha(page);
    if (captcha) {
      const solved = await waitForCaptchaSolve(page);
      if (!solved) return { status: 'captcha_failed' };
    }

    // Check for account creation / login requirement
    const accountResult = await checkAccountCreation(page, null, opts);
    if (accountResult && accountResult.status === 'account_created') {
      await delay(3000);
    }

    // Fill all fields on this page
    const filled = await fillAllFields(page, opts);
    console.log('  Filled ' + filled + ' fields');

    // Fill any unanswered radio groups (LinkedIn EA additional questions use artdeco divs, not fieldset)
    await answerUnfilledRadios(page);

    // Upload resume if there's a file input
    await uploadResume(page, opts.resume);

    await screenshot(page, outDir, 'step-' + step + '-filled');

    // Click Next / Continue / Submit / Apply
    const nextSelectors = [
      'button:has-text("Next")','button:has-text("Continue")','button:has-text("Review")',
      'button:has-text("Submit")','button:has-text("Apply")','button:has-text("Send Application")',
      'button:has-text("Complete")','button:has-text("Finish")','button:has-text("Done")',
      'button:has-text("Save and Continue")','button:has-text("Save & Continue")',
      'button[type="submit"]','button[type="button"][class*="next"]','button[type="button"][class*="continue"]',
      'input[type="submit"]','input[type="button"][value*="Next"]','input[type="button"][value*="Continue"]',
      'a:has-text("Next")','a:has-text("Continue")','a:has-text("Submit")','a:has-text("Apply")',
    ];

    let clicked = false;
    for (const sel of nextSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          const text = (await btn.textContent()).trim();
          if (text && !text.includes('Cancel') && !text.includes('Close') && !text.includes('Back') && !text.includes('Previous')) {
            // Check if button is disabled
            const disabled = await btn.isDisabled().catch(() => false);
            if (disabled) { console.log('  Button disabled: "' + text + '" — may need required fields'); continue; }
            await btn.click();
            console.log('  Clicked: "' + text + '"');
            clicked = true;
            await delay(3000);
            break;
          }
        }
      } catch (e) {}
    }

    if (!clicked) {
      console.log('  No Next/Submit button found. Checking if done...');

      // Check for success / confirmation
      // ponytail: "successfully"/"applied" removed — too broad (matches "Resume uploaded successfully", LinkedIn sidebar badges)
      const pageText = await page.evaluate(() => document.body ? document.body.innerText.toLowerCase() : '');
      if (pageText.includes('application was sent') || pageText.includes('application received') ||
          pageText.includes('application complete') || pageText.includes('application has been') ||
          (pageText.includes('thank you') && pageText.includes('application'))) {
        console.log('  Application submitted successfully!');
        await screenshot(page, outDir, 'final-submitted');
        return { status: 'submitted' };
      }

      // Check if there's an error message
      const errorEl = await page.$('[class*="error"]:not(:empty), .alert-danger, .form-error, [role="alert"]');
      if (errorEl) {
        const errorText = await errorEl.textContent().catch(() => '');
        if (errorText.trim()) {
          console.log('  Error detected: ' + errorText.trim().slice(0, 200));
          await screenshot(page, outDir, 'step-' + step + '-error');
          return { status: 'error', error: errorText.trim().slice(0, 500) };
        }
      }

      await screenshot(page, outDir, 'step-' + step + '-stuck');
      console.log('  Could not find next button or success message. Pausing for manual help.');
      console.log('  Please check the browser and press Enter if you fix it, or type "skip" to abort.');
      await page.bringToFront().catch(() => {});
      const response = await new Promise(resolve => {
        process.stdin.resume();
        process.stdin.once('data', d => resolve(d.toString().trim().toLowerCase()));
      });
      if (response === 'skip' || response === 'abort') return { status: 'manual_abort' };
      await delay(2000);
    }

    // Check for success after navigation
    await delay(2000);
    const pageText2 = await page.evaluate(() => document.body ? document.body.innerText.toLowerCase() : '');
    if (pageText2.includes('application was sent') || pageText2.includes('application received') ||
        pageText2.includes('application complete') || pageText2.includes('application has been') ||
        (pageText2.includes('thank you') && pageText2.includes('application'))) {
      console.log('  Application submitted successfully!');
      await screenshot(page, outDir, 'final-submitted');
      return { status: 'submitted' };
    }

    step++;
  }

  await screenshot(page, outDir, 'final');
  return { status: 'completed_unknown' };
}

// ── LINKEDIN EASY APPLY ──
async function applyLinkedIn(page, opts, outDir) {
  console.log('\n[LinkedIn]');
  const id = PROFILE.identity || {};

  // ponytail: input[name="session_key"] exists as hidden element even when logged in — require visible
  const loginCheck = await page.$('input[name="session_key"]:visible, .sign-in-form, .authwall');
  if (loginCheck) {
    console.log('  NOT LOGGED IN. Run: node login.js --board linkedin');
    return { status: 'not_logged_in' };
  }

  // Wait for the job card to fully render before looking for the Apply button
  await page.waitForSelector(
    'button.apply-button, button.jobs-apply-button, button[class*="_7704646e"], button[aria-label*="আবেদন"], button[aria-label*="apply" i]',
    { timeout: 15000 }
  ).catch(() => console.log('  Apply button wait timed out — trying anyway'));

  // Find Easy Apply / Apply button — force:true bypasses any overlay without needing to dismiss them
  const easyApplySelectors = [
    'button.jobs-apply-button', 'button[class*="jobs-apply"]', '.jobs-s-apply button',
    'button.jobs-apply-button--top-card',
    'button:has-text("Easy Apply")', 'button[aria-label*="Easy Apply"]',
    'button[class*="apply"][class*="button"]',  // matches apply-button class
    'button.apply-button',
  ];

  let eaClicked = false;
  for (const sel of easyApplySelectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click({ force: true });
        console.log('  Clicked Apply button (' + sel + ')');
        eaClicked = true;
        await delay(3000);
        break;
      }
    } catch (e) {}
  }

  // Fallback: scan all buttons by aria-label content (any language)
  if (!eaClicked) {
    try {
      const btns = await page.$$('button');
      for (const btn of btns) {
        const aria = await btn.getAttribute('aria-label') || '';
        const ariaLower = aria.toLowerCase();
        const isApply = ariaLower.includes('apply') ||
          ariaLower.includes('আবেদন') || ariaLower.includes('bewerben') ||
          ariaLower.includes('postular') || ariaLower.includes('candidater') ||
          ariaLower.includes('応募') || ariaLower.includes('지원') || ariaLower.includes('申请');
        if (!isApply) continue;
        await btn.click({ force: true });
        console.log('  Clicked Apply (aria fallback): aria="' + aria.slice(0, 40) + '"');
        eaClicked = true;
        await delay(3000);
        break;
      }
    } catch (e) {}
  }

  if (!eaClicked) {
    // Check for external apply
    const extBtn = await page.$('a:has-text("Apply"), a:has-text("Apply Now"), a:has-text("Apply on company website"), a[href*="safety/go"]');
    if (extBtn) {
      const href = await extBtn.getAttribute('href');
      console.log('  External Apply (not Easy Apply). Following redirect...');
      if (href && href.includes('safety/go')) {
        const urlMatch = href.match(/url=([^&]+)/);
        if (urlMatch) {
          const realUrl = decodeURIComponent(urlMatch[1]);
          console.log('  Decoded external URL: ' + realUrl.slice(0, 100));
          return { status: 'external_apply', externalUrl: realUrl };
        }
      }
      if (href && href.startsWith('http')) {
        return { status: 'external_apply', externalUrl: href };
      }
      return { status: 'external_apply', externalUrl: href };
    }
    console.log('  No Easy Apply or Apply button found');
    return { status: 'no_easy_apply' };
  }

  // ponytail: LinkedIn EA navigates the current page to /jobs/view/{id}/apply/ — not a modal
  // Wait for that navigation, then work on the apply page (may have an iframe)
  await delay(5000);

  const applyUrl = page.url();
  console.log('  Post-click URL: ' + applyUrl.slice(0, 100));

  if (!applyUrl.includes('/apply/')) {
    // Didn't navigate — check for a modal (some jobs still use modal in certain A/B tests)
    const modal = await page.$('.artdeco-modal[role="dialog"], [role="dialog"], .jobs-easy-apply-modal, .artdeco-modal__content').catch(() => null);
    if (modal) {
      console.log('  Found Easy Apply modal (fallback)');
      return await navigateWizard(page, outDir, opts);
    }
    console.log('  No /apply/ navigation and no modal found');
    await page.screenshot({ path: path.join(outDir, 'li-no-apply.png') });
    return { status: 'no_easy_apply_modal' };
  }

  console.log('  On apply page. Looking for iframe...');
  await delay(3000);

  // ponytail: LinkedIn EA form is on the main /apply/ page — all child iframes are tracking pixels
  console.log('  Form is on main apply page — using wizard');
  return await navigateWizard(page, outDir, opts);

  // Fill the Easy Apply form inside the iframe
  console.log('  Filling Easy Apply iframe form...');

  for (let step = 0; step < 8; step++) {
    console.log('  Easy Apply step ' + (step + 1) + '...');
    await delay(2000);

    // Fill text inputs in the iframe
    const frameInputs = await applyFrame.$$('input:visible, textarea:visible').catch(() => []);
    for (const inp of frameInputs) {
      try {
        const type = await inp.getAttribute('type') || 'text';
        if (type === 'file' || type === 'hidden' || type === 'submit') continue;
        const label = (await inp.getAttribute('aria-label') || await inp.getAttribute('placeholder') || '').toLowerCase();
        const cv = await inp.inputValue().catch(() => '');
        if (cv && cv.trim()) continue;

        let value = '';
        if (type === 'tel' || label.includes('phone')) value = id.phone || '';
        else if (type === 'email' || label.includes('email')) value = id.email || '';
        else if (label.includes('first')) value = id.firstName || '';
        else if (label.includes('last')) value = id.lastName || '';
        else if (label.includes('city')) value = id.city || '';
        else if (label.includes('state') || label.includes('province')) value = id.state || '';
        else if (label.includes('zip') || label.includes('postal')) value = id.postalCode || '';
        else if (label.includes('address')) value = id.address1 || id.location || '';
        else if (label.includes('salary') || label.includes('compensation')) value = PROFILE.jobPreferences?.salaryExpectation || '';
        else if (label.includes('linkedin') || label.includes('website')) value = id.linkedinUrl || '';

        if (value) {
          await inp.click({ clickCount: 3 }).catch(() => {});
          await inp.fill(value).catch(() => {});
          console.log('    Filled: ' + label + ' = ' + value.slice(0, 30));
        }
      } catch (e) {}
    }

    // Upload resume if file input present
    if (opts.resume && fs.existsSync(opts.resume)) {
      const fileInputs = await applyFrame.$$('input[type="file"]').catch(() => []);
      for (const fi of fileInputs) {
        try { await fi.setInputFiles(opts.resume); console.log('    Uploaded resume'); await delay(2000); break; } catch (e) {}
      }
    }

    // Handle screening questions in iframe
    await fillScreeningQuestions(applyFrame, applyFrame);

    // Find Next/Review/Submit in the iframe
    const nextSelectors = [
      'footer button:last-child', 'button[type="submit"]',
      'button:has-text("Next")', 'button:has-text("Review")', 'button:has-text("Submit")',
      'button:has-text("Continue")', 'button:has-text("Send")',
    ];

    let advanced = false;
    for (const sel of nextSelectors) {
      try {
        const btn = await applyFrame.$(sel);
        if (!btn) continue;
        const disabled = await btn.isDisabled().catch(() => false);
        if (disabled) continue;
        const text = (await btn.textContent()).trim();
        console.log('    Clicking: ' + text);
        await btn.click();
        advanced = true;
        await delay(2000);
        if (text.toLowerCase().includes('submit') || text.toLowerCase().includes('send')) {
          console.log('  APPLICATION SUBMITTED!');
          await page.screenshot({ path: path.join(outDir, 'li-easy-apply-submitted.png') });
          return { status: 'submitted', platform: 'linkedin' };
        }
        break;
      } catch (e) {}
    }

    if (!advanced) {
      const pageText = await page.evaluate(() => document.body ? document.body.innerText.toLowerCase() : '');
      if (pageText.includes('application was sent') || pageText.includes('submitted') || pageText.includes('applied')) {
        console.log('  APPLICATION SUBMITTED!');
        return { status: 'submitted', platform: 'linkedin' };
      }
      console.log('    No next button — may be done or stuck');
      break;
    }
  }

  await page.screenshot({ path: path.join(outDir, 'li-easy-apply-result.png') });
  return { status: 'easy_apply_partial', platform: 'linkedin' };
}

// ── INDEED APPLY ──
async function applyIndeed(page, opts, outDir) {
  console.log('\n[Indeed]');

  // Check if logged in
  const loggedIn = await page.$('.gnav-UserMenu, [data-testid="user-menu"]');
  const loginCheck = await page.$('#login-email, #login-password, .gnav-LoginButton');
  if (loginCheck && !loggedIn) {
    console.log('  NOT LOGGED IN. Run: node login.js --board indeed');
    return { status: 'not_logged_in' };
  }

  // Find Apply button
  const applySelectors = [
    'button:has-text("Apply now")','button:has-text("Apply Now")','button:has-text("Apply")',
    '#applyButton','[data-testid="apply-button"]','.jobsearch-ApplyButton',
  ];

  for (const sel of applySelectors) {
    try {
      const btn = await page.$(sel);
      if (btn) { await btn.click(); console.log('  Clicked Apply'); await delay(3000); break; }
    } catch (e) {}
  }

  // Indeed may redirect to external or show its own form
  const isIndeedApply = await page.$('.ia-FormFields, .ia-questions, [data-testid="apply-form"]');
  if (!isIndeedApply && page.url().includes('indeed.com') === false) {
    console.log('  Redirected to external site: ' + page.url());
    return await navigateWizard(page, outDir, opts);
  }

  // Use wizard handler
  return await navigateWizard(page, outDir, opts);
}

// ── MAIN ──
async function main() {
  const opts = parseArgs();
  const platform = detectPlatform(opts.url);
  const dateStr = new Date().toISOString().slice(0, 10);
  const outDir = path.join(ROOT, 'output', dateStr + '-apply-' + platform);
  fs.mkdirSync(outDir, { recursive: true });

  // Determine which browser profile to use
  let profileDir;
  if (platform === 'linkedin') profileDir = path.join(ROOT, 'profiles', 'linkedin');
  else if (platform === 'indeed') profileDir = path.join(ROOT, 'profiles', 'indeed');
  else profileDir = path.join(ROOT, 'profiles', 'generic');

  fs.mkdirSync(profileDir, { recursive: true });

  console.log('\n=== AUTO-APPLY ===');
  console.log('Platform: ' + platform);
  console.log('URL: ' + opts.url);
  console.log('Resume: ' + (opts.resume || '(none)'));
  console.log('Profile: ' + profileDir);
  if (opts.email) console.log('Account email: ' + opts.email);
  console.log('Output: ' + outDir);

  const browser = await chromium.launchPersistentContext(profileDir, {
    headless: opts.headless,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
  });

  // Inject saved session cookies so LinkedIn recognizes the session even after bot detection clears them
  const cookiePath = path.join(profileDir, 'session-cookies.json');
  if (fs.existsSync(cookiePath)) {
    const savedCookies = JSON.parse(fs.readFileSync(cookiePath, 'utf-8'));
    await browser.addCookies(savedCookies).catch(() => {});
    console.log('  Loaded ' + savedCookies.length + ' session cookies');
  }

  const page = await browser.newPage();
  page.setDefaultTimeout(30000);

  let result;
  try {
    console.log('\n  Navigating to job posting...');
    await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await delay(3000);
    await screenshot(page, outDir, '01-landing');

    // Auto-generate tailored resume if none provided
    if (!opts.resume) {
      console.log('\n  No resume — extracting JD and generating tailored resume...');
      // Wait for job title to render (LinkedIn SPA loads async)
      await page.waitForSelector('h1, .job-details-jobs-unified-top-card__job-title, .t-24', { timeout: 15000 }).catch(() => {});
      await delay(2000);
      const jobInfo = await page.evaluate(() => {
        const titleEl = document.querySelector('.job-details-jobs-unified-top-card__job-title h1, .job-details-jobs-unified-top-card__job-title, .t-24.t-bold, h1');
        const companyEl = document.querySelector('.job-details-jobs-unified-top-card__company-name a, .job-details-jobs-unified-top-card__primary-description a, .topcard__org-name-link, a[href*="/company/"]');
        const jdEl = document.querySelector('.jobs-description__content, .jobs-description-content, .jobs-box__html-content, #job-details, [class*="description__text"]');
        // Parse "Job Title - Company | LinkedIn" from page title as reliable fallback
        const pageTitle = document.title || '';
        const pageTitleParts = pageTitle.replace(' | LinkedIn', '').split(' - ');
        const title = (titleEl?.innerText || '').trim() || pageTitleParts[0]?.trim() || 'Unknown Role';
        const company = (companyEl?.innerText || '').trim() || pageTitleParts[1]?.trim() || 'Unknown Company';
        const jd = (jdEl || document.body).innerText?.slice(0, 8000) || '';
        return { title, company, jd };
      });
      console.log('  Job: ' + jobInfo.title + ' at ' + jobInfo.company);
      const jdPath = path.join(outDir, 'jd.txt');
      fs.writeFileSync(jdPath, jobInfo.jd);
      const { spawnSync } = require('child_process');
      console.log('  Generating resume (~60s)...\n');
      const tailorResult = spawnSync('node', [
        path.join(ROOT, 'tailor.js'), '--jd', jdPath,
        '--company', jobInfo.company, '--title', jobInfo.title
      ], { cwd: ROOT, stdio: 'inherit', timeout: 300000 });
      if (tailorResult.status !== 0) {
        console.error('\n  Resume generation failed. Fix tailor.js then re-run with --resume path/to/resume.pdf');
        process.exit(1);
      }
      // Find the newest output dir with a resume.pdf
      const outputRoot = path.join(ROOT, 'output');
      const subdirs = fs.readdirSync(outputRoot)
        .map(d => path.join(outputRoot, d))
        .filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } })
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      for (const dir of subdirs) {
        const pdf = path.join(dir, 'resume.pdf');
        if (fs.existsSync(pdf)) { opts.resume = pdf; console.log('\n  Resume: ' + pdf); break; }
      }
      if (!opts.resume) {
        console.error('  No resume.pdf found after generation. Aborting.');
        process.exit(1);
      }
    }

    // Platform-specific handlers that don't need the generic flow
    if (platform === 'greenhouse') {
      result = await applyGreenhouse(page, opts, outDir);
    } else if (platform === 'lever') {
      result = await applyLever(page, opts, outDir);
    } else {

    // Check for account creation / login on the landing page
    const accountResult = await checkAccountCreation(page, browser, opts);
    if (accountResult && accountResult.status === 'account_created') {
      await delay(3000);
      await screenshot(page, outDir, '02-after-account');
    }

    // Find and click the Apply button (external sites usually have one)
    if (platform !== 'linkedin' && platform !== 'indeed') {
      // First check if the current page is already the Workday apply page
      const pageUrl = page.url();
      const pageText = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 500) : '');
      const isAlreadyWorkdayApply = pageUrl.includes('myworkdayjobs.com') && 
        (pageText.includes('Start Your Application') || pageText.includes('Apply Manually') || pageText.includes('Create Account') || pageText.includes('Password Requirements'));

      if (isAlreadyWorkdayApply) {
        console.log('  Already on Workday apply page. Starting application...');
        // Accept cookies if present
        const cookieBtn = await page.$('button:has-text("Accept Cookies"), button:has-text("Accept"), #onetrust-accept-btn-handler');
        if (cookieBtn) { await cookieBtn.click(); await delay(2000); }
        
        // Click Apply Manually to skip resume autofill
        const applyManual = await page.$('a:has-text("Apply Manually"), button:has-text("Apply Manually"), [data-automation-id*="applyManually"]');
        if (applyManual) { await applyManual.click({ force: true }); console.log('  Clicked Apply Manually'); await delay(4000); }
        
        // Now we should be on the account creation page — fill it directly
        console.log('  Filling Workday account creation form...');
        const emailInput = await page.$('[data-automation-id="email"], input[type="text"][data-automation-id="email"]');
        if (emailInput) {
          // Use fresh email with timestamp to avoid duplicate account errors
          const freshEmail = (opts.email || 'test@gmail.com').replace('@', '+wd' + Date.now() + '@');
          await emailInput.click({ clickCount: 3 });
          await emailInput.fill(freshEmail);
          console.log('  Filled email: ' + freshEmail);
          await page.fill('[data-automation-id="password"]', opts.password || 'Test1234!').catch(() => {});
          await page.fill('[data-automation-id="verifyPassword"]', opts.password || 'Test1234!').catch(() => {});
          console.log('  Filled password + verify');
          await delay(1000);
          
          // Click Create Account with force (bypasses Workday overlay)
          const createBtn = await page.$('[data-automation-id="createAccountSubmitButton"], button:has-text("Create Account")');
          if (createBtn) {
            await createBtn.click({ force: true }).catch(async () => {
              await page.evaluate(() => { const b = document.querySelector('[data-automation-id="createAccountSubmitButton"]'); if (b) b.click(); });
            });
            console.log('  Clicked Create Account (force)');
            await delay(5000);
          }
          
          // Check if email verification is needed
          const afterText = await page.evaluate(() => document.body ? document.body.innerText.toLowerCase() : '');
          const needsVerification = afterText.includes('verification') || afterText.includes('verify') || afterText.includes('check your email') || afterText.includes('code');
          
          if (needsVerification) {
            console.log('  *** EMAIL VERIFICATION REQUIRED ***');
            const emailCreds = PROFILE.emailCredentials || {};
            if (emailCreds.appPassword) {
              console.log('  Auto-reading verification email via IMAP...');
              try {
                const { fetchEmails } = require('./email-reader.js');
                // Wait a few seconds for the email to arrive
                await delay(5000);
                const emails = await fetchEmails({ email: emailCreds.email, password: emailCreds.appPassword, since: 5 });
                const verifyEmails = emails.filter(e => {
                  const t = (e.subject + ' ' + e.preview).toLowerCase();
                  return t.includes('verify') || t.includes('code') || t.includes('workday') || t.includes('confirm') || t.includes('activate') || e.codes.length > 0 || e.links.length > 0;
                }).sort((a, b) => new Date(b.date) - new Date(a.date));
                
                if (verifyEmails.length > 0) {
                  const email = verifyEmails[0];
                  console.log('  Found verification email: ' + email.subject);
                  console.log('  Codes: ' + JSON.stringify(email.codes) + ', Links: ' + email.links.length);
                  
                  if (email.links && email.links.length > 0) {
                    const link = email.links.filter(l => !l.includes('unsubscribe') && !l.includes('privacy')).pop() || email.links[0];
                    console.log('  Opening verification link: ' + link.slice(0, 100));
                    await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 });
                    await delay(3000);
                    console.log('  Verification link opened');
                  } else if (email.codes && email.codes.length > 0) {
                    console.log('  Entering verification code: ' + email.codes[0]);
                    await enterVerificationCode(page, email.codes[0]);
                  }
                } else {
                  // Retry after 30s
                  console.log('  No verification email yet. Waiting 30s and retrying...');
                  await delay(30000);
                  const retry = await fetchEmails({ email: emailCreds.email, password: emailCreds.appPassword, since: 10 });
                  const retryVerify = retry.filter(e => {
                    const t = (e.subject + ' ' + e.preview).toLowerCase();
                    return t.includes('verify') || t.includes('code') || t.includes('workday') || e.codes.length > 0 || e.links.length > 0;
                  }).sort((a, b) => new Date(b.date) - new Date(a.date));
                  if (retryVerify.length > 0) {
                    console.log('  Found on retry: ' + retryVerify[0].subject);
                    if (retryVerify[0].links && retryVerify[0].links.length > 0) {
                      const link = retryVerify[0].links.filter(l => !l.includes('unsubscribe')).pop();
                      if (link) { await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 }); await delay(3000); }
                    } else if (retryVerify[0].codes && retryVerify[0].codes.length > 0) {
                      await enterVerificationCode(page, retryVerify[0].codes[0]);
                    }
                  } else {
                    console.log('  No verification email found after retry.');
                  }
                }
              } catch (e) {
                console.log('  IMAP error: ' + e.message);
              }
            } else {
              console.log('  No IMAP appPassword configured. Cannot auto-read.');
            }
          }
        }
        
        // Run the universal wizard for the remaining steps
        result = await navigateWizard(page, outDir, opts);
      } else {
        const applySelectors = [
          'a:has-text("Apply Now")','a:has-text("Apply")','button:has-text("Apply Now")','button:has-text("Apply")',
          'a[href*="apply"]','button:has-text("Start Application")',
          'button:has-text("Apply for this job")','button:has-text("Apply for job")',
          'input[type="button"][value*="Apply"]','input[type="submit"][value*="Apply"]',
        ];
        let clicked = false;
        for (const sel of applySelectors) {
          try {
            const btn = await page.$(sel);
            if (btn) {
              // Check if it's a link to a Workday URL — navigate directly instead of clicking
              const href = await btn.getAttribute('href');
              if (href && href.includes('myworkdayjobs.com')) {
                console.log('  Found Workday apply link: ' + href.slice(0, 100));
                await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await delay(4000);
                
                // Handle Workday apply page — cookies, Apply Manually, account creation, then wizard
                const wdCookieBtn = await page.$('button:has-text("Accept Cookies"), button:has-text("Accept"), #onetrust-accept-btn-handler');
                if (wdCookieBtn) { await wdCookieBtn.click(); await delay(2000); }
                
                const wdApplyManual = await page.$('a:has-text("Apply Manually"), button:has-text("Apply Manually"), [data-automation-id*="applyManually"]');
                if (wdApplyManual) { await wdApplyManual.click({ force: true }); console.log('  Clicked Apply Manually'); await delay(6000); }
                
                // Fill account creation form using locators (more reliable than page.$)
                console.log('  Filling Workday account creation form...');
                try {
                  const freshEmail = (opts.email || 'test@gmail.com').replace('@', '+wd' + Date.now() + '@');
                  await page.locator('[data-automation-id="email"]').fill(freshEmail).catch(() => {});
                  console.log('  Filled email: ' + freshEmail);
                  await page.locator('[data-automation-id="password"]').fill(opts.password || 'Test1234!').catch(() => {});
                  await page.locator('[data-automation-id="verifyPassword"]').fill(opts.password || 'Test1234!').catch(() => {});
                  console.log('  Filled password + verify');
                } catch(e) { console.log('  Form fill error: ' + e.message.slice(0, 100)); }
                await delay(1000);
                
                  const wdCreateBtn = await page.$('[data-automation-id="createAccountSubmitButton"], button:has-text("Create Account")');
                  if (wdCreateBtn) {
                    await wdCreateBtn.click({ force: true }).catch(async () => {
                      await page.evaluate(() => { const b = document.querySelector('[data-automation-id="createAccountSubmitButton"]'); if (b) b.click(); });
                    });
                    console.log('  Clicked Create Account (force)');
                    await delay(5000);
                  }
                  
                  // Check for email verification
                  const wdAfterText = await page.evaluate(() => document.body ? document.body.innerText.toLowerCase() : '');
                  const wdNeedsVerification = (wdAfterText.includes('verification') && !wdAfterText.includes('verify new password')) || 
                    wdAfterText.includes('check your email') || wdAfterText.includes('we sent') || 
                    wdAfterText.includes('enter the code') || wdAfterText.includes('verification code') ||
                    wdAfterText.includes('one-time') || wdAfterText.includes('otp');
                  if (wdNeedsVerification) {
                    console.log('  *** EMAIL VERIFICATION REQUIRED ***');
                    const emailCreds = PROFILE.emailCredentials || {};
                    if (emailCreds.appPassword) {
                      console.log('  Auto-reading verification email via IMAP...');
                      try {
                        const { fetchEmails } = require('./email-reader.js');
                        await delay(5000);
                        const emails = await fetchEmails({ email: emailCreds.email, password: emailCreds.appPassword, since: 5 });
                        const verifyEmails = emails.filter(e => {
                          const t = (e.subject + ' ' + e.preview).toLowerCase();
                          return t.includes('verify') || t.includes('code') || t.includes('workday') || t.includes('confirm') || e.codes.length > 0 || e.links.length > 0;
                        }).sort((a, b) => new Date(b.date) - new Date(a.date));
                        if (verifyEmails.length > 0) {
                          const email = verifyEmails[0];
                          console.log('  Found verification email: ' + email.subject);
                          if (email.links && email.links.length > 0) {
                            const link = email.links.filter(l => !l.includes('unsubscribe') && !l.includes('privacy')).pop() || email.links[0];
                            console.log('  Opening verification link: ' + link.slice(0, 100));
                            await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 });
                            await delay(3000);
                          } else if (email.codes && email.codes.length > 0) {
                            console.log('  Entering verification code: ' + email.codes[0]);
                            await enterVerificationCode(page, email.codes[0]);
                          }
                        } else {
                          console.log('  No verification email found yet. Waiting 30s...');
                          await delay(30000);
                          const retry = await fetchEmails({ email: emailCreds.email, password: emailCreds.appPassword, since: 10 });
                          const retryVerify = retry.filter(e => {
                            const t = (e.subject + ' ' + e.preview).toLowerCase();
                            return t.includes('verify') || t.includes('code') || t.includes('workday') || e.codes.length > 0 || e.links.length > 0;
                          }).sort((a, b) => new Date(b.date) - new Date(a.date));
                          if (retryVerify.length > 0) {
                            console.log('  Found on retry: ' + retryVerify[0].subject);
                            if (retryVerify[0].links && retryVerify[0].links.length > 0) {
                              const link = retryVerify[0].links.filter(l => !l.includes('unsubscribe')).pop();
                              if (link) { await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 }); await delay(3000); }
                            } else if (retryVerify[0].codes && retryVerify[0].codes.length > 0) {
                              await enterVerificationCode(page, retryVerify[0].codes[0]);
                            }
                          } else {
                            console.log('  No verification email found after retry.');
                          }
                        }
                      } catch (e) {
                        console.log('  IMAP error: ' + e.message);
                      }
                    } else {
                      console.log('  No IMAP appPassword configured. Cannot auto-read.');
                    }
                  }
                
                // Run the wizard for the remaining steps
                result = await navigateWizard(page, outDir, opts);
                clicked = true;
                break;
              }
              await btn.click({ force: true });
              console.log('  Clicked Apply button: ' + sel);
              clicked = true;
              await delay(4000);
              break;
            }
          } catch (e) {}
        }

        if (clicked) {
        // Check for account creation again after clicking apply
        const accountResult2 = await checkAccountCreation(page, browser, opts);
        if (accountResult2 && accountResult2.status === 'account_created') {
          await delay(3000);
        }
        // Run the universal wizard
        result = await navigateWizard(page, outDir, opts);
      } else {
        // No apply button found — maybe the form is already on the page
        console.log('  No explicit Apply button. Looking for application form on page...');
        const hasForm = await page.$('input[type="text"], input[type="email"], textarea, select');
        if (hasForm) {
          result = await navigateWizard(page, outDir, opts);
        } else {
          console.log('  Could not find application form or apply button.');
          await screenshot(page, outDir, 'no-form-found');
          result = { status: 'no_form_found' };
        }
      }
      } // end of else (not already on workday)
    } else if (platform === 'linkedin') {
      result = await applyLinkedIn(page, opts, outDir);
    } else if (platform === 'indeed') {
      result = await applyIndeed(page, opts, outDir);
    }
    } // end of else (not greenhouse/lever)

  } catch (e) {
    console.error('  Error: ' + e.message);
    await screenshot(page, outDir, 'error');
    result = { status: 'error', error: e.message };
  }

  // Save result
  const resultPath = path.join(outDir, 'result.json');
  fs.writeFileSync(resultPath, JSON.stringify({
    platform, url: opts.url, resume: opts.resume,
    timestamp: new Date().toISOString(), ...result,
  }, null, 2));

  console.log('\n=== RESULT ===');
  console.log('Status: ' + result.status);
  console.log('Result file: ' + resultPath);
  console.log('Screenshots: ' + outDir);

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
