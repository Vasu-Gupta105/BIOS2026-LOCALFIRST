import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, cp, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'
import { resolveArchivePath } from './Diwan-Archive-Paths.mjs'

if (!process.argv.includes('--sdk-license-accepted')) throw new Error('User authorization to accept the Android SDK license is required.')
const root = resolve(import.meta.dirname, '.tools', 'relay-android')
await mkdir(root, { recursive: true })
const archive = resolveArchivePath(join(root, 'android-command-tools.zip'))
const url = 'https://dl.google.com/android/repository/commandlinetools-win-16111833_latest.zip'
// Official repository2-3.xml archive checksum, retrieved before installation.
const officialSHA1 = '57d04f2d75eb8e8fffc5000a987e5de4b5a63e9d'
if (!existsSync(archive)) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`SDK tools download failed: ${response.status}`)
  await pipeline(response.body, createWriteStream(archive))
}
const bytes = await readFile(archive)
if (createHash('sha1').update(bytes).digest('hex') !== officialSHA1) throw new Error('SDK archive checksum mismatch.')
const staging = resolveArchivePath(join(root, 'sdk-tools-staging'))
const sdk = join(root, 'sdk')
if (!existsSync(staging)) {
  const extraction = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $env:DIWAN_RELAY_ARCHIVE -DestinationPath $env:DIWAN_RELAY_DESTINATION'], { windowsHide: true, encoding: 'utf8', env: { ...process.env, DIWAN_RELAY_ARCHIVE: archive, DIWAN_RELAY_DESTINATION: staging } })
  if (extraction.status !== 0) throw new Error(extraction.stderr)
}
if (!existsSync(join(sdk, 'cmdline-tools', 'latest', 'bin', 'android.exe'))) await cp(join(staging, 'cmdline-tools'), join(sdk, 'cmdline-tools', 'latest'), { recursive: true })
const java = join(root, 'java', (await readdir(join(root, 'java'))).find(name => name.startsWith('jdk-')))
await writeFile(join(root, 'sdk-provenance.json'), JSON.stringify({ url, officialSHA1, sha256: createHash('sha256').update(bytes).digest('hex'), licenseAuthorizedByUser: true, licenseSource: 'https://developer.android.com/studio#terms-and-conditions' }, null, 2))
const install = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(import.meta.dirname, 'Install-Relay-Android-Sdk.ps1'), '-SdkRoot', sdk, '-JavaRoot', java], { windowsHide: true, encoding: 'utf8', maxBuffer: 2*1024*1024 })
process.stdout.write(install.stdout || '')
process.stderr.write(install.stderr || '')
if (install.status !== 0) throw new Error('Android SDK setup failed.')
