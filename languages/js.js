/**
 * Language module: JavaScript + TypeScript
 * Covers: .js .jsx .ts .tsx .mjs .cjs
 */

'use strict';

const EXTENSIONS = /\.(js|jsx|ts|tsx|mjs|cjs)$/;

// ─── COMMENT STRIPPER ─────────────────────────────────────────────────────
function stripComments(source) {
  return source
    .split('\n')
    .map(line => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return '';
      return line.replace(/\/\/.*$/, '');
    })
    .join('\n');
}

// ─── PATTERNS ─────────────────────────────────────────────────────────────
const PATTERNS = {

  // ── Anthropic ─────────────────────────────────────────────────────────
  anthropicImport: [
    /new\s+Anthropic\s*\(/g,
    /require\s*\(\s*['"]@anthropic-ai\/sdk['"]\s*\)/g,
    /from\s+['"]@anthropic-ai\/sdk['"]/g,
  ],
  anthropicCall: [
    /\.messages\.create\s*\(/g,
    /anthropic\.messages\s*\./g,
    /client\.messages\.create\s*\(/g,
  ],

  // ── OpenAI ────────────────────────────────────────────────────────────
  openaiImport: [
    /new\s+OpenAI\s*\(/g,
    /require\s*\(\s*['"]openai['"]\s*\)/g,
    /from\s+['"]openai['"]/g,
    /from\s+['"]@openai\/openai['"]/g,
  ],
  openaiCall: [
    /\.chat\.completions\.create\s*\(/g,
    /openai\.chat\s*\./g,
    /client\.chat\.completions\s*\./g,
    /\.completions\.create\s*\(/g,   // legacy
  ],

  // ── Google Gemini ─────────────────────────────────────────────────────
  geminiImport: [
    /require\s*\(\s*['"]@google\/generative-ai['"]\s*\)/g,
    /from\s+['"]@google\/generative-ai['"]/g,
    /from\s+['"]@google-ai\/generativelanguage['"]/g,
  ],
  geminiCall: [
    /\.generateContent\s*\(/g,
    /\.startChat\s*\(/g,
    /model\.generateContentStream\s*\(/g,
  ],

  // ── AWS Bedrock ───────────────────────────────────────────────────────
  bedrockImport: [
    /from\s+['"]@aws-sdk\/client-bedrock-runtime['"]/g,
    /require\s*\(\s*['"]@aws-sdk\/client-bedrock-runtime['"]\s*\)/g,
  ],
  bedrockCall: [
    /new\s+BedrockRuntimeClient\s*\(/g,
    /InvokeModelCommand\s*\(/g,
    /ConverseCommand\s*\(/g,
  ],

  // ── Azure OpenAI ──────────────────────────────────────────────────────
  azureImport: [
    /from\s+['"]@azure\/openai['"]/g,
    /require\s*\(\s*['"]@azure\/openai['"]\s*\)/g,
  ],

  // ── LangChain ─────────────────────────────────────────────────────────
  langchainImport: [
    /from\s+['"]langchain['"]/g,
    /from\s+['"]@langchain\//g,
    /require\s*\(\s*['"]langchain/g,
  ],
  langchainCall: [
    /\.invoke\s*\(/g,
    /\.call\s*\(/g,
    /new\s+ChatOpenAI\s*\(/g,
    /new\s+ChatAnthropic\s*\(/g,
    /new\s+ChatGoogleGenerativeAI\s*\(/g,
  ],

  // ── Shared ────────────────────────────────────────────────────────────
  // Model name strings — covers all providers
  modelString: /['"`](claude-[a-z0-9\-\.]+|gpt-[a-z0-9\-\.]+|gemini-[a-z0-9\-\.]+|mistral-[a-z0-9\-\.]+|llama-?[a-z0-9\-\.]*|anthropic\.[a-z0-9\-\.]+|amazon\.[a-z0-9\-\.]+)['"`]/g,

  maxTokens:      /max_tokens\s*[:=]\s*(\d+)/g,           // covers JS (:) and config (=)
  maxOutputTokens:/max_output_tokens\s*[:=]\s*(\d+)/g,    // Gemini style
  systemPrompt:   /system\s*:\s*[`'"]([\s\S]*?)[`'"]/g,
  templateLiteral:/`[^`]*\$\{[^}]+\}[^`]*`/g,
  streaming:      /stream\s*:\s*true/g,
  retry:          /retry|retries|backoff|RateLimitError|APIError/gi,
  cacheControl:   /cache_control|ephemeral/g,
};

// ─── PROVIDER DETECTION ───────────────────────────────────────────────────
function detectProviders(codeOnly) {
  const providers = [];

  const check = (patterns, name) => {
    for (const p of patterns) {
      p.lastIndex = 0;
      if (p.test(codeOnly)) { providers.push(name); return; }
    }
  };

  check(PATTERNS.anthropicImport, 'anthropic');
  check(PATTERNS.openaiImport,    'openai');
  check(PATTERNS.geminiImport,    'gemini');
  check(PATTERNS.bedrockImport,   'bedrock');
  check(PATTERNS.azureImport,     'azure-openai');
  check(PATTERNS.langchainImport, 'langchain');

  return providers;
}

// ─── CALL SITE DETECTION ──────────────────────────────────────────────────
function detectCallSites(codeOnly, lines, providers) {
  const seenLines = new Set();
  const calls = [];

  const callPatternSets = [];
  if (providers.includes('anthropic'))    callPatternSets.push(PATTERNS.anthropicCall);
  if (providers.includes('openai') ||
      providers.includes('azure-openai')) callPatternSets.push(PATTERNS.openaiCall);
  if (providers.includes('gemini'))       callPatternSets.push(PATTERNS.geminiCall);
  if (providers.includes('bedrock'))      callPatternSets.push(PATTERNS.bedrockCall);
  if (providers.includes('langchain'))    callPatternSets.push(PATTERNS.langchainCall);

  // If provider detected via import but no specific call patterns matched, fall back
  if (callPatternSets.length === 0 && providers.length > 0) {
    callPatternSets.push(PATTERNS.anthropicCall);
  }

  for (const patternSet of callPatternSets) {
    for (const p of patternSet) {
      p.lastIndex = 0;
      let m;
      while ((m = p.exec(codeOnly)) !== null) {
        const lineNum = codeOnly.slice(0, m.index).split('\n').length;
        if (seenLines.has(lineNum)) continue;
        seenLines.add(lineNum);
        const origLine = lines[lineNum - 1]?.trim() || '';
        if (origLine.startsWith('//') || origLine.startsWith('*')) continue;
        calls.push({ line: lineNum, snippet: origLine.slice(0, 120) });
      }
    }
  }

  return calls;
}

// ─── MAIN EXPORT ──────────────────────────────────────────────────────────
module.exports = {
  name: 'JavaScript/TypeScript',
  extensions: EXTENSIONS,
  stripComments,
  detectProviders,
  detectCallSites,
  PATTERNS,
};
