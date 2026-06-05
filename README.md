# ccstatuslite

A minimal two-line status bar for [Claude Code](https://claude.ai/code). Zero dependencies, pure Node.js.

Inspired by the official [ccstatusline](https://github.com/anthropics/ccstatusline), with added proxy smoothing, CJK-aware width calculation, and context compaction detection.

```
deepseek-v4-pro · ◆ max · ~/Projects · ⎇ feature/statusline · ✦ brainstorming
ctx 1M [▓▓▓▓▓▓▓▓▓▒▒▒▒▒░░░░░░░░░░░░░░░░░░] 45% · ↖ cached 60%
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

## Features beyond ccstatusline

- **Proxy smoothing** — Some API proxies report per-call token usage instead of cumulative session totals, causing the progress bar to flicker wildly. This statusline persists per-session max values and automatically detects context compaction (resets when usage drops >25 points), keeping the bar stable.
- **CJK-aware width** — Skill name truncation correctly accounts for double-width CJK characters.
- **Compaction detection** — After Claude Code performs context compaction, the progress bar resets instead of being stuck at the historical peak.
- **Path traversal protection** — Session IDs are sanitized before being used in file paths.

## Requirements

- **Node.js** ≥ 14
- **Claude Code**
- No npm dependencies

## Installation

### Quick install (one sentence)

Paste this into Claude Code:

> 阅读 https://github.com/zesming/ccstatus/blob/main/README.md 然后安装配置一下

Claude Code will read the instructions and set everything up for you.

### Manual install

#### 1. Clone

```bash
git clone https://github.com/zesming/ccstatus.git ~/ccstatuslite
```

#### 2. Verify

```bash
node ~/ccstatuslite/index.js --preview
```

You should see sample output with all effort levels, a progress bar, and a mock skill.

#### 3. Configure Claude Code

Add these blocks to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /Users/YOUR_USER/ccstatuslite/index.js",
    "refreshInterval": 10
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Skill",
        "hooks": [
          {
            "type": "command",
            "command": "node /Users/YOUR_USER/ccstatuslite/index.js --hook"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /Users/YOUR_USER/ccstatuslite/index.js --hook"
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

Follows the same pattern as [ccstatusline](https://github.com/anthropics/ccstatusline):

```
Skill call or /slash command
  → PreToolUse / UserPromptSubmit hook fires
  → node index.js --hook
  → reads stdin: {session_id, hook_event_name, tool_input}
  → appends to ~/.cache/ccstatuslite/skills-<sessionId>.jsonl

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
  barWidth: 32,       // progress bar character width
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
};
```

Color codes are ANSI 256-color palette values (0–255).

## Debug mode

If the progress bar is behaving unexpectedly (e.g., jumping values), you can enable debug logging to capture the raw StatusJSON payloads:

1. Edit `~/.claude/settings.json` and add `--debug` to the statusLine command:
   ```json
   "command": "node /Users/YOUR_USER/ccstatuslite/index.js --debug"
   ```
2. Use Claude Code normally — raw payloads are appended to `~/.cache/ccstatuslite/debug.jsonl`
3. Inspect the log to see what `used_percentage` and `current_usage` values Claude Code is reporting

Remove `--debug` when done.

## Doctor mode

Run a comprehensive self-diagnostic to verify everything is working correctly:

```bash
node ~/ccstatuslite/index.js --doctor
```

This checks 14 aspects of the installation:

| Check | What it verifies |
|-------|-----------------|
| Node.js version | ≥ 14 required |
| index.js readable | File integrity |
| Cache directory | `~/.cache/ccstatuslite/` is readable and writable |
| Git available | `git` is in PATH |
| Git branch detection | Can detect branch name from current directory |
| statusLine config | `~/.claude/settings.json` points to this file |
| PreToolUse Skill hook | Hook configured with correct command |
| UserPromptSubmit hook | Hook configured with correct command |
| Skill tracking | Write + read round-trip to JSONL |
| Session smoothing | Max retention + compaction detection |
| Render test | Full two-line render with mock data (displayed) |
| ANSI 256-color | Terminal support detection |
| CJK visibleLen | Chinese/Japanese/Korean character width calculation |
| Cache data | Existing session and skill file count |

Exit code is `0` when all checks pass, `1` if any check fails — useful for scripting.

## Files

```
ccstatuslite/
├── index.js          # Main script (~500 lines, zero dependencies)
├── package.json      # Metadata
├── preview.html      # Browser-based visual preview
├── LICENSE           # MIT License
├── .gitignore
└── README.md         # This file
```

## Acknowledgments

- [ccstatusline](https://github.com/anthropics/ccstatusline) — Official Anthropic statusline implementation
- [Claude Code](https://claude.ai/code) — The AI coding assistant

## License

MIT
