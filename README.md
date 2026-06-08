# AI Architecture Scanner

> "SonarQube for AI Cost & Efficiency"

A GitHub Action that scans your codebase for AI API usage and posts findings directly on pull requests — before expensive patterns reach production.

## What it detects

- **All AI call sites** with file paths and line numbers
- **Cost projections** — estimated monthly spend per model
- **Expensive model misuse** — e.g. Sonnet used for 2-sentence outputs (Haiku does this at 73% less cost)
- **Duplicate call patterns** — same model called from multiple files that could share a service layer
- **Missing retry/backoff** — API calls that will crash on rate limit errors
- **Caching opportunities** — large reused system prompts not using prompt caching

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
| JavaScript | .js .jsx .mjs .cjs |
| TypeScript | .ts .tsx |

---

## Quick start

Add this to `.github/workflows/ai-scan.yml`:

```yaml
name: AI Architecture Scan

on:
  pull_request:
    branches: [main, master]
  push:
    branches: [main, master]   # required — saves the baseline after each merge

jobs:
  ai-scan:
    runs-on: ubuntu-latest
    permissions:
      contents: write          # required — saves baseline to ai-arch-scanner-cache branch
      pull-requests: write     # required — posts comment on PRs
    steps:
      - uses: actions/checkout@v4
      - uses: kavyarani7/ai-arch-scanner@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

**First-time setup — two steps:**

1. Add the workflow file above and push it to `main`.
2. The first push run establishes the baseline. After that, every PR will show a cost delta vs that baseline.

> **Cost delta won't appear on the very first PR** — it appears from the second PR onwards once a baseline exists on `main`.

> The action creates an `ai-arch-scanner-cache` branch in your repo to store baselines. This branch is managed automatically — you don't need to touch it.

---

## Configuration

| Input | Default | Description |
|---|---|---|
| `path` | `.` | Directory to scan |
| `threshold` | _(none)_ | Fail if est. monthly cost exceeds this USD amount |
| `post_pr_comment` | `true` | Post summary comment on PRs |
| `github_token` | `${{ github.token }}` | Token for PR comments |
| `fail_on_warn` | `false` | Block merge if WARN-level findings exist |

## Outputs

| Output | Description |
|---|---|
| `monthly_cost` | Estimated monthly AI cost in USD |
| `warn_count` | Number of WARN-level findings |
| `findings_count` | Total findings count |
| `report_path` | Path to full text report |

---

## What a PR comment looks like

```
## 🤖 AI Architecture Scan Results

| | |
|---|---|
| 🟡 Est. monthly AI cost | $151.81/month (threshold: $500) |
| ⚠️ Warnings | 1 |
| ℹ️ Info findings | 4 |
| 💡 Recommendations | 6 |
| 🔁 Duplicate call patterns | 1 |

### ⚠️ Warnings — fix before merge

- **server/services/divergence-detector.js**: claude-sonnet used with
  max_tokens=150. Outputs ≤300 tokens on structured inputs strongly suggest
  a classification task. Haiku handles these at ~73% less cost.

### 💡 Top Recommendations
- **automator/server.js**: 3 dynamic prompts detected. Prompt caching could
  reduce input token costs by up to 90%.
```

---

## Run locally (no GitHub required)

```bash
# Clone the scanner
git clone https://github.com/kavyarani7/ai-arch-scanner
cd ai-arch-scanner

# Scan any repo
node scanner.js /path/to/your/repo

# With cost threshold
node scanner.js /path/to/your/repo --threshold 500

# JSON output (for CI pipelines)
node scanner.js /path/to/your/repo --json
```

No npm install required. Zero dependencies — pure Node.js built-ins.

---

## Roadmap

- [ ] Python support (.py)
- [ ] Go support (.go)
- [ ] Prompt quality scoring
- [ ] AI security review (prompt injection detection)
- [ ] Hallucination risk patterns
- [ ] Dashboard & trend tracking (SaaS)

---

## License

MIT
