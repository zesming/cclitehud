# cclitehud

A minimal HUD for [Claude Code](https://claude.ai/code), in the terminal and the desktop app's Code tab. Zero npm dependencies.

Inspired by [ccstatusline](https://github.com/sirmalloc/ccstatusline), with cache-hit visualization, an auto-compact mark, subscription usage limits and the week's API-equivalent cost.

```
Projects/cclitehud · ⎇ main · ✦ brainstorming                                          ← plugin (above the prompt)
ctx 1M ━━──────•─ 23% · ↖ cached 60% · 5h ━━──────── 23% ↻2h14m · 7d ━━━━━━━━── 78% ↻3d5h · ⌂ $186.42
> _                                                                                      ← prompt
claude-opus-5-5 · ◆ medium                                                               ← statusLine (terminal only)
```

It comes in two parts:

| Part | Where it draws | What it shows |
|------|----------------|---------------|
| **Plugin** (`plugin/`) | Above the prompt, in the terminal **and** the desktop Code tab | Directory, worktree, branch, recent skill; context and usage-limit bars; weekly cost |
| **statusLine** (`index.js`) | Below the prompt, terminal only | Model and thinking effort |

The plugin reads the session through the plugin API (plus `git` for the branch and `node index.js` for the weekly cost). That API shows the thinking effort only on a running turn, not the session's setting, so the terminal keeps a small statusLine for model and effort. The desktop app already shows both below its prompt.

## What it shows

**Plugin, row 1** — where you are, in bold (in the terminal the band keeps a blank row above it, matching the one Claude Code leaves below it)
- **Directory** — last 2 path segments, home-relative (`Projects/cclitehud`)
- **Worktree** — inside a git worktree the main project's path comes first, then `⧉` and the worktree's name
- **Git branch** — `⎇`, hidden outside repos
- **Recent skill** — last skill or slash command used, with `✦`

**Plugin, row 2** — how full things are
- **Context bar** — `ctx` + window size, then a 10-cell thin-line bar: bright `━` cached tokens, dim `━` uncached, `─` remaining
- **Auto-compact mark** — a gray `•` in the context bar where auto-compaction kicks in; follows `/autocompact`, hidden when auto-compact is off
- **Cached %** — cache hit rate of the last turn (cache_read ÷ all input tokens)
- **5h / 7d** — subscription usage-limit bars with a `↻` reset countdown (`38m`, `2h14m`, `3d5h`); absent on API-key logins
- **Threshold colors** — a bar and its percentage turn yellow at ≥70% and red at ≥90%. The context percentage is of the full window, but its color is judged against the auto-compact point (the full window when auto-compact is off), so it warns before compaction
- **Weekly cost** — `⌂ $186.42`, where `⌂` means local: what this machine's Claude Code usage in the current 7d limit window would cost at API list prices. Computed from the transcripts under `~/.claude/projects` (`$CLAUDE_CONFIG_DIR/projects` when set) (subagents included, non-Claude models skipped), deduplicated per response, refreshed at most once a minute. It counts this machine only, and appears once the first refresh has run

**statusLine** — the model
- **Model** — raw model ID (`claude-opus-5-5`, `deepseek-v4-pro`, …)
- **Thinking effort** — `◆` + level, color-coded: `low` `medium` `high` `xhigh` `ultra` `max`

## Requirements

- **Node.js** ≥ 14 (the plugin runs `node` for the weekly cost: found on `PATH`, then `/opt/homebrew/bin`, `/usr/local/bin`)
- **Claude Code** with plugin support (the desktop app's Code tab runs the same Claude Code)

## Installation

### Quick install (one sentence)

Paste this into Claude Code:

```
Read https://github.com/zesming/cclitehud/blob/main/README.md and install & configure it for me
```

### Manual install

#### 1. Clone

```bash
git clone https://github.com/zesming/cclitehud.git ~/cclitehud
```

Keep the repository in one piece: the plugin calls `../index.js` for the weekly cost.

#### 2. Configure Claude Code

Let the script configure itself (merges into existing settings, safe to re-run):

```bash
node ~/cclitehud/index.js --install
```

It sets the statusLine, adds the plugin folder to `env.CLAUDE_CODE_PLUGIN_DIRS` (keeping any folders already there), removes the skill hooks an older cclitehud installed, replaces the pre-rename `desktop-plugin` folder in `CLAUDE_CODE_PLUGIN_DIRS`, and keeps the original file as `settings.json.bak` (made on the first run only; the file's permissions and any symlink are kept). It uses `$CLAUDE_CONFIG_DIR/settings.json` when that variable is set. A `settings.json` that is not plain JSON (comments, trailing commas) is left untouched: the command stops and says why.

**Upgrading from 1.x** — the three-line statusline, or the `desktop-plugin/` folder: pull, then run `--install` once more. Until then the terminal shows only `model · effort` with no band above the prompt, and the desktop loses its band (the folder is now `plugin/`).

Or edit `~/.claude/settings.json` by hand (merge with existing keys rather than replacing the file):

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /Users/YOUR_USER/cclitehud/index.js"
  },
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/Users/YOUR_USER/cclitehud/plugin"
  }
}
```

`CLAUDE_CODE_PLUGIN_DIRS` takes several folders separated by `:` (`;` on Windows), and is read from `~/.claude/settings.json` only, never from a project's settings. Upgrading from 1.x by hand: also delete the `index.js --hook` entries under `hooks.PreToolUse` and `hooks.UserPromptSubmit`, and change a `…/cclitehud/desktop-plugin` entry in `CLAUDE_CODE_PLUGIN_DIRS` to `…/cclitehud/plugin`.

#### 3. Restart

Restart Claude Code and the desktop app. To try the plugin in one session first: `claude --plugin-dir ~/cclitehud/plugin`.

#### 4. Check

```bash
node ~/cclitehud/index.js --doctor
```

## Configuration

**Plugin** — `CONFIG` and `C` at the top of `plugin/hooks/register.tsx`:

```ts
const CONFIG = {
  barWidth: 10,       // context bar cells
  limitBarWidth: 10,  // 5h / 7d bar cells
  limitWarnPct: 70,   // bar + % turn yellow at this level
  limitCritPct: 90,   // bar + % turn red at this level
  maxDirDepth: 2,     // directory path segments to show
}
```

Colors in `C` are mid-tone hex values readable on light and dark themes.

**statusLine** — the `C` palette at the top of `index.js` (ANSI 256-color codes, 0–255) for the model and effort colors.

**Weekly cost prices** — the `PRICING` table in `index.js` ($ per million tokens: input, output, cache read; cache writes are 1.25× input for 5 minutes, 2× for 1 hour; fast mode 2×).

## Commands

| Command | What it does |
|---------|--------------|
| `node index.js --install` | Configure the statusLine and the plugin in `~/.claude/settings.json` |
| `node index.js --doctor` | Check the installation (below) |
| `node index.js --preview` | Show the statusLine for every effort level |
| `node index.js --refresh-cost <windowStart>` | Recompute the weekly cost cache (the plugin runs this) |
| `claude plugin validate plugin` | Validate the plugin |
| `claude plugin test plugin` | Run the plugin's tests |

### Doctor

| Check | What it verifies |
|-------|------------------|
| Node.js version | ≥ 14 |
| Cache directory | `~/.cache/cclitehud/` is readable and writable |
| Plugin folder | `plugin/` has its manifest and hooks module |
| settings.json | `~/.claude/settings.json` reads as a JSON object (or does not exist yet) |
| statusLine config | `~/.claude/settings.json` points to this `index.js` |
| Plugin config | `env.CLAUDE_CODE_PLUGIN_DIRS` includes the plugin folder |
| Legacy hooks | No leftover `index.js --hook` entries from an older install |
| Weekly cost scan | Scans the last 7 days of transcripts and prints the total |
| Render test | Renders the statusLine |

Exit code is `0` when nothing fails, `1` otherwise.

### Debug

Add `--debug` to the statusLine command to append the `model` and `effort` fields of each StatusJSON payload to `~/.cache/cclitehud/debug.jsonl`. For the plugin, run `claude --debug`: a failing hook is logged with its reason.

## Files

```
cclitehud/
├── index.js          # statusLine, weekly cost, --install / --doctor
├── package.json
├── preview.html      # Browser preview of the band and the statusLine
├── plugin/           # The band above the prompt (terminal + desktop)
│   ├── .claude-plugin/plugin.json
│   ├── hooks/hooks.json
│   ├── hooks/register.tsx   # Rendering + data
│   ├── tests/band.test.tsx
│   └── types/index.d.ts     # Plugin state contract
├── LICENSE
└── README.md
```

## Acknowledgments

- [ccstatusline](https://github.com/sirmalloc/ccstatusline) — The statusline that inspired this project
- [Claude Code](https://claude.ai/code) — The AI coding assistant

## License

MIT
