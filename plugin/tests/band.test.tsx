import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const MAIN = '/Users/me/Projects/app'
const WORKTREE = MAIN + '/.claude/worktrees/fix-login'
const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

type Setup = {
  cwd: string
  top: string
  tokens: number
  limits: [number, number]
  threshold?: () => number
  weekly?: { resetsAt: string; file: string }
  runs?: string[][] // argv of each --refresh-cost run
  nodePath?: string // what --install noted in node-path
  missing?: string[] // node binaries whose --version fails
  noRepo?: boolean // cwd is outside any git repository
  noLimits?: boolean // an API-key login: no rate-limit windows
  window?: number // context window override (0/undefined model: an unrecognized third-party model)
  noTokens?: boolean // a fresh or just-compacted session: no reading until its first response
}

function stub(on: On, s: Setup) {
  on('session.cwd', () => ({ value: s.cwd }))
  mock.clock(on)
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  on('process.run', (_$, e) => {
    if (s.missing?.includes(e.argv[0] ?? '')) throw new Error('ENOENT')
    if (e.argv.includes('--refresh-cost')) s.runs?.push([...e.argv])
    if (s.noRepo && e.argv[0] === 'git') return { value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
    const out = e.argv.includes('--show-toplevel') ? `main\n${s.top}\n${MAIN}/.git\n` : 'abc123\n'
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.usage', (_$, e) => ({ value: {
    startedAt: 0,
    context: (() => {
      const window = s.window ?? 200_000
      const context: Record<string, unknown> = { window }
      // A fresh / compacted session has no token reading until its first response
      if (!s.noTokens) {
        context.tokens = s.tokens
        if (window > 0) context.percent = Math.round((s.tokens / window) * 100)
      }
      if (e.breakdown) {
        context.breakdown = { isAutoCompactEnabled: true, autoCompactThreshold: s.threshold ? s.threshold() : 160_000 } as never
      }
      return context
    })() as never,
    rateLimits: s.noLimits ? [] : [
      { kind: 'five_hour', percentUsed: s.limits[0] },
      { kind: 'seven_day', percentUsed: s.limits[1], ...(s.weekly ? { resetsAt: s.weekly.resetsAt } : {}) },
    ],
  } }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/Users/me' : undefined }))
  // Answers the tool beneath the plugins so a Skill tool.call can dispatch
  on('tool.call', () => ({ result: 'ok' } as never))
  on('fs.read', (_$, e) => {
    if (e.path === '/Users/me/.cache/cclitehud/node-path' && s.nodePath) return { value: s.nodePath + '\n' }
    if (!e.path.endsWith('/weekly-cost.json') || !s.weekly) throw new Error('ENOENT')
    return { value: s.weekly.file }
  })
}

test('worktree shows the main project first, then the worktree with its icon', async ($, on) => {
  stub(on, { cwd: WORKTREE, top: WORKTREE, tokens: 20_000, limits: [10, 10] })
  const ui = await $.ui.mount({ plugin: 'cclitehud', surface: 'desktop', ...BAND })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts.indexOf('~/Projects/app')).toBeGreaterThan(-1)
  expect(texts.indexOf('⧉ fix-login')).toBeGreaterThan(texts.indexOf('~/Projects/app'))
  await ui.unmount()
})

const DIRS: [cwd: string, shown: string, inRepo: boolean][] = [
  ['/Users/me/Projects', '~/Projects', false],
  [MAIN + '/packages/web', '~/Projects/app/packages/web', true],
  ['/Users/me', '~', false],
  ['/opt/work/app', '/opt/work/app', false],
]
for (const [cwd, shown, inRepo] of DIRS) {
  test(`the directory shows in full: ${cwd} → ${shown}`, async ($, on) => {
    stub(on, { cwd, top: MAIN, tokens: 20_000, limits: [10, 10], noRepo: !inRepo })
    const ui = await $.ui.mount({ plugin: 'cclitehud', surface: 'desktop', ...BAND })
    expect(await ui.find({ type: 'Text', text: shown })).toBeDefined()
    await ui.unmount()
  })
}

test('plain checkout shows the cwd and no worktree', async ($, on) => {
  stub(on, { cwd: MAIN, top: MAIN, tokens: 20_000, limits: [10, 10] })
  const ui = await $.ui.mount({ plugin: 'cclitehud', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: '~/Projects/app' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /⧉/ })).toBeUndefined()
  await ui.unmount()
})

test('ctx bar carries the auto-compact mark at 160K of 200K', async ($, on) => {
  stub(on, { cwd: MAIN, top: MAIN, tokens: 20_000, limits: [10, 10] })
  const ui = await $.ui.mount({ plugin: 'cclitehud', surface: 'desktop', ...BAND })
  // 160K / 200K * 10 cells = cell 8
  expect(await ui.find({ type: 'Text', text: '•' })).toBeDefined()
  await ui.unmount()
})

test('limit bars turn warn at 70% and crit at 90%', async ($, on) => {
  stub(on, { cwd: MAIN, top: MAIN, tokens: 20_000, limits: [75, 92] })
  const ui = await $.ui.mount({ plugin: 'cclitehud', surface: 'desktop', ...BAND })
  expect((await ui.find({ type: 'Text', text: ' 75%' }))?.props.color).toBe('#c9a227')
  expect((await ui.find({ type: 'Text', text: ' 92%' }))?.props.color).toBe('#d9534f')
  expect((await ui.find({ type: 'Text', text: '━━━━━━━━' }))?.props.color).toBe('#c9a227')
  await ui.unmount()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface} draws the band`, async ($, on) => {
    stub(on, { cwd: MAIN, top: MAIN, tokens: 20_000, limits: [10, 10] })
    const ui = await $.ui.mount({ plugin: 'cclitehud', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: '~/Projects/app' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'ctx 20K/200K ' })).toBeDefined()
    await ui.unmount()
  })
}

test('compact mark follows a changed auto-compact threshold', async ($, on) => {
  let threshold = 160_000
  stub(on, { cwd: MAIN, top: MAIN, tokens: 20_000, limits: [10, 10], threshold: () => threshold })
  const markCell = async () => {
    const ui = await $.ui.mount({ plugin: 'cclitehud', surface: 'desktop', ...BAND })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    await ui.unmount()
    const bar = texts.slice(texts.indexOf('ctx 20K/200K ') + 1, texts.indexOf(' 10%')).join('')
    return bar.indexOf('•')
  }
  expect(await markCell()).toBe(8)
  threshold = 100_000
  await $.session.measure({ changed: ['context'] } as never).catch(() => undefined)
  expect(await markCell()).toBe(5)
})

test('usage line ends with the local weekly cost for the current 7d window', async ($, on) => {
  const resetsAt = '2026-10-29T06:00:00.000Z'
  const windowStart = Date.parse(resetsAt) / 1000 - 7 * 86400
  const file = JSON.stringify({ windowStart, usd: 21.954, computedAt: 0 })
  stub(on, { cwd: MAIN, top: MAIN, tokens: 20_000, limits: [10, 10], weekly: { resetsAt, file } })
  const ui = await $.ui.mount({ plugin: 'cclitehud', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: '≈ $21.95' })).toBeDefined()
  await ui.unmount()
})

test('a cost cached for another window is not shown', async ($, on) => {
  const file = JSON.stringify({ windowStart: 1, usd: 99, computedAt: 0 })
  stub(on, { cwd: MAIN, top: MAIN, tokens: 20_000, limits: [10, 10], weekly: { resetsAt: '2026-10-29T06:00:00.000Z', file } })
  const ui = await $.ui.mount({ plugin: 'cclitehud', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: /≈/ })).toBeUndefined()
  await ui.unmount()
})

test('a /command prompt becomes the recent skill, and no model or effort is drawn', async ($, on) => {
  stub(on, { cwd: MAIN, top: MAIN, tokens: 20_000, limits: [10, 10] })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  await $.prompt.submit({ text: '/review the diff', command: { name: 'review', args: 'the diff' } } as never).catch(() => undefined)
  const ui = await $.ui.mount({ plugin: 'cclitehud', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: '✦ review' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /◆|claude-/ })).toBeUndefined()
  await ui.unmount()
})

test('a measurement with a stale cache runs index.js --refresh-cost for the 7d window', async ($, on) => {
  const runs: string[][] = []
  const resetsAt = '2026-10-29T06:00:30.400Z'
  stub(on, { cwd: MAIN, top: MAIN, tokens: 20_000, limits: [10, 10], runs })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { tokens: 20_000, window: 200_000, percent: 10 },
    rateLimits: [{ kind: 'seven_day', percentUsed: 10, resetsAt }],
    changed: ['rateLimits'],
  } as never).catch((err: unknown) => { throw new Error('measure rejected: ' + String(err)) })
  expect(runs.length).toBe(1)
  const argv = runs[0] ?? []
  expect(argv[1]?.endsWith('/../index.js')).toBe(true)
  expect(argv.slice(2)).toEqual(['--refresh-cost', '1792648860'])
})

test('a measurement without rate limits refreshes cost for the fixed UTC week bucket', async ($, on) => {
  const runs: string[][] = []
  stub(on, { cwd: MAIN, top: MAIN, tokens: 20_000, limits: [10, 10], runs, noLimits: true })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { tokens: 20_000, window: 200_000, percent: 10 },
    rateLimits: [],
    changed: ['context'],
  } as never)
  // Mocked clock starts at 0, which sits in the epoch-aligned 7d bucket 0
  expect(runs.length).toBe(1)
  expect(runs[0]?.slice(2)).toEqual(['--refresh-cost', '0'])
})

test('the refresh runs the node --install noted', async ($, on) => {
  const runs: string[][] = []
  const nodePath = '/Users/me/.nvm/versions/node/v22.0.0/bin/node'
  stub(on, { cwd: MAIN, top: MAIN, tokens: 20_000, limits: [10, 10], runs, nodePath })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { tokens: 20_000, window: 200_000, percent: 10 },
    rateLimits: [{ kind: 'seven_day', percentUsed: 10, resetsAt: '2026-10-29T06:00:30.400Z' }],
    changed: ['rateLimits'],
  } as never)
  expect(runs[0]?.[0]).toBe(nodePath)
})

test('a noted node that no longer starts falls back to PATH', async ($, on) => {
  const runs: string[][] = []
  const nodePath = '/Users/me/.nvm/versions/node/v20.0.0/bin/node'
  stub(on, { cwd: MAIN, top: MAIN, tokens: 20_000, limits: [10, 10], runs, nodePath, missing: [nodePath] })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { tokens: 20_000, window: 200_000, percent: 10 },
    rateLimits: [{ kind: 'seven_day', percentUsed: 10, resetsAt: '2026-10-29T06:00:30.400Z' }],
    changed: ['rateLimits'],
  } as never)
  expect(runs[0]?.[0]).toBe('node')
})

test('a survey takes the band', async ($, on) => {
  stub(on, { cwd: MAIN, top: MAIN, tokens: 20_000, limits: [10, 10] })
  const ui = await $.ui.mount({ plugin: 'cclitehud', surface: 'desktop', ...BAND, props: { ...BAND.props, hasSurvey: true } })
  expect(await ui.find({ type: 'Text', text: '~/Projects/app' })).toBeUndefined()
  await ui.unmount()
})

test('row 1 is bold on every surface', async ($, on) => {
  stub(on, { cwd: MAIN, top: MAIN, tokens: 20_000, limits: [10, 10] })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'cclitehud', surface, ...BAND })
    expect((await ui.find({ type: 'Text', text: '~/Projects/app' }))?.props.bold).toBe(true)
    expect((await ui.find({ type: 'Text', text: '⎇ main' }))?.props.bold).toBe(true)
    await ui.unmount()
  }
})

test('a gateway / API-key login shows the context bar and the weekly cost, without limit bars', async ($, on) => {
  // No rate limits: the render anchors the week to fixed UTC buckets, and the
  // mocked clock starts at 0, so the cache key is windowStart 0
  const file = JSON.stringify({ windowStart: 0, usd: 5, computedAt: 0 })
  stub(on, { cwd: MAIN, top: MAIN, tokens: 20_000, limits: [10, 10], noLimits: true, weekly: { resetsAt: '2026-10-29T06:00:00.000Z', file } })
  const ui = await $.ui.mount({ plugin: 'cclitehud', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: 'ctx 20K/200K ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '5h ' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '7d ' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '≈ $5.00' })).toBeDefined()
  await ui.unmount()
})

test('an unrecognized model with no usable window shows tokens but no zero-window bar', async ($, on) => {
  // noLimits keeps the 5h/7d bars out, so the assertions scope to the ctx segment
  stub(on, { cwd: MAIN, top: MAIN, tokens: 20_000, limits: [10, 10], window: 0, noLimits: true })
  const ui = await $.ui.mount({ plugin: 'cclitehud', surface: 'desktop', ...BAND })
  // Tokens still known; the misleading "ctx 0" and percentage are not drawn
  expect(await ui.find({ type: 'Text', text: 'ctx 20K ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /%/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /━|─/ })).toBeUndefined()
  await ui.unmount()
})

test('a fresh session before its first response shows the window without a usage reading', async ($, on) => {
  stub(on, { cwd: MAIN, top: MAIN, tokens: 0, limits: [10, 10], noTokens: true })
  const ui = await $.ui.mount({ plugin: 'cclitehud', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: 'ctx 200K ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' 0%' })).toBeDefined()
  await ui.unmount()
})

test('the model driving the Skill tool becomes the recent skill', async ($, on) => {
  stub(on, { cwd: MAIN, top: MAIN, tokens: 20_000, limits: [10, 10] })
  await $.tool.call({ tool: 'Skill', skill: 'animation-vocabulary' } as never)
  const ui = await $.ui.mount({ plugin: 'cclitehud', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: '✦ animation-vocabulary' })).toBeDefined()
  await ui.unmount()
})

test("a subagent's Skill tool call does not replace the recent skill", async ($, on) => {
  stub(on, { cwd: MAIN, top: MAIN, tokens: 20_000, limits: [10, 10] })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  await $.prompt.submit({ text: '/review the diff', command: { name: 'review', args: 'the diff' } } as never).catch(() => undefined)
  await $.tool.call({ tool: 'Skill', skill: 'background-skill', agentId: 'sub-1' } as never)
  const ui = await $.ui.mount({ plugin: 'cclitehud', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: '✦ review' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '✦ background-skill' })).toBeUndefined()
  await ui.unmount()
})

test('the terminal band keeps a blank row above it, the desktop none', async ($, on) => {
  stub(on, { cwd: MAIN, top: MAIN, tokens: 20_000, limits: [10, 10] })
  for (const [surface, margin] of [['terminal', 1], ['desktop', 0]] as const) {
    const ui = await $.ui.mount({ plugin: 'cclitehud', surface, ...BAND })
    const boxes = await ui.findAll({ type: 'Box' })
    expect(boxes.some(b => (b.props as { marginTop?: number }).marginTop === margin)).toBe(true)
    await ui.unmount()
  }
})
