import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

// cclitehud for the desktop Code tab: two rows above the prompt, dir,
// branch and skill on the first, the context and usage-limit bars on the
// second. Model and effort are left out
// because the desktop already shows them. The terminal keeps its real
// statusLine, so this band only draws on non-terminal surfaces.

const skill = atom({ plugin: 'cclitehud', key: 'skill' } as const, null)
const cachePct = atom({ plugin: 'cclitehud', key: 'cachePct' } as const, null)
const tick = atom({ plugin: 'cclitehud', key: 'tick' } as const, 0)

const CONFIG = {
  barWidth: 10,
  limitBarWidth: 10,
  limitWarnPct: 80,
  limitCritPct: 95,
  maxDirDepth: 2,
}

// Mid-tone hex versions of index.js's 256-color palette, readable on both
// light and dark desktop themes.
const C = {
  dir: '#5f87d7',
  git: '#9b72cf',
  skill: '#d98a5f',
  separator: '#8a8a8a',
  label: '#8a8a8a',
  barFilled: '#3fa58a',
  barPct: undefined as string | undefined,
  pctWarn: '#e08a3c',
  pctCrit: '#d9534f',
}

const FILL_CACHED = '▓'
const FILL_UNCACHED = '▒'
const FILL_EMPTY = '░'

const GIT_TTL = 5000
const gitCache = { dir: '', branch: null as string | null, ts: 0 }

function clamp(n: number) {
  return Math.max(0, Math.min(100, n))
}

function bar(usedPct: number, cachedOfUsed: number, width: number) {
  const used = clamp(usedPct)
  const total = Math.round((used / 100) * width)
  const cached = Math.min(total, Math.round(((clamp(cachedOfUsed) / 100) * used / 100) * width))
  return {
    filled: FILL_CACHED.repeat(cached) + FILL_UNCACHED.repeat(Math.max(0, total - cached)),
    empty: FILL_EMPTY.repeat(Math.max(0, width - total)),
  }
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
  return m ? m[1] : null
}

async function gitBranch($: EngineInterface, cwd: string) {
  const now = await $.clock.now()
  if (gitCache.dir === cwd && now - gitCache.ts < GIT_TTL) return gitCache.branch
  let branch: string | null = null
  try {
    const r = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 2000 })
    if (r.exitCode === 0) {
      branch = r.stdout.trim() || null
      if (branch === 'HEAD') {
        const s = await $.process.run(['git', 'rev-parse', '--short', 'HEAD'], { cwd, timeoutMs: 2000 })
        branch = s.exitCode === 0 ? s.stdout.trim() : null
      }
    }
  } catch {
    branch = null
  }
  gitCache.dir = cwd
  gitCache.branch = branch
  gitCache.ts = now
  return branch
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
    if (m) await update($, skill, () => m[1])
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
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
    const branch = await gitBranch($, cwd)
    const now = await $.clock.now()

    const { Box, Text } = $.ui.resolve(e)
    const dot = (k: string) => (
      <Text key={k} color={C.separator} dimColor>
        {' · '}
      </Text>
    )

    // dir · branch · skill
    const line1 = [
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

    // ctx bar with cache split
    const ctx = usage.context
    const used = ctx.percent ?? 0
    const b = bar(used, cached ?? 0, CONFIG.barWidth)
    const line2 = [
      <Text key="label" color={C.label}>
        {'ctx ' + formatSize(ctx.window) + ' '}
      </Text>,
      <Text key="lb" color={C.separator}>
        [
      </Text>,
      <Text key="filled" color={C.barFilled}>
        {b.filled}
      </Text>,
      <Text key="empty" dimColor>
        {b.empty}
      </Text>,
      <Text key="rb" color={C.separator}>
        ]
      </Text>,
      <Text key="pct" bold>
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
        const lb = bar(pct, 0, CONFIG.limitBarWidth)
        const color = pct >= CONFIG.limitCritPct ? C.pctCrit : pct >= CONFIG.limitWarnPct ? C.pctWarn : undefined
        const cd = countdown(w.resetsAt, now)
        const parts = [
          <Text key={w.kind + 'l'} color={C.label}>
            {labels[w.kind] + ' '}
          </Text>,
          <Text key={w.kind + 'lb'} color={C.separator}>
            [
          </Text>,
          <Text key={w.kind + 'f'} color={C.barFilled}>
            {lb.filled}
          </Text>,
          <Text key={w.kind + 'e'} dimColor>
            {lb.empty}
          </Text>,
          <Text key={w.kind + 'rb'} color={C.separator}>
            ]
          </Text>,
          <Text key={w.kind + 'p'} bold color={color}>
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
