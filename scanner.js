#!/usr/bin/env node

/**
 * AI Architecture Scanner
 * "SonarQube for AI Cost & Efficiency"
 *
 * Scans JS/TS codebases for AI API usage and produces:
 *   - Call inventory with line numbers
 *   - Cost projections
 *   - Duplicate/redundant call detection
 *   - Architecture findings (WARN / INFO)
 *   - Prioritised quick wins
 *
 * Usage:
 *   node scanner.js /path/to/repo
 *   node scanner.js /path/to/repo --json          (machine-readable output)
 *   node scanner.js /path/to/repo --threshold 500  (exit 1 if monthly cost > $500)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── LANGUAGE MODULES ─────────────────────────────────────────────────────
const LANGUAGES = [
  require('./languages/js'),
  // require('./languages/python'),  // coming soon
  // require('./languages/go'),      // coming soon
];

// Build extension → module map
const EXT_MAP = new Map();
for (const lang of LANGUAGES) {
  // lang.extensions is a RegExp — we iterate common extensions manually
  const exts = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];
  for (const ext of exts) {
    if (lang.extensions.test('file' + ext)) EXT_MAP.set(ext, lang);
  }
}

// ─── PRICING TABLE ────────────────────────────────────────────────────────
// Per 1M tokens. Update as providers change pricing.
const PRICING = {
  // Anthropic
  'claude-haiku-4-5-20251001': { input: 0.80,  output: 4.00,  provider: 'anthropic' },
  'claude-haiku-4-5':          { input: 0.80,  output: 4.00,  provider: 'anthropic' },
  'claude-sonnet-4-6':         { input: 3.00,  output: 15.00, provider: 'anthropic' },
  'claude-sonnet-4-5':         { input: 3.00,  output: 15.00, provider: 'anthropic' },
  'claude-opus-4-6':           { input: 15.00, output: 75.00, provider: 'anthropic' },
  'claude-opus-4-5':           { input: 15.00, output: 75.00, provider: 'anthropic' },
  // OpenAI
  'gpt-4o':                    { input: 2.50,  output: 10.00, provider: 'openai' },
  'gpt-4o-mini':               { input: 0.15,  output: 0.60,  provider: 'openai' },
  'gpt-4-turbo':               { input: 10.00, output: 30.00, provider: 'openai' },
  'gpt-4':                     { input: 30.00, output: 60.00, provider: 'openai' },
  'gpt-3.5-turbo':             { input: 0.50,  output: 1.50,  provider: 'openai' },
  'o1':                        { input: 15.00, output: 60.00, provider: 'openai' },
  'o1-mini':                   { input: 3.00,  output: 12.00, provider: 'openai' },
  'o3-mini':                   { input: 1.10,  output: 4.40,  provider: 'openai' },
  // Google
  'gemini-1.5-pro':            { input: 1.25,  output: 5.00,  provider: 'google' },
  'gemini-1.5-flash':          { input: 0.075, output: 0.30,  provider: 'google' },
  'gemini-2.0-flash':          { input: 0.10,  output: 0.40,  provider: 'google' },
  // Fallback
  'unknown':                   { input: 3.00,  output: 15.00, provider: 'unknown' },
};

const CHEAPER_ALTERNATIVES = {
  // Anthropic
  'claude-sonnet-4-6': 'claude-haiku-4-5-20251001',
  'claude-sonnet-4-5': 'claude-haiku-4-5-20251001',
  'claude-opus-4-6':   'claude-sonnet-4-6',
  'claude-opus-4-5':   'claude-sonnet-4-6',
  // OpenAI
  'gpt-4o':        'gpt-4o-mini',
  'gpt-4-turbo':   'gpt-4o',
  'gpt-4':         'gpt-4o',
  'o1':            'o3-mini',
};

// ─── DIRECTORY WALKER ─────────────────────────────────────────────────────
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'build', 'dist', '.next', 'out', 'coverage',
  '.cache', 'public', '.env', 'migrations', '__pycache__', 'vendor',
  '.turbo', '.vercel', 'storybook-static',
]);

function walkDir(dir, files = []) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return files; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      walkDir(full, files);
    } else {
      const ext = path.extname(entry).toLowerCase();
      if (EXT_MAP.has(ext)) files.push({ full, ext });
    }
  }
  return files;
}

// ─── TOKEN ESTIMATOR ──────────────────────────────────────────────────────
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// ─── SINGLE FILE ANALYSIS ─────────────────────────────────────────────────
function analyzeFile(filePath, ext, repoRoot) {
  const lang = EXT_MAP.get(ext);
  if (!lang) return null;

  let source;
  try { source = fs.readFileSync(filePath, 'utf8'); }
  catch { return null; }

  const relPath  = path.relative(repoRoot, filePath);
  const lines    = source.split('\n');
  const codeOnly = lang.stripComments(source);

  const findings = {
    path:               relPath,
    language:           lang.name,
    providers:          [],
    hasSDKImport:       false,
    apiCalls:           [],
    models:             [],
    maxTokensValues:    [],
    hasStreaming:       false,
    hasRetryLogic:      false,
    hasCacheControl:    false,
    dynamicPrompts:     [],
    staticPromptTokens: 0,
    issues:             [],
    recommendations:    [],
  };

  // Provider detection
  findings.providers = lang.detectProviders(codeOnly);
  findings.hasSDKImport = findings.providers.length > 0;

  // Call sites
  findings.apiCalls = lang.detectCallSites(codeOnly, lines, findings.providers);

  // Model names
  const P = lang.PATTERNS;
  P.modelString.lastIndex = 0;
  let m;
  while ((m = P.modelString.exec(codeOnly)) !== null) {
    if (!findings.models.includes(m[1])) findings.models.push(m[1]);
  }

  // max_tokens (JS colon style)
  P.maxTokens.lastIndex = 0;
  while ((m = P.maxTokens.exec(codeOnly)) !== null) {
    findings.maxTokensValues.push(parseInt(m[1], 10));
  }
  // max_output_tokens (Gemini style)
  if (P.maxOutputTokens) {
    P.maxOutputTokens.lastIndex = 0;
    while ((m = P.maxOutputTokens.exec(codeOnly)) !== null) {
      findings.maxTokensValues.push(parseInt(m[1], 10));
    }
  }

  // Flags
  P.streaming.lastIndex = 0;
  findings.hasStreaming = P.streaming.test(codeOnly);
  P.retry.lastIndex = 0;
  findings.hasRetryLogic = P.retry.test(codeOnly);
  P.cacheControl.lastIndex = 0;
  findings.hasCacheControl = P.cacheControl.test(codeOnly);

  // Dynamic prompts
  P.templateLiteral.lastIndex = 0;
  const tplMatches = codeOnly.match(P.templateLiteral) || [];
  findings.dynamicPrompts = tplMatches.slice(0, 3).map(t => t.slice(0, 100));

  // Static system prompt token estimate
  P.systemPrompt.lastIndex = 0;
  while ((m = P.systemPrompt.exec(codeOnly)) !== null) {
    findings.staticPromptTokens += estimateTokens(m[1]);
  }

  // ── ISSUE DETECTION ───────────────────────────────────────────────────

  if (findings.apiCalls.length === 0 && !findings.hasSDKImport) return null;

  // 1. Sonnet/GPT-4/Opus with tiny max_tokens → caption-output misuse
  const expensiveModel = findings.models.find(model =>
    model.includes('sonnet') || model.includes('opus') ||
    model === 'gpt-4o' || model === 'gpt-4-turbo' || model === 'gpt-4' ||
    model === 'o1' || model === 'gemini-1.5-pro'
  );
  const lowOutput = findings.maxTokensValues.length > 0 &&
                    findings.maxTokensValues.every(t => t <= 300);

  if (expensiveModel && lowOutput && findings.apiCalls.length > 0) {
    const maxT    = Math.max(...findings.maxTokensValues);
    const pricing = PRICING[expensiveModel] || PRICING['unknown'];
    const haikuP  = PRICING['claude-haiku-4-5-20251001'];
    const cheapAlt = CHEAPER_ALTERNATIVES[expensiveModel] || 'a cheaper model';
    const savingsPct = pricing.output > 0
      ? ((1 - (PRICING[cheapAlt]?.output ?? haikuP.output) / pricing.output) * 100).toFixed(0)
      : '?';
    findings.issues.push({
      severity: 'WARN',
      type: 'EXPENSIVE_MODEL_FOR_CAPTION_OUTPUT',
      detail: `${expensiveModel} used with max_tokens=${maxT}. Outputs ≤300 tokens on structured inputs strongly suggest a classification/summarisation task — not a reasoning task. ` +
              `${cheapAlt} handles these at equivalent quality and costs ~${savingsPct}% less on output tokens. ` +
              `Recommended: switch model and A/B test 20 sample outputs.`
    });
  } else if (expensiveModel && findings.apiCalls.length > 0) {
    findings.recommendations.push({
      type: 'MODEL_DOWNGRADE_CANDIDATE',
      detail: `Uses ${expensiveModel}. If this call produces structured/deterministic output, ` +
              `${CHEAPER_ALTERNATIVES[expensiveModel] || 'a cheaper model'} may produce equivalent results at significantly lower cost.`
    });
  }

  // 2. Oversized max_tokens on a cheap model
  for (const tokens of findings.maxTokensValues) {
    const isCheapModel = findings.models.some(m =>
      m.includes('haiku') || m === 'gpt-4o-mini' || m.includes('flash') || m === 'gpt-3.5-turbo'
    );
    if (isCheapModel && tokens > 2000) {
      findings.issues.push({
        severity: 'WARN',
        type: 'OVERSIZED_MAX_TOKENS',
        detail: `max_tokens=${tokens} on a low-cost model. For structured JSON responses, ` +
                `consider 512–1024 to avoid runaway costs at scale.`
      });
      break;
    }
    if (tokens >= 4096) {
      findings.issues.push({
        severity: 'INFO',
        type: 'HIGH_MAX_TOKENS',
        detail: `max_tokens=${tokens} — verify this output size is genuinely required.`
      });
      break;
    }
  }

  // 3. No retry logic
  if (findings.apiCalls.length > 0 && !findings.hasRetryLogic) {
    findings.issues.push({
      severity: 'INFO',
      type: 'NO_RETRY_LOGIC',
      detail: `${findings.apiCalls.length} API call(s) with no visible retry/backoff logic. ` +
              `Rate limit errors will surface as unhandled exceptions.`
    });
  }

  // 4. Dynamic prompts without caching
  if (findings.dynamicPrompts.length > 0 && !findings.hasCacheControl) {
    findings.recommendations.push({
      type: 'CACHING_OPPORTUNITY',
      detail: `${findings.dynamicPrompts.length} dynamic prompt(s) detected. ` +
              `If the system prompt is large and reused across calls, prompt caching ` +
              `(cache_control: ephemeral) can reduce input token costs by up to 90%.`
    });
  }

  // 5. Large static system prompt
  if (findings.staticPromptTokens > 800) {
    findings.recommendations.push({
      type: 'LARGE_SYSTEM_PROMPT',
      detail: `Estimated ${findings.staticPromptTokens} tokens in static system prompt. ` +
              `Add cache_control: { type: 'ephemeral' } — pays off after ~4 calls.`
    });
  }

  // 6. LangChain detected — note abstraction layer risk
  if (findings.providers.includes('langchain')) {
    findings.recommendations.push({
      type: 'ABSTRACTION_LAYER',
      detail: `LangChain detected. LLM calls may be hidden inside chains/agents. ` +
              `Static analysis may undercount actual API call volume. ` +
              `Consider adding runtime observability (Helicone, LangSmith) alongside this scanner.`
    });
  }

  return findings;
}

// ─── COST PROJECTION ──────────────────────────────────────────────────────
function projectCosts(allFindings) {
  const callsByModel = {};

  for (const f of allFindings) {
    if (f.apiCalls.length === 0) continue;
    for (const model of f.models) {
      if (!callsByModel[model]) {
        callsByModel[model] = { callSites: 0, maxTokensSum: 0, tokenCount: 0 };
      }
      callsByModel[model].callSites += f.apiCalls.length;
      for (const t of f.maxTokensValues) {
        callsByModel[model].maxTokensSum += t;
        callsByModel[model].tokenCount++;
      }
    }
  }

  return Object.entries(callsByModel).map(([model, data]) => {
    const pricing        = PRICING[model] || PRICING['unknown'];
    const avgMaxTokens   = data.tokenCount > 0
      ? Math.round(data.maxTokensSum / data.tokenCount)
      : 1000;
    const dailyCalls     = data.callSites * 100; // heuristic: 100 calls/day per call site
    const inputTokens    = 800;
    const outputTokens   = Math.min(avgMaxTokens, 2000);
    const dailyCost      = (dailyCalls * inputTokens  / 1_000_000) * pricing.input
                         + (dailyCalls * outputTokens / 1_000_000) * pricing.output;
    return {
      model,
      provider:        pricing.provider,
      callSites:       data.callSites,
      avgMaxTokens,
      dailyCalls,
      dailyCost,
      monthlyCost:     dailyCost * 30,
      cheaperAlt:      CHEAPER_ALTERNATIVES[model] || null,
    };
  });
}

// ─── DUPLICATE CALL DETECTION ─────────────────────────────────────────────
function detectDuplicates(allFindings) {
  const byModel = {};
  for (const f of allFindings) {
    if (f.apiCalls.length === 0) continue;
    for (const model of f.models) {
      if (!byModel[model]) byModel[model] = [];
      byModel[model].push(f.path);
    }
  }
  return Object.entries(byModel)
    .filter(([, files]) => files.length > 1)
    .map(([model, files]) => ({ model, files, count: files.length }));
}

// ─── REPORT: TEXT ─────────────────────────────────────────────────────────
function renderText(allFindings, projections, duplicates, repoRoot, totalFiles, opts = {}) {
  const D = '─'.repeat(72);
  const out = [];
  const p = (...l) => out.push(...l);

  const realFiles    = allFindings.filter(f => f.apiCalls.length > 0);
  const configFiles  = allFindings.filter(f => f.apiCalls.length === 0);
  const totalMonthly = projections.reduce((s, x) => s + x.monthlyCost, 0);

  p('');
  p('╔══════════════════════════════════════════════════════════════════════╗');
  p('║            AI ARCHITECTURE SCANNER  v0.2                           ║');
  p('╚══════════════════════════════════════════════════════════════════════╝');
  p('');
  p(`  Repo       : ${repoRoot}`);
  p(`  Scanned    : ${totalFiles} files`);
  p(`  AI files   : ${realFiles.length} files with active AI calls`);
  p(`  Config refs: ${configFiles.length} files with model/pricing constants`);
  p(`  Providers  : ${[...new Set(allFindings.flatMap(f => f.providers))].join(', ') || 'none detected'}`);
  p(`  Timestamp  : ${new Date().toISOString()}`);
  if (opts.threshold) {
    const status = totalMonthly > opts.threshold ? '⚠️  OVER THRESHOLD' : '✓ within threshold';
    p(`  Cost gate  : $${opts.threshold}/mo  →  ${status}`);
  }
  p('');

  // ── SECTION 1 ───────────────────────────────────────────────────────────
  p(D);
  p('  SECTION 1 — AI CALL INVENTORY');
  p(D);
  p('');

  for (const f of allFindings) {
    const isConfig = f.apiCalls.length === 0;
    p(`  ${isConfig ? '📋' : '📄'} ${f.path}  [${f.language}]${isConfig ? '  (constants/config)' : ''}`);
    if (f.providers.length)       p(`     Providers  : ${f.providers.join(', ')}`);
    if (f.models.length)          p(`     Models     : ${f.models.join(', ')}`);
    if (!isConfig) {
      if (f.apiCalls.length)      p(`     Call sites : ${f.apiCalls.length}`);
      if (f.maxTokensValues.length) p(`     max_tokens : ${f.maxTokensValues.join(', ')}`);
      if (f.hasStreaming)          p(`     Streaming  : yes`);
      if (f.hasCacheControl)      p(`     Caching    : cache_control detected ✓`);
      if (f.hasRetryLogic)        p(`     Retry      : detected ✓`);
      if (f.dynamicPrompts.length) p(`     Dynamic    : ${f.dynamicPrompts.length} template literal(s)`);
      for (const c of f.apiCalls) p(`     L${c.line}: ${c.snippet}`);
    }
    if (f.issues.length || f.recommendations.length) {
      p('');
      for (const i of f.issues) {
        p(`     ${i.severity === 'WARN' ? '⚠️ ' : 'ℹ️ '} [${i.type}] ${i.detail}`);
      }
      for (const r of f.recommendations) {
        p(`     💡 [${r.type}] ${r.detail}`);
      }
    }
    p('');
  }

  // ── SECTION 2 ───────────────────────────────────────────────────────────
  p(D);
  p('  SECTION 2 — COST PROJECTIONS');
  p(D);
  p('');
  p('  Assumption: 100 calls/day per call site · ~800 input tokens · output = avg max_tokens');
  p('  Replace the multiplier with real traffic data for accurate projections.');
  p('');

  for (const proj of projections) {
    const alt    = proj.cheaperAlt;
    const altP   = alt ? PRICING[alt] : null;
    const curP   = PRICING[proj.model] || PRICING['unknown'];
    const saving = altP
      ? `~${((1 - altP.input / curP.input) * 100).toFixed(0)}% less on input`
      : null;

    p(`  ${proj.model}  [${proj.provider}]`);
    p(`    Call sites      : ${proj.callSites}`);
    p(`    Est. daily calls: ${proj.dailyCalls.toLocaleString()}`);
    p(`    Avg max_tokens  : ${proj.avgMaxTokens}`);
    p(`    Daily cost      : $${proj.dailyCost.toFixed(4)}`);
    p(`    Monthly cost    : $${proj.monthlyCost.toFixed(2)}`);
    if (saving) p(`    💡 Cheaper alt  : ${alt} (${saving})`);
    p('');
  }

  p(`  ► TOTAL ESTIMATED MONTHLY: $${totalMonthly.toFixed(2)}`);
  if (opts.threshold && totalMonthly > opts.threshold) {
    p(`  ⚠️  COST THRESHOLD EXCEEDED: $${totalMonthly.toFixed(2)} > $${opts.threshold}`);
  }
  p('');

  // ── SECTION 3 ───────────────────────────────────────────────────────────
  p(D);
  p('  SECTION 3 — DUPLICATE / REDUNDANT CALL DETECTION');
  p(D);
  p('');

  if (duplicates.length === 0) {
    p('  ✓ No duplicate call patterns detected across files.');
  } else {
    for (const d of duplicates) {
      p(`  ${d.model} — used in ${d.count} separate files:`);
      for (const f of d.files) p(`    · ${f}`);
      p(`  → Centralise in a shared service to enable unified caching, logging,`);
      p(`    retry logic, and single-point model upgrades.`);
      p('');
    }
  }

  // ── SECTION 4 ───────────────────────────────────────────────────────────
  p('');
  p(D);
  p('  SECTION 4 — ARCHITECTURE FINDINGS');
  p(D);
  p('');

  const warnIssues = allFindings.flatMap(f =>
    f.issues.filter(i => i.severity === 'WARN').map(i => ({ ...i, file: f.path }))
  );
  const infoIssues = allFindings.flatMap(f =>
    f.issues.filter(i => i.severity === 'INFO').map(i => ({ ...i, file: f.path }))
  );
  const recs = allFindings.flatMap(f =>
    f.recommendations.map(r => ({ ...r, file: f.path }))
  );

  if (warnIssues.length === 0 && infoIssues.length === 0 && recs.length === 0) {
    p('  ✓ No significant issues detected.');
  }

  if (warnIssues.length > 0) {
    p('  ⚠️  WARNINGS (fix these first):');
    p('');
    for (const i of warnIssues) { p(`  ⚠️  ${i.file}`); p(`     ${i.detail}`); p(''); }
  }
  if (infoIssues.length > 0) {
    p('  ℹ️  INFO:');
    p('');
    for (const i of infoIssues) { p(`  ℹ️  ${i.file}`); p(`     ${i.detail}`); p(''); }
  }
  if (recs.length > 0) {
    p('  💡 RECOMMENDATIONS:');
    p('');
    for (const r of recs) { p(`  💡 ${r.file}`); p(`     ${r.detail}`); p(''); }
  }

  // ── SECTION 5 ───────────────────────────────────────────────────────────
  p(D);
  p('  SECTION 5 — QUICK WINS  (ordered by estimated impact)');
  p(D);
  p('');

  let n = 1;

  const captionSonnet = allFindings.some(f =>
    f.issues.some(i => i.type === 'EXPENSIVE_MODEL_FOR_CAPTION_OUTPUT')
  );
  if (captionSonnet) {
    p(`  ${n++}. ⚠️  SWITCH CAPTION-OUTPUT CALLS TO CHEAPER MODEL  ← highest ROI`);
    p(`     Premium model + max_tokens ≤ 300 = paying for reasoning on a caption task.`);
    p(`     Action: swap model, run 20 sample outputs side by side.`);
    p(`     You will almost certainly not see a quality difference.`);
    p('');
  }

  const hasNoCache = allFindings.some(f =>
    !f.hasCacheControl && (f.staticPromptTokens > 500 || f.dynamicPrompts.length > 0)
  );
  if (hasNoCache) {
    p(`  ${n++}. ADD PROMPT CACHING`);
    p(`     Large or reused system prompts without cache_control: ephemeral.`);
    p(`     Cached input tokens cost 90% less. Pays off after ~4 calls per prompt.`);
    p('');
  }

  if (duplicates.some(d => d.count > 1)) {
    p(`  ${n++}. CONSOLIDATE AI CALL SITES`);
    p(`     Multiple files call the same model directly. A shared service layer`);
    p(`     enables centralised caching, logging, retry, and single-point model swaps.`);
    p('');
  }

  const noRetry = allFindings.some(f => !f.hasRetryLogic && f.apiCalls.length > 0);
  if (noRetry) {
    p(`  ${n++}. ADD RETRY / BACKOFF`);
    p(`     Add maxRetries: 2 to your SDK client init. One-line fix, prevents`);
    p(`     transient rate limit errors from crashing requests.`);
    p('');
  }

  if (n === 1) p('  ✓ No quick wins identified — architecture looks solid.');

  p(D);
  p('  END OF REPORT');
  p(D);
  p('');

  return out.join('\n');
}

// ─── REPORT: JSON ─────────────────────────────────────────────────────────
function renderJson(allFindings, projections, duplicates, totalMonthly, opts = {}) {
  return JSON.stringify({
    meta: {
      version:      '0.2',
      timestamp:    new Date().toISOString(),
      totalMonthly: parseFloat(totalMonthly.toFixed(2)),
      thresholdBreached: opts.threshold ? totalMonthly > opts.threshold : null,
    },
    findings:    allFindings,
    projections,
    duplicates,
  }, null, 2);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);

  // Parse args
  const repoRoot  = args.find(a => !a.startsWith('--')) || process.cwd();
  const jsonMode  = args.includes('--json');
  const threshIdx = args.indexOf('--threshold');
  const threshold = threshIdx !== -1 ? parseFloat(args[threshIdx + 1]) : null;

  if (!fs.existsSync(repoRoot)) {
    console.error(`Error: path not found: ${repoRoot}`);
    process.exit(1);
  }

  if (!jsonMode) console.log(`\nScanning ${repoRoot} ...\n`);

  const allFiles = walkDir(repoRoot);
  if (!jsonMode) console.log(`Found ${allFiles.length} files. Analysing...\n`);

  const allFindings = allFiles
    .map(({ full, ext }) => analyzeFile(full, ext, repoRoot))
    .filter(Boolean);

  const projections  = projectCosts(allFindings);
  const duplicates   = detectDuplicates(allFindings);
  const totalMonthly = projections.reduce((s, x) => s + x.monthlyCost, 0);
  const opts         = { threshold };

  if (jsonMode) {
    console.log(renderJson(allFindings, projections, duplicates, totalMonthly, opts));
  } else {
    const report = renderText(allFindings, projections, duplicates, repoRoot, allFiles.length, opts);
    console.log(report);
    const outPath = path.join(process.cwd(), 'ai-scan-report.txt');
    fs.writeFileSync(outPath, report, 'utf8');
    console.log(`\nReport saved → ${outPath}\n`);
  }

  // Exit code for CI gates
  if (threshold && totalMonthly > threshold) {
    if (!jsonMode) console.error(`\n❌ Monthly cost $${totalMonthly.toFixed(2)} exceeds threshold $${threshold}\n`);
    process.exit(1);
  }

  process.exit(0);
}

main();
