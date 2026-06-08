# AI Architecture Scanner

[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-AI%20Architecture%20Scanner-blue?logo=github)](https://github.com/marketplace/actions/ai-architecture-scanner)

> Catch expensive AI patterns before they merge. SonarQube for AI cost & efficiency.

The AI Architecture Scanner runs on every pull request and posts a comment showing:
- **Estimated monthly AI cost** for the current branch
- **Cost delta vs your main branch** — did this PR make things more or less expensive?
- **Warnings** for misused models, missing retry logic, and caching opportunities
- **Recommendations** to reduce cost without changing behavior

---

## What it detects

| Finding | Example |
|---|---|
| Expensive model misuse | `claude-sonnet` used for 2-sentence outputs — Haiku costs 73% less |
| Missing retry/backoff | API calls that crash on rate limit errors |
| Caching opportunities | Large reused system prompts not using prompt caching |
| Duplicate call patterns | Same model called from 4 files that could share a service layer |
| Cost threshold breaches | Monthly spend projected to exceed your defined limit |

## Supported providers & languages

| Provider | Models detected |
|---|---|
| Anthropic | claude-haiku, claude-sonnet, claude-opus |
| OpenAI | gpt-4o, gpt-4o-mini, gpt-4-turbo, o1, o3-mini |
| Google | gemini-1.5-pro, gemini-1.5-flash, gemini-2.0-flash |
| AWS Bedrock | via BedrockRuntimeClient |
| LangChain | ChatOpenAI, ChatAnthropic, chains, agents |

| Language | Extensions |
|---|---|
| JavaScript | `.js` `.jsx` `.mjs` `.cjs` |
| TypeScript | `.ts` `.tsx` |

---

## Installation

### Step 1 — Create the workflow file

Create `.github/workflows/ai-scan.yml` in your repo (the filename can be anything):

```yaml
name: AI Architecture Scan

on:
  pull_request:
    branches: [main, master]
  push:
    branches: [main, master]

jobs:
  ai-scan:
    name: AI Architecture Review
    runs-on: ubuntu-latest
    permissions:
      contents: write       # stores baseline in ai-arch-scanner-cache branch
      pull-requests: write  # posts comment on PRs
    steps:
      - uses: actions/checkout@v4

      - uses: kavyarani7/ai-arch-scanner@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

### Step 2 — Push the workflow to main

```bash
git add .github/workflows/ai-scan.yml
git commit -m "add AI architecture scanner"
git push origin main
```

This push triggers the first scan on `main` and saves it as the **baseline**. A branch called `ai-arch-scanner-cache` will appear in your repo — this is where baselines are stored. You don't need to touch it.

### Step 3 — Open a pull request

The next PR targeting `main` will show a full cost analysis comment with a delta table comparing the PR to the baseline.

> **Note:** The very first PR after setup will show "First scan — no baseline yet" if it was opened before the push in Step 2 completed. Just re-run the action on that PR once the push workflow has finished.

---

## PR comment example

```
🤖 AI Architecture Scan

┌─────────────────────────┬────────────────────┐
│ Est. monthly AI cost    │ $157.81/month      │
│ Cost delta vs main      │ +$12.40 (+8.5%)    │
│ Warnings                │ 1 (1 new)          │
│ Info findings           │ 5                  │
│ Recommendations         │ 7                  │
└─────────────────────────┴────────────────────┘

⚠️ New Warnings Introduced

• server/services/divergence-detector.js — claude-sonnet used with
  max_tokens=150. Outputs ≤300 tokens on structured inputs strongly
  suggest a classification task. Haiku handles these at ~73% less cost.
```

---

## Configuration

All inputs are optional.

| Input | Default | Description |
|---|---|---|
| `path` | `.` | Directory to scan (relative to repo root) |
| `threshold` | _(none)_ | Fail if estimated monthly cost exceeds this USD amount |
| `post_pr_comment` | `true` | Post summary comment on PRs |
| `github_token` | `${{ github.token }}` | Token for posting PR comments and saving baselines |
| `fail_on_warn` | `false` | Block merge if any new WARN-level findings are introduced |

## Outputs

| Output | Description |
|---|---|
| `monthly_cost` | Estimated monthly AI cost in USD |
| `warn_count` | Total WARN-level findings |
| `new_warn_count` | New WARN-level findings introduced by this PR |
| `findings_count` | Total findings count |
| `threshold_breached` | `true` if monthly cost exceeds threshold |
| `report_path` | Path to the full text report |

### Using outputs in your workflow

```yaml
      - uses: kavyarani7/ai-arch-scanner@v1
        id: ai-scan
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          threshold: '500'

      - name: Block on cost threshold
        if: steps.ai-scan.outputs.threshold_breached == 'true'
        run: exit 1
```

---

## Run locally

No GitHub account or Docker required.

```bash
git clone https://github.com/kavyarani7/ai-arch-scanner
cd ai-arch-scanner

# Scan any local repo
node scanner.js /path/to/your/repo

# With cost threshold
node scanner.js /path/to/your/repo --threshold 500

# JSON output
node scanner.js /path/to/your/repo --json
```

Zero dependencies — pure Node.js built-ins.

---

## Troubleshooting

**"Resource not accessible by integration" (403)**
Your workflow is missing `contents: write` permission. Make sure your job has:
```yaml
permissions:
  contents: write
  pull-requests: write
```

**"First scan on main — no baseline yet" on every PR**
The `push` trigger is missing from your workflow `on:` block. Without it the baseline is never saved. Add:
```yaml
on:
  pull_request:
    branches: [main, master]
  push:
    branches: [main, master]   # ← this line saves the baseline
```

**Cost delta not showing after fixing the above**
Delete any existing `ai-arch-scanner-baseline-main-v1` entry under **Settings → Actions → Caches** in your repo, then re-run the push workflow on main.

**The `ai-arch-scanner-cache` branch appeared in my repo**
That's expected — it's where the action stores baseline JSON files. It's managed automatically and safe to ignore.

---

## Roadmap

- [ ] Python support
- [ ] Go support
- [ ] Prompt quality scoring
- [ ] AI security review (prompt injection detection)
- [ ] Dashboard & trend tracking

---

## License

MIT
