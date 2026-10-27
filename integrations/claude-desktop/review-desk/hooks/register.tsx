import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { DeskCard, DeskView } from '../types'

const PANE = 'review-desk'
const API = 'http://localhost:47823'
const view = atom({ plugin: 'review-desk', key: 'view' } as const, { cards: [], status: '', error: null, busy: null } as DeskView)

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text: string }>

async function refresh(fetch: Fetch, set: (fn: (v: DeskView) => DeskView) => Promise<unknown>) {
  let focus, status
  try {
    ;[focus, status] = await Promise.all([fetch(`${API}/api/focus`), fetch(`${API}/api/status`)])
  } catch {
    await set(v => ({ ...v, cards: [], status: '', error: 'desk is not running. Start it with: desk serve' }))
    return 'desk offline'
  }
  try {
    if (!focus.ok) throw new Error(JSON.parse(focus.text).error ?? `HTTP ${focus.status}`)
    const sections = JSON.parse(focus.text).sections as Record<'now' | 'today', { id: string; title: string; why: string; url: string; new: boolean }[]>
    const cards: DeskCard[] = (['now', 'today'] as const).flatMap(bucket =>
      sections[bucket].map(c => ({ id: c.id, bucket, title: c.title, why: c.why, url: c.url, isNew: c.new })),
    )
    const text = status.ok ? (JSON.parse(status.text).text as string) : ''
    await set(v => ({ ...v, cards, status: text, error: null }))
    return text
  } catch (err) {
    await set(v => ({ ...v, cards: [], status: '', error: String((err as Error).message ?? err) }))
    return 'desk: error'
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'desk', description: 'Open Review Desk: what needs you now and today' })
    const tick = async () => {
      const text = await refresh((u, i) => $.http.fetch(u, i), fn => update($, view, fn))
      $.ui.status(text || undefined)
    }
    void tick()
    $.clock.every(60_000, tick)
    return next(e)
  })

  on('command.run', { command: 'desk' }, async $ => {
    await refresh((u, i) => $.http.fetch(u, i), fn => update($, view, fn))
    const opened = await $.ui.open({ id: PANE, title: 'Review Desk' })
    return { text: opened.isPlaced ? 'Review Desk opened.' : `Review Desk: ${API}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const v = await read($, view)
    const set = (fn: (x: DeskView) => DeskView) => update($, view, fn)
    const act = async (id: string, action: string, until?: string) => {
      await set(x => ({ ...x, busy: id }))
      await $.http.fetch(`${API}/api/act`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, action, until }) })
      await refresh((u, i) => $.http.fetch(u, i), set)
      await set(x => ({ ...x, busy: null }))
      $.ui.status(v.status || undefined)
    }
    const room = Math.max(1, Math.floor(((e.viewport?.rows ?? 30) - 4) / 3))

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text bold>{v.status || 'Nothing needs you right now.'}</Text>
          <Text> </Text>
          <Button key="refresh" hotkey="r" plain onPress={() => refresh((u, i) => $.http.fetch(u, i), set)}>refresh</Button>
          <Text> </Text>
          <Link href={`${API}/`} label="open desk" />
        </Box>
        {v.error && <Text color="red">{v.error}</Text>}
        {v.cards.slice(0, room).map(c => (
          <Box flexDirection="column">
            <Box flexDirection="row">
              <Text color={c.bucket === 'now' ? 'red' : 'yellow'}>{c.bucket === 'now' ? '● ' : '◐ '}</Text>
              <Link href={c.url} label={`${c.id.split('/')[1]} ${c.title}`} />
              {c.isNew && <Text color="blue"> new</Text>}
            </Box>
            <Box flexDirection="row">
              <Text dimColor>  {c.why}  </Text>
              <Button key={`done:${c.id}`} plain dimColor onPress={() => act(c.id, 'done')}>done</Button>
              <Text> </Text>
              <Button key={`snooze:${c.id}`} plain dimColor onPress={() => act(c.id, 'snooze', 'tomorrow')}>tomorrow</Button>
              {v.busy === c.id && <Text dimColor> …</Text>}
            </Box>
          </Box>
        ))}
        {v.cards.length > room && <Text dimColor>+{v.cards.length - room} more in the desk</Text>}
      </Box>
    )
  })
}
