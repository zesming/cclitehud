#!/usr/bin/env node
'use strict';

/**
 * cclitehud — A lightweight Claude Code HUD, in two parts:
 *
 *   plugin/           A Claude Code plugin drawing two rows above the prompt,
 *                     in the terminal and the desktop Code tab alike:
 *                     directory · worktree · branch · skill, then the context
 *                     and usage-limit bars and the weekly API-equivalent cost.
 *   index.js          The terminal statusLine: model · thinking effort. The
 *                     plugin sees effort only on a running turn's steps, not
 *                     the session's setting; the desktop shows both itself.
 *                     Also computes the weekly cost for the plugin
 *                     (--refresh-cost) and sets both parts up (--install).
 *
 * Reads StatusJSON from stdin (piped by Claude Code).
 * Run with --preview to see a sample rendering.
 */

const {
  readFileSync, mkdirSync, writeFileSync, appendFileSync,
  existsSync, readdirSync, statSync, unlinkSync, renameSync, realpathSync, chmodSync,
} = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');
const os = require('os');

// ─── 256-color palette (muted, modern, not garish) ──────────────────────────
const C = {
  model: 117, // soft sky blue
  effort: { low: 151, medium: 222, high: 215, xhigh: 210, max: 209 },
  effDefault: 248,
  separator: 243, // muted gray
};

// ─── ANSI helpers ────────────────────────────────────────────────────────────
const fg = (n) => `\x1b[38;5;${n}m`;
const R = '\x1b[0m';
const B = '\x1b[1m';
const D = '\x1b[2m';

// Non-breaking space — prevents VSCode trimming
const NBSP = ' ';
const SEP = '·'; // middle dot separator

// Safe numeric coercion — prevents string concatenation bugs (e.g. "500"+"1000" → "5001000")
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

const CACHE_DIR = path.join(os.homedir(), '.cache', 'cclitehud');
// Claude Code's own config folder: settings.json and the transcripts
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PLUGIN_DIR = path.join(__dirname, 'plugin');
const OLD_PLUGIN_DIR = path.join(__dirname, 'desktop-plugin'); // name before 2026-10

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

function prettyModel(raw) {
  // Return raw model ID as-is — no prettification, no name mapping
  if (!raw) return '?';
  // Prefer id over display_name since id is the canonical model identifier
  const id = typeof raw === 'string' ? raw : (raw.id || raw.display_name || '?');
  return sanitizeDisplay(String(id).trim(), 80) || '?';
}

// ─── Thinking-effort helpers ─────────────────────────────────────────────────
const EFFORT_ICON = '◆'; // diamond icon, color-coded by effort level
const EFFORT_LABELS = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };

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

// ─── Statusline ──────────────────────────────────────────────────────────────
function dimDot() {
  return fg(C.separator) + D + NBSP + SEP + NBSP + R;
}

// Model · effort — StatusJSON: { model, effort: { level: string|null } | null }
function renderStatusline(data) {
  const model = prettyModel(data.model);
  const effortLevel = (data.effort && data.effort.level) || null;
  const parts = [
    B + fg(C.model) + model + R,
    effortColor(effortLevel) + B + effortGlyph() + NBSP + effortLabel(effortLevel) + R,
  ];
  return '\x1b[0m' + parts.join(dimDot()).replace(/ /g, NBSP);
}

// ─── Weekly API-equivalent cost ──────────────────────────────────────────────
// Sums what this machine's Claude Code usage in the current 7d limit window
// would cost at API list prices. Source: transcripts under
// <CLAUDE_CONFIG_DIR|~/.claude>/projects/**/*.jsonl (subagents included),
// deduplicated by message.id + requestId (one response spans several lines).
//
// The plugin runs `--refresh-cost <windowStart>` at most once a minute
// and reads the cache this writes.
const COST_CACHE_FILE = path.join(CACHE_DIR, 'weekly-cost.json');
// The node --install ran with, for the plugin: a desktop app's PATH misses
// nvm / volta / asdf installs
const NODE_PATH_FILE = path.join(CACHE_DIR, 'node-path');

// $ per million tokens: [input, output, cacheRead], Anthropic API list prices
// as of 2026-10. Cache writes are derived: 5m = 1.25× input, 1h = 2× input.
// First matching prefix wins, so more specific IDs come before shorter ones.
// Not modeled: long-context premiums of older 1M-context betas, and fast mode
// on models whose fast price is not 2× (FAST_MULTIPLIER).
const PRICING = [
  ['claude-fable-5-1', [10, 50, 0.25]],
  ['claude-mythos-5-1', [10, 50, 0.25]],
  ['claude-fable-5', [10, 50, 1]],
  ['claude-mythos-5', [10, 50, 1]],
  ['claude-opus-5-5', [4, 20, 0.2]],
  ['claude-opus-5', [5, 25, 0.5]],
  ['claude-opus-4-8', [5, 25, 0.5]],
  ['claude-opus-4-7', [5, 25, 0.5]],
  ['claude-opus-4-6', [5, 25, 0.5]],
  ['claude-opus-4-5', [5, 25, 0.5]],
  ['claude-opus-4', [15, 75, 1.5]],
  ['claude-sonnet-5-5', [2, 10, 0.2]],
  ['claude-sonnet-5', [2, 10, 0.2]],
  ['claude-sonnet-4', [3, 15, 0.3]],
  ['claude-3-7-sonnet', [3, 15, 0.3]],
  ['claude-3-5-sonnet', [3, 15, 0.3]],
  ['claude-haiku-5-5', [0.1, 0.5, 0.01]],
  ['claude-haiku-4-5', [1, 5, 0.1]],
  ['claude-3-5-haiku', [0.8, 4, 0.08]],
];
const HAIKU_55_LONG = [0.5, 2.5, 0.05]; // prompts over 100K tokens
const FAST_MULTIPLIER = 2; // usage.speed === 'fast' (Opus 5 / 5.5 fast mode)

function priceFor(model) {
  // Bedrock-style IDs: an optional region prefix (us., eu., apac., …) + anthropic.
  const id = String(model || '').replace(/^(?:[a-z]+\.)?anthropic\./, '');
  for (const [prefix, price] of PRICING) {
    if (id.startsWith(prefix)) return price;
  }
  return null; // unknown / non-Claude model → not counted
}

function usageCostUsd(model, u) {
  let price = priceFor(model);
  if (!price || !u) return 0;
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  const read = num(u.cache_read_input_tokens);
  const create = num(u.cache_creation_input_tokens);
  const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
  const write1h = cc ? num(cc.ephemeral_1h_input_tokens) : 0;
  const write5m = cc ? Math.max(0, create - write1h) : create;
  if (String(model).includes('haiku-5-5') && input + read + create > 100000) price = HAIKU_55_LONG;
  const [pIn, pOut, pRead] = price;
  let usd = (input * pIn + output * pOut + read * pRead
    + write5m * pIn * 1.25 + write1h * pIn * 2) / 1e6;
  if (u.speed === 'fast') usd *= FAST_MULTIPLIER;
  return usd;
}

function projectsDir() {
  return path.join(CONFIG_DIR, 'projects');
}

/** Scan transcripts and sum API-equivalent cost for messages at or after windowStart (unix s) */
function computeWindowCost(windowStart) {
  const startMs = windowStart * 1000;
  const files = [];
  (function walk(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.jsonl')) {
        try { if (statSync(full).mtimeMs >= startMs) files.push(full); } catch {}
      }
    }
  })(projectsDir());

  // Last line per response wins (later lines carry the final usage)
  const byKey = new Map();
  for (const f of files) {
    let raw;
    try { raw = readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.includes('"usage"')) continue;
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      const msg = d && d.message;
      if (!msg || !msg.usage) continue;
      if (!(Date.parse(d.timestamp) >= startMs)) continue;
      const key = (msg.id || '') + ':' + (d.requestId || '');
      if (key === ':') continue;
      byKey.set(key, usageCostUsd(msg.model, msg.usage));
    }
  }
  let total = 0;
  for (const usd of byKey.values()) total += usd;
  return total;
}

/** Handle --refresh-cost <windowStart>: recompute and write the cost cache */
function refreshCost(windowStart) {
  try {
    const usd = computeWindowCost(windowStart);
    mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = COST_CACHE_FILE + '.' + process.pid;
    writeFileSync(tmp, JSON.stringify({ windowStart, usd, computedAt: Date.now() }));
    renameSync(tmp, COST_CACHE_FILE);
  } catch {}
}

// ─── Preview mode ────────────────────────────────────────────────────────────
function preview() {
  const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
  console.log('');
  console.log('  Statusline — model · effort (terminal, below the prompt):');
  console.log('');
  for (const eff of efforts) {
    console.log('  ' + renderStatusline({ model: { id: 'claude-opus-5-5' }, effort: { level: eff } }));
  }
  console.log('');
  console.log('  The band above the prompt (directory, branch, skill, context and');
  console.log('  usage bars, weekly cost) comes from the plugin in plugin/.');
  console.log('  See README.md, or open preview.html.');
  console.log('');
}

// ─── Install mode ────────────────────────────────────────────────────────────
const SETTINGS_PATH = path.join(CONFIG_DIR, 'settings.json');

/** Shell-quote a path for safe embedding in command strings */
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * True for a skill hook an older cclitehud installed: an `index.js` under a
 * cclitehud (or a pre-rename) folder, or this very file, run with a
 * standalone `--hook` argument.
 */
function isOwnHook(h) {
  if (!h || typeof h.command !== 'string') return false;
  const cmd = h.command;
  if (!/(^|\s)--hook(\s|$)/.test(cmd)) return false;
  // Folder names this project has shipped under (not the unrelated ccstatusline)
  return cmd.includes(path.resolve(__filename))
    || /(cclitehud|ccstatus|ccstatuslite|ccstatusline-custom)\/index\.js\b/.test(cmd);
}

/** Remove our legacy skill hooks, dropping matcher groups they leave empty */
function removeLegacyHooks(hooks) {
  let removed = 0;
  for (const event of ['PreToolUse', 'UserPromptSubmit']) {
    if (!Array.isArray(hooks[event])) continue;
    hooks[event] = hooks[event].filter(entry => {
      if (!entry || !Array.isArray(entry.hooks)) return true;
      const before = entry.hooks.length;
      entry.hooks = entry.hooks.filter(h => !isOwnHook(h));
      removed += before - entry.hooks.length;
      return entry.hooks.length > 0 || before === 0;
    });
    if (hooks[event].length === 0) delete hooks[event];
  }
  return removed;
}

/**
 * CLAUDE_CODE_PLUGIN_DIRS entries as Claude Code reads them: trimmed, `~`
 * expanded, relative entries skipped (Claude Code ignores those too)
 */
function pluginDirEntries(value) {
  return String(value || '').split(path.delimiter)
    .map(p => p.trim().replace(/^~(?=$|\/)/, os.homedir()))
    .filter(p => p && path.isAbsolute(p))
    .map(p => path.resolve(p));
}

/** settings.json as an object; {} when missing, throws when unreadable */
function readSettings() {
  let raw;
  try {
    raw = readFileSync(SETTINGS_PATH, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`cannot read ${SETTINGS_PATH}: ${e.message}`);
  }
  let settings;
  try {
    settings = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${SETTINGS_PATH} is not valid JSON (${e.message}) — fix it, or edit it by hand as README.md shows`);
  }
  if (!isPlainObject(settings)) throw new Error(`${SETTINGS_PATH} does not hold a JSON object`);
  return settings;
}

/**
 * Write atomically through any symlink (dotfile managers), keeping the file's
 * mode (settings.json may hold tokens); the first run keeps a .bak of the
 * original, later runs leave that backup alone
 */
function writeSettings(settings) {
  mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  let target = SETTINGS_PATH;
  let mode = 0o600;
  let backup = null; // the .bak this run made beside the real file
  if (existsSync(SETTINGS_PATH)) {
    target = realpathSync(SETTINGS_PATH);
    mode = statSync(target).mode & 0o777;
    if (!existsSync(target + '.bak')) {
      backup = target + '.bak';
      writeFileSync(backup, readFileSync(target), { mode });
      chmodSync(backup, mode);
    }
  }
  const tmp = target + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { mode });
  chmodSync(tmp, mode); // umask may have narrowed or widened it
  renameSync(tmp, target);
  return backup;
}

/** The node to write into the statusLine: a stable symlink over a versioned path */
function stableNodePath() {
  const exec = process.execPath || 'node';
  let real;
  try { real = realpathSync(exec); } catch { return exec; }
  for (const link of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
    try { if (realpathSync(link) === real) return link; } catch {}
  }
  return exec;
}

/** Files older versions left in the cache: per-session skill logs, cost lock */
function removeLegacyCacheFiles() {
  let files;
  try { files = readdirSync(CACHE_DIR); } catch { return 0; }
  let removed = 0;
  for (const f of files) {
    if ((f.startsWith('skills-') && f.endsWith('.jsonl')) || f === 'weekly-cost.lock') {
      try { unlinkSync(path.join(CACHE_DIR, f)); removed++; } catch {}
    }
  }
  return removed;
}

function install() {
  const cmd = `${shellQuote(stableNodePath())} ${shellQuote(path.resolve(__filename))}`;

  let settings;
  try {
    settings = readSettings();
    if (settings.env === null) delete settings.env;
    if (settings.env !== undefined && !isPlainObject(settings.env)) {
      throw new Error(`"env" in ${SETTINGS_PATH} is not an object — fix it first`);
    }
  } catch (e) {
    console.error(`❌  ${e.message}`);
    process.exit(1);
  }

  // statusLine — model · effort; keeps fields the user added (padding, …).
  // Older installs wrote refreshInterval: 10 for the bars, no longer needed
  const statusLine = { ...(isPlainObject(settings.statusLine) ? settings.statusLine : {}), type: 'command', command: cmd };
  if (statusLine.refreshInterval === 10) delete statusLine.refreshInterval;
  settings.statusLine = statusLine;

  // Plugin — append our folder to CLAUDE_CODE_PLUGIN_DIRS, keeping others
  const env = settings.env || {};
  // and dropping this repo's folder under its old name
  const dirs = String(env.CLAUDE_CODE_PLUGIN_DIRS || '').split(path.delimiter).map(p => p.trim()).filter(Boolean)
    .filter(p => pluginDirEntries(p)[0] !== OLD_PLUGIN_DIR);
  if (!pluginDirEntries(dirs.join(path.delimiter)).includes(PLUGIN_DIR)) dirs.push(PLUGIN_DIR);
  env.CLAUDE_CODE_PLUGIN_DIRS = dirs.join(path.delimiter);
  settings.env = env;

  // Skill tracking moved into the plugin — drop the old hooks
  let removed = 0;
  if (isPlainObject(settings.hooks)) {
    removed = removeLegacyHooks(settings.hooks);
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }

  let backup;
  try {
    backup = writeSettings(settings);
  } catch (e) {
    console.error(`❌  cannot write ${SETTINGS_PATH}: ${e.message}`);
    process.exit(1);
  }
  const cleaned = removeLegacyCacheFiles();
  let nodeNoted = true;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(NODE_PATH_FILE, stableNodePath() + '\n');
  } catch { nodeNoted = false; }

  console.log(`✅  cclitehud installed!`);
  console.log(`   statusLine → ${cmd}`);
  console.log(`   plugin     → env.CLAUDE_CODE_PLUGIN_DIRS includes ${PLUGIN_DIR}`);
  if (removed > 0) console.log(`   hooks      → removed ${removed} legacy skill hook(s)`);
  if (cleaned > 0) console.log(`   cache      → removed ${cleaned} legacy file(s) from ${CACHE_DIR}`);
  if (!nodeNoted) console.log(`   node       → could not write ${NODE_PATH_FILE}; the plugin falls back to PATH`);
  console.log(`   config     → ${SETTINGS_PATH}`);
  if (backup) console.log(`   backup     → ${backup} (the file as it was before this run)`);
  console.log(`   Restart Claude Code (and the desktop app) to activate.`);
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
  if (major >= 14) pass('Node.js version', `v${nodeVersion} (≥14 required)`);
  else fail('Node.js version', `v${nodeVersion} — need ≥14`);

  // 2. Cache directory (weekly cost cache)
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const testFile = path.join(CACHE_DIR, '.doctor-test');
    writeFileSync(testFile, 'ok');
    readFileSync(testFile, 'utf8');
    unlinkSync(testFile);
    pass('Cache directory', `${CACHE_DIR} (read/write)`);
  } catch (e) {
    fail('Cache directory', `${CACHE_DIR} — ${e.message}`);
  }

  // 3. Plugin folder
  const pluginFiles = ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.tsx'];
  const missing = pluginFiles.filter(f => !existsSync(path.join(PLUGIN_DIR, f)));
  if (missing.length === 0) pass('Plugin folder', PLUGIN_DIR);
  else fail('Plugin folder', `${PLUGIN_DIR} — missing ${missing.join(', ')}`);

  // 4. settings.json
  const settingsPath = SETTINGS_PATH;
  let settings = null;
  try {
    settings = readSettings();
    pass('settings.json', existsSync(settingsPath) ? settingsPath : `${settingsPath} (not created yet)`);
  } catch (e) {
    fail('settings.json', e.message);
  }

  if (settings) {
    // statusLine → this file. Handles `'/path/node' '/path/index.js'` and `node /path`
    const sl = settings.statusLine;
    if (sl && sl.type === 'command' && typeof sl.command === 'string') {
      const quoted = [...sl.command.matchAll(/'([^']+)'/g)].map(m => m[1]);
      const scriptPath = (quoted.length >= 2 ? quoted[1] : sl.command.replace(/^node\s+/, '').split(' ')[0])
        .replace(/^~(?=$|\/)/, os.homedir());
      const resolved = path.isAbsolute(scriptPath) ? scriptPath : path.resolve(path.dirname(settingsPath), scriptPath);
      if (resolved === path.resolve(__filename)) pass('statusLine config', 'command points to this file');
      else if (scriptPath.includes('cclitehud')) warn('statusLine config', `path mismatch:\n        settings → ${scriptPath}\n        actual   → ${path.resolve(__filename)}`);
      else warn('statusLine config', `points to a different script: ${scriptPath}`);
    } else {
      fail('statusLine config', 'missing — model · effort not shown in the terminal (run --install)');
    }

    // Plugin registered through env.CLAUDE_CODE_PLUGIN_DIRS
    const pluginDirs = settings.env && settings.env.CLAUDE_CODE_PLUGIN_DIRS;
    if (pluginDirEntries(pluginDirs).includes(PLUGIN_DIR)) {
      pass('Plugin config', 'env.CLAUDE_CODE_PLUGIN_DIRS includes the plugin folder');
    } else if (pluginDirEntries(process.env.CLAUDE_CODE_PLUGIN_DIRS).includes(PLUGIN_DIR)) {
      pass('Plugin config', 'CLAUDE_CODE_PLUGIN_DIRS (process environment) includes the plugin folder');
    } else {
      fail('Plugin config', 'plugin folder not in env.CLAUDE_CODE_PLUGIN_DIRS — no band above the prompt (run --install)');
    }

    // Legacy skill hooks from an older install
    const hooks = settings.hooks || {};
    const legacy = ['PreToolUse', 'UserPromptSubmit'].some(ev => (Array.isArray(hooks[ev]) ? hooks[ev] : [])
      .some(e => e && Array.isArray(e.hooks) && e.hooks.some(isOwnHook)));
    if (legacy) warn('Legacy hooks', '`index.js --hook` entries are no longer needed — run --install to remove them');
    else pass('Legacy hooks', 'none');
  }

  // Node for the plugin's weekly cost, as --install noted it
  let noted = '';
  try { noted = readFileSync(NODE_PATH_FILE, 'utf8').trim(); } catch {}
  const runs = noted && spawnSync(noted, ['--version'], { timeout: 5000 }).status === 0;
  if (runs) pass('Plugin node', `${noted} (runs the weekly cost scan)`);
  else if (noted) warn('Plugin node', `${JSON.stringify(noted)} does not start — run --install again`);
  else warn('Plugin node', 'not noted — the plugin looks for node on PATH (run --install)');

  // 5. Weekly cost scan (dry run over the current week, nothing written)
  try {
    const t0 = Date.now();
    const usd = computeWindowCost(Math.floor(Date.now() / 1000) - 7 * 86400);
    pass('Weekly cost scan', `${projectsDir()} → $${usd.toFixed(2)} over the last 7 days (${Date.now() - t0} ms)`);
  } catch (e) {
    fail('Weekly cost scan', e.message);
  }

  // 6. Render test
  try {
    const line = renderStatusline({ model: { id: 'test-model' }, effort: { level: 'high' } });
    if (line.includes('test-model') && line.includes('high')) {
      pass('Render test', 'statusline generated');
      console.log('  ' + line);
    } else {
      fail('Render test', 'unexpected output');
    }
  } catch (e) {
    fail('Render test', e.message);
  }

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
  console.log('  ╰────────────────────────────────────────────────────╯');
  console.log('');

  process.exit(failCount > 0 ? 1 : 0);
}

// ─── Main ────────────────────────────────────────────────────────────────────
function main() {
  const DEBUG = process.argv.includes('--debug');

  // --hook: legacy skill hook from an older install — skill tracking now lives
  // in the plugin. Swallow stdin and print nothing (hook stdout reaches the
  // model on UserPromptSubmit); --install removes these hooks.
  if (process.argv.includes('--hook')) {
    try { readFileSync(0); } catch {}
    return;
  }

  // --refresh-cost <windowStart>: recompute the weekly cost cache (plugin)
  const rcIdx = process.argv.indexOf('--refresh-cost');
  if (rcIdx >= 0) {
    const windowStart = Number(process.argv[rcIdx + 1]);
    if (Number.isFinite(windowStart)) refreshCost(windowStart);
    return;
  }

  if (process.argv.includes('--preview') || process.argv.includes('-p')) {
    preview();
    return;
  }

  if (process.argv.includes('--doctor')) {
    doctor();
    return;
  }

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

  // Debug mode: log the raw StatusJSON fields the statusline reads
  if (DEBUG) {
    try {
      mkdirSync(CACHE_DIR, { recursive: true });
      appendFileSync(path.join(CACHE_DIR, 'debug.jsonl'), JSON.stringify({
        ts: new Date().toISOString(),
        model: data.model,
        effort: data.effort,
      }) + '\n');
    } catch {}
  }

  process.stdout.write(renderStatusline(data) + '\n');
}

main();
