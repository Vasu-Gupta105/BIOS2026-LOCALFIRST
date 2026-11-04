import { readFile } from 'node:fs/promises'
import { resolve, join, relative, isAbsolute, basename } from 'node:path'

export const workspaceRoot = resolve(import.meta.dirname)
const indexPath = join(workspaceRoot, 'Diwan-Archives.json')
let index
try { index = JSON.parse((await readFile(indexPath, 'utf8')).replace(/^\uFEFF/, '')) }
catch (error) {
  if (error.code !== 'ENOENT') throw error
  index = { archiveRoot: resolve(workspaceRoot, '..', 'W-Archives'), relocations: [], maintenanceChanges: [] }
}

const contains = (parent, path) => {
  const suffix = relative(parent, path)
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..\\') && !suffix.startsWith('../'))
}
if (index?.indexPath) {
  if (!isAbsolute(index.archiveRoot) || !isAbsolute(index.indexPath) || !contains(resolve(index.archiveRoot), resolve(index.indexPath))) throw new Error('Invalid archive index pointer.')
  const configuredRoot = resolve(index.archiveRoot)
  index = JSON.parse((await readFile(index.indexPath, 'utf8')).replace(/^\uFEFF/, ''))
  if (resolve(index.archiveRoot) !== configuredRoot) throw new Error('Archive index root does not match its pointer.')
}
if (!index || !isAbsolute(index.archiveRoot) || !Array.isArray(index.relocations)) throw new Error('Invalid Diwan archive index.')
export const archiveRoot = resolve(index.archiveRoot)
if (contains(workspaceRoot, archiveRoot)) throw new Error('Diwan archives must be outside the working workspace.')
for (const entry of index.relocations) {
  if (!isAbsolute(entry.original) || !isAbsolute(entry.destination) || !['move', 'duplicate-alias'].includes(entry.kind)) throw new Error('Invalid Diwan archive relocation.')
  if (!contains(workspaceRoot, resolve(entry.original)) || !contains(archiveRoot, resolve(entry.destination))) throw new Error('Diwan archive relocation is outside its declared roots.')
}
export const archiveIndex = index
const relocations = [...index.relocations].sort((left, right) => right.original.length - left.original.length)

/** Resolve recorded moves and duplicate aliases without copying any artifact. */
export function resolveArchivePath(path) {
  const original = resolve(workspaceRoot, path)
  for (const entry of relocations) {
    const from = resolve(entry.original)
    if (contains(from, original)) return resolve(entry.destination, relative(from, original))
  }
  return original
}

/** Callers explicitly create snapshots only when the user invokes a save. */
export function archiveSnapshotPath(name) {
  if (!name || basename(name) !== name || name === '.' || name === '..') throw new Error('Invalid Diwan snapshot name.')
  return join(archiveRoot, 'snapshots', name)
}
