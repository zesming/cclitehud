# cclitehud

A minimal status bar for [Claude Code](https://claude.ai/code). Zero dependencies, pure Node.js.

Inspired by [ccstatusline](https://github.com/sirmalloc/ccstatusline), with CJK-aware width calculation, cache-hit visualization, and subscription usage limits.

```
deepseek-v4-pro · ◆ max · ~/Projects · ⎇ feature/statusline · ✦ brainstorming
ctx 1M [▓▓▓▓▓▓▓▓▓▒▒▒▒▒░░░░░░░░░░░░░░░░░░] 45% · ↖ cached 60%
5h [▒▒▒░░░░░░░░░] 23% ↻2h14m · 7d [▒▒▒▒▒▒▒░░░░░] 61% ↻3d5h
```

> Run `node index.js --preview` to see all effort levels and usage variants.

## What it shows

**Line 1** — Session context
- **Model** — raw model ID (`deepseek-v4-pro`, `claude-sonnet-4-6`, etc.)
- **Thinking effort** — `◆` icon + label, color-coded by level: `low` `medium` `high` `xhigh` `ultra` `max`
- **Current directory** — last 2 path segments, home-relative (`~/Projects`)
- **Git branch** — auto-detected with `⎇`, hidden outside repos
- **Recent skill** — last skill / slash command used, with `✦`. Per-session isolation. Adaptive width: full name shown unless terminal is too narrow.

**Line 2** — Context window
- **Window size** — `200K` / `1M` auto-detected from model ID
- **Progress bar** — single-color foreground with shade-character tiers:
  - `▓` (75% density) = cached tokens
  - `▒` (50% density) = uncached tokens
  - `░` (25% density) = empty space
- **Usage %** — total context window usage
- **Cached %** — cache hit rate (cache_read ÷ actual_context × 100)

**Line 3** — Usage limits (Claude.ai subscription logins only)
- **5h / 7d** — rolling 5-hour and weekly limit usage, each with a compact progress bar
- **Reset countdown** — `↻` time until the window resets (`38m`, `2h14m`, `3d5h`)
- **Threshold colors** — percentage turns orange at ≥80% and red at ≥95%
- Hidden entirely when `rate_limits` is absent (API key / third-party proxy, or before the first API response); a window without data is omitted

## Features beyond ccstatusline

- **Cache-hit visualization** — the context bar splits cached vs. uncached tokens using shade-character density, with no color seams.
- **Usage limits** — 5h / weekly subscription limits with reset countdowns and warning colors.
- **CJK-aware width** — Skill name truncation correctly accounts for double-width CJK characters.
- **Safe by default** — Session IDs are sanitized before being used in file paths; model, branch, and skill names are stripped of terminal control sequences.
- **Self-cleaning** — Per-session skill files untouched for 7 days are pruned automatically.

## Requirements

- **Node.js** ≥ 14
- **Claude Code**
- No npm dependencies

## Installation

### Quick install (one sentence)

Paste this into Claude Code:

```
Read https://github.com/zesming/cclitehud/blob/main/README.md and install & configure it for me
```

Claude Code will read the instructions and set everything up for you.

### Manual install

#### 1. Clone

```bash
git clone https://github.com/zesming/cclitehud.git ~/cclitehud
```

#### 2. Verify

```bash
node ~/cclitehud/index.js --preview
```

You should see sample output with all effort levels, progress bars, usage limits, and a mock skill.

#### 3. Configure Claude Code

The easiest way is to let the script configure itself (merges into existing settings, safe to re-run):

```bash
node ~/cclitehud/index.js --install
```

Or add these blocks manually to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /Users/YOUR_USER/cclitehud/index.js",
    "refreshInterval": 10
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Skill",
        "hooks": [
          {
            "type": "command",
            "command": "node /Users/YOUR_USER/cclitehud/index.js --hook"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /Users/YOUR_USER/cclitehud/index.js --hook"
          }
        ]
      }
    ]
  }
}
```

> Replace `/Users/YOUR_USER/` with your actual home path. Merge with any existing `statusLine` and `hooks` keys — don't overwrite the whole file.

#### 4. Restart Claude Code

The new statusline takes effect on next launch.

## How skill tracking works

Follows the same pattern as [ccstatusline](https://github.com/sirmalloc/ccstatusline):

```
Skill call or /slash command
  → PreToolUse / UserPromptSubmit hook fires
  → node index.js --hook
  → reads stdin: {session_id, hook_event_name, tool_input}
  → appends to ~/.cache/cclitehud/skills-<sessionId>.jsonl

Statusline render (every 10s)
  → stdin = StatusJSON {session_id, ...}
  → reads skills-<sessionId>.jsonl for current session
  → displays last skill: ✦ skillname
```

Each Claude Code session gets its own JSONL file keyed by `session_id` — skills from other sessions don't leak across.

## Configuration

Edit `index.js` — the `CONFIG` and `C` objects at the top:

```js
const CONFIG = {
  barWidth: 32,       // context bar character width
  limitBarWidth: 12,  // width of each usage-limit bar (line 3)
  limitWarnPct: 80,   // usage-limit % turns orange at this level
  limitCritPct: 95,   // usage-limit % turns red at this level
  maxDirDepth: 2,     // directory path segments to show
};

const C = {
  model: 117,         // 256-color code for model name
  effort: { low: 151, medium: 222, high: 215, xhigh: 210, ultra: 203, max: 209 },
  dir: 111,           // directory color
  git: 183,           // git branch color
  skill: 216,         // skill name color
  barFilled: 115,     // progress bar fill color
  barEmpty: 236,      // progress bar empty background
  pctWarn: 215,       // usage-limit warning color
  pctCrit: 203,       // usage-limit critical color
};
```

Color codes are ANSI 256-color palette values (0–255).

## Debug mode

If the progress bars are behaving unexpectedly (e.g., jumping values, missing usage limits), you can enable debug logging to capture the raw StatusJSON payloads:

1. Edit `~/.claude/settings.json` and add `--debug` to the statusLine command:
   ```json
   "command": "node /Users/YOUR_USER/cclitehud/index.js --debug"
   ```
2. Use Claude Code normally — raw payloads are appended to `~/.cache/cclitehud/debug.jsonl`
3. Inspect the log to see what `context_window` and `rate_limits` values Claude Code is reporting

Remove `--debug` when done.

## Doctor mode

Run a comprehensive self-diagnostic to verify everything is working correctly:

```bash
node ~/cclitehud/index.js --doctor
```

This checks 13 aspects of the installation:

| Check | What it verifies |
|-------|-----------------|
| Node.js version | ≥ 14 required |
| index.js readable | File integrity |
| Cache directory | `~/.cache/cclitehud/` is readable and writable |
| Git available | `git` is in PATH |
| Git branch detection | Can detect branch name from current directory |
| statusLine config | `~/.claude/settings.json` points to this file |
| PreToolUse Skill hook | Hook configured with correct command |
| UserPromptSubmit hook | Hook configured with correct command |
| Skill tracking | Write + read round-trip to JSONL |
| Render test | Full three-line render with mock data (displayed) |
| ANSI 256-color | Terminal support detection |
| CJK visibleLen | Chinese/Japanese/Korean character width calculation |
| Cache data | Existing skill file count |

Exit code is `0` when all checks pass, `1` if any check fails — useful for scripting.

## Files

```
cclitehud/
├── index.js          # Main script (single file, zero dependencies)
├── package.json      # Metadata
├── preview.html      # Browser-based visual preview
├── LICENSE           # MIT License
├── .gitignore
└── README.md         # This file
```

## Acknowledgments

- [ccstatusline](https://github.com/sirmalloc/ccstatusline) — The statusline that inspired this project
- [Claude Code](https://claude.ai/code) — The AI coding assistant

## License

MIT
