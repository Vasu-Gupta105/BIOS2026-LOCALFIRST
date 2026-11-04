import { Y, MAX_SNAPSHOT_BYTES, REMOTE_ORIGIN, type ApplyRemoteUpdateResult } from '../crdt/ydoc'
import type { ReplicaModel } from './replica'
import type { SharedFileType } from './fileTypes'
import { isAllowedImage, type BoardFile } from '../../apps/whiteboard/binding'

type Node = { kind: 'object' | 'array' | 'value'; value?: unknown; order?: number }
type Snapshot = { name: string; content: unknown }
const MAP = 'localfirst-file-v1'
const MAX_NODES = 60000

/** Stable array identities keep edits to separate cells, slides and shapes independent. */
function identity(value: unknown, index: number): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const item = value as Record<string, unknown>
    if (typeof item.id === 'string') return `id:${item.id}`
    if (Number.isInteger(item.r) && Number.isInteger(item.c)) return `cell:${String(item.r)}:${String(item.c)}`
    if (typeof item.index === 'string' || typeof item.index === 'number') return `sheet:${item.index}`
  }
  return `index:${index}`
}

function flatten(snapshot: Snapshot): Map<string, string> {
  // Match the JSON storage contract (omit undefined object properties).
  const json: unknown = JSON.parse(JSON.stringify(snapshot))
  const entries = new Map<string, string>()
  const visit = (value: unknown, path: string[], order?: number) => {
    if (path.length > 32 || entries.size >= MAX_NODES) throw new Error('This file is too complex for Bluetooth sharing.')
    const kind = Array.isArray(value) ? 'array' : value !== null && typeof value === 'object' ? 'object' : 'value'
    entries.set(JSON.stringify(path), JSON.stringify({ kind, ...(kind === 'value' ? { value } : {}), ...(order === undefined ? {} : { order }) }))
    if (Array.isArray(value)) {
      const used = new Set<string>()
      value.forEach((child, index) => {
        let key = identity(child, index)
        if (used.has(key)) key = `index:${index}`
        used.add(key)
        visit(child, [...path, key], index)
      })
    } else if (kind === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) visit(child, [...path, key])
    }
  }
  visit(json, [])
  return entries
}

export function fileSnapshotKey(snapshot: Snapshot): string {
  return JSON.stringify([...flatten(snapshot)].sort(([a], [b]) => a.localeCompare(b)))
}

function decode(doc: Y.Doc, mapKey: string): Snapshot | null {
  const map = doc.getMap<string>(mapKey)
  if (!map.size) return null
  if (map.size > MAX_NODES) throw new Error('Too many shared file entries.')
  const nodes = new Map<string, { node: Node; children: Map<string, string> }>()
  for (const [key, encoded] of map) {
    const path: unknown = JSON.parse(key)
    if (!Array.isArray(path) || path.length > 32 || path.some(part => typeof part !== 'string')) throw new Error('Invalid shared file path.')
    const node = JSON.parse(encoded) as Node
    if (!node || !['value', 'object', 'array'].includes(node.kind) || (node.order !== undefined && (!Number.isFinite(node.order) || node.order < 0))) throw new Error('Invalid shared file entry.')
    nodes.set(key, { node, children: new Map() })
  }
  for (const key of nodes.keys()) {
    const path = JSON.parse(key) as string[]
    if (path.length) nodes.get(JSON.stringify(path.slice(0, -1)))?.children.set(path[path.length - 1], key)
  }
  const read = (key: string): unknown => {
    const entry = nodes.get(key)
    if (!entry) throw new Error('Missing shared file root.')
    if (entry.node.kind === 'value') return entry.node.value
    const children = [...entry.children.entries()]
    if (entry.node.kind === 'array') {
      children.sort(([a, ka], [b, kb]) => (nodes.get(ka)!.node.order ?? 0) - (nodes.get(kb)!.node.order ?? 0) || a.localeCompare(b))
      return children.map(([, child]) => read(child))
    }
    return Object.fromEntries(children.map(([name, child]) => [name, read(child)]))
  }
  const snapshot = read('[]') as Snapshot
  if (!snapshot || typeof snapshot.name !== 'string' || !snapshot.name.trim() || snapshot.name.length > 512 || !Object.hasOwn(snapshot, 'content')) throw new Error('Invalid shared file metadata.')
  return snapshot
}

export function validateSharedContent(type: Exclude<SharedFileType, 'doc'>, content: unknown): void {
  const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid shared ${type} object.`)
    return value as Record<string, unknown>
  }
  const array = (value: unknown): unknown[] => {
    if (!Array.isArray(value)) throw new Error(`Invalid shared ${type} collection.`)
    return value as unknown[]
  }
  const object = type === 'sheet' ? {} : record(content)
  if (type === 'sheet') {
    const sheets = array(content)
    if (!sheets.length) throw new Error('Invalid shared spreadsheet.')
    for (const raw of sheets) {
      const sheet = record(raw)
      if (typeof sheet.name !== 'string') throw new Error('Invalid shared spreadsheet name.')
      for (const entry of array(sheet.celldata ?? [])) {
        const cell = record(entry)
        if (typeof cell.r !== 'number' || typeof cell.c !== 'number' || !Number.isInteger(cell.r) || !Number.isInteger(cell.c) || cell.r < 0 || cell.r >= 1048576 || cell.c < 0 || cell.c >= 16384) throw new Error('Invalid shared spreadsheet cell.')
      }
    }
  } else if (type === 'slide') {
    const slides = array(object.slides)
    if (!slides.length) throw new Error('Invalid shared presentation.')
    for (const raw of slides) {
      const slide = record(raw)
      if (typeof slide.id !== 'string' || ['title', 'content', 'notes'].some(key => slide[key] !== undefined && typeof slide[key] !== 'string')) throw new Error('Invalid shared presentation.')
    }
  } else if (type === 'whiteboard') {
    if (array(object.elements).some(element => typeof record(element).id !== 'string')) throw new Error('Invalid shared whiteboard.')
    if (Object.values(record(object.files)).some(file => !isAllowedImage(record(file) as BoardFile))) throw new Error('Invalid image in shared whiteboard.')
  } else if (type === 'pdf') {
    if (object.format !== 'localfirst-pdf-v1' || typeof object.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(object.data) || !object.data.startsWith('JVBER')) throw new Error('Invalid shared PDF.')
    if (!array(object.pageOrder).length || array(object.pageOrder).some(page => !Number.isSafeInteger(page))) throw new Error('Invalid shared PDF pages.')
    const annotations = record(object.annotations)
    for (const entries of Object.values(annotations)) {
      for (const raw of array(entries)) {
        const entry = record(raw)
        if (typeof entry.id !== 'string' || !Number.isFinite(entry.x) || !Number.isFinite(entry.y) || !Number.isInteger(entry.pageIndex)) throw new Error('Invalid shared PDF annotation.')
        if (entry.type === 'text') {
          if (typeof entry.content !== 'string' || typeof entry.fontFamily !== 'string' || typeof entry.color !== 'string' || !Number.isFinite(entry.fontSize)) throw new Error('Invalid shared PDF text.')
        } else if (entry.type === 'signature') {
          if (!Number.isFinite(entry.width) || !Number.isFinite(entry.height) || typeof entry.imageData !== 'string' || !/^data:image\/(png|jpe?g|webp);base64,/i.test(entry.imageData)) throw new Error('Invalid shared PDF signature.')
        } else throw new Error('Unsupported shared PDF annotation.')
      }
    }
    for (const entries of Object.values(record(object.drawPaths))) {
      for (const raw of array(entries)) {
        const path = record(raw)
        if (typeof path.id !== 'string' || typeof path.color !== 'string' || !Number.isFinite(path.size) || array(path.points).some(raw => { const point = record(raw); return !Number.isFinite(point.x) || !Number.isFinite(point.y) })) throw new Error('Invalid shared PDF drawing.')
      }
    }
    if (Object.values(record(object.pageRotations)).some(rotation => !Number.isFinite(rotation))) throw new Error('Invalid shared PDF rotation.')
    if (Object.values(record(object.blankPages)).some(data => typeof data !== 'string' || !data.startsWith('JVBER') || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))) throw new Error('Invalid shared blank PDF page.')
  }
}

/** JSON fields use independent Y.Map registers; only changed local fields are written. */
export class SharedFileModel implements ReplicaModel {
  readonly context = { ydoc: new Y.Doc() }
  private baseline = new Map<string, string>()
  constructor(readonly type: Exclude<SharedFileType, 'doc'>) {}
  private get mapKey() { return `${MAP}:${this.type}` }
  get hasContent() { return this.context.ydoc.getMap(this.mapKey).size > 0 }
  seed(content: unknown, name: string) { this.write({ name, content }) }
  read(): Snapshot | null { return decode(this.context.ydoc, this.mapKey) }
  adopt(snapshot: Snapshot) { this.baseline = flatten(snapshot) }
  write(snapshot: Snapshot) {
    validateSharedContent(this.type, snapshot.content)
    const next = flatten(snapshot)
    const map = this.context.ydoc.getMap<string>(this.mapKey)
    // Preflight against a disposable clone, so an oversized edit cannot poison
    // the durable replica. The editor still retains its local recovery copy.
    const apply = (target: Y.Map<string>) => {
      for (const key of this.baseline.keys()) if (!next.has(key)) target.delete(key)
      for (const [key, value] of next) if (value !== this.baseline.get(key)) target.set(key, value)
    }
    const shadow = new Y.Doc()
    try {
      Y.applyUpdate(shadow, Y.encodeStateAsUpdate(this.context.ydoc))
      shadow.transact(() => apply(shadow.getMap<string>(this.mapKey)))
      if (Y.encodeStateAsUpdate(shadow).length > MAX_SNAPSHOT_BYTES) throw new Error('This file exceeds the 1 MiB Bluetooth replica limit. Your edits are still in this editor; save a recovery copy.')
    } finally { shadow.destroy() }
    this.context.ydoc.transact(() => apply(map))
    this.baseline = next
  }
  applyUpdate(update: Uint8Array): ApplyRemoteUpdateResult {
    const shadow = new Y.Doc()
    try {
      Y.applyUpdate(shadow, Y.encodeStateAsUpdate(this.context.ydoc))
      Y.applyUpdate(shadow, update)
      if ([...shadow.share.keys()].some(key => key !== this.mapKey)) throw new Error('This update belongs to a different editor model.')
      if (Y.encodeStateAsUpdate(shadow).length > MAX_SNAPSHOT_BYTES) throw new Error('Shared file exceeds the Bluetooth replica limit.')
      const snapshot = decode(shadow, this.mapKey)
      if (snapshot) validateSharedContent(this.type, snapshot.content)
      Y.applyUpdate(this.context.ydoc, update, REMOTE_ORIGIN)
      return { applied: true }
    } catch (error) {
      return { applied: false, reason: error instanceof Error ? error.message : 'Invalid shared file update.' }
    } finally { shadow.destroy() }
  }
  destroy() { this.context.ydoc.destroy() }
}
