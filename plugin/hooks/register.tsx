import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

// cclitehud band: two rows above the prompt on every surface (terminal and
// desktop Code tab alike), dir, worktree, branch and skill on the first, the
// context and usage-limit bars on the second, ending with the local
// API-equivalent cost of the current 7d window. Model and effort are left
// out: the desktop shows them itself, and in the terminal index.js draws
// them as the statusLine below the prompt.

const skill = atom({ plugin: 'cclitehud', key: 'skill' } as const, null)
const cachePct = atom({ plugin: 'cclitehud', key: 'cachePct' } as const, null)
const tick = atom({ plugin: 'cclitehud', key: 'tick' } as const, 0)

const CONFIG = {
  barWidth: 10,
  limitBarWidth: 10,
  limitWarnPct: 70,
  limitCritPct: 90,
}

// Mid-tone hex colors, readable on both light and dark themes.
const C = {
  dir: '#5f87d7',
  git: '#9b72cf',
  worktree: '#4fa3a3',
  skill: '#d98a5f',
  separator: '#8a8a8a',
  label: '#8a8a8a',
  barFilled: '#3fa58a',
  pctWarn: '#c9a227',
  pctCrit: '#d9534f',
  cost: '#b8865b',
}

// Thin line glyphs: cached is the full fill color, uncached the same color
// dimmed, the remaining track a light line
const BAR_FILL = '━'
const BAR_TRACK = '─'
const COMPACT_MARK = '•' // auto-compact point, gray, on top of the bar
const WORKTREE_ICON = '⧉'
const COST_ICON = '≈' // an estimate at API list prices

// Weekly cost: `index.js --refresh-cost <windowStart>` scans the local
// transcripts and writes ~/.cache/cclitehud/weekly-cost.json keyed by that
// window start; the band reads it and asks for a refresh after each
// measurement
const COST_TTL_MS = 60_000
const COST_FAIL_BACKOFF_MS = 10 * 60_000 // after a scan that failed or timed out
const WEEK_SECS = 7 * 86400
// Tried after the node --install noted in node-path (a desktop app's PATH
// misses nvm / volta installs), with ~/.volta/bin/node last
const NODE_CANDIDATES = ['node', '/opt/homebrew/bin/node', '/usr/local/bin/node']
const costState = { nextRefresh: -Infinity, node: null as string | null }
type WeeklyCost = { windowStart: number; usd: number; computedAt: number }

const GIT_TTL = 5000
type GitInfo = { branch: string | null; mainRoot: string | null; worktree: string | null }
const gitCache = { dir: '', info: null as GitInfo | null, ts: 0 }

// Auto-compact threshold in tokens; re-read when the window changes or the
// session is measured again (a turn ended, /autocompact may have moved it)
const compactCache = { window: 0, threshold: null as number | null }

function clamp(n: number) {
  return Math.max(0, Math.min(100, n))
}

function pctColor(pct: number) {
  if (pct >= CONFIG.limitCritPct) return C.pctCrit
  if (pct >= CONFIG.limitWarnPct) return C.pctWarn
  return C.barFilled
}

type Cell = 'cached' | 'uncached' | 'empty' | 'mark'

// One character per cell; `markAt` (a cell index) is overwritten with the
// auto-compact mark so every bar keeps the same width.
function barCells(usedPct: number, cachedOfUsed: number, width: number, markAt: number | null) {
  const used = clamp(usedPct)
  const total = Math.round((used / 100) * width)
  const cached = Math.min(total, Math.round(((clamp(cachedOfUsed) / 100) * used / 100) * width))
  const cells: Cell[] = []
  for (let i = 0; i < width; i++) {
    cells.push(i < cached ? 'cached' : i < total ? 'uncached' : 'empty')
  }
  if (markAt !== null && markAt >= 0 && markAt < width) cells[markAt] = 'mark'
  return cells
}

const CELL_CHAR: Record<Cell, string> = {
  cached: BAR_FILL,
  uncached: BAR_FILL,
  empty: BAR_TRACK,
  mark: COMPACT_MARK,
}

function formatSize(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(0) + 'M'
  if (n >= 1_000) return Math.round(n / 1_000) + 'K'
  return String(n)
}

function countdown(resetsAt: string | undefined, nowMs: number) {
  if (!resetsAt) return ''
  const secs = (Date.parse(resetsAt) - nowMs) / 1000
  if (!Number.isFinite(secs) || secs <= 0) return ''
  const mins = Math.ceil(secs / 60)
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d > 0) return d + 'd' + (h > 0 ? h + 'h' : '')
  if (h > 0) return h + 'h' + (m > 0 ? m + 'm' : '')
  return m + 'm'
}

function formatUsd(usd: number) {
  if (usd >= 1000) return '$' + Math.round(usd).toLocaleString('en-US')
  return '$' + usd.toFixed(2)
}

// The cache's window key: the 7d reset minus a week, to the minute
function windowStartOf(resetsAt: string | undefined) {
  const t = resetsAt ? Date.parse(resetsAt) / 1000 : NaN
  if (!Number.isFinite(t) || t <= 0) return null
  return Math.round((t - WEEK_SECS) / 60) * 60
}

// No subscription window on a gateway / API-key login: anchor "this week" to
// fixed 7-day UTC buckets counted from the epoch, so the cache key holds for a
// whole week instead of sliding on every render
function weeklyWindowStart(nowMs: number) {
  return Math.floor(nowMs / 1000 / WEEK_SECS) * WEEK_SECS
}

async function readWeeklyCost($: EngineInterface, windowStart: number): Promise<WeeklyCost | null> {
  try {
    const home = await $.env.get('HOME')
    if (!home) return null
    const c = JSON.parse(await $.fs.read(home + '/.cache/cclitehud/weekly-cost.json'))
    return c && c.windowStart === windowStart && typeof c.usd === 'number' ? c : null
  } catch {
    return null
  }
}

// The first node candidate that starts (a quick `--version`), remembered
async function findNode($: EngineInterface) {
  if (costState.node) return costState.node
  const home = await $.env.get('HOME')
  const noted = home ? await $.fs.read(home + '/.cache/cclitehud/node-path').then(s => s.trim(), () => '') : ''
  const volta = home ? [home + '/.volta/bin/node'] : []
  for (const node of [...(noted ? [noted] : []), ...NODE_CANDIDATES, ...volta]) {
    try {
      const r = await $.process.run([node, '--version'], { timeoutMs: 5_000 })
      if (r.exitCode === 0) return (costState.node = node)
    } catch {
      // not on PATH here — try the next candidate
    }
  }
  return null
}

// Runs index.js --refresh-cost when the cache is stale; true when it ran. A
// scan that fails or times out is not retried with another node, and waits
// out a longer backoff so a huge transcript folder is not rescanned each turn
async function refreshWeeklyCost($: EngineInterface, windowStart: number) {
  const now = await $.clock.now()
  if (now < costState.nextRefresh) return false
  const cached = await readWeeklyCost($, windowStart)
  if (cached && now - cached.computedAt < COST_TTL_MS) return false
  costState.nextRefresh = now + COST_TTL_MS
  const node = await findNode($)
  if (!node) return false
  const script = $.plugin.root.replace(/\/+$/, '') + '/../index.js'
  try {
    const r = await $.process.run([node, script, '--refresh-cost', String(windowStart)], { timeoutMs: 30_000 })
    if (r.exitCode === 0) return true
  } catch {
    // timed out
  }
  costState.nextRefresh = now + COST_FAIL_BACKOFF_MS
  return false
}

// The full path, with the home folder as ~
function displayPath(full: string, home: string | null) {
  const p = full.replace(/\/+$/, '') || '/'
  if (home && (p === home || p.startsWith(home + '/'))) return '~' + p.slice(home.length)
  return p
}

function homeOf(cwd: string) {
  const m = /^(\/Users\/[^/]+|\/home\/[^/]+)/.exec(cwd)
  return m?.[1] ?? null
}

function dirname(p: string) {
  const i = p.replace(/\/+$/, '').lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

function basename(p: string) {
  return p.replace(/\/+$/, '').split('/').pop() || p
}

// Branch, plus the main working tree and the linked worktree when the
// session runs inside one (its top level differs from the main tree).
async function gitInfo($: EngineInterface, cwd: string): Promise<GitInfo | null> {
  const now = await $.clock.now()
  if (gitCache.dir === cwd && now - gitCache.ts < GIT_TTL) return gitCache.info
  let info: GitInfo | null = null
  try {
    const r = await $.process.run(
      ['git', 'rev-parse', '--abbrev-ref', 'HEAD', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
      { cwd, timeoutMs: 2000 },
    )
    if (r.exitCode === 0) {
      const [head = '', top = '', common = ''] = r.stdout.trim().split('\n').map(l => l.trim())
      let branch: string | null = head || null
      if (branch === 'HEAD') {
        const s = await $.process.run(['git', 'rev-parse', '--short', 'HEAD'], { cwd, timeoutMs: 2000 })
        branch = s.exitCode === 0 ? s.stdout.trim() : null
      }
      const mainRoot = basename(common) === '.git' ? dirname(common) : null
      const worktree = mainRoot && top && top !== mainRoot ? top : null
      info = { branch, mainRoot, worktree }
    }
  } catch {
    info = null
  }
  gitCache.dir = cwd
  gitCache.info = info
  gitCache.ts = now
  return info
}

async function compactThreshold($: EngineInterface, window: number) {
  if (compactCache.window === window) return compactCache.threshold
  let threshold: number | null = null
  try {
    const u = await $.session.usage({ breakdown: 'summary' })
    const b = u.context.breakdown
    threshold = b && b.isAutoCompactEnabled && b.autoCompactThreshold ? b.autoCompactThreshold : null
  } catch {
    threshold = null
  }
  compactCache.window = window
  compactCache.threshold = threshold
  return threshold
}

export const register: Register = on => {
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.usage) {
      const u = e.usage
      const actual = u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens
      if (actual > 0) {
        const pct = Math.min(100, (u.cache_read_input_tokens / actual) * 100)
        await update($, cachePct, () => pct)
      }
    }
    return next(e)
  })

  on('skill.prompt', async ($, e, next) => {
    await update($, skill, () => e.skill)
    return next(e)
  })

  // A slash command, aliases resolved; a failure here never holds up the prompt
  on('prompt.submit', async ($, e, next) => {
    const name = e.command?.name
    if (name) await update($, skill, () => name).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  // The model driving the Skill tool itself (a "/name" typed by hand arrives
  // through prompt.submit instead). On a managed machine the built-in security
  // plugin passes person-installed plugins over on skill.prompt, so that event
  // never reaches us there; this tool.call is not intercepted and keeps the
  // recent-skill indicator working. Main loop only, so a subagent's internal
  // skill use does not overwrite what the person invoked.
  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined && e.tool === 'Skill' && e.skill) {
      await update($, skill, () => e.skill).catch(() => undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    compactCache.window = 0
    await update($, tick, n => n + 1)
    const result = await next(e)
    // A subscription gives the seven_day reset to align to; a gateway / API-key
    // login reports no rate limits, so fall back to the fixed UTC week bucket
    const windowStart =
      windowStartOf(e.rateLimits.find(w => w.kind === 'seven_day')?.resetsAt) ??
      weeklyWindowStart(await $.clock.now())
    if (await refreshWeeklyCost($, windowStart).catch(() => false)) {
      await update($, tick, n => n + 1)
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    await read($, tick)
    const [cwd, usage, lastSkill, cached] = await Promise.all([
      $.session.cwd(),
      $.session.usage(),
      read($, skill),
      read($, cachePct),
    ])
    const git = await gitInfo($, cwd)
    const branch = git?.branch ?? null
    const ctx = usage.context
    const threshold = await compactThreshold($, ctx.window)
    const now = await $.clock.now()
    const weekStart =
      windowStartOf(usage.rateLimits.find(w => w.kind === 'seven_day')?.resetsAt) ??
      weeklyWindowStart(now)
    const weekly = await readWeeklyCost($, weekStart)

    const { Box, Text } = $.ui.resolve(e)
    const dot = (k: string) => (
      <Text key={k} color={C.separator} dimColor>
        {' · '}
      </Text>
    )

    // A bar as runs of same-kind cells: uncached dimmed, the mark in gray
    const renderBar = (k: string, cells: Cell[], fill: string) => {
      const runs: { kind: Cell; text: string }[] = []
      for (const c of cells) {
        const last = runs[runs.length - 1]
        if (last && last.kind === c) last.text += CELL_CHAR[c]
        else runs.push({ kind: c, text: CELL_CHAR[c] })
      }
      return runs.map((r, i) =>
        r.kind === 'empty' ? (
          <Text key={k + i} dimColor>
            {r.text}
          </Text>
        ) : r.kind === 'mark' ? (
          <Text key={k + i} color={C.separator}>
            {r.text}
          </Text>
        ) : (
          <Text key={k + i} color={fill} dimColor={r.kind === 'uncached'}>
            {r.text}
          </Text>
        ),
      )
    }

    // [main project · ⧉ worktree | dir] · branch · skill, in bold
    const mainRoot = git?.mainRoot ?? null
    const worktree = git?.worktree ?? null
    const line1 = mainRoot && worktree
      ? [
          <Text key="dir" bold color={C.dir}>
            {displayPath(mainRoot, homeOf(mainRoot))}
          </Text>,
          dot('dw'),
          <Text key="wt" bold color={C.worktree}>
            {WORKTREE_ICON + ' ' + basename(worktree)}
          </Text>,
        ]
      : [
          <Text key="dir" bold color={C.dir}>
            {displayPath(cwd, homeOf(cwd))}
          </Text>,
        ]
    if (branch) {
      line1.push(
        dot('d3'),
        <Text key="git" bold color={C.git}>
          {'⎇ ' + branch}
        </Text>,
      )
    }
    if (lastSkill) {
      line1.push(
        dot('d4'),
        <Text key="skill" bold color={C.skill}>
          {'✦ ' + lastSkill}
        </Text>,
      )
    }

    // ctx bar with cache split and the auto-compact mark; its color tracks
    // how close the context is to auto-compaction (or to the window when
    // auto-compact is off). A third-party / unrecognized model can leave the
    // engine without a usable window, and a fresh or just-compacted session has
    // no token reading until its first response: degrade to what is known
    // instead of drawing a "ctx 0" bar against a zero window.
    const windowTokens = ctx.window
    const hasWindow = Number.isFinite(windowTokens) && windowTokens > 0
    const usedTokens = ctx.tokens
    const used = hasWindow ? (ctx.percent ?? (usedTokens ? (usedTokens / windowTokens) * 100 : 0)) : 0
    const markAt =
      hasWindow && threshold
        ? Math.min(CONFIG.barWidth - 1, Math.max(0, Math.floor((threshold / windowTokens) * CONFIG.barWidth)))
        : null
    const nearPct = hasWindow && threshold && usedTokens !== undefined ? (usedTokens / threshold) * 100 : used
    const ctxColor = pctColor(nearPct)
    const ctxLabel = hasWindow
      ? 'ctx ' + (usedTokens !== undefined ? formatSize(usedTokens) + '/' : '') + formatSize(windowTokens) + ' '
      : usedTokens !== undefined
        ? 'ctx ' + formatSize(usedTokens) + ' '
        : ''
    // Row 2 as segments that wrap whole: a narrow terminal breaks the row
    // between segments, never inside a bar
    const segments: { key: string; parts: RenderChildren[] }[] = []
    if (ctxLabel) {
      const ctxParts: RenderChildren[] = [
        <Text key="label" color={C.label}>
          {ctxLabel}
        </Text>,
      ]
      // The bar and percentage only mean something against a real window
      if (hasWindow) {
        ctxParts.push(...renderBar('ctx', barCells(used, cached ?? 0, CONFIG.barWidth, markAt), ctxColor))
        ctxParts.push(
          <Text key="pct" bold color={ctxColor === C.barFilled ? undefined : ctxColor}>
            {' ' + used.toFixed(0) + '%'}
          </Text>,
        )
      }
      segments.push({ key: 'ctx', parts: ctxParts })
    }
    if (cached !== null && cached > 0.5) {
      segments.push({
        key: 'cached',
        parts: [
          <Text key="cached" color={C.barFilled}>
            {'↖ cached ' + cached.toFixed(0) + '%'}
          </Text>,
        ],
      })
    }

    // 5h / 7d limits (subscription logins only)
    const labels: Record<string, string> = { five_hour: '5h', seven_day: '7d' }
    for (const w of usage.rateLimits) {
      const label = labels[w.kind]
      if (!label) continue
      const pct = clamp(w.percentUsed)
      const fill = pctColor(pct)
      const cd = countdown(w.resetsAt, now)
      const parts = [
        <Text key={w.kind + 'l'} color={C.label}>
          {label + ' '}
        </Text>,
        ...renderBar(w.kind, barCells(pct, 100, CONFIG.limitBarWidth, null), fill),
        <Text key={w.kind + 'p'} bold color={fill === C.barFilled ? undefined : fill}>
          {' ' + pct.toFixed(0) + '%'}
        </Text>,
      ]
      if (cd) {
        parts.push(
          <Text key={w.kind + 'c'} color={C.separator}>
            {' ↻' + cd}
          </Text>,
        )
      }
      segments.push({ key: w.kind, parts })
    }
    // The weekly estimate stands on its own: a gateway / API-key login has no
    // rate-limit windows but the local transcript scan still prices its usage
    if (weekly) {
      segments.push({
        key: 'cost',
        parts: [
          <Text key="cost" color={C.cost}>
            {COST_ICON + ' ' + formatUsd(weekly.usd)}
          </Text>,
        ],
      })
    }

    // The terminal leaves a blank row between the band and the prompt box; a
    // matching row above keeps the band off the transcript's last line
    return (
      <Box flexDirection="column" marginTop={e.surface === 'terminal' ? 1 : 0}>
        <Box key="l1" flexDirection="row" flexWrap="wrap">
          {line1}
        </Box>
        <Box key="l2" flexDirection="row" flexWrap="wrap">
          {segments.map((seg, i) => (
            <Box key={seg.key} flexDirection="row">
              {i > 0 ? dot('d' + seg.key) : null}
              {seg.parts}
            </Box>
          ))}
        </Box>
      </Box>
    )
  })
}
