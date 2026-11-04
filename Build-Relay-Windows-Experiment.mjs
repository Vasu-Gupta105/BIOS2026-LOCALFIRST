import { readFile, writeFile, mkdir, cp, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { resolve, join } from 'node:path'

const workspace = resolve(import.meta.dirname)
const repo = join(workspace, 'diwan')
const stable = join(repo, 'offline-package', 'windows-x64-1793488092292')
const source = join(repo, 'cmd', 'diwan-relay-experiment')
await mkdir(source, { recursive: true })
let main = await readFile(join(repo, 'cmd', 'diwan-offline', 'main.go'), 'utf8')
if (!main.includes('hub := nearby.NewHub()')) throw new Error('The base entrypoint changed; review experimental integration.')
main = '//go:build relay_experiment\n\n' + main
main = main.replace('\t"embed"\n', '')
main = main.replace('//go:embed launch.html launch.js\nvar launcherFiles embed.FS', 'var launcherFiles fs.FS')
main = main.replace('launcherFiles.ReadFile(name)', 'fs.ReadFile(launcherFiles, name)')
main = main.replace('assets := os.DirFS(*assetsPath)', 'assets := os.DirFS(*assetsPath)\n\tlauncherFiles = os.DirFS(path.Join(*assetsPath, "_launcher"))')
main = main.replace('"127.0.0.1:8765", "loopback listen address"', '"127.0.0.1:8768", "isolated experimental loopback listen address"')
main = main.replace('hub := nearby.NewHub()', `hub, err := nearby.NewRelayedHub(os.Getenv("DIWAN_EXPERIMENTAL_RELAY_CODE"))
    _ = os.Unsetenv("DIWAN_EXPERIMENTAL_RELAY_CODE")
    if err != nil { log.Fatal(err) }`)
await writeFile(join(source, 'main.go'), main)
// Remove old exact source copies; the package receives its runtime assets below.
for (const file of ['launch.html', 'launch.js']) {
  try {
    const duplicate = await readFile(join(source, file))
    if (!duplicate.equals(await readFile(join(repo, 'cmd', 'diwan-offline', file)))) throw new Error(`Experimental source copy changed: ${file}; review before deleting.`)
    await unlink(join(source, file))
  } catch (error) { if (error.code !== 'ENOENT') throw error }
}
const go = join(workspace, '.tools', 'go', 'bin', 'go.exe')
const format = spawnSync(join(workspace, '.tools', 'go', 'bin', 'gofmt.exe'), ['-w', join(source, 'main.go')], { windowsHide: true, encoding: 'utf8' })
if (format.status !== 0) throw new Error(format.stderr)
// One canonical experimental build output; rebuilds do not create new copies.
const output = join(repo, 'relay-experiment-package', 'windows-x64')
await mkdir(output, { recursive: true })
const executable = join(output, 'diwan-relay-experiment.exe')
const build = spawnSync(go, ['build', '-tags', 'relay_experiment', '-trimpath', '-ldflags', '-s -w', '-o', executable, './cmd/diwan-relay-experiment'], { cwd: repo, windowsHide: true, stdio: 'inherit', env: { ...process.env, CGO_ENABLED: '0' } })
if (build.status !== 0) throw new Error('Experimental Windows build failed.')
await cp(join(stable, 'web'), join(output, 'web'), { recursive: true })
await mkdir(join(output, 'web', '_launcher'), { recursive: true })
for (const file of ['launch.html', 'launch.js']) await cp(join(repo, 'cmd', 'diwan-offline', file), join(output, 'web', '_launcher', file))
let html = await readFile(join(output, 'web', 'index.html'), 'utf8')
html = html.replace('<body>', '<body><div role="status" style="padding:8px;background:#fff0d7;color:#582d00;font:14px system-ui">Experimental Android relay · Separate test workspace · Select the relay phone when connecting</div>')
await writeFile(join(output, 'web', 'index.html'), html)
const metadata = JSON.parse(await readFile(join(output, 'web', '.diwan-offline.json'), 'utf8'))
const version = createHash('sha256').update(html).update(await readFile(executable)).digest('hex').slice(0,16)
let worker = await readFile(join(output, 'web', 'sw.js'), 'utf8')
worker = worker.replaceAll(metadata.cacheVersion, version)
await writeFile(join(output, 'web', 'sw.js'), worker)
await writeFile(join(output, 'web', '.diwan-offline.json'), JSON.stringify({ ...metadata, cacheVersion: version, nativeVersion: createHash('sha256').update(await readFile(executable)).digest('hex').slice(0,16), stage: 'experimental-fixed-route-android-relay', experimental: true }, null, 2))
for (const file of ['LICENSE-MIT', 'LICENSE-APACHE', 'THIRD-PARTY-NOTICES.txt', 'THIRD-PARTY-NOTICES-GO.txt']) await cp(join(stable, file), join(output,file))
await cp(join(workspace, 'Start-Relay-Windows-Experiment.ps1'), join(output, 'Start-Relay-Windows-Experiment.ps1'))
await writeFile(join(output, 'Start-Relay-Windows-Experiment.cmd'), '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Relay-Windows-Experiment.ps1"\r\nif errorlevel 1 pause\r\n')
await cp(join(repo, 'experiments', 'android-relay', 'README.md'), join(output, 'README.md'))
await writeFile(join(workspace, 'Diwan-relay-windows-build.json'), JSON.stringify({ package: output, experimental: true, loopbackPort: 8768, stablePortUnchanged: 8765, physicallyVerified: false }, null, 2))
console.log(JSON.stringify({ package: output, port: 8768, physicalBluetoothVerified: false }))
