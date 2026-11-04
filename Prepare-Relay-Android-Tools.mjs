import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolveArchivePath } from './Diwan-Archive-Paths.mjs'

const root = resolve(import.meta.dirname, '.tools', 'relay-android')
await mkdir(root, { recursive: true })
const packages = [
  { name: 'jdk.zip', url: 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jdk_x64_windows_hotspot_17.0.20.1_1.zip', sha256: 'e53a79c3c3d86865bd7e787903884331068e71321714ffd44f145785affc7cb0', output: 'java' },
  { name: 'gradle.zip', url: 'https://services.gradle.org/distributions/gradle-8.13-bin.zip', sha256: '20f1b1176237254a6fc204d8434196fa11a4cfb387567519c61556e8710aed78', output: 'gradle' },
]
for (const item of packages) {
  const archive = resolveArchivePath(join(root, item.name))
  if (!existsSync(archive)) {
    const response = await fetch(item.url)
    if (!response.ok) throw new Error(`Download failed: ${item.name}: ${response.status}`)
    await pipeline(response.body, createWriteStream(archive))
  }
  if (createHash('sha256').update(await readFile(archive)).digest('hex') !== item.sha256) throw new Error(`Checksum mismatch: ${item.name}`)
  const destination = join(root, item.output)
  if (!existsSync(destination)) {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $env:DIWAN_RELAY_ARCHIVE -DestinationPath $env:DIWAN_RELAY_DESTINATION'], { windowsHide: true, encoding: 'utf8', env: { ...process.env, DIWAN_RELAY_ARCHIVE: archive, DIWAN_RELAY_DESTINATION: destination } })
    if (result.status !== 0) throw new Error(result.stderr)
  }
  console.log(`Verified and extracted ${item.name}`)
}
await writeFile(join(root, 'download-provenance.json'), JSON.stringify(packages, null, 2))
