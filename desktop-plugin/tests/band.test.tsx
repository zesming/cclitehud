import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const MAIN = '/Users/me/Projects/app'
const WORKTREE = MAIN + '/.claude/worktrees/fix-login'
const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

type Setup = {
  cwd: string
  top: string
  tokens: number
  limits: [number, number]
  threshold?: () => number
  weekly?: { resetsAt: string; file: string }
}

function stub(on: On, s: Setup) {
  on('session.cwd', () => ({ value: s.cwd }))
  mock.clock(on)
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  on('process.run', (_$, e) => {
    const out = e.argv.includes('--show-toplevel') ? `main\n${s.top}\n${MAIN}/.git\n` : 'abc123\n'
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.usage', (_$, e) => ({ value: {
    startedAt: 0,
    context: {
      tokens: s.tokens,
      window: 200_000,
      percent: Math.round((s.tokens / 200_000) * 100),
      ...(e.breakdown ? { breakdown: { isAutoCompactEnabled: true, autoCompactThreshold: s.threshold ? s.threshold() : 160_000 } as never } : {}),
    },
    rateLimits: [
      { kind: 'five_hour', percentUsed: s.limits[0] },
      { kind: 'seven_day', percentUsed: s.limits[1], ...(s.weekly ? { resetsAt: s.weekly.resetsAt } : {}) },
    ],
  } }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/Users/me' : undefined }))
  on('fs.read', () => {
    if (!s.weekly) throw new Error('ENOENT')
    return { value: s.weekly.file }
  })
}

test('worktree shows the main project first, then the worktree with its icon', async ($, on) => {
  stub(on, { cwd: WORKTREE, top: WORKTREE, tokens: 20_000, limits: [10, 10] })
  const ui = await $.ui.mount({ plugin: 'cclitehud', surface: 'desktop', ...BAND })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts.indexOf('Projects/app')).toBeGreaterThan(-1)
  expect(texts.indexOf('⧉ fix-login')).toBeGreaterThan(texts.indexOf('Projects/app'))
  await ui.unmount()
})

test('plain checkout shows the cwd and no worktree', async ($, on) => {
  stub(on, { cwd: MAIN, top: MAIN, tokens: 20_000, limits: [10, 10] })
  const ui = await $.ui.mount({ plugin: 'cclitehud', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: 'Projects/app' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /⧉/ })).toBeUndefined()
  await ui.unmount()
})

test('ctx bar carries the auto-compact mark at 160K of 200K', async ($, on) => {
  stub(on, { cwd: MAIN, top: MAIN, tokens: 20_000, limits: [10, 10] })
  const ui = await $.ui.mount({ plugin: 'cclitehud', surface: 'desktop', ...BAND })
  // 160K / 200K * 10 cells = cell 8
  expect(await ui.find({ type: 'Text', text: '│' })).toBeDefined()
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

test('terminal draws nothing of its own', async ($, on) => {
  stub(on, { cwd: MAIN, top: MAIN, tokens: 20_000, limits: [10, 10] })
  const ui = await $.ui.mount({ plugin: 'cclitehud', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: 'Projects/app' })).toBeUndefined()
  await ui.unmount()
})

test('compact mark follows a changed auto-compact threshold', async ($, on) => {
  let threshold = 160_000
  stub(on, { cwd: MAIN, top: MAIN, tokens: 20_000, limits: [10, 10], threshold: () => threshold })
  const markCell = async () => {
    const ui = await $.ui.mount({ plugin: 'cclitehud', surface: 'desktop', ...BAND })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    await ui.unmount()
    const bar = texts.slice(texts.indexOf('ctx 200K ') + 1, texts.indexOf(' 10%')).join('')
    return bar.indexOf('│')
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
  expect(await ui.find({ type: 'Text', text: '⌂ $21.95' })).toBeDefined()
  await ui.unmount()
})

test('a cost cached for another window is not shown', async ($, on) => {
  const file = JSON.stringify({ windowStart: 1, usd: 99, computedAt: 0 })
  stub(on, { cwd: MAIN, top: MAIN, tokens: 20_000, limits: [10, 10], weekly: { resetsAt: '2026-10-29T06:00:00.000Z', file } })
  const ui = await $.ui.mount({ plugin: 'cclitehud', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: /⌂/ })).toBeUndefined()
  await ui.unmount()
})
