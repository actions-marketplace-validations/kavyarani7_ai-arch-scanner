'use strict';

/**
 * diff.js
 * Compares two scanner JSON outputs (baseline vs PR branch)
 * and produces a structured diff + PR comment markdown.
 *
 * Usage:
 *   node diff.js <baseline.json> <pr.json> [--threshold 500]
 *
 * Outputs JSON to stdout:
 *   { summary, comment, thresholdBreached, newWarnCount }
 */

const fs   = require('fs');
const path = require('path');

// ─── HELPERS ──────────────────────────────────────────────────────────────

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function deltaSign(n) {
  if (n > 0)  return `+${n}`;
  if (n < 0)  return `${n}`;
  return '—';
}

function deltaSignDollar(n) {
  if (n > 0)  return `+$${n.toFixed(2)}`;
  if (n < 0)  return `-$${Math.abs(n).toFixed(2)}`;
  return '—';
}

function costIcon(cost, threshold) {
  if (threshold && cost > threshold) return '🔴';
  if (cost > 500)  return '🔴';
  if (cost > 100)  return '🟡';
  return '🟢';
}

function deltaIcon(delta) {
  if (delta > 0)  return '🔺';
  if (delta < 0)  return '🔽';
  return '➡️';
}

function pct(base, pr) {
  if (base === 0) return pr > 0 ? '+∞%' : '—';
  const p = ((pr - base) / base * 100).toFixed(0);
  return p > 0 ? `+${p}%` : `${p}%`;
}

// ─── FINDING DIFFING ──────────────────────────────────────────────────────

function extractFindings(data) {
  if (!data) return { warns: [], infos: [], recs: [] };
  return {
    warns: data.findings.flatMap(f =>
      f.issues.filter(i => i.severity === 'WARN').map(i => ({ file: f.path, ...i }))
    ),
    infos: data.findings.flatMap(f =>
      f.issues.filter(i => i.severity === 'INFO').map(i => ({ file: f.path, ...i }))
    ),
    recs: data.findings.flatMap(f =>
      f.recommendations.map(r => ({ file: f.path, ...r }))
    ),
  };
}

function diffFindings(baseFindings, prFindings) {
  // A finding is identified by file + type — simple key match
  const key = f => `${f.file}::${f.type}`;

  const baseKeys = new Set(baseFindings.map(key));
  const prKeys   = new Set(prFindings.map(key));

  const newFindings      = prFindings.filter(f => !baseKeys.has(key(f)));
  const resolvedFindings = baseFindings.filter(f => !prKeys.has(key(f)));

  return { newFindings, resolvedFindings };
}

function diffModels(baseData, prData) {
  if (!baseData || !prData) return { added: [], removed: [] };

  const baseModels = new Set(
    baseData.findings.flatMap(f => f.models)
  );
  const prModels = new Set(
    prData.findings.flatMap(f => f.models)
  );

  return {
    added:   [...prModels].filter(m => !baseModels.has(m)),
    removed: [...baseModels].filter(m => !prModels.has(m)),
  };
}

// ─── COMMENT BUILDER ──────────────────────────────────────────────────────

function buildComment(diff, opts = {}) {
  const { threshold, baseBranch = 'base', prBranch = 'this PR' } = opts;
  const {
    baseCost, prCost, costDelta, costPct,
    baseWarnCount, prWarnCount, warnDelta,
    baseInfoCount, prInfoCount,
    baseRecCount,  prRecCount,
    baseDupCount,  prDupCount,
    newWarns, resolvedWarns,
    newInfos, resolvedInfos,
    newRecs,
    modelDiff,
    thresholdBreached,
    hasBaseline,
  } = diff;

  let body = '## 🤖 AI Architecture Scan\n\n';

  if (!hasBaseline) {
    // First run — no baseline yet
    body += `> 📋 **First scan on \`${baseBranch}\`** — no baseline yet. `;
    body += `Next PR will show cost delta vs this baseline.\n\n`;
  }

  // ── Cost table ────────────────────────────────────────────────────────
  if (hasBaseline) {
    const cIcon  = costIcon(prCost, threshold);
    const dIcon  = deltaIcon(costDelta);
    const tNote  = threshold ? ` · threshold: $${threshold}` : '';

    body += `| | \`${baseBranch}\` | \`${prBranch}\` | Delta |\n`;
    body += `|---|---|---|---|\n`;
    body += `| ${cIcon} Monthly AI cost | $${baseCost.toFixed(2)} | **$${prCost.toFixed(2)}**${tNote} | ${dIcon} **${deltaSignDollar(costDelta)}** (${costPct}) |\n`;
    body += `| ${prWarnCount > baseWarnCount ? '⚠️' : '✅'} Warnings | ${baseWarnCount} | **${prWarnCount}** | ${deltaSign(warnDelta)} |\n`;
    body += `| ℹ️ Info | ${baseInfoCount} | ${prInfoCount} | ${deltaSign(prInfoCount - baseInfoCount)} |\n`;
    body += `| 💡 Recommendations | ${baseRecCount} | ${prRecCount} | ${deltaSign(prRecCount - baseRecCount)} |\n`;
    body += `| 🔁 Duplicates | ${baseDupCount} | ${prDupCount} | ${deltaSign(prDupCount - baseDupCount)} |\n`;
  } else {
    // No baseline — single column
    const cIcon = costIcon(prCost, threshold);
    body += `| | |\n|---|---|\n`;
    body += `| ${cIcon} Est. monthly AI cost | **$${prCost.toFixed(2)}/month** |\n`;
    body += `| ${prWarnCount > 0 ? '⚠️' : '✅'} Warnings | **${prWarnCount}** |\n`;
    body += `| ℹ️ Info findings | **${prInfoCount}** |\n`;
    body += `| 💡 Recommendations | **${prRecCount}** |\n`;
    body += `| 🔁 Duplicates | **${prDupCount}** |\n`;
  }

  body += '\n';

  // ── Threshold breach ──────────────────────────────────────────────────
  if (thresholdBreached) {
    body += `> 🔴 **Cost threshold breached**: estimated $${prCost.toFixed(2)}/month exceeds $${threshold}/month limit.\n\n`;
  }

  // ── Model changes ─────────────────────────────────────────────────────
  if (hasBaseline && (modelDiff.added.length > 0 || modelDiff.removed.length > 0)) {
    body += '### 🔄 Model Changes\n\n';
    if (modelDiff.added.length > 0) {
      body += `- **Added**: ${modelDiff.added.map(m => `\`${m}\``).join(', ')}\n`;
    }
    if (modelDiff.removed.length > 0) {
      body += `- **Removed**: ${modelDiff.removed.map(m => `\`${m}\``).join(', ')}\n`;
    }
    body += '\n';
  }

  // ── New warnings ──────────────────────────────────────────────────────
  if (newWarns.length > 0) {
    body += '### ⚠️ New Warnings Introduced\n\n';
    for (const w of newWarns.slice(0, 5)) {
      body += `- **\`${w.file}\`** \`[${w.type}]\`\n`;
      body += `  ${w.detail.slice(0, 220)}\n\n`;
    }
  }

  // ── Resolved warnings ─────────────────────────────────────────────────
  if (resolvedWarns.length > 0) {
    body += '### ✅ Warnings Resolved by This PR\n\n';
    for (const w of resolvedWarns.slice(0, 5)) {
      body += `- ~~\`${w.file}\`~~ \`[${w.type}]\` — fixed ✓\n`;
    }
    body += '\n';
  }

  // ── New recommendations ───────────────────────────────────────────────
  if (newRecs.length > 0) {
    body += '### 💡 New Recommendations\n\n';
    for (const r of newRecs.slice(0, 3)) {
      body += `- **\`${r.file}\`**: ${r.detail.slice(0, 200)}\n\n`;
    }
  }

  // ── Existing unresolved warnings (always show) ────────────────────────
  const existingWarns = diff.allPrWarns.filter(w =>
    !newWarns.some(n => n.file === w.file && n.type === w.type)
  );
  if (existingWarns.length > 0) {
    body += '<details>\n<summary>⚠️ Existing warnings (carried from base)</summary>\n\n';
    for (const w of existingWarns.slice(0, 5)) {
      body += `- **\`${w.file}\`**: ${w.detail.slice(0, 180)}\n\n`;
    }
    body += '</details>\n\n';
  }

  // ── Footer ────────────────────────────────────────────────────────────
  body += '---\n';
  body += '_[AI Architecture Scanner](https://github.com/marketplace/actions/ai-architecture-scanner) ';
  body += `· Baseline: \`${baseBranch}\` · Scanned at ${new Date().toISOString().slice(0, 16)}Z_\n`;

  return body;
}

// ─── MAIN DIFF COMPUTATION ────────────────────────────────────────────────

function computeDiff(baseData, prData, opts = {}) {
  const { threshold } = opts;
  const hasBaseline = baseData !== null;

  const baseCost = baseData?.meta?.totalMonthly ?? 0;
  const prCost   = prData?.meta?.totalMonthly   ?? 0;
  const costDelta = prCost - baseCost;
  const costPct   = pct(baseCost, prCost);

  const baseF = extractFindings(baseData);
  const prF   = extractFindings(prData);

  const warnDiff = diffFindings(baseF.warns, prF.warns);
  const infoDiff = diffFindings(baseF.infos, prF.infos);
  const recDiff  = diffFindings(baseF.recs,  prF.recs);

  const baseDupCount = baseData?.duplicates?.length ?? 0;
  const prDupCount   = prData?.duplicates?.length   ?? 0;

  const thresholdBreached = threshold ? prCost > parseFloat(threshold) : false;

  const diff = {
    hasBaseline,
    baseCost,
    prCost,
    costDelta,
    costPct,
    baseWarnCount: baseF.warns.length,
    prWarnCount:   prF.warns.length,
    warnDelta:     prF.warns.length - baseF.warns.length,
    baseInfoCount: baseF.infos.length,
    prInfoCount:   prF.infos.length,
    baseRecCount:  baseF.recs.length,
    prRecCount:    prF.recs.length,
    baseDupCount,
    prDupCount,
    newWarns:      warnDiff.newFindings,
    resolvedWarns: warnDiff.resolvedFindings,
    newInfos:      infoDiff.newFindings,
    resolvedInfos: infoDiff.resolvedFindings,
    newRecs:       recDiff.newFindings,
    allPrWarns:    prF.warns,
    modelDiff:     diffModels(baseData, prData),
    thresholdBreached,
  };

  const comment = buildComment(diff, opts);

  return {
    summary: {
      baseCost:      parseFloat(baseCost.toFixed(2)),
      prCost:        parseFloat(prCost.toFixed(2)),
      costDelta:     parseFloat(costDelta.toFixed(2)),
      costPct,
      newWarnCount:  warnDiff.newFindings.length,
      fixedWarnCount: warnDiff.resolvedFindings.length,
      thresholdBreached,
      hasBaseline,
    },
    comment,
  };
}

// ─── CLI ENTRY ────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const baselinePath = args[0];
  const prPath       = args[1];
  const threshIdx    = args.indexOf('--threshold');
  const threshold    = threshIdx !== -1 ? args[threshIdx + 1] : null;
  const baseBranch   = args[args.indexOf('--base-branch') + 1] || 'base';

  if (!prPath) {
    console.error('Usage: node diff.js <baseline.json> <pr.json> [--threshold 500] [--base-branch main]');
    process.exit(1);
  }

  const baseData = baselinePath && fs.existsSync(baselinePath) ? loadJson(baselinePath) : null;
  const prData   = loadJson(prPath);

  if (!prData) {
    console.error('Could not read PR scan JSON:', prPath);
    process.exit(1);
  }

  const result = computeDiff(baseData, prData, { threshold, baseBranch });
  console.log(JSON.stringify(result, null, 2));
}

main();
