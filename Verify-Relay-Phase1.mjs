import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import JSZip from './diwan/web/node_modules/jszip/lib/index.js'
import { archiveRoot, archiveIndex, resolveArchivePath } from './Diwan-Archive-Paths.mjs'

const workspace = resolve(import.meta.dirname)
const repo = join(workspace, 'diwan')
const go = join(workspace, '.tools', 'go', 'bin', 'go.exe')
if (!existsSync(go)) throw new Error('The portable Go toolchain is required for this Windows development verifier.')
const snapshotRoot = join(archiveRoot, 'snapshots')
const checkpointHomes = [workspace, snapshotRoot]
const checkpoints = (await Promise.all(checkpointHomes.map(async root => {
  try { return (await readdir(root)).filter(name => name.startsWith('Diwan-working-checkpoint-2026-11-01-')).map(name => join(root,name)) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
}))).flat().sort()
const checkpoint = process.argv[2] ? resolveArchivePath(resolve(workspace, process.argv[2])) : checkpoints.at(-1)
if (!checkpoint) throw new Error('No working checkpoint exists in the workspace or sibling archive.')
const manifest = JSON.parse(await readFile(join(checkpoint, 'manifest.json'), 'utf8'))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const reportPath = join(workspace, 'Diwan-relay-phase1-verification.json')

async function verifyBaseline() {
  let files = 0
  let maintenanceFiles = 0
  for (const entry of manifest.files) {
    const saved = await readFile(join(checkpoint, entry.path))
    if (digest(saved) !== entry.sha256) throw new Error(`Checkpoint integrity failed: ${entry.path}`)
    const isSource = entry.path.startsWith('source/')
    const current = resolveArchivePath(isSource ? join(repo, entry.path.slice(7)) : join(workspace, entry.path))
    const actual = digest(await readFile(current))
    const authorizedMaintenance = !isSource && (archiveIndex.maintenanceChanges || []).find(change => change.path === entry.path && change.originalSha256.toLowerCase() === entry.sha256.toLowerCase() && change.sha256.toLowerCase() === actual)
    if (actual !== entry.sha256 && !authorizedMaintenance) throw new Error(`Stable baseline changed: ${entry.path}`)
    if (authorizedMaintenance) maintenanceFiles++
    files++
  }
  const zip = await JSZip.loadAsync(await readFile(join(checkpoint, 'Diwan-Windows-Bluetooth-Update-Fix.zip')))
  let packageFiles = 0
  const roots = new Set()
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue
    const [root, ...parts] = entry.name.replaceAll('\\', '/').split('/')
    roots.add(root)
    if (!/^windows-x64-\d+$/.test(root) || parts.length === 0 || parts.some(part => part === '..' || part === '')) throw new Error(`Unexpected package entry: ${entry.name}`)
    const installed = join(repo, 'offline-package', root, ...parts)
    if (digest(await entry.async('nodebuffer')) !== digest(await readFile(installed))) throw new Error(`Installed stable package changed: ${parts.join('/')}`)
    packageFiles++
  }
  if (roots.size !== 1 || !packageFiles) throw new Error('Working package is empty or has unexpected layout.')
  const health = await fetch('http://127.0.0.1:8765/healthz', { signal: AbortSignal.timeout(2000) }).then(response => response.json())
  if (health.server !== 'diwan-offline' || health.cache_version !== manifest.cacheVersion || health.native_version !== manifest.nativeVersion) throw new Error('Running stable package does not match the preserved working release.')
  return { checkpoint, sourceAndWorkspaceFilesVerified: files, authorizedArchiveToolingChanges: maintenanceFiles, stableSourceHashChecksStrict: true, installedPackageFilesVerified: packageFiles, cacheVersion: health.cache_version, nativeVersion: health.native_version }
}
const baselineBefore = await verifyBaseline()
const scenarioRegister = JSON.parse(await readFile(join(repo, 'docs', 'BLUETOOTH-RELAY-SCENARIOS.json'), 'utf8'))
const tests = spawnSync(go, ['test', '-json', './internal/nearby', './cmd/diwan-offline', '-count=10', '-timeout=120s'], { cwd: repo, windowsHide: true, encoding: 'utf8', maxBuffer: 16*1024*1024 })
if (tests.error) throw tests.error
const events = tests.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
const passed = events.filter(event => event.Action === 'pass' && event.Test)
const failed = events.filter(event => event.Action === 'fail')
const names = [...new Set(passed.map(event => event.Test))]
const relayNames = names.filter(name => name.startsWith('TestRelayLab'))
const relayLeaves = relayNames.filter(name => !relayNames.some(other => other.startsWith(`${name}/`)))
const packages = [...new Set(events.filter(event => event.Action === 'pass' && !event.Test).map(event => event.Package))]
const missingEvidence = scenarioRegister.scenarios.filter(scenario => scenario.status === 'lab-covered' && !names.includes(scenario.evidenceTest))
const vet = spawnSync(go, ['vet', './internal/nearby', './cmd/diwan-offline'], { cwd: repo, windowsHide: true, encoding: 'utf8', maxBuffer: 2*1024*1024 })
const compiler = spawnSync('gcc.exe', ['-dumpmachine'], { windowsHide: true, encoding: 'utf8' })
const race = spawnSync(go, ['test', '-race', './internal/nearby', '-run', 'RelayLab', '-count=1', '-timeout=60s'], { cwd: repo, windowsHide: true, encoding: 'utf8', env: { ...process.env, CGO_ENABLED: '1' }, maxBuffer: 2*1024*1024 })
const raceOutput = `${race.stdout || ''}${race.stderr || ''}`.trim()
const raceCompilerUnavailable = race.status !== 0 && raceOutput.includes('64-bit mode not compiled in')
const baselineAfter = await verifyBaseline()
const source = await readFile(join(repo, 'internal', 'nearby', 'relay_lab_test.go'))
const nonTestFiles = spawnSync(go, ['list', '-f', '{{join .GoFiles " "}} {{join .CgoFiles " "}}', './internal/nearby'], { cwd: repo, windowsHide: true, encoding: 'utf8' })
if (nonTestFiles.status !== 0 || nonTestFiles.stdout.includes('relay_lab_test.go')) throw new Error('Lab build isolation could not be verified.')
const report = {
  phase: 1,
  scope: 'Protocol feasibility lab; Windows PCs and Android phones are the future hardware targets',
  passed: tests.status === 0 && failed.length === 0 && missingEvidence.length === 0 && vet.status === 0 && packages.length === 2 && (race.status === 0 || raceCompilerUnavailable),
  passScope: 'Protocol lab checks and baseline preservation. Missing race-detector toolchain is explicitly an open gate, not a security or production pass.',
  repetitions: 10,
  relayLeafScenarios: relayLeaves.length,
  relayTestExecutions: passed.filter(event => relayLeaves.includes(event.Test)).length,
  allGoTestExecutionsIncludingSubtests: passed.length,
  packages,
  relayTests: relayLeaves,
  labCoverageRows: scenarioRegister.scenarios.filter(scenario => scenario.status === 'lab-covered').length,
  pendingScenarios: scenarioRegister.scenarios.filter(scenario => scenario.status === 'pending').length,
  missingEvidence: missingEvidence.map(scenario => scenario.id),
  failedTests: failed.map(event => ({ package: event.Package, test: event.Test || '' })),
  goVet: { passed: vet.status === 0, output: `${vet.stdout || ''}${vet.stderr || ''}`.trim() },
  raceDetector: { status: race.status === 0 ? 'passed' : raceCompilerUnavailable ? 'blocked-toolchain' : 'failed', compilerTarget: compiler.stdout?.trim() || 'unavailable', exitCode: race.status, output: raceOutput },
  baselineBefore,
  baselineAfter,
  labSourceSha256: digest(source),
  labExcludedFromApplicationBuilds: true,
  physicalBluetoothRelayTested: false,
  androidRelayCoveredByThisReport: false,
  measuredRangeMetres: null,
  productionReady: false,
  independentSecurityAuditCompleted: false,
  limitations: ['Memory pipes and one loopback impersonation test are not radio evidence.', 'Absence of synthetic plaintext markers in these captures is a limited observation, not a cryptographic proof.', 'This phase-one report does not exercise the later Android/Windows prototype, routing discovery, field range or production deployment; see Diwan-relay-experiment-verification.json for prototype software checks.', 'Traffic metadata visibility, compromised endpoints and denial of service remain explicit threat-model limits.'],
}
await writeFile(reportPath, JSON.stringify(report, null, 2))
if (!report.passed) {
  process.stderr.write(tests.stderr || '')
  for (const event of events.filter(event => event.Action === 'output' && /FAIL|Error|fatal|race/i.test(event.Output || ''))) process.stderr.write(event.Output)
  throw new Error(`Phase-one checks failed; see ${reportPath}`)
}
console.log(JSON.stringify({ passed: true, relayLeafScenarios: report.relayLeafScenarios, repetitions: report.repetitions, relayTestExecutions: report.relayTestExecutions, pendingScenarios: report.pendingScenarios, stablePackagePreserved: true, productionReady: false, report: reportPath }, null, 2))
