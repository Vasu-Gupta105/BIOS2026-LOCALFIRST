import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { Y } from '../crdt/ydoc'
import { SharedFileModel } from './fileModel'
import { LocalReplica } from './replica'
import { NearbyDocumentSync, type SyncState } from './documentSync'
import type { NearbyMessage, NearbyStatus, NearbyWire } from './nativeBridge'
import type { SharedFileType } from './fileTypes'

const id = '97a562f0-0751-4ee1-8634-78b80914077d'
const replicas: LocalReplica[] = []
const models: SharedFileModel[] = []
const sessions: NearbyDocumentSync[] = []
beforeEach(() => { vi.stubGlobal('BroadcastChannel', undefined) })
afterEach(async () => {
  sessions.splice(0).forEach(session => session.close())
  for (const replica of replicas.splice(0)) await replica.close()
  models.splice(0).forEach(model => model.destroy())
  vi.unstubAllGlobals()
})

class Wire implements NearbyWire {
  peer!: Wire
  state: NearbyStatus = { state: 'idle' }
  messages = new Set<(message: NearbyMessage) => void>()
  statuses = new Set<(status: NearbyStatus) => void>()
  sent: NearbyMessage[] = []
  status = () => this.state
  send = async (message: NearbyMessage) => {
    this.sent.push(message)
    queueMicrotask(() => { if (this.state.state === 'connected' && this.peer.state.state === 'connected') for (const listener of this.peer.messages) listener(message) })
  }
  onMessage = (listener: (message: NearbyMessage) => void) => { this.messages.add(listener); return () => { this.messages.delete(listener) } }
  onStatus = (listener: (status: NearbyStatus) => void) => { this.statuses.add(listener); return () => { this.statuses.delete(listener) } }
  connect(connected: boolean) {
    this.state = connected ? { state: 'connected', session: 'test-session', document: { id, name: 'Shared test' } } : { state: 'idle' }
    this.statuses.forEach(listener => listener(this.state))
  }
}
async function open(type: Exclude<SharedFileType, 'doc'>, storage: IDBFactory, content: unknown) {
  vi.stubGlobal('indexedDB', storage)
  const model = new SharedFileModel(type)
  const failures: Error[] = []
  const replica = await LocalReplica.openModel(model, id, content, 'Shared test', () => {}, error => failures.push(error))
  const recovered = model.read()
  if (recovered) model.adopt(recovered)
  models.push(model); replicas.push(replica)
  return { model, replica, failures }
}
function link(a: LocalReplica, b: LocalReplica) {
  const wa = new Wire(), wb = new Wire(); wa.peer = wb; wb.peer = wa
  let stateA: SyncState = { phase: 'local' }, stateB: SyncState = { phase: 'local' }
  const sa = new NearbyDocumentSync(a, wa, value => { stateA = value }), sb = new NearbyDocumentSync(b, wb, value => { stateB = value })
  sessions.push(sa, sb)
  wa.connect(true); wb.connect(true)
  return { wa, wb, sa, sb, a: () => stateA, b: () => stateB }
}
const cases: Array<{ type: Exclude<SharedFileType, 'doc'>; content: unknown; edit: (content: any, side: number) => void }> = [
  { type: 'sheet', content: [{ id: 'sheet-1', name: 'Sheet1', celldata: [{ r: 0, c: 0, v: { v: 'original', f: '=1+1', bg: '#ffeeaa' } }], config: {} }], edit: (content, side) => { content[0].celldata.push({ r: side + 1, c: 0, v: { v: `Laptop ${side}` } }) } },
  { type: 'slide', content: { theme: 'black', transition: 'slide', slides: [{ id: 'a', title: 'First', content: '<p><b>Rich text</b></p>', notes: '' }, { id: 'b', title: 'Second', content: '<p>Body</p>', notes: '' }] }, edit: (content, side) => { content.slides[side].notes = `Laptop ${side}` } },
  { type: 'whiteboard', content: { type: 'excalidraw', elements: [{ id: 'a', type: 'rectangle', x: 0 }, { id: 'b', type: 'ellipse', x: 0 }], files: {} }, edit: (content, side) => { content.elements[side].x = 100 + side } },
  { type: 'pdf', content: { format: 'localfirst-pdf-v1', data: 'JVBERi0xLjQK', pageOrder: [1, 2], annotations: {}, pageRotations: {}, drawPaths: {}, blankPages: {} }, edit: (content, side) => { content.pageRotations[side + 1] = 90 } },
]

describe('structured file synchronization (test wire, not a Bluetooth hardware test)', () => {
  for (const scenario of cases) {
    it(`${scenario.type}: transfers intact, merges disconnected edits, and recovers both journals`, async () => {
      const storageA = new IDBFactory(), storageB = new IDBFactory()
      let a = await open(scenario.type, storageA, scenario.content), b = await open(scenario.type, storageB, null)
      const first = link(a.replica, b.replica)
      await vi.waitFor(() => expect(b.model.read()?.content).toEqual(scenario.content))
      await vi.waitFor(() => expect(first.a().phase).toBe('acknowledged'))
      first.wa.connect(false); first.wb.connect(false)
      for (const [side, current] of [a, b].entries()) {
        const snapshot = current.model.read()!
        current.model.adopt(snapshot)
        scenario.edit(snapshot.content, side)
        current.model.write(snapshot)
        await current.replica.flush()
      }
      first.sa.close(); first.sb.close(); await a.replica.close(); await b.replica.close()
      a = await open(scenario.type, storageA, null); b = await open(scenario.type, storageB, null)
      const second = link(a.replica, b.replica)
      const expected = structuredClone(scenario.content)
      scenario.edit(expected, 0); scenario.edit(expected, 1)
      await vi.waitFor(() => {
        expect(a.model.read()?.content).toEqual(expected)
        expect(b.model.read()?.content).toEqual(expected)
        expect(second.a().phase).toBe('acknowledged')
        expect(second.b().phase).toBe('acknowledged')
      })
      expect(a.failures).toEqual([]); expect(b.failures).toEqual([])
    })
  }
  it('rejects oversized local edits without modifying the live replica', () => {
    const model = new SharedFileModel('slide'); models.push(model)
    const content = structuredClone(cases[1].content) as { slides: Array<{ content: string }> }
    model.seed(content, 'Safe')
    const before = model.read()
    content.slides[0].content = 'X'.repeat(1024 * 1024)
    expect(() => model.write({ name: 'Safe', content })).toThrow('1 MiB')
    expect(model.read()).toEqual(before)
  })
  it('rejects invalid remote content and another editor model before applying it', () => {
    const model = new SharedFileModel('whiteboard'); models.push(model)
    model.seed(cases[2].content, 'Safe')
    const before = model.read()
    const wrong = new SharedFileModel('slide'); models.push(wrong)
    wrong.seed(cases[1].content, 'Wrong type')
    expect(model.applyUpdate(Y.encodeStateAsUpdate(wrong.context.ydoc)).applied).toBe(false)
    const other = new Y.Doc()
    other.getMap('unrelated').set('payload', 'wrong editor')
    expect(model.applyUpdate(Y.encodeStateAsUpdate(other)).applied).toBe(false)
    other.destroy()
    expect(model.read()).toEqual(before)
  })
  it('preserves deletion and slide order through a state-vector reconnect', async () => {
    const a = await open('slide', new IDBFactory(), cases[1].content), b = await open('slide', new IDBFactory(), null)
    const connection = link(a.replica, b.replica)
    await vi.waitFor(() => expect(b.model.read()?.content).toEqual(cases[1].content))
    connection.wa.connect(false); connection.wb.connect(false)
    const snapshot = a.model.read()!
    a.model.adopt(snapshot)
    ;(snapshot.content as { slides: unknown[] }).slides.splice(0, 1)
    a.model.write(snapshot)
    await a.replica.flush()
    connection.wa.connect(true); connection.wb.connect(true)
    await vi.waitFor(() => expect(b.model.read()).toEqual(a.model.read()))
    expect((b.model.read()!.content as { slides: Array<{ id: string }> }).slides.map(slide => slide.id)).toEqual(['b'])
  })
})
