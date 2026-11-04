import { useCallback, useEffect, useRef, useState } from 'react'
import { OFFLINE_ONLY } from '../offline/mode'
import { enableLocalReplica, getLocalFile } from '../offline/workspace'
import { useFilesStore, type LocalFirstFile } from '../../store/filesStore'
import { SharedFileModel, fileSnapshotKey } from './fileModel'
import { LocalReplica } from './replica'
import { NearbyDocumentSync, type SyncState } from './documentSync'
import { nativeWire, type NearbyDocument } from './nativeBridge'
import type { SharedFileType } from './fileTypes'

interface Options {
  id: string | undefined
  type: Exclude<SharedFileType, 'doc'>
  file: LocalFirstFile | undefined
  name: string
  content: unknown
  ready?: boolean
  receive: (name: string, content: unknown) => void
}

/** Opt-in bridge for structured editors. Unshared and hosted editors retain their save path. */
export function useNearbyFile(options: Options) {
  const latest = useRef(options)
  latest.current = options
  const stored = useFilesStore(state => state.files.find(file => file.id === options.id))
  const enabled = OFFLINE_ONLY && !!(stored?.nearby_enabled || options.file?.nearby_enabled)
  const [sync, setSync] = useState<SyncState>({ phase: 'local' })
  const [storageError, setStorageError] = useState('')
  const [ready, setReady] = useState(false)
  const runtime = useRef({ enabled, ready })
  runtime.current = { enabled, ready }
  const active = useRef<{ model: SharedFileModel; replica: LocalReplica; persist: () => Promise<LocalFirstFile>; write: (snapshot: { name: string; content: unknown }) => void } | null>(null)
  const opening = useRef<Promise<void> | null>(null)
  const fail = (error: unknown) => setStorageError(error instanceof Error ? error.message : 'Bluetooth file synchronization failed.')

  useEffect(() => {
    if (!enabled || !options.id || !options.file || options.ready === false) return
    const id = options.id
    let cancelled = false
    let replica: LocalReplica | null = null
    let connection: NearbyDocumentSync | null = null
    let saveTail: Promise<unknown> = Promise.resolve()
    const model = new SharedFileModel(options.type)
    let rendered = ''
    const receive = () => {
      const snapshot = model.read()
      if (!snapshot) return
      const encoded = fileSnapshotKey(snapshot)
      if (encoded !== rendered) {
        rendered = encoded
        model.adopt(snapshot)
        latest.current.receive(snapshot.name, snapshot.content)
      }
      setReady(true)
    }
    const write = (snapshot: { name: string; content: unknown }) => {
      model.write(snapshot)
      rendered = fileSnapshotKey(snapshot)
    }
    const persist = (): Promise<LocalFirstFile> => {
      const write = saveTail.catch(() => {}).then(async () => {
        await replica!.flush()
        const snapshot = model.read()
        if (!snapshot) throw new Error('Waiting for the shared file before saving.')
        const saved = await useFilesStore.getState().saveFileWithDraft(id, snapshot.name, snapshot.content, { replica: true })
        if (!cancelled) setStorageError('')
        return saved
      })
      saveTail = write
      return write
    }
    setReady(false)
    opening.current = (async () => {
      const file = await getLocalFile(id)
      replica = await LocalReplica.openModel(model, id, file.nearby_initial ? null : file.content, file.name, () => {
        if (cancelled) return
        receive()
        if (model.hasContent) void persist().catch(fail)
      }, error => { if (!cancelled) fail(error) })
      if (cancelled) { await replica.close(); model.destroy(); return }
      // Capture edits made while the journal was opening before applying its state.
      if (!file.nearby_initial) {
        model.adopt({ name: file.name, content: file.content })
        write({ name: latest.current.name, content: latest.current.content })
      }
      active.current = { model, replica, persist, write }
      receive()
      connection = new NearbyDocumentSync(replica, nativeWire, state => { if (!cancelled) setSync(state) })
    })().catch(error => { if (!cancelled) fail(error) })
    return () => {
      cancelled = true
      connection?.close()
      active.current = null
      // Closing drains journal writes; destruction must follow the final snapshot save.
      if (replica) void saveTail.catch(() => {}).then(() => replica!.close()).then(() => model.destroy())
    }
  }, [enabled, options.id, options.type, !!options.file, options.ready !== false])

  useEffect(() => {
    const current = active.current
    if (!current || !ready || options.ready === false) return
    try { current.write({ name: options.name, content: options.content }) }
    catch (error) { fail(error) }
  }, [options.name, options.content, ready, options.ready])

  const save = useCallback(async (name: string, content: unknown): Promise<LocalFirstFile> => {
    if (!runtime.current.enabled) return useFilesStore.getState().saveFileWithDraft(latest.current.id!, name, content)
    await opening.current
    const current = active.current
    if (!current || !runtime.current.ready) throw new Error('Wait for Bluetooth file recovery before saving.')
    current.write({ name, content })
    await current.replica.flush()
    return current.persist()
  }, [])
  const prepare = useCallback(async (): Promise<NearbyDocument> => {
    const current = latest.current
    if (!current.id || !current.file || current.ready === false) throw new Error('Wait for the file to open and finish recovery before sharing.')
    // Validate size and shape before opting in. A failed preflight leaves normal editing intact.
    const preflight = new SharedFileModel(current.type)
    try { preflight.write({ name: current.name, content: current.content }) }
    finally { preflight.destroy() }
    await save(current.name, current.content)
    const file = await enableLocalReplica(current.id)
    useFilesStore.setState(state => ({ files: state.files.map(entry => entry.id === file.id ? file : entry) }))
    return { id: file.id, name: file.name, type: current.type }
  }, [save])
  const visibleSync: SyncState = storageError ? { phase: 'error', error: storageError } : sync
  return { prepare, save, sync: visibleSync, waiting: enabled && !ready, enabled }
}
