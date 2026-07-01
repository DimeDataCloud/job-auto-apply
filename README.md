# Job Auto-Apply

Automated job application system. Tailors your resume for each job, searches LinkedIn and Indeed, ranks jobs by fit score, and auto-applies using Playwright with stealth anti-detection.

## Features

- **Resume Tailoring** — Uses Ollama (glm-5.2:cloud) to rewrite your resume summary, bullets, and skills for each job description. Generates a print-ready PDF.
- **Fit Scoring** — Scores jobs 0-100 against your resume using keyword overlap, skill matching, and role indicators.
- **Job Search** — Searches LinkedIn and Indeed with your preferences, extracts job descriptions, and scores each.
- **Auto-Apply** — Fills out job applications automatically on LinkedIn Easy Apply, Indeed Apply, and external career sites (Workday, Greenhouse, Lever, Taleo, iCIMS, generic forms).
- **Account Creation** — Auto-creates accounts on external career sites that require registration before applying.
- **Email Verification** — Auto-reads verification emails via IMAP (Gmail App Password), extracts verification links AND 4-8 digit codes, enters them into the page.
- **Consent Auto-Approve** — Automatically checks all consent/terms/acknowledge checkboxes. No manual clicking.
- **Stealth Anti-Detection** — Uses playwright-extra + puppeteer-extra-plugin-stealth to patch navigator.webdriver, WebGL renderer, plugins array, and canvas fingerprint.
- **Screening Questions** — Auto-answers work authorization, visa sponsorship, veteran status, disability, background check, drug test, and felony questions.

## Quick Start

### 1. Install Dependencies

```bash
npm install playwright playwright-extra puppeteer-extra-plugin-stealth imapflow
```

### 2. Install Ollama + Model

```bash
# Install Ollama: https://ollama.com
ollama pull glm-5.2:cloud
```

### 3. Set Up Your Profile

```bash
cp applicant-profile.example.json applicant-profile.json
```

Edit `applicant-profile.json` with your:
- Identity (name, email, phone, address, LinkedIn)
- Work authorization status
- EEO demographics
- Job preferences (roles, industries, locations)
- Account credentials (email + password for career site registration)
- Email credentials (Gmail App Password for IMAP auto-verification)

### 4. Set Up Your Resume

Create your master resume at `master-resumes/your-name.json` following the `master-resumes/example.json` template. Set `"activeResume": "your-name"` in `applicant-profile.json`.

### 5. Log Into Job Portals

```bash
node login.js --board linkedin   # Log into LinkedIn
node login.js --board indeed      # Log into Indeed
```

### 6. Run the Pipeline

```bash
# Score a single job
node fit-score.js --text "paste job description here"

# Tailor resume for a job
node tailor.js --text "JD text" --company "Acme Corp" --title "Account Executive"

# Search for jobs
node search.js --portals "linkedin,indeed" --titles "account executive,sdr" --locations "remote" --max 50

# Auto-apply to a job
node apply.js --url "https://careers.company.com/jobs/123" --resume "output/.../resume.pdf"
```

## Scripts

| Script | Purpose |
|--------|---------|
| `fit-score.js` | Score a job description against your resume (0-100) |
| `tailor.js` | Tailor resume for a specific job (generates PDF via Ollama) |
| `login.js` | One-time login for LinkedIn/Indeed (saves browser session) |
| `search.js` | Search LinkedIn/Indeed, score jobs, save ranked results |
| `apply.js` | Auto-apply to a job (fills forms, uploads resume, handles wizards) |
| `email-reader.js` | IMAP email reader for auto-verification (used by apply.js) |

## File Structure

```
job-applications/
├── .gitignore                    # Excludes profiles, output, real data
├── README.md                     # This file
├── package.json                  # npm scripts
├── applicant-profile.example.json  # Template — copy to applicant-profile.json
├── master-resumes/
│   └── example.json              # Example resume template
├── fit-score.js                  # Job scoring
├── tailor.js                     # Resume tailoring (Ollama)
├── login.js                      # Portal login
├── search.js                     # Job search
├── apply.js                      # Auto-apply engine
├── email-reader.js               # IMAP verification reader
├── profiles/                     # Browser sessions (gitignored)
│   ├── linkedin/
│   ├── indeed/
│   └── generic/
└── output/                       # Tailored resumes, search results (gitignored)
```

## How It Works

### Resume Tailoring

`tailor.js` sends the job description to Ollama's `glm-5.2:cloud` model with a prompt that asks it to rewrite only the summary, bullets, and skills — not the work history structure. This keeps output under 2K tokens, preventing truncation. The AI output is merged with the master resume and rendered through an HTML template to produce a PDF.

**Critical rule:** No numbers/metrics/percentages/dollar amounts in the output EXCEPT dates. This is enforced in the prompt and verified post-generation.

### Auto-Apply

`apply.js` detects the platform from the URL (LinkedIn, Indeed, Workday, Greenhouse, Lever, Taleo, iCIMS, generic) and adapts its strategy:

1. Navigates to the job posting
2. Finds and clicks the Apply button (or follows redirects to Workday)
3. Handles account creation if needed (fills email + password, clicks Create Account)
4. Auto-reads verification emails via IMAP if required
5. Fills all form fields using smart matching (name, aria-label, placeholder, label association)
6. Answers screening questions (work auth, visa, veteran, disability, background, drug test, felony)
7. Auto-approves all consent/terms/acknowledge checkboxes
8. Uploads resume (handles both file inputs and file chooser dialogs)
9. Navigates multi-page wizards (clicks Next/Continue/Submit)
10. Detects CAPTCHA and pauses for human solve
11. Detects success/error and reports status

### Email Verification

`email-reader.js` connects to Gmail via IMAP using an App Password (not your regular password). It:

- Fetches recent emails (configurable time window)
- Extracts verification links from HTML and plain text bodies
- Extracts 4-8 digit verification codes using 7 regex patterns:
  - Keyword-based ("code: 123456", "your verification code is 123456")
  - Subject line codes
  - Standalone codes on their own HTML line
  - Styled/bold code elements
  - Dashed codes ("123-456")
  - Bare 4-6 digit numbers (last resort, with phone number filtering)
- `apply.js` enters codes into single inputs, separate digit boxes, or textareas

## Important Notes

- **SSN:** NEVER collected, stored, or filled. If an application requires SSN, it's flagged for manual completion.
- **Workday honeypot:** Workday includes a honeypot field (`data-automation-id="beecatcher"`). Never fill it.
- **Workday state names:** Workday uses full state names ("Tennessee") not abbreviations ("TN").
- **Workday button clicks:** Use `{ force: true }` to bypass Angular SPA overlay interception.
- **Gmail App Password:** Regular Gmail passwords don't work for IMAP. Create an App Password at https://myaccount.google.com/apppasswords.
- **Rate limiting:** Add 5-10 second delays between applications to avoid being rate-limited.

## Hermes Agent Skill

This project includes a Hermes Agent skill (`job-auto-apply`) that provides a 12-step guided pipeline:

1. Resume Intake → 2. Info Confirmation → 3. Application Questionnaire (16 sections) → 4. Final Proof → 5. Job Preferences → 6. Portal Selection + Account Setup → 7. Login → 8. Job Search → 9. Ranking → 10. Job Selection → 11. Auto-Apply → 12. Completion

The skill is at `~/AppData/Local/hermes/skills/productivity/job-auto-apply/SKILL.md` and includes:
- Full questionnaire covering all Workday/application fields
- 18 documented pitfalls with solutions
- Workday wizard field map (6 steps, all fields mapped to profile keys)
- Verification checklist

## License

MIT