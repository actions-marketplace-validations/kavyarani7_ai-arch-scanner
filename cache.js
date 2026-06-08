'use strict';

/**
 * cache.js
 * Reads and writes scan baselines using the GitHub Actions Cache API.
 * No npm packages — pure Node http/https built-ins.
 *
 * The Actions cache API is available inside any running Action via:
 *   ACTIONS_CACHE_URL  — the cache service base URL
 *   ACTIONS_RUNTIME_TOKEN — the auth token
 *
 * Cache key format: ai-arch-scanner-baseline-{branch}
 * e.g. ai-arch-scanner-baseline-main
 *
 * Usage:
 *   node cache.js read  <branch> <output-path>
 *   node cache.js write <branch> <input-path>
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');
const os    = require('os');

const CACHE_VERSION = 'v1';

function cacheKey(branch) {
  // Sanitise branch name for use as cache key
  const safe = branch.replace(/[^a-zA-Z0-9._-]/g, '-');
  return `ai-arch-scanner-baseline-${safe}-${CACHE_VERSION}`;
}

function getEnv() {
  const cacheUrl = process.env.ACTIONS_CACHE_URL;
  const token    = process.env.ACTIONS_RUNTIME_TOKEN;

  if (!cacheUrl || !token) {
    return null; // Not running inside GitHub Actions — cache unavailable
  }

  return { cacheUrl: cacheUrl.replace(/\/$/, ''), token };
}

// Simple promise-based HTTP request
function request(method, url, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const mod     = isHttps ? https : http;

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method,
      headers: {
        'Accept': 'application/json;api-version=6.0-preview.1',
        ...headers,
      },
    };

    let bodyBuf = null;
    if (body !== null) {
      if (Buffer.isBuffer(body)) {
        bodyBuf = body;
      } else if (typeof body === 'string') {
        bodyBuf = Buffer.from(body, 'utf8');
      } else {
        bodyBuf = Buffer.from(JSON.stringify(body), 'utf8');
      }
      // Only set defaults if caller didn't supply them
      if (!options.headers['Content-Type'])   options.headers['Content-Type']   = 'application/json';
      if (!options.headers['Content-Length']) options.headers['Content-Length'] = bodyBuf.length;
    }

    const req = mod.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });

    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// ─── READ BASELINE FROM CACHE ─────────────────────────────────────────────
async function readBaseline(branch, outputPath) {
  const env = getEnv();

  if (!env) {
    console.log('[cache] Not in GitHub Actions environment — skipping cache read.');
    process.exit(0); // Not an error — just no cache available
  }

  const key = cacheKey(branch);
  console.log(`[cache] Reading baseline for branch: ${branch}`);
  console.log(`[cache] Cache key: ${key}`);

  try {
    // Step 1: Look up the cache entry
    const lookupUrl = `${env.cacheUrl}/_apis/artifactcache/cache?keys=${encodeURIComponent(key)}&version=${CACHE_VERSION}`;
    const lookup = await request('GET', lookupUrl, {
      'Authorization': `Bearer ${env.token}`,
    });

    if (lookup.status === 204 || lookup.status === 404) {
      console.log('[cache] No baseline found — this is the first scan on this branch.');
      process.exit(0);
    }

    if (lookup.status !== 200) {
      console.log(`[cache] Cache lookup returned ${lookup.status} — skipping.`);
      process.exit(0);
    }

    const entry = JSON.parse(lookup.body.toString('utf8'));
    if (!entry.archiveLocation) {
      console.log('[cache] No archive location in response — skipping.');
      process.exit(0);
    }

    // Step 2: Download the cached file
    console.log('[cache] Baseline found. Downloading...');
    const download = await request('GET', entry.archiveLocation, {});

    if (download.status !== 200) {
      console.log(`[cache] Download returned ${download.status} — skipping.`);
      process.exit(0);
    }

    fs.writeFileSync(outputPath, download.body);
    console.log(`[cache] Baseline written to: ${outputPath}`);
    process.exit(0);

  } catch (e) {
    // Cache errors are non-fatal — degrade gracefully to no-baseline mode
    console.log(`[cache] Read error (non-fatal): ${e.message}`);
    process.exit(0);
  }
}

// ─── WRITE BASELINE TO CACHE ──────────────────────────────────────────────
async function writeBaseline(branch, inputPath) {
  const env = getEnv();

  if (!env) {
    console.log('[cache] Not in GitHub Actions environment — skipping cache write.');
    process.exit(0);
  }

  if (!fs.existsSync(inputPath)) {
    console.log(`[cache] Input file not found: ${inputPath}`);
    process.exit(0);
  }

  const key     = cacheKey(branch);
  const content = fs.readFileSync(inputPath, 'utf8');

  console.log(`[cache] Writing baseline for branch: ${branch}`);
  console.log(`[cache] Cache key: ${key}`);

  try {
    // Step 1: Reserve a cache entry
    const reserveUrl = `${env.cacheUrl}/_apis/artifactcache/caches`;
    const reserve = await request('POST', reserveUrl, {
      'Authorization': `Bearer ${env.token}`,
    }, { key, version: CACHE_VERSION });

    if (reserve.status === 409) {
      // Actions cache is immutable per key within a workflow run; skip silently.
      console.log('[cache] Cache entry already exists for this key — skipping write.');
      process.exit(0);
    } else if (reserve.status !== 201) {
      console.log(`[cache] Reserve returned ${reserve.status} — skipping write.`);
      process.exit(0);
    }

    const reserveBody = JSON.parse(reserve.body.toString('utf8'));
    const cacheId     = reserveBody.cacheId;

    if (!cacheId) {
      console.log('[cache] No cacheId returned — skipping write.');
      process.exit(0);
    }

    // Step 2: Upload the content
    const contentBuf = Buffer.from(content, 'utf8');
    const uploadUrl  = `${env.cacheUrl}/_apis/artifactcache/caches/${cacheId}`;

    const upload = await request('PATCH', uploadUrl, {
      'Authorization':  `Bearer ${env.token}`,
      'Content-Type':   'application/octet-stream',
      'Content-Range':  `bytes 0-${contentBuf.length - 1}/*`,
      'Content-Length': contentBuf.length,
    }, contentBuf);

    if (upload.status !== 204) {
      console.log(`[cache] Upload returned ${upload.status} — may have failed.`);
      process.exit(0);
    }

    // Step 3: Commit the cache entry
    const commitUrl = `${env.cacheUrl}/_apis/artifactcache/caches/${cacheId}`;
    const commit = await request('POST', commitUrl, {
      'Authorization': `Bearer ${env.token}`,
    }, { size: contentBuf.length });

    if (commit.status === 204) {
      console.log(`[cache] ✓ Baseline cached successfully (${contentBuf.length} bytes).`);
    } else {
      console.log(`[cache] Commit returned ${commit.status}.`);
    }

    process.exit(0);

  } catch (e) {
    // Cache write errors are non-fatal
    console.log(`[cache] Write error (non-fatal): ${e.message}`);
    process.exit(0);
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────
const [,, command, branch, filePath] = process.argv;

if (command === 'read' && branch && filePath) {
  readBaseline(branch, filePath);
} else if (command === 'write' && branch && filePath) {
  writeBaseline(branch, filePath);
} else {
  console.error('Usage:');
  console.error('  node cache.js read  <branch> <output-path>');
  console.error('  node cache.js write <branch> <input-path>');
  process.exit(1);
}
