#!/usr/bin/env node
'use strict';

/**
 * cclitehud — A lightweight two-line Claude Code statusline.
 *
 * Line 1   Model · Effort · Directory · Git branch · Recent skill
 * Line 2   Context window progress bar with cache-breakdown + percentages
 *
 * Reads StatusJSON from stdin (piped by Claude Code).
 * Run with --preview to see a sample rendering.
 */

const { execSync } = require('child_process');
const { readFileSync, mkdirSync, writeFileSync, appendFileSync } = require('fs');
const path = require('path');
const os = require('os');

// ─── Configuration ───────────────────────────────────────────────────────────
const CONFIG = {
  barWidth: 32,
  maxDirDepth: 2, // how many trailing path segments to show
};

// ─── 256-color palette (muted, modern, not garish) ──────────────────────────
const C = {
  // Semantic
  model: 117, // soft sky blue
  effort: { low: 151, medium: 222, high: 215, xhigh: 210, ultra: 203, max: 209 },
  effDefault: 248,
  dir: 111, // soft periwinkle blue
  git: 183, // soft lavender
  skill: 216, // soft peach
  separator: 243, // muted gray
  label: 248, // light gray
  // Progress bar
  barFilled: 115, // single foreground — shade chars create tiers
  barEmpty: 236, // dark gray for pixel-dot background
  barBracket: 243, // brackets around bar
  barPct: 250, // percentage text
};

// ─── ANSI helpers ────────────────────────────────────────────────────────────
const fg = (n) => `\x1b[38;5;${n}m`;
const R = '\x1b[0m';
const B = '\x1b[1m';
const D = '\x1b[2m';

// Strip ANSI escape sequences and measure terminal display width.
// Accounts for CJK and wide characters that occupy 2 terminal columns.
function visibleLen(str) {
  const stripped = str.replace(/\x1b\[[0-9;]*m/g, '');
  let width = 0;
  for (const ch of stripped) {
    const code = ch.codePointAt(0);
    // CJK Unified Ideographs, CJK Compatibility, Fullwidth Forms, etc.
    if (
      (code >= 0x1100 && code <= 0x115f) ||   // Hangul Jamo
      (code >= 0x2e80 && code <= 0x9fff) ||   // CJK Radicals .. CJK Unified
      (code >= 0xac00 && code <= 0xd7a3) ||   // Hangul Syllables
      (code >= 0xf900 && code <= 0xfaff) ||   // CJK Compatibility Ideographs
      (code >= 0xfe10 && code <= 0xfe19) ||   // Vertical Forms
      (code >= 0xfe30 && code <= 0xfe6f) ||   // CJK Compatibility Forms
      (code >= 0xff00 && code <= 0xff60) ||   // Fullwidth Forms
      (code >= 0xffe0 && code <= 0xffe6) ||   // Fullwidth Sign Variants
      (code >= 0x20000 && code <= 0x2ffff) || // CJK Unified Ideographs Ext B+
      (code >= 0x30000 && code <= 0x3ffff)    // CJK Unified Ideographs Ext G+
    ) {
      width += 2;
    } else if (code >= 0x20) {
      width += 1;
    }
    // control characters and zero-width: +0
  }
  return width;
}

// Non-breaking space — prevents VSCode trimming
const NBSP = ' ';

// Safe numeric coercion — prevents string concatenation bugs (e.g. "500"+"1000" → "5001000")
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// ─── Glyphs ──────────────────────────────────────────────────────────────────
// Shade characters: density creates visual tiers WITHOUT ANSI color boundaries
// ▓ (75%) → looks bright  ·  ▒ (50%) → looks darker  ·  ░ (25%) → pixel dots
const FILL_CACHED   = '▓'; // dark shade  — cached = brighter
const FILL_UNCACHED = '▒'; // medium shade — uncached = darker
const FILL_EMPTY    = '░'; // light shade — pixel-dot background
const SEP = '·'; // middle dot separator

// Context window sizes by model family (default 200k)
const MODEL_CONTEXT = {
  'claude-opus-4-8': 200000,
  'claude-opus-4-7': 200000,
  'claude-opus-4-6': 200000,
  'claude-sonnet-4-6': 200000,
  'claude-sonnet-4-5': 200000,
  'claude-haiku-4-5': 200000,
  'deepseek-v4-pro': 1000000,
  'deepseek-v4-pro[1M]': 1000000,
};

function getModelId(raw) {
  if (!raw) return '';
  return typeof raw === 'string' ? raw.trim() : (raw.id || raw.display_name || '').trim();
}

function getContextSize(modelId) {
  // Check exact match first
  if (MODEL_CONTEXT[modelId]) return MODEL_CONTEXT[modelId];
  // Parse [1M] / [200K] suffix from model string (must come before fuzzy includes)
  const m = /\[(\d+(?:\.\d+)?)\s*([mMkK])\]/.exec(modelId);
  if (m) {
    const val = parseFloat(m[1]);
    const unit = m[2].toLowerCase();
    return Math.round(val * (unit === 'm' ? 1_000_000 : 1_000));
  }
  // Check if modelId contains a known key (fuzzy fallback)
  for (const [key, size] of Object.entries(MODEL_CONTEXT)) {
    if (modelId.includes(key)) return size;
  }
  return 200000; // default
}

function prettyModel(raw) {
  // Return raw model ID as-is — no prettification, no name mapping
  if (!raw) return '?';
  if (typeof raw === 'string') return raw.trim();
  // Prefer id over display_name since id is the canonical model identifier
  return (raw.id || raw.display_name || '?').trim();
}

// ─── Thinking-effort helpers ─────────────────────────────────────────────────
const EFFORT_ICON = '◆'; // diamond icon, color-coded by effort level
const EFFORT_LABELS = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', ultra: 'ultra', max: 'max' };

function effortColor(level) {
  if (!level) return fg(C.effDefault);
  const code = C.effort[level] || C.effDefault;
  return fg(code);
}

function effortGlyph() {
  return EFFORT_ICON;
}

function effortLabel(level) {
  return EFFORT_LABELS[level] || level || '—';
}

// ─── Git branch ──────────────────────────────────────────────────────────────
// Simple in-memory cache with TTL
const gitCache = { branch: null, ts: 0, dir: null };
const GIT_TTL = 5000; // 5 s

function getGitBranch(cwd) {
  const now = Date.now();
  if (gitCache.dir === cwd && gitCache.branch !== null && now - gitCache.ts < GIT_TTL) {
    return gitCache.branch;
  }
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    if (branch === 'HEAD') {
      // Detached HEAD — show short sha
      const sha = execSync('git rev-parse --short HEAD', {
        cwd: cwd || process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      }).trim();
      gitCache.branch = `(detached:${sha})`;
    } else {
      gitCache.branch = branch;
    }
  } catch {
    gitCache.branch = null;
  }
  gitCache.ts = now;
  gitCache.dir = cwd;
  return gitCache.branch;
}

// ─── Path shortener ──────────────────────────────────────────────────────────
function shortPath(fullPath, maxDepth) {
  if (!fullPath) return '?';
  const home = os.homedir();
  let display = fullPath;
  if (fullPath === home || fullPath.startsWith(home + path.sep)) {
    display = '~' + fullPath.slice(home.length);
  }
  const parts = display.split(path.sep).filter(Boolean);
  if (parts.length <= maxDepth) return display;
  // Show ".../lastN"
  const last = parts.slice(-maxDepth);
  return (display.startsWith('~') ? '~' : '') + '…/' + last.join('/');
}

// ─── Skills ──────────────────────────────────────────────────────────────────
// Follows ccstatusline's pattern: per-session JSONL files keyed by session_id,
// with a --hook subcommand for writing (called from Claude Code hooks).
//
// Hook mode  (--hook):   stdin = {session_id, hook_event_name, tool_name, tool_input}
//                         → appends to ~/.cache/cclitehud/skills-<sessionId>.jsonl
//
// Normal mode (piped):   stdin = StatusJSON {session_id, ...}
//                         → reads JSONL for current session, returns last skill
//
// This gives reliable per-session isolation using Claude Code's own session_id,
// no PPID guessing or TTL hacks needed.
const CACHE_DIR = path.join(os.homedir(), '.cache', 'cclitehud');

/** Sanitize session ID to prevent path traversal in file names */
function sanitizeSessionId(id) {
  if (!id) return '';
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '');
}

function getSkillsFilePath(sessionId) {
  return path.join(CACHE_DIR, 'skills-' + sanitizeSessionId(sessionId) + '.jsonl');
}

/** Strip ANSI/control characters and bound length to prevent terminal injection */
function sanitizeDisplay(str, maxLen) {
  if (!str) return '';
  const cleaned = String(str)
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')  // CSI sequences (SGR, cursor, etc.)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')  // OSC sequences
    .replace(/\x1b[()][AB012]/g, '')         // charset selection
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '');   // C0 + C1 control characters
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen - 1) + '…' : cleaned;
}

/** Handle --hook: parse hook payload from stdin, write skill invocation to JSONL */
function handleHook() {
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { return; }

  let data;
  try { data = JSON.parse(raw); } catch { return; }

  const sessionId = data.session_id;
  if (!sessionId) return;

  let skillName = '';
  if (data.hook_event_name === 'PreToolUse' && data.tool_name === 'Skill') {
    skillName = sanitizeDisplay((data.tool_input && data.tool_input.skill) || '', 80);
  } else if (data.hook_event_name === 'UserPromptSubmit') {
    const m = /^\/([a-zA-Z0-9_:-]+)(?:\s|$)/.exec(data.prompt || '');
    if (m) skillName = m[1];
  }
  if (!skillName) return;

  const filePath = getSkillsFilePath(sessionId);
  try { mkdirSync(path.dirname(filePath), { recursive: true }); } catch {}
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    skill: skillName,
    source: data.hook_event_name,
  });
  try { writeFileSync(filePath, entry + '\n', { flag: 'a' }); } catch {}
}

/** Read the last skill for a given session from its JSONL file */
function getRecentSkillBySession(sessionId) {
  if (!sessionId) return null;
  const filePath = getSkillsFilePath(sessionId);
  try {
    const raw = readFileSync(filePath, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    // Scan backward for the last parseable line (resilient to partial writes)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry && entry.skill) return entry.skill;
      } catch { /* corrupt line — try previous */ }
    }
    return null;
  } catch {
    return null;
  }
}

function getRecentSkill(data) {
  // Use per-session JSONL only (uses session_id from StatusJSON)
  if (data && data.session_id) {
    return getRecentSkillBySession(data.session_id);
  }
  return null;
}

// ─── Context-size formatter ──────────────────────────────────────────────────
function formatSize(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(0) + 'M';
  if (n >= 1_000) return Math.round(n / 1_000) + 'K';
  return String(n);
}

// ─── Progress bar renderer ───────────────────────────────────────────────────
// Single foreground color for the entire filled portion — no internal ANSI
// boundaries. Visual tiers come from shade-character density:
//   ▓ (75%) = cached, brighter  |  ▒ (50%) = uncached, darker  |  ░ (25%) = empty
// This follows ccstatusline's pattern: one-color bar, no per-character fg().
//
// usedPct      — total context window usage (0–100)
// cachePctUsed — cache-hit portion of USED context (0–100), NOT of total window
// width        — character width of the bar interior
function renderBar(usedPct, cachePctUsed, width) {
  usedPct = Math.max(0, Math.min(100, usedPct));
  cachePctUsed = Math.max(0, Math.min(100, cachePctUsed || 0));

  // Cache as percentage of total bar width
  const cacheOfTotal = (cachePctUsed / 100) * usedPct;

  const totalCols = Math.round((usedPct / 100) * width);
  const cacheCols = Math.round((cacheOfTotal / 100) * width);

  // Clamp to prevent overlap
  const c = Math.min(cacheCols, totalCols);
  const u = Math.max(0, totalCols - c);
  const e = Math.max(0, width - totalCols);

  // Build the filled portion as a single string — ONE fg() wrapper, zero
  // internal ANSI codes. The shade characters (▓ vs ▒) create the visual
  // distinction without any color boundary in between.
  let filled = '';
  if (c > 0) filled += FILL_CACHED.repeat(c);
  if (u > 0) filled += FILL_UNCACHED.repeat(u);

  let bar = '';
  if (filled.length > 0) bar += fg(C.barFilled) + filled + R;
  if (e > 0) bar += fg(C.barEmpty) + FILL_EMPTY.repeat(e) + R;

  return bar;
}

// ─── Line builders ───────────────────────────────────────────────────────────
function dimDot() {
  return fg(C.separator) + D + NBSP + SEP + NBSP + R;
}

function renderLine1(data) {
  const parts = [];

  // Model
  const model = prettyModel(data.model);
  parts.push(B + fg(C.model) + model + R);

  // Thinking effort — StatusJSON: { effort: { level: string|null } | null }
  const effortLevel = (data.effort && data.effort.level) || null;
  parts.push(
    effortColor(effortLevel) + B + effortGlyph() + NBSP + effortLabel(effortLevel) + R,
  );

  // Current directory (prefer worktree original_cwd if inside a worktree)
  let cwd = data.cwd || (data.workspace && data.workspace.current_dir) || process.cwd();
  if (data.worktree && data.worktree.original_cwd) {
    cwd = data.worktree.original_cwd;
  }
  parts.push(fg(C.dir) + shortPath(cwd, CONFIG.maxDirDepth) + R);

  // Git branch (prefer worktree branch if available)
  const worktreeBranch = data.worktree && data.worktree.branch;
  const gitBranch = worktreeBranch || getGitBranch(cwd);
  if (gitBranch) {
    parts.push(fg(C.git) + '⎇' + NBSP + gitBranch + R);
  }

  // Recent skill (per-session via session_id from StatusJSON)
  const skill = getRecentSkill(data);
  if (skill) {
    // Build the prefix (everything before skill) to measure its visible width
    const prefix = '\x1b[0m' + parts.join(dimDot()).replace(/ /g, NBSP);
    // Separator that would precede the skill, plus skill icon + NBSP
    const skillPrefix = dimDot() + fg(C.skill) + '✦' + NBSP;
    const skillSuffix = R;
    const prefixWidth = visibleLen(prefix);
    const skillPrefixWidth = visibleLen(skillPrefix) + visibleLen(skillSuffix);

    // Get terminal width
    const termWidth = (data && data.terminal_width)
      || process.stdout.columns
      || (process.env.COLUMNS && parseInt(process.env.COLUMNS, 10))
      || 120;
    const available = Math.max(0, termWidth - prefixWidth - skillPrefixWidth);

    let skillStr;
    if (skill.length <= available) {
      skillStr = skill;
    } else if (available > 2) {
      skillStr = skill.slice(0, available - 1) + '…';
    } else {
      skillStr = ''; // no room — skip the skill entirely
    }

    if (skillStr) {
      parts.push(fg(C.skill) + '✦' + NBSP + skillStr + R);
    }
  }

  return '\x1b[0m' + parts.join(dimDot()).replace(/ /g, NBSP);
}

function renderLine2(data) {
  const ctx = data.context_window || {};

  // Determine context window size — validate it's a positive finite number
  const modelId = getModelId(data.model);
  const rawCtxSize = ctx.context_window_size;
  const ctxSize = (typeof rawCtxSize === 'number' && Number.isFinite(rawCtxSize) && rawCtxSize > 0)
    ? rawCtxSize
    : getContextSize(modelId);

  // Total context usage percentage (from Claude Code — already correct)
  let usedPct = 0;
  if (typeof ctx.used_percentage === 'number' && Number.isFinite(ctx.used_percentage)) {
    usedPct = ctx.used_percentage;
  } else if (ctx.current_usage) {
    const cu = ctx.current_usage;
    const actual =
      (typeof cu === 'object' ? num(cu.input_tokens) : num(cu)) +
      (typeof cu === 'object' ? num(cu.cache_creation_input_tokens) : 0) +
      (typeof cu === 'object' ? num(cu.cache_read_input_tokens) : 0);
    usedPct = (actual / ctxSize) * 100;
  }

  // Cache hit rate: what % of the actual context was read from cache.
  // actualContext = input_tokens + cache_creation + cache_read (ALL THREE)
  // cacheHitRate  = cache_read / actualContext * 100
  // (Only cache_read counts as "hit"; cache_creation is new cache writes, billed higher)
  let cacheHitRate = 0;
  if (ctx.current_usage && typeof ctx.current_usage === 'object') {
    const cu = ctx.current_usage;
    const fresh = num(cu.input_tokens);
    const create = num(cu.cache_creation_input_tokens);
    const read = num(cu.cache_read_input_tokens);
    const actual = fresh + create + read;
    if (actual > 0) {
      cacheHitRate = Math.min(100, (read / actual) * 100);
    }
  }

  const bar = renderBar(usedPct, cacheHitRate, CONFIG.barWidth);
  const pctStr = usedPct.toFixed(0) + '%';
  const sizeStr = formatSize(ctxSize);

  let line = '';
  // Label with context window size
  line += fg(C.label) + 'ctx' + NBSP + fg(C.separator) + sizeStr + NBSP + R;
  // Bar
  line += fg(C.barBracket) + '[' + R + bar + fg(C.barBracket) + ']' + R;
  // Percentage
  line += NBSP + fg(C.barPct) + B + pctStr + R;

  // Cached hit rate (only if we have cache data)
  if (cacheHitRate > 0.5) {
    const cacheStr = cacheHitRate.toFixed(0) + '%';
    line += NBSP + fg(C.separator) + D + SEP + R + NBSP;
    line += fg(C.barFilled) + '↖' + NBSP + 'cached' + NBSP + cacheStr + R;
  }

  // Replace regular spaces with NBSP for VSCode compatibility
  return '\x1b[0m' + line.replace(/ /g, NBSP);
}

// ─── Preview mode ────────────────────────────────────────────────────────────
function preview() {
  const sample = {
    model: { id: 'deepseek-v4-pro' },
    session_id: 'preview-session',
    effort: { level: 'medium' },
    cwd: os.homedir() + '/Projects',
    worktree: null,
    context_window: {
      context_window_size: 1000000,
      used_percentage: 45,
      current_usage: {
        // actualContext = fresh + create + read = 450000 (45% of 1M)
        input_tokens: 5000,                   // fresh, uncached (new turn msg)
        output_tokens: 32000,
        cache_creation_input_tokens: 175000,  // new cache writes
        cache_read_input_tokens: 270000,      // served from cache (hit!)
        // → cacheHitRate = 270000 / 450000 = 60%
      },
    },
  };

  // Simulate a git branch
  gitCache.branch = 'feature/statusline';
  gitCache.ts = Date.now();
  gitCache.dir = sample.cwd;

  // Simulate a skill (per-session JSONL format, like the hook writes)
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const skillFile = path.join(CACHE_DIR, 'skills-preview-session.jsonl');
    writeFileSync(skillFile, JSON.stringify({
      timestamp: new Date().toISOString(),
      session_id: 'preview-session',
      skill: 'brainstorming',
      source: 'PreToolUse',
    }) + '\n');
  } catch {}

  // Gather all effort levels for showcase
  const efforts = ['low', 'medium', 'high', 'xhigh', 'ultra', 'max'];

  console.log('');
  console.log('  ╭──────────────── Preview — cclitehud ────────────────╮');
  console.log('');

  // ── Line 1 — all effort level variants ──
  const baseData = { ...sample };
  for (const eff of efforts) {
    baseData.effort = { level: eff };
    console.log('  ' + renderLine1(baseData));
  }

  // ── Line 2 — main sample (45% used, 60% cached-of-used) ──
  console.log('');
  console.log('  ' + renderLine2(sample));
  console.log('');

  // ── Line 2 variants ──
  console.log('  Variants:');
  const variants = [
    { label: 'Low usage (12%), 90% cached hit rate', used: 12, hitRate: 90, size: 1000000 },
    { label: 'High usage (85%), 56% cached hit rate', used: 85, hitRate: 56, size: 200000 },
    { label: 'Medium usage (45%), no cache', used: 45, hitRate: 0, size: 200000 },
  ];
  for (const v of variants) {
    const actual = Math.round((v.used / 100) * v.size);
    const read = Math.round((v.hitRate / 100) * actual);
    const remaining = actual - read;
    // Split remaining between fresh and cache_creation
    const create = Math.round(remaining * 0.95); // most of non-hit is new cache writes
    const fresh = remaining - create;            // tiny bit is fresh tokens
    const vData = {
      model: v.size === 1000000 ? { id: 'deepseek-v4-pro' } : { id: 'claude-sonnet-4-6' },
      context_window: {
        context_window_size: v.size,
        used_percentage: v.used,
        current_usage: {
          input_tokens: fresh,
          cache_creation_input_tokens: create,
          cache_read_input_tokens: read,
        },
      },
    };
    console.log('    ' + v.label);
    console.log('    ' + renderLine2(vData));
  }

  console.log('');
  console.log('  Legend:');
  console.log('  ' + fg(C.barFilled) + FILL_CACHED.repeat(10) + R + '  cached (▓ 75% density, brighter)');
  console.log('  ' + fg(C.barFilled) + FILL_UNCACHED.repeat(10) + R + '  uncached (▒ 50% density, darker)');
  console.log('  ' + fg(C.barEmpty) + FILL_EMPTY.repeat(10) + R + '  empty (░ 25% density, pixel dots)');
  console.log('');
  console.log('  Effort icon: ◆ (unified for all levels — color indicates intensity)');
  console.log('');
  console.log('  ╰───────────────────────────────────────────────────────────────╯');
  console.log('');
}

// ─── Install mode ────────────────────────────────────────────────────────────
/** Shell-quote a path for safe embedding in command strings */
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function install() {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  const selfPath = path.resolve(__filename);
  const nodePath = process.execPath || 'node';
  const cmd = `${shellQuote(nodePath)} ${shellQuote(selfPath)}`;
  const hookCmd = `${cmd} --hook`;

  let settings = {};
  try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch {}

  // statusLine
  settings.statusLine = {
    type: 'command',
    command: cmd,
    refreshInterval: 10,
  };

  // hooks — merge with existing, preserving other hooks
  const hooks = settings.hooks || {};
  if (!Array.isArray(hooks.PreToolUse)) hooks.PreToolUse = [];
  if (!Array.isArray(hooks.UserPromptSubmit)) hooks.UserPromptSubmit = [];

  // Helper: upsert our hook command within a matcher entry's hooks array
  // Detect our own hooks by checking for the script's basename + --hook flag
  const selfBasename = path.basename(selfPath);
  function upsertHook(entry) {
    if (!Array.isArray(entry.hooks)) entry.hooks = [];
    const idx = entry.hooks.findIndex(h =>
      h && typeof h.command === 'string'
      && h.command.includes(selfBasename)
      && h.command.includes('--hook'));
    if (idx >= 0) {
      entry.hooks[idx] = { type: 'command', command: hookCmd };
    } else {
      entry.hooks.push({ type: 'command', command: hookCmd });
    }
  }

  // PreToolUse Skill hook — upsert by matcher
  let skillMatcher = hooks.PreToolUse.find(h => h && h.matcher === 'Skill');
  if (!skillMatcher) {
    skillMatcher = { matcher: 'Skill', hooks: [] };
    hooks.PreToolUse.push(skillMatcher);
  }
  upsertHook(skillMatcher);

  // UserPromptSubmit hook — upsert (preserve other UserPromptSubmit hooks)
  let upsEntry = hooks.UserPromptSubmit.find(h => h && !h.matcher);
  if (!upsEntry) {
    upsEntry = { hooks: [] };
    hooks.UserPromptSubmit.push(upsEntry);
  }
  upsertHook(upsEntry);

  settings.hooks = hooks;

  try { mkdirSync(path.dirname(settingsPath), { recursive: true }); } catch {}
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  console.log(`✅  cclitehud installed!`);
  console.log(`   statusLine → ${cmd}`);
  console.log(`   hooks      → PreToolUse + UserPromptSubmit`);
  console.log(`   config     → ${settingsPath}`);
  console.log(`   Restart Claude Code to activate.`);

  // Also run preview to confirm it works
  console.log('');
  preview();
}

// ─── Doctor mode ─────────────────────────────────────────────────────────────
function doctor() {
  const checks = [];
  let passCount = 0;
  let warnCount = 0;
  let failCount = 0;

  const pass = (label, detail) => { checks.push({ icon: '✅', label, detail }); passCount++; };
  const warn = (label, detail) => { checks.push({ icon: '⚠️', label, detail }); warnCount++; };
  const fail = (label, detail) => { checks.push({ icon: '❌', label, detail }); failCount++; };

  console.log('');
  console.log('  ╭──────────────── Doctor — cclitehud ────────────────╮');
  console.log('');

  // 1. Node.js version
  const nodeVersion = process.versions.node;
  const major = parseInt(nodeVersion.split('.')[0], 10);
  if (major >= 14) {
    pass('Node.js version', `v${nodeVersion} (≥14 required)`);
  } else {
    fail('Node.js version', `v${nodeVersion} — need ≥14`);
  }

  // 2. index.js exists and is readable
  const selfPath = __filename;
  try {
    readFileSync(selfPath);
    pass('index.js readable', selfPath);
  } catch (e) {
    fail('index.js readable', `Cannot read: ${e.message}`);
  }

  // 3. Cache directory
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const testFile = path.join(CACHE_DIR, '.doctor-test');
    writeFileSync(testFile, 'ok');
    readFileSync(testFile, 'utf8');
    // Clean up — use unlinkSync from fs but we don't import it, use writeFileSync to empty
    writeFileSync(testFile, '');
    pass('Cache directory', `${CACHE_DIR} (read/write)`);
  } catch (e) {
    fail('Cache directory', `${CACHE_DIR} — ${e.message}`);
  }

  // 4. Git availability and branch detection
  try {
    const gitVer = execSync('git --version', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
    pass('Git available', gitVer);
  } catch {
    warn('Git available', 'git not found in PATH — branch display disabled');
  }

  const testCwd = process.cwd();
  const testBranch = getGitBranch(testCwd);
  if (testBranch) {
    pass('Git branch detection', `detected: ${testBranch} (cwd: ${testCwd})`);
  } else {
    warn('Git branch detection', `no branch in ${testCwd} (not a git repo or detached HEAD)`);
  }

  // 5. settings.json — statusLine config
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  let settings = null;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch (e) {
    fail('settings.json', `Cannot read/parse: ${e.message}`);
  }

  if (settings) {
    // Check statusLine
    const sl = settings.statusLine;
    if (sl && sl.type === 'command' && typeof sl.command === 'string') {
      // Parse command — handle both `node /path` and `'/path/node' '/path/index.js'` formats
      const rawCmd = sl.command;
      // Extract script path: last quoted or unquoted segment that looks like a file path
      const quotedPaths = [...rawCmd.matchAll(/'([^']+)'/g)].map(m => m[1]);
      const scriptPath = quotedPaths.length >= 2
        ? quotedPaths[1]                          // second quoted arg = script
        : rawCmd.replace(/^node\s+/, '').split(' ')[0]; // legacy format
      // Resolve to absolute for comparison
      let resolvedCmd = scriptPath;
      if (!path.isAbsolute(resolvedCmd)) {
        resolvedCmd = path.resolve(path.dirname(settingsPath), resolvedCmd);
      }
      const resolvedSelf = path.resolve(selfPath);

      if (resolvedCmd === resolvedSelf) {
        pass('statusLine config', `command points to this file (refreshInterval: ${sl.refreshInterval || 'default'})`);
      } else if (scriptPath.includes('cclitehud')) {
        warn('statusLine config', `path mismatch:\n        settings → ${scriptPath}\n        actual   → ${resolvedSelf}`);
      } else {
        warn('statusLine config', `points to different script: ${scriptPath}`);
      }
    } else {
      fail('statusLine config', 'missing or invalid statusLine in settings.json');
    }

    // Check hooks
    const hooks = settings.hooks || {};

    // PreToolUse → Skill
    const preHooks = hooks.PreToolUse || [];
    const skillHook = preHooks.find(h => h.matcher === 'Skill');
    if (skillHook && skillHook.hooks && skillHook.hooks[0]) {
      const cmd = skillHook.hooks[0].command;
      if (cmd.includes('index.js') && cmd.includes('--hook')) {
        pass('PreToolUse Skill hook', 'configured correctly');
      } else {
        warn('PreToolUse Skill hook', `unexpected command: ${cmd}`);
      }
    } else {
      fail('PreToolUse Skill hook', 'not configured — skill tracking disabled');
    }

    // UserPromptSubmit
    const upsHooks = hooks.UserPromptSubmit || [];
    if (upsHooks.length > 0 && upsHooks[0].hooks && upsHooks[0].hooks[0]) {
      const cmd = upsHooks[0].hooks[0].command;
      if (cmd.includes('index.js') && cmd.includes('--hook')) {
        pass('UserPromptSubmit hook', 'configured correctly');
      } else {
        warn('UserPromptSubmit hook', `unexpected command: ${cmd}`);
      }
    } else {
      warn('UserPromptSubmit hook', 'not configured — /slash command tracking disabled');
    }
  }

  // 6. Skill tracking round-trip
  const testSessionId = 'doctor-test-' + process.pid;
  const testSkillName = 'doctor-test-skill';
  try {
    const testFilePath = getSkillsFilePath(testSessionId);
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      session_id: testSessionId,
      skill: testSkillName,
      source: 'PreToolUse',
    });
    writeFileSync(testFilePath, entry + '\n', { flag: 'a' });
    const readBack = getRecentSkillBySession(testSessionId);
    if (readBack === testSkillName) {
      pass('Skill tracking', 'write + read round-trip OK');
    } else {
      fail('Skill tracking', `wrote "${testSkillName}", read back "${readBack}"`);
    }
    // Clean up test file
    writeFileSync(testFilePath, '');
  } catch (e) {
    fail('Skill tracking', `round-trip failed: ${e.message}`);
  }

  // 7. Render test
  try {
    const mockData = {
      model: { id: 'test-model' },
      session_id: 'doctor-render-test',
      effort: { level: 'high' },
      cwd: os.homedir(),
      context_window: {
        context_window_size: 200000,
        used_percentage: 42,
        current_usage: {
          input_tokens: 10000,
          output_tokens: 5000,
          cache_creation_input_tokens: 30000,
          cache_read_input_tokens: 44000,
        },
      },
    };
    const line1 = renderLine1(mockData);
    const line2 = renderLine2(mockData);
    if (line1.length > 0 && line2.length > 0) {
      pass('Render test', 'both lines generated');
      console.log('');
      console.log('  ' + line1);
      console.log('  ' + line2);
      console.log('');
    } else {
      fail('Render test', 'empty output');
    }
  } catch (e) {
    fail('Render test', e.message);
  }

  // 9. ANSI 256-color support
  if (process.stdout.isTTY && (process.stdout.hasColors ? process.stdout.hasColors(256) : true)) {
    pass('ANSI 256-color', 'terminal supports 256 colors');
  } else if (!process.stdout.isTTY) {
    warn('ANSI 256-color', 'not a TTY — colors may not render (this is normal for doctor mode)');
  } else {
    warn('ANSI 256-color', 'terminal may not support 256 colors');
  }

  // 10. visibleLen CJK test
  const cjkTest = visibleLen('\x1b[38;5;111m中文test\x1b[0m');
  if (cjkTest === 8) {
    pass('visibleLen CJK', `'中文test' → 8 columns (correct)`);
  } else {
    fail('visibleLen CJK', `'中文test' → ${cjkTest} columns (expected 8)`);
  }

  // 11. Existing session data summary
  try {
    const files = require('fs').readdirSync(CACHE_DIR);
    const sessionFiles = files.filter(f => f.startsWith('session-') && f.endsWith('.json'));
    const skillFiles = files.filter(f => f.startsWith('skills-') && f.endsWith('.jsonl'));
    const debugLog = files.includes('debug.jsonl');
    if (sessionFiles.length > 0 || skillFiles.length > 0) {
      pass('Cache data', `${sessionFiles.length} session files, ${skillFiles.length} skill files${debugLog ? ', debug log active' : ''}`);
    } else {
      warn('Cache data', 'no session/skill files yet (normal on first run)');
    }
  } catch {
    warn('Cache data', 'could not enumerate cache directory');
  }

  // Print results
  console.log('');
  for (const c of checks) {
    const detail = typeof c.detail === 'string' ? c.detail.replace(/\n/g, '\n        ') : String(c.detail);
    console.log(`  ${c.icon}  ${c.label}`);
    console.log(`     ${fg(243)}${detail}${R}`);
  }

  console.log('');
  const summaryColor = failCount > 0 ? fg(203) : warnCount > 0 ? fg(222) : fg(151);
  console.log(`  ${summaryColor}${passCount} passed · ${warnCount} warnings · ${failCount} failed${R}`);
  console.log('');
  console.log('  ╰───────────────────────────────────────────────────────────────╯');
  console.log('');

  process.exit(failCount > 0 ? 1 : 0);
}

// ─── Main ────────────────────────────────────────────────────────────────────
function main() {
  const DEBUG = process.argv.includes('--debug');

  // --hook mode: process hook payload from Claude Code (PreToolUse / UserPromptSubmit)
  if (process.argv.includes('--hook')) {
    handleHook();
    return;
  }

  // --preview mode: show sample rendering
  if (process.argv.includes('--preview') || process.argv.includes('-p')) {
    preview();
    return;
  }

  // --doctor mode: diagnose installation and configuration
  if (process.argv.includes('--doctor')) {
    doctor();
    return;
  }

  // --install mode: auto-configure ~/.claude/settings.json
  if (process.argv.includes('--install')) {
    install();
    return;
  }

  // Normal piped mode: read StatusJSON from stdin, render statusline
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8'); // fd 0 = stdin
  } catch {
    console.error('cclitehud: no stdin data. Run with --preview to see a sample.');
    process.exit(0);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error('cclitehud: failed to parse stdin JSON');
    process.exit(0);
  }

  // Debug mode: log raw StatusJSON context_window + model fields to a file
  if (DEBUG) {
    try {
      mkdirSync(CACHE_DIR, { recursive: true });
      const logPath = path.join(CACHE_DIR, 'debug.jsonl');
      const entry = {
        ts: new Date().toISOString(),
        model: data.model,
        context_window: data.context_window,
        effort: data.effort,
        status: data.status,
        // derived values for quick diagnosis
        _usedPct_isNumber: typeof (data.context_window && data.context_window.used_percentage) === 'number',
        _usedPct_value: data.context_window && data.context_window.used_percentage,
        _ctxSize: data.context_window && data.context_window.context_window_size,
      };
      appendFileSync(logPath, JSON.stringify(entry) + '\n');
    } catch {}
  }

  // Render and output
  process.stdout.write(renderLine1(data) + '\n');
  process.stdout.write(renderLine2(data) + '\n');
}

main();
