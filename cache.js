'use strict';

/**
 * cache.js
 * Stores and retrieves scan baselines using the GitHub Contents API
 * (api.github.com) instead of the internal Actions cache service, which is
 * unreachable from inside Docker container actions.
 *
 * Baseline files are stored on a dedicated orphan-like branch:
 *   branch: ai-arch-scanner-cache
 *   path:   baselines/{safe-branch-name}.json
 *
 * Requires: GITHUB_TOKEN, GITHUB_REPOSITORY (both set automatically by Actions)
 *
 * Usage:
 *   node cache.js read  <branch> <output-path>
 *   node cache.js write <branch> <input-path>
 *
 * All errors are non-fatal (exit 0).
 */

const fs    = require('fs');
const https = require('https');

const CACHE_BRANCH = 'ai-arch-scanner-cache';

function safeName(branch) {
  return branch.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function apiRequest(method, path, token, body = null) {
  return new Promise((resolve, reject) => {
    let bodyBuf = null;
    if (body !== null) {
      bodyBuf = Buffer.from(JSON.stringify(body), 'utf8');
    }

    const options = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization':  `Bearer ${token}`,
        'Accept':         'application/vnd.github.v3+json',
        'User-Agent':     'ai-arch-scanner',
        ...(bodyBuf ? {
          'Content-Type':   'application/json',
          'Content-Length': bodyBuf.length,
        } : {}),
      },
    };

    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

async function ensureCacheBranch(repo, token) {
  // Check if the cache branch already exists
  const check = await apiRequest('GET', `/repos/${repo}/git/refs/heads/${CACHE_BRANCH}`, token);
  if (check.status === 200) return true;

  // Need a SHA to point the new branch at — use GITHUB_SHA (current push commit)
  const sha = process.env.GITHUB_SHA;
  if (!sha) {
    console.log('[cache] GITHUB_SHA not available — cannot create cache branch.');
    return false;
  }

  const create = await apiRequest('POST', `/repos/${repo}/git/refs`, token, {
    ref: `refs/heads/${CACHE_BRANCH}`,
    sha,
  });

  if (create.status === 201 || create.status === 422) return true; // 422 = already exists race

  console.log(`[cache] Failed to create cache branch (${create.status}): ${create.body.slice(0, 200)}`);
  return false;
}

async function getExistingFileSha(repo, token, filePath) {
  const res = await apiRequest(
    'GET',
    `/repos/${repo}/contents/${filePath}?ref=${CACHE_BRANCH}`,
    token,
  );
  if (res.status !== 200) return null;
  try { return JSON.parse(res.body).sha || null; } catch { return null; }
}

// ─── WRITE ────────────────────────────────────────────────────────────────────
async function writeBaseline(branch, inputPath) {
  const token = process.env.GITHUB_TOKEN;
  const repo  = process.env.GITHUB_REPOSITORY;

  if (!token || !repo) {
    console.log('[cache] GITHUB_TOKEN or GITHUB_REPOSITORY not set — skipping write.');
    return;
  }
  if (!fs.existsSync(inputPath)) {
    console.log(`[cache] Input file not found: ${inputPath} — skipping write.`);
    return;
  }

  const filePath = `baselines/${safeName(branch)}.json`;
  const content  = fs.readFileSync(inputPath, 'utf8');
  const encoded  = Buffer.from(content, 'utf8').toString('base64');

  console.log(`[cache] Writing baseline → ${CACHE_BRANCH}/${filePath}`);

  const ok = await ensureCacheBranch(repo, token);
  if (!ok) return;

  const existingSha = await getExistingFileSha(repo, token, filePath);

  const body = {
    message: `chore: update ai-arch-scanner baseline for ${branch}`,
    content: encoded,
    branch:  CACHE_BRANCH,
  };
  if (existingSha) body.sha = existingSha;

  const res = await apiRequest('PUT', `/repos/${repo}/contents/${filePath}`, token, body);

  if (res.status === 200 || res.status === 201) {
    console.log(`[cache] ✓ Baseline saved (${content.length} bytes).`);
  } else {
    console.log(`[cache] Write failed (${res.status}): ${res.body.slice(0, 300)}`);
  }
}

// ─── READ ─────────────────────────────────────────────────────────────────────
async function readBaseline(branch, outputPath) {
  const token = process.env.GITHUB_TOKEN;
  const repo  = process.env.GITHUB_REPOSITORY;

  if (!token || !repo) {
    console.log('[cache] GITHUB_TOKEN or GITHUB_REPOSITORY not set — skipping read.');
    return;
  }

  const filePath = `baselines/${safeName(branch)}.json`;
  console.log(`[cache] Reading baseline ← ${CACHE_BRANCH}/${filePath}`);

  const res = await apiRequest(
    'GET',
    `/repos/${repo}/contents/${filePath}?ref=${CACHE_BRANCH}`,
    token,
  );

  if (res.status === 404) {
    console.log('[cache] No baseline found — first scan on this branch.');
    return;
  }
  if (res.status !== 200) {
    console.log(`[cache] Read failed (${res.status}): ${res.body.slice(0, 200)}`);
    return;
  }

  const data    = JSON.parse(res.body);
  const decoded = Buffer.from(data.content, 'base64').toString('utf8');
  fs.writeFileSync(outputPath, decoded, 'utf8');
  console.log(`[cache] ✓ Baseline loaded (${decoded.length} bytes).`);
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
const [,, command, branch, filePath] = process.argv;

if (!command || !branch || !filePath) {
  console.error('Usage: node cache.js <read|write> <branch> <file>');
  process.exit(0);
}

(async () => {
  try {
    if (command === 'write')     await writeBaseline(branch, filePath);
    else if (command === 'read') await readBaseline(branch, filePath);
    else console.log(`[cache] Unknown command: ${command}`);
  } catch (e) {
    console.log(`[cache] Error (non-fatal): ${e.message}`);
  }
  process.exit(0);
})();
