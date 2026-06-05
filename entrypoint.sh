#!/bin/sh
set -e

# ─── INPUTS ───────────────────────────────────────────────────────────────
SCAN_PATH="${1:-.}"
THRESHOLD="${2:-}"
POST_COMMENT="${3:-true}"
GITHUB_TOKEN="${4:-}"
FAIL_ON_WARN="${5:-false}"

# ─── PATHS ────────────────────────────────────────────────────────────────
REPORT_PATH="/tmp/ai-scan-report.txt"
PR_JSON="/tmp/ai-scan-pr.json"
BASELINE_JSON="/tmp/ai-scan-baseline.json"
DIFF_JSON="/tmp/ai-scan-diff.json"

# Resolve scan path
if [ -n "$GITHUB_WORKSPACE" ]; then
  FULL_PATH="$GITHUB_WORKSPACE/$SCAN_PATH"
else
  FULL_PATH="$SCAN_PATH"
fi

# Determine branch context
# On pull_request: GITHUB_BASE_REF = target branch (main), GITHUB_HEAD_REF = PR branch
# On push:        GITHUB_REF_NAME  = branch that was pushed to
IS_PR=false
BASE_BRANCH=""

if [ -n "$GITHUB_BASE_REF" ]; then
  IS_PR=true
  BASE_BRANCH="$GITHUB_BASE_REF"
elif [ -n "$GITHUB_REF_NAME" ]; then
  BASE_BRANCH="$GITHUB_REF_NAME"
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  AI Architecture Scanner v0.3"
echo "  Path       : $FULL_PATH"
echo "  Event      : $([ "$IS_PR" = "true" ] && echo "pull_request (base: $BASE_BRANCH)" || echo "push (branch: $BASE_BRANCH)")"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ─── STEP 1: SCAN CURRENT BRANCH ─────────────────────────────────────────
echo ""
echo "▶ Scanning codebase..."

# Full text report
THRESHOLD_FLAG=""
if [ -n "$THRESHOLD" ]; then
  THRESHOLD_FLAG="--threshold $THRESHOLD"
fi

node /app/scanner.js "$FULL_PATH" $THRESHOLD_FLAG > "$REPORT_PATH" 2>&1 || SCAN_EXIT=$?
node /app/scanner.js "$FULL_PATH" --json > "$PR_JSON" 2>/dev/null || true

cat "$REPORT_PATH"

# ─── STEP 2: LOAD OR SAVE BASELINE ───────────────────────────────────────

if [ "$IS_PR" = "true" ] && [ -n "$BASE_BRANCH" ]; then
  # On a PR: try to load the baseline from cache
  echo ""
  echo "▶ Loading baseline for branch: $BASE_BRANCH ..."
  node /app/cache.js read "$BASE_BRANCH" "$BASELINE_JSON" || true

  if [ -f "$BASELINE_JSON" ]; then
    echo "  ✓ Baseline loaded."
  else
    echo "  ℹ No baseline found — first scan on this branch."
    echo "    Push to $BASE_BRANCH to establish a baseline."
  fi

elif [ -n "$BASE_BRANCH" ]; then
  # On a push to base branch: save current scan as the new baseline
  echo ""
  echo "▶ Push to base branch detected — saving as new baseline..."
  node /app/cache.js write "$BASE_BRANCH" "$PR_JSON" || true
  echo "  ✓ Baseline saved for branch: $BASE_BRANCH"
fi

# ─── STEP 3: COMPUTE DIFF ─────────────────────────────────────────────────

BASELINE_ARG=""
if [ -f "$BASELINE_JSON" ]; then
  BASELINE_ARG="$BASELINE_JSON"
fi

BASE_BRANCH_FLAG=""
if [ -n "$BASE_BRANCH" ]; then
  BASE_BRANCH_FLAG="--base-branch $BASE_BRANCH"
fi

THRESHOLD_DIFF_FLAG=""
if [ -n "$THRESHOLD" ]; then
  THRESHOLD_DIFF_FLAG="--threshold $THRESHOLD"
fi

node /app/diff.js \
  "${BASELINE_ARG:-/nonexistent}" \
  "$PR_JSON" \
  $THRESHOLD_DIFF_FLAG \
  $BASE_BRANCH_FLAG \
  > "$DIFF_JSON" 2>/dev/null || true

# ─── STEP 4: PARSE OUTPUTS ────────────────────────────────────────────────

MONTHLY_COST=$(node -e "
  try {
    const d = JSON.parse(require('fs').readFileSync('$DIFF_JSON','utf8'));
    console.log(d.summary.prCost || 0);
  } catch(e) { console.log('0'); }
")

WARN_COUNT=$(node -e "
  try {
    const d = JSON.parse(require('fs').readFileSync('$PR_JSON','utf8'));
    const w = d.findings.flatMap(f => f.issues.filter(i => i.severity === 'WARN'));
    console.log(w.length);
  } catch(e) { console.log('0'); }
")

NEW_WARN_COUNT=$(node -e "
  try {
    const d = JSON.parse(require('fs').readFileSync('$DIFF_JSON','utf8'));
    console.log(d.summary.newWarnCount || 0);
  } catch(e) { console.log('0'); }
")

FINDINGS_COUNT=$(node -e "
  try {
    const d = JSON.parse(require('fs').readFileSync('$PR_JSON','utf8'));
    const all = d.findings.flatMap(f => [...f.issues, ...f.recommendations]);
    console.log(all.length);
  } catch(e) { console.log('0'); }
")

THRESHOLD_BREACHED=$(node -e "
  try {
    const d = JSON.parse(require('fs').readFileSync('$DIFF_JSON','utf8'));
    console.log(d.summary.thresholdBreached ? 'true' : 'false');
  } catch(e) { console.log('false'); }
")

# ─── STEP 5: GITHUB ACTION OUTPUTS ───────────────────────────────────────

if [ -n "$GITHUB_OUTPUT" ]; then
  echo "monthly_cost=$MONTHLY_COST"       >> "$GITHUB_OUTPUT"
  echo "warn_count=$WARN_COUNT"           >> "$GITHUB_OUTPUT"
  echo "new_warn_count=$NEW_WARN_COUNT"   >> "$GITHUB_OUTPUT"
  echo "findings_count=$FINDINGS_COUNT"   >> "$GITHUB_OUTPUT"
  echo "report_path=$REPORT_PATH"         >> "$GITHUB_OUTPUT"
  echo "threshold_breached=$THRESHOLD_BREACHED" >> "$GITHUB_OUTPUT"
fi

echo ""
echo "  Monthly cost  : \$$MONTHLY_COST"
echo "  Warnings      : $WARN_COUNT (new: $NEW_WARN_COUNT)"
echo "  Total findings: $FINDINGS_COUNT"

# ─── STEP 6: POST PR COMMENT ─────────────────────────────────────────────

if [ "$POST_COMMENT" = "true" ] && [ "$IS_PR" = "true" ] && [ -n "$GITHUB_TOKEN" ]; then

  PR_NUMBER=$(node -e "
    try {
      const e = JSON.parse(require('fs').readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));
      console.log(e.pull_request?.number || e.number || '');
    } catch(e) { console.log(''); }
  ")

  if [ -n "$PR_NUMBER" ] && [ "$PR_NUMBER" != "" ]; then

    # Get comment body from diff.js output
    COMMENT_BODY=$(node -e "
      const fs = require('fs');
      try {
        const diff = JSON.parse(fs.readFileSync('$DIFF_JSON', 'utf8'));
        let body = diff.comment;

        // Append full report in collapsible section
        body += '\n<details>\n<summary>📄 Full scan report</summary>\n\n\`\`\`\n';
        try {
          const txt = fs.readFileSync('$REPORT_PATH', 'utf8');
          body += txt.slice(0, 7000);
          if (txt.length > 7000) body += '\n... (truncated — see Action log for full report)';
        } catch(e) {}
        body += '\n\`\`\`\n</details>';

        console.log(JSON.stringify(body));
      } catch(e) {
        console.log(JSON.stringify('AI Architecture Scan complete. See Action log for details.'));
      }
    ")

    REPO="${GITHUB_REPOSITORY}"

    # Find existing bot comment to update (avoid comment spam on re-runs)
    EXISTING_COMMENT_ID=$(node -e "
      const https = require('https');
      const options = {
        hostname: 'api.github.com',
        path: '/repos/$REPO/issues/$PR_NUMBER/comments?per_page=50',
        headers: {
          'Authorization': 'Bearer $GITHUB_TOKEN',
          'User-Agent': 'ai-arch-scanner',
          'Accept': 'application/vnd.github.v3+json',
        }
      };
      let data = '';
      const req = https.get(options, res => {
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const comments = JSON.parse(data);
            const existing = comments.find(c =>
              c.body && c.body.includes('AI Architecture Scan') &&
              c.user?.type === 'Bot'
            );
            console.log(existing?.id || '');
          } catch(e) { console.log(''); }
        });
      });
      req.on('error', () => console.log(''));
      req.end();
    " 2>/dev/null || echo "")

    if [ -n "$EXISTING_COMMENT_ID" ] && [ "$EXISTING_COMMENT_ID" != "" ]; then
      # Update existing comment
      API_URL="https://api.github.com/repos/${REPO}/issues/comments/${EXISTING_COMMENT_ID}"
      METHOD="PATCH"
      echo ""
      echo "▶ Updating existing PR comment (ID: $EXISTING_COMMENT_ID)..."
    else
      # Create new comment
      API_URL="https://api.github.com/repos/${REPO}/issues/${PR_NUMBER}/comments"
      METHOD="POST"
      echo ""
      echo "▶ Posting new PR comment on PR #$PR_NUMBER..."
    fi

    curl -s -X "$METHOD" "$API_URL" \
      -H "Authorization: Bearer $GITHUB_TOKEN" \
      -H "Content-Type: application/json" \
      -H "User-Agent: ai-arch-scanner" \
      -H "Accept: application/vnd.github.v3+json" \
      -d "{\"body\": $COMMENT_BODY}" \
      > /dev/null

    echo "  ✓ Done."
  fi
fi

# ─── STEP 7: EXIT CODES ───────────────────────────────────────────────────

if [ "$FAIL_ON_WARN" = "true" ] && [ "$NEW_WARN_COUNT" -gt "0" ]; then
  echo ""
  echo "❌ fail_on_warn=true — $NEW_WARN_COUNT new WARN finding(s) introduced. Blocking merge."
  exit 1
fi

if [ "$THRESHOLD_BREACHED" = "true" ]; then
  echo ""
  echo "❌ Monthly cost \$$MONTHLY_COST exceeds threshold \$$THRESHOLD. Blocking merge."
  exit 1
fi

if [ -n "$SCAN_EXIT" ] && [ "$SCAN_EXIT" != "0" ]; then
  echo ""
  echo "❌ Scanner exited with code $SCAN_EXIT."
  exit 1
fi

echo ""
echo "✓ AI Architecture Scan complete."
exit 0
