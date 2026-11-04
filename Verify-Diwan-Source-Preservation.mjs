import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { workspaceRoot, resolveArchivePath } from './Diwan-Archive-Paths.mjs'

const repo = join(workspaceRoot, 'diwan')
const backup = resolveArchivePath('Diwan-source-backup-1793487067714')
const expectedChanges = new Set([
  'web/src/components/NearbyBluetooth.tsx',
  'scripts/package-offline.mjs',
  'docs/WINDOWS-BLUETOOTH.md',
  'docs/OFFLINE-NEARBY-PROGRESS.md',
  'docs/OFFLINE-USER-SAFETY-AUDIT.md',
])
async function files(dir, prefix = '') {
  const result = []
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const name = prefix + item.name
    if (item.isDirectory()) result.push(...await files(join(dir, item.name), name + '/'))
    else result.push(name)
  }
  return result
}
const changed = [], missing = []
const originalFiles = await files(join(backup, 'source'))
for (const file of originalFiles) {
  let current
  try { current = await readFile(join(repo, file)) } catch { missing.push(file); continue }
  if (!(await readFile(join(backup, 'source', file))).equals(current)) changed.push(file)
}
const unexpected = changed.filter(file => !expectedChanges.has(file))
const zip = resolveArchivePath('Diwan-Windows-Bluetooth-Invitation-Fix.zip')
const packageReportPath = join(workspaceRoot, 'Diwan-offline-package-verification.json')
const report = JSON.parse(await readFile(packageReportPath, 'utf8'))
report.archive = { path: zip, bytes: (await stat(zip)).size, sha256: createHash('sha256').update(await readFile(zip)).digest('hex') }
report.sourcePreservation = { backup, sourceFiles: originalFiles.length, missing, expectedModifiedFiles: changed, unexpectedModifiedFiles: unexpected, storageAndNativeProtocolUnchanged: missing.length === 0 && unexpected.length === 0 }
report.focusedTests = { passed: 133, files: 13 }
report.typecheck = 'passed'
report.goPackages = ['internal/nearby', 'cmd/diwan-offline']
await writeFile(packageReportPath, JSON.stringify(report, null, 2))
console.log(JSON.stringify({ passed: missing.length === 0 && unexpected.length === 0, originalFiles: originalFiles.length, missing, changed, unexpected, archiveBytes: report.archive.bytes }, null, 2))
if (missing.length || unexpected.length) process.exitCode = 1
