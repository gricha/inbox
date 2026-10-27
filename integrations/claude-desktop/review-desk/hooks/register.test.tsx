import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'review-desk',
  component: 'Pane',
  requestId: 'review-desk',
  props: { title: 'Review Desk', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const card = (id: string, title: string, why: string) => ({ id, title, why, url: `https://github.com/${id.replace('#', '/pull/')}`, new: false })

test('the pane lists Focus, and done hides a card', async ($, on) => {
  const done = new Set<string>()
  const statuses: (string | undefined)[] = []
  on('command.register', () => ({ value: { command: 'desk' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', (_, e) => (statuses.push(e.text), { value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  on('http.fetch', (_, e) => {
    const reply = (body: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } })
    if (e.url.endsWith('/api/act')) {
      done.add(JSON.parse(e.init!.body as string).id)
      return reply({ ok: true })
    }
    const now = [card('acme/api#1', 'Fix login', 'alice asked you directly')].filter(c => !done.has(c.id))
    const today = [card('acme/web#2', 'Add cache', 'CI failing')]
    if (e.url.endsWith('/api/status')) return reply({ text: `desk ${now.length ? `●${now.length} ` : ''}◐1` })
    return reply({ sections: { now, today } })
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'desk', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /desk ●1 ◐1/ }))?.text).toBe('desk ●1 ◐1')
    expect(await ui.find({ type: 'Text', text: /alice asked you directly/ })).toBeTruthy()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'done:acme/api#1' })
  expect(await ui.find({ type: 'Text', text: /alice asked you directly/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /CI failing/ })).toBeTruthy()
  await ui.unmount()
})

test('a stopped desk says how to start it', async ($, on) => {
  on('command.register', () => ({ value: { command: 'desk' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  on('http.fetch', () => {
    throw new Error('fetch failed: ECONNREFUSED')
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'desk', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /desk serve/ })).toBeTruthy()
  await ui.unmount()
})
