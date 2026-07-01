// email-reader.js — Self-contained IMAP reader for Gmail.
// Polls the inbox for recent verification/code emails and extracts links/codes.
// Used by apply.js to auto-complete email verification during job applications.
//
// Usage:
//   node email-reader.js --email "x@gmail.com" --password "app-password" [--since 5] [--from "workday"]
//   node email-reader.js --email "x@gmail.com" --password "app-password" --wait --timeout 120
//
// Output: JSON array of matching emails with subject, from, body, links, codes
//
// Requires: imapflow (npm install imapflow)
// Gmail users must use an App Password, not their regular password.
// Create one at: https://myaccount.google.com/apppasswords

const { ImapFlow } = require('imapflow');
const fs = require('fs');
const path = require('path');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { email: null, password: null, since: 2, from: null, wait: false, timeout: 120, folder: 'INBOX' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--email' && args[i+1]) opts.email = args[++i];
    else if (args[i] === '--password' && args[i+1]) opts.password = args[++i];
    else if (args[i] === '--since' && args[i+1]) opts.since = parseInt(args[++i]);
    else if (args[i] === '--from' && args[i+1]) opts.from = args[++i].toLowerCase();
    else if (args[i] === '--wait') opts.wait = true;
    else if (args[i] === '--timeout' && args[i+1]) opts.timeout = parseInt(args[++i]);
    else if (args[i] === '--folder' && args[i+1]) opts.folder = args[++i];
  }
  if (!opts.email || !opts.password) {
    console.error('Usage: node email-reader.js --email <email> --password <app-password> [--since <minutes>] [--from <filter>] [--wait] [--timeout <seconds>]');
    process.exit(1);
  }
  return opts;
}

// Extract verification links from HTML/text body
function extractLinks(body) {
  const links = [];
  // HTML href links
  const hrefRegex = /href=["']([^"']+)["']/gi;
  let match;
  while ((match = hrefRegex.exec(body)) !== null) {
    const url = match[1];
    if (url.startsWith('http') && !links.includes(url)) links.push(url);
  }
  // Plain text URLs
  const urlRegex = /https?:\/\/[^\s<>"']+/gi;
  while ((match = urlRegex.exec(body)) !== null) {
    const url = match[0].replace(/['"<>]+$/, '');
    if (!links.includes(url)) links.push(url);
  }
  return links;
}

// Extract verification codes (4-8 digit numeric, or 4-6 char alphanumeric)
// Handles many real-world email patterns:
//   - "Your verification code is 123456"
//   - "Code: 123456"
//   - "Your code:  123456"
//   - "OTP: 123456"
//   - Subject: "Your code: 123456"
//   - HTML emails where the code is in a large styled span/div by itself
//   - "123-456" style codes
//   - Codes surrounded by whitespace/newlines (standalone in HTML)
function extractCodes(body, subject) {
  const codes = [];
  const seen = new Set();

  function add(code) {
    // Clean the code — strip dashes, spaces, hyphens
    code = (code || '').toString().replace(/[\s-]/g, '');
    // Accept 4-8 char alphanumeric codes (letters + digits), or pure digits
    if (!code || code.length < 4 || code.length > 8) return;
    if (!/^[A-Z0-9]+$/i.test(code)) return;
    // Skip things that look like years, zip codes, or phone fragments
    if (/^\d{4}$/.test(code) && parseInt(code) > 1900 && parseInt(code) < 2100) return;
    if (!seen.has(code.toUpperCase())) {
      seen.add(code.toUpperCase());
      codes.push(code);
    }
  }

  // Combine subject + body for searching
  const searchText = (subject || '') + ' ' + body;

  // Pattern 1: Explicit "code" keyword followed by the code
  // "verification code is 123456", "your code: 123456", "code: 123456"
  const codeKeywordRegex = /(?:verification\s+code|verify\s+code|your\s+code|security\s+code|access\s+code|one[-\s]?time\s+(?:code|password|otp)|otp|pin|code)\s*(?:is|:|=|\s)+\s*([A-Z0-9]{4,8})/gi;
  let m;
  while ((m = codeKeywordRegex.exec(searchText)) !== null) { add(m[1]); }

  // Pattern 2: "enter ... code" / "use ... code" followed by digits
  const enterCodeRegex = /(?:enter|use|input|provide|type)\s+(?:the\s+)?(?:code|otp|pin)[:\s]*([A-Z0-9]{4,8})/i;
  if ((m = enterCodeRegex.exec(searchText)) !== null) { add(m[1]); }

  // Pattern 3: Code in subject line (e.g., "Your verification code: 123456")
  if (subject) {
    const subjectCodeRegex = /(?:code|verify|verification|otp|pin)[:\s]+([A-Z0-9]{4,8})/i;
    if ((m = subjectCodeRegex.exec(subject)) !== null) { add(m[1]); }
    // Subject that IS just the code: "123456"
    const bareSubjectCode = subject.trim().match(/^(\d{4,8})$/);
    if (bareSubjectCode) add(bareSubjectCode[1]);
  }

  // Pattern 4: Standalone numeric code on its own line (common in HTML emails)
  // The code is often in a <div> or styled element by itself
  const lines = searchText.split(/[\n\r]+|<br\s*\/?>/i);
  for (const line of lines) {
    const trimmed = line.replace(/<[^>]+>/g, '').trim();
    // A line that is JUST a 4-8 digit/alphanumeric code
    if (/^[A-Z0-9]{4,8}$/i.test(trimmed)) { add(trimmed); }
    // A line like "123456" with surrounding whitespace/punctuation
    const bareCode = trimmed.match(/^\s*([A-Z0-9]{4,8})\s*$/i);
    if (bareCode) add(bareCode[1]);
  }

  // Pattern 5: Code in large/bold HTML elements (styled for display)
  // <span style="font-size: 24px">123456</span> or <div class="code">123456</div>
  const styledCodeRegex = /<(?:span|div|p|b|strong|td|h[1-6])[^>]*(?:font-size|class[^=]*=["'][^"']*code)[^>]*>\s*([A-Z0-9]{4,8})\s*<\//gi;
  while ((m = styledCodeRegex.exec(body)) !== null) { add(m[1]); }

  // Pattern 6: Dashed codes "123-456" or "ABCD-1234"
  // But not phone numbers like 800-555-0199 (3-3-4 format) — strip those first
  const phoneStripped = searchText.replace(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, '')
                                  .replace(/\b\d{1}[-.\s]\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g, '');
  const dashedCodeRegex = /\b([A-Z0-9]{3,4}-[A-Z0-9]{3,4})\b/gi;
  while ((m = dashedCodeRegex.exec(phoneStripped)) !== null) { add(m[1]); }

  // Pattern 7: Last resort — bare 4-6 digit numbers in the body
  // Only use if we haven't found any codes yet (avoid false positives)
  // Skip numbers that are part of phone numbers (e.g., 1-800-555-0199 -> 800555)
  if (codes.length === 0) {
    // Remove phone-number-like patterns before searching for bare digits
    // Handles: 1-800-555-0199, 800-555-0199, 555-0199, 800.555.0199, (800) 555-0199
    const cleaned = searchText
      .replace(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, '')  // standard US phone
      .replace(/\b\d{1}[-.\s]\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g, '')  // 1-800-555-0199
      .replace(/\b\d{3}[-.\s]\d{4}\b/g, '');  // 555-0199
    const bareNumberRegex = /\b(\d{4,6})\b/g;
    while ((m = bareNumberRegex.exec(cleaned)) !== null) { add(m[1]); }
  }

  return codes;
}

// Clean HTML to plain text
function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchEmails(opts) {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: opts.email,
      pass: opts.password,
    },
    logger: false,
  });

  const results = [];

  try {
    await client.connect();
    const folder = opts.folder || 'INBOX';
    const lock = await client.getMailboxLock(folder);
    try {
      // Search for recent emails
      const sinceDate = new Date(Date.now() - opts.since * 60 * 1000);
      const searchCriteria = { since: sinceDate };

      let uids = await client.search(searchCriteria);

      if (!uids || uids.length === 0) {
        return results;
      }

      // Get last 10 emails max
      uids = uids.slice(-10);

      for (const uid of uids) {
        const msg = await client.fetchOne(uid, { envelope: true, source: true });
        if (!msg) continue;

        const env = msg.envelope || {};
        const fromAddr = (env.from && env.from[0] && env.from[0].address) ? env.from[0].address : '';
        const fromName = (env.from && env.from[0] && env.from[0].name) ? env.from[0].name : '';
        const subject = env.subject || '(no subject)';
        const date = env.date ? new Date(env.date) : new Date();

        // Filter by sender if specified
        if (opts.from && !(fromAddr || '').toLowerCase().includes(opts.from) && !(subject || '').toLowerCase().includes(opts.from)) {
          continue;
        }

        // Parse body
        const source = msg.source || '';
        const sourceStr = source.toString('utf-8');

        // Try to extract HTML and text parts
        let htmlBody = '';
        let textBody = '';

        // Simple multipart extraction
        const htmlMatch = sourceStr.match(/Content-Type:\s*text\/html[\s\S]*?\r?\n\r?\n([\s\S]*?)(?:\r?\n--|\r?\n$)/i);
        const textMatch = sourceStr.match(/Content-Type:\s*text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?:\r?\n--|\r?\n$)/i);

        if (htmlMatch) htmlBody = htmlMatch[1];
        if (textMatch) textBody = textMatch[1];

        // Fallback: use whole source if no parts found
        if (!htmlBody && !textBody) {
          textBody = stripHtml(sourceStr).slice(0, 5000);
        }

        const plainText = (textBody || stripHtml(htmlBody) || '').slice(0, 5000);
        const fullBody = ((textBody || '') + '\n' + stripHtml(htmlBody || '')).trim() || '';

        const links = extractLinks((htmlBody || '') + ' ' + (textBody || ''));
        const codes = extractCodes(fullBody, subject || '');

        results.push({
          uid,
          from: fromAddr || '',
          fromName: fromName || '',
          subject: subject || '',
          date: date.toISOString(),
          preview: (plainText || '').slice(0, 500),
          links,
          codes,
        });
      }
    } finally {
      lock.release();
    }
  } catch (e) {
    console.error('IMAP error: ' + e.message);
  } finally {
    await client.logout().catch(() => {});
  }

  return results;
}

async function main() {
  const opts = parseArgs();

  console.log('=== EMAIL READER ===');
  console.log('Email: ' + opts.email);
  console.log('Since: ' + opts.since + ' minutes ago');
  if (opts.from) console.log('Filter from: ' + opts.from);
  if (opts.wait) console.log('Waiting for new emails (timeout: ' + opts.timeout + 's)');

  if (opts.wait) {
    // Poll mode: check every 10 seconds for new emails until timeout
    const startTime = Date.now();
    const pollInterval = 10000; // 10 seconds

    while (Date.now() - startTime < opts.timeout * 1000) {
      console.log('  Checking inbox...');
      const emails = await fetchEmails(opts);

      // Filter for verification-related emails
      const verifyEmails = emails.filter(e => {
        const text = (e.subject + ' ' + e.preview).toLowerCase();
        return text.includes('verify') || text.includes('verification') ||
               text.includes('confirm') || text.includes('activate') ||
               text.includes('account') || text.includes('code') ||
               text.includes('workday') || text.includes('welcome') ||
               e.links.length > 0 || e.codes.length > 0;
      });

      if (verifyEmails.length > 0) {
        console.log('\nFound ' + verifyEmails.length + ' verification email(s)!');
        console.log(JSON.stringify(verifyEmails, null, 2));
        return;
      }

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log('  No verification emails yet (' + elapsed + 's elapsed)');

      await new Promise(r => setTimeout(r, pollInterval));
    }

    console.log('\nTimeout reached. No verification emails found.');
    console.log(JSON.stringify([], null, 2));
  } else {
    // Single fetch mode
    const emails = await fetchEmails(opts);
    console.log('\nFound ' + emails.length + ' email(s)');
    console.log(JSON.stringify(emails, null, 2));
  }
}

module.exports = { fetchEmails, extractLinks, extractCodes, stripHtml };

// Only run main when called directly (not when required as a module)
if (require.main === module) {
  main().catch(e => { console.error('FATAL: ' + e.message); process.exit(1); });
}