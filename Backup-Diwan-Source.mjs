import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { workspaceRoot, archiveSnapshotPath } from './Diwan-Archive-Paths.mjs'

const repo = join(workspaceRoot, 'diwan')
const output = archiveSnapshotPath(`Diwan-source-backup-${Date.now()}`)
await mkdir(dirname(output), { recursive: true })
await mkdir(output)
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repo, encoding: 'utf8' }).split('\0').filter(Boolean)
let count = 0
for (const file of files) {
  const source = join(repo, file)
  try { if (!(await stat(source)).isFile()) continue } catch { continue }
  const target = join(output, 'source', file)
  await mkdir(dirname(target), { recursive: true })
  await cp(source, target)
  count++
}
execFileSync('git', ['diff', '--binary', `--output=${join(output, 'tracked-changes.patch')}`], { cwd: repo })
await writeFile(join(output, 'HEAD.txt'), execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }))
console.log(JSON.stringify({ backup: output, sourceFiles: count }))

// Inspect only the format of relevant downloads; never print document content or secrets.
const downloads = join(homedir(), 'Downloads')
for (const name of await readdir(downloads)) {
  if (!/^diwan.*\.json$/i.test(name)) continue
  const path = join(downloads, name)
  if ((await stat(path)).size > 4 * 1024 * 1024) continue
  try {
    const entry = JSON.parse(await readFile(path, 'utf8'))
    console.log(JSON.stringify({ downloadedFile: name, format: entry?.format || null, version: entry?.version || null, invitationPresent: typeof entry?.invitation === 'string', invitationLength: typeof entry?.invitation === 'string' ? entry.invitation.length : null }))
  } catch { console.log(JSON.stringify({ downloadedFile: name, validJson: false })) }
}
