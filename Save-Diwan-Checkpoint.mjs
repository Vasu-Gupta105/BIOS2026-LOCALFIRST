import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { workspaceRoot, archiveSnapshotPath, resolveArchivePath } from './Diwan-Archive-Paths.mjs'

const repo = join(workspaceRoot, 'diwan')
const output = archiveSnapshotPath(`Diwan-working-checkpoint-2026-11-01-${Date.now()}`)
await mkdir(dirname(output), { recursive: true })
await mkdir(output)
const digest = data => createHash('sha256').update(data).digest('hex')
const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repo, encoding: 'utf8' }).split('\0').filter(Boolean)
const files = []
for (const file of paths) {
  const source = join(repo, file)
  try { if (!(await stat(source)).isFile()) continue } catch { continue }
  const destination = join(output, 'source', file)
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination)
  const hash = digest(await readFile(source))
  if (digest(await readFile(destination)) !== hash) throw new Error(`Backup mismatch: ${file}`)
  files.push({ path: `source/${file}`, sha256: hash })
}
execFileSync('git', ['diff', '--binary', `--output=${join(output, 'tracked-changes.patch')}`], { cwd: repo })
await writeFile(join(output, 'HEAD.txt'), execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }))
await writeFile(join(output, 'git-status.txt'), execFileSync('git', ['status', '--short'], { cwd: repo }))
const tooling = ['Diwan-Windows-Bluetooth-Update-Fix.zip', 'Diwan-offline-upgrade-verification.json', 'Diwan-offline-package-verification.json', 'Start-Diwan-Offline.cmd', 'Start-Diwan-Offline.ps1', 'Verify-Offline-Upgrade.mjs', 'Verify-Offline-Package.mjs', 'Save-Diwan-Checkpoint.mjs', 'Diwan-Archive-Paths.mjs']
if (existsSync(join(workspaceRoot, 'Diwan-Archives.json'))) tooling.push('Diwan-Archives.json')
for (const file of tooling) {
  await cp(resolveArchivePath(file), join(output, file))
  files.push({ path: file, sha256: digest(await readFile(join(output, file))) })
}
const packageReport = JSON.parse(await readFile(join(workspaceRoot, 'Diwan-offline-package-verification.json'), 'utf8'))
await writeFile(join(output, 'manifest.json'), JSON.stringify({ userDate: '2026-11-01', purpose: 'User-confirmed working baseline before relay development', cacheVersion: packageReport.cacheVersion, nativeVersion: packageReport.nativeVersion, sourceFiles: paths.length, files }, null, 2))
await writeFile(join(output, 'RESTORE.txt'), `User-confirmed working Diwan baseline, 1 November 2026.
The ZIP contains the working Windows app, with frontend ${packageReport.cacheVersion} and native executable ${packageReport.nativeVersion}.
Extract it completely and run Start-Diwan-Offline.cmd with the same browser profile and http://127.0.0.1:8765 origin.
source/ contains the complete tracked/untracked non-ignored source snapshot; manifest.json records SHA-256 hashes.
HEAD.txt and tracked-changes.patch record Git provenance. The existing repository and working launcher were left in place.
Personal browser documents are stored in IndexedDB and are NOT in this source/app checkpoint. Export workspace in Diwan for a document backup. Do not clear browser data.
`)
console.log(JSON.stringify({ checkpoint: output, verifiedFiles: files.length, cacheVersion: packageReport.cacheVersion, nativeVersion: packageReport.nativeVersion }))
