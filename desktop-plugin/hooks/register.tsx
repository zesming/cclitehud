import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

// cclitehud for the desktop Code tab: two rows above the prompt, dir,
// worktree, branch and skill on the first, the context and usage-limit bars
// on the second. Model and effort are left out because the desktop already
// shows them. The terminal keeps its real statusLine, so this band only
// draws on non-terminal surfaces.

const skill = atom({ plugin: 'cclitehud', key: 'skill' } as const, null)
const cachePct = atom({ plugin: 'cclitehud', key: 'cachePct' } as const, null)
const tick = atom({ plugin: 'cclitehud', key: 'tick' } as const, 0)

const CONFIG = {
  barWidth: 10,
  limitBarWidth: 10,
  limitWarnPct: 70,
  limitCritPct: 90,
  maxDirDepth: 2,
}

// Mid-tone hex versions of index.js's 256-color palette, readable on both
// light and dark desktop themes.
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
}

const FILL_CACHED = '▓'
const FILL_UNCACHED = '▒'
const FILL_EMPTY = '░'
const COMPACT_MARK = '│'
const WORKTREE_ICON = '⧉'

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
  cached: FILL_CACHED,
  uncached: FILL_UNCACHED,
  empty: FILL_EMPTY,
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

function shortPath(full: string, home: string | null) {
  let p = full
  if (home && (p === home || p.startsWith(home + '/'))) p = '~' + p.slice(home.length)
  const segs = p.split('/').filter(Boolean)
  if (segs.length <= CONFIG.maxDirDepth) return p || '/'
  return segs.slice(-CONFIG.maxDirDepth).join('/')
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

  on('prompt.submit', async ($, e, next) => {
    const m = /^\/([a-zA-Z0-9_:-]+)(?:\s|$)/.exec(e.text)
    // Never hold up the prompt over a display-only value
    if (m) await update($, skill, () => m[1]).catch(() => undefined)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    compactCache.window = 0
    await update($, tick, n => n + 1)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface === 'terminal' || e.props.hasSurvey) return next(e)

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

    const { Box, Text } = $.ui.resolve(e)
    const dot = (k: string) => (
      <Text key={k} color={C.separator} dimColor>
        {' · '}
      </Text>
    )

    // A bar as runs of same-kind cells, so the mark can be dimmed apart
    const renderBar = (k: string, cells: Cell[], fill: string) => {
      const runs: { kind: Cell; text: string }[] = []
      for (const c of cells) {
        const last = runs[runs.length - 1]
        if (last && last.kind === c) last.text += CELL_CHAR[c]
        else runs.push({ kind: c, text: CELL_CHAR[c] })
      }
      return [
        <Text key={k + 'lb'} color={C.separator}>
          [
        </Text>,
        ...runs.map((r, i) =>
          r.kind === 'empty' ? (
            <Text key={k + i} dimColor>
              {r.text}
            </Text>
          ) : r.kind === 'mark' ? (
            <Text key={k + i} color={C.separator} dimColor>
              {r.text}
            </Text>
          ) : (
            <Text key={k + i} color={fill}>
              {r.text}
            </Text>
          ),
        ),
        <Text key={k + 'rb'} color={C.separator}>
          ]
        </Text>,
      ]
    }

    // [main project · ⧉ worktree | dir] · branch · skill
    const mainRoot = git?.mainRoot ?? null
    const worktree = git?.worktree ?? null
    const line1 = mainRoot && worktree
      ? [
          <Text key="dir" color={C.dir}>
            {shortPath(mainRoot, homeOf(mainRoot))}
          </Text>,
          dot('dw'),
          <Text key="wt" color={C.worktree}>
            {WORKTREE_ICON + ' ' + basename(worktree)}
          </Text>,
        ]
      : [
          <Text key="dir" color={C.dir}>
            {shortPath(cwd, homeOf(cwd))}
          </Text>,
        ]
    if (branch) {
      line1.push(
        dot('d3'),
        <Text key="git" color={C.git}>
          {'⎇ ' + branch}
        </Text>,
      )
    }
    if (lastSkill) {
      line1.push(
        dot('d4'),
        <Text key="skill" color={C.skill}>
          {'✦ ' + lastSkill}
        </Text>,
      )
    }

    // ctx bar with cache split and the auto-compact mark; its color tracks
    // how close the context is to auto-compaction (or to the window when
    // auto-compact is off)
    const used = ctx.percent ?? 0
    const markAt = threshold ? Math.min(CONFIG.barWidth - 1, Math.floor((threshold / ctx.window) * CONFIG.barWidth)) : null
    const nearPct = threshold && ctx.tokens !== undefined ? (ctx.tokens / threshold) * 100 : used
    const ctxColor = pctColor(nearPct)
    const line2 = [
      <Text key="label" color={C.label}>
        {'ctx ' + formatSize(ctx.window) + ' '}
      </Text>,
      ...renderBar('ctx', barCells(used, cached ?? 0, CONFIG.barWidth, markAt), ctxColor),
      <Text key="pct" bold color={ctxColor === C.barFilled ? undefined : ctxColor}>
        {' ' + used.toFixed(0) + '%'}
      </Text>,
    ]
    if (cached !== null && cached > 0.5) {
      line2.push(
        dot('d5'),
        <Text key="cached" color={C.barFilled}>
          {'↖ cached ' + cached.toFixed(0) + '%'}
        </Text>,
      )
    }

    // 5h / 7d limits (subscription logins only)
    const labels: Record<string, string> = { five_hour: '5h', seven_day: '7d' }
    const line3 = usage.rateLimits
      .filter(w => labels[w.kind])
      .flatMap((w, i) => {
        const pct = clamp(w.percentUsed)
        const fill = pctColor(pct)
        const cd = countdown(w.resetsAt, now)
        const parts = [
          <Text key={w.kind + 'l'} color={C.label}>
            {labels[w.kind] + ' '}
          </Text>,
          ...renderBar(w.kind, barCells(pct, 0, CONFIG.limitBarWidth, null), fill),
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
        return i > 0 ? [dot('d6' + i), ...parts] : parts
      })

    return (
      <Box flexDirection="column">
        <Box key="l1" flexDirection="row" flexWrap="wrap">
          {line1}
        </Box>
        <Box key="l2" flexDirection="row" flexWrap="wrap">
          {line2}
          {line3.length > 0 ? [dot('s2'), ...line3] : null}
        </Box>
      </Box>
    )
  })
}
