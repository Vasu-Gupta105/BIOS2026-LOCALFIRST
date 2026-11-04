import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFile, readdir, mkdir, stat, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { chromium, expect } from './diwan/web/node_modules/@playwright/test/index.mjs'

const workspace = resolve(import.meta.dirname)
const repo = join(workspace, 'diwan')
const android = join(repo, 'experiments', 'android-relay')
const tools = join(workspace, '.tools', 'relay-android')
const javaRoot = join(tools, 'java', 'jdk-17.0.20.1+1')
const java = join(javaRoot, 'bin', 'java.exe')
const javac = join(javaRoot, 'bin', 'javac.exe')
const buildTools = join(tools, 'sdk', 'build-tools', '35.0.0')
const go = join(workspace, '.tools', 'go', 'bin', 'go.exe')
const packageRoot = join(repo, 'relay-experiment-package', 'windows-x64')
const executable = join(packageRoot, 'diwan-relay-experiment.exe')
const apk = join(android, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
const reportPath = join(workspace, 'Diwan-relay-experiment-verification.json')
const origin = 'http://127.0.0.1:8769'
const stableOrigin = 'http://127.0.0.1:8765'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const report = {
  purpose: 'Software checks and isolated package smoke test for the fixed-route Android relay experiment',
  passed: false,
  androidApk: apk,
  windowsPackage: packageRoot,
  physicalBluetoothRelayVerified: false,
  androidDeviceLifecycleVerified: false,
  androidEndpointApplicationImplemented: false,
  measuredRangeMetres: null,
  productionReady: false,
  independentSecurityAuditCompleted: false,
  raceDetectorPassed: false,
  raceDetectorLimitation: 'Existing local 32-bit MinGW cannot build the Windows amd64 race runtime; this verifier does not claim a race-detector pass.',
}
function run(file, args, cwd = workspace) {
  const result = spawnSync(file, args, { cwd, windowsHide: true, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(`${file.split(/[\\/]/).at(-1)} failed: ${result.error?.message || `${result.stdout || ''}${result.stderr || ''}`.trim().slice(-3000)}`)
  return result.stdout || ''
}
async function health(base) {
  const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2000), cache: 'no-store' })
  if (!response.ok) throw new Error(`Health request failed at ${base}.`)
  return response.json()
}
async function sourceModificationTime(directory) {
  let latest = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    latest = Math.max(latest, entry.isDirectory() ? await sourceModificationTime(path) : (await stat(path)).mtimeMs)
  }
  return latest
}

let app
let browser
let appSpawnError
let failure
try {
  const stable = await health(stableOrigin)
  if (stable.server !== 'diwan-offline') throw new Error('The preserved stable app is not running on port 8765.')
  report.stableBefore = { cacheVersion: stable.cache_version, nativeVersion: stable.native_version }

  const classes = join(android, 'build', 'core-tests')
  await mkdir(classes, { recursive: true })
  const core = join(android, 'app', 'src', 'main', 'java', 'org', 'diwan', 'relay', 'experimental', 'RelayCore.java')
  const coreTest = join(android, 'core-tests', 'org', 'diwan', 'relay', 'experimental', 'RelayCoreTest.java')
  run(javac, ['-d', classes, core, coreTest], android)
  const jvm = JSON.parse(run(java, ['-cp', classes, 'org.diwan.relay.experimental.RelayCoreTest'], android).trim())
  if (!jvm.passed || jvm.physicalBluetoothVerified !== false || !(jvm.checks > 0)) throw new Error('Unexpected Java core test result.')
  report.jvmCore = { passed: true, checks: jvm.checks, sourceSha256: digest(await readFile(core)), testsSha256: digest(await readFile(coreTest)), physicalBluetoothVerified: false }

  const testOutput = run(go, ['test', '-json', '-tags', 'relay_experiment', './internal/nearby', '-run', 'ExperimentalRelay', '-count=3', '-timeout=90s'], repo)
  const events = testOutput.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  if (events.some(event => event.Action === 'fail') || !events.some(event => event.Action === 'pass' && !event.Test)) throw new Error('Tagged Go relay tests did not pass.')
  const passed = events.filter(event => event.Action === 'pass' && event.Test)
  const names = [...new Set(passed.map(event => event.Test))]
  const leaves = names.filter(name => !names.some(other => other.startsWith(`${name}/`)))
  if (!leaves.length) throw new Error('Tagged Go relay tests did not execute any scenarios.')
  report.goProtocolTests = { passed: true, repetitions: 3, distinctLeafScenarios: leaves.length, leafExecutions: passed.filter(event => leaves.includes(event.Test)).length, scenarios: leaves, transport: 'synthetic memory/loopback; not physical Bluetooth' }
  run(go, ['vet', '-tags', 'relay_experiment', './internal/nearby', './cmd/diwan-relay-experiment'], repo)
  report.goVet = { passed: true, buildTag: 'relay_experiment' }

  const lintFile = join(android, 'app', 'build', 'reports', 'lint-results-debug.txt')
  const lint = (await readFile(lintFile, 'utf8')).trim()
  const sourceTime = await sourceModificationTime(join(android, 'app', 'src'))
  if (lint !== 'No issues found.' || (await stat(lintFile)).mtimeMs < sourceTime) throw new Error('A current clean Android lint report is required.')
  if ((await stat(apk)).mtimeMs < sourceTime) throw new Error('The debug APK predates Android application source edits.')
  report.androidLint = { passed: true, issues: 0, report: lintFile, reportSha256: digest(await readFile(lintFile)), newerThanApplicationSources: true }
  const signature = run(java, ['-jar', join(buildTools, 'lib', 'apksigner.jar'), 'verify', '--verbose', '--print-certs', apk])
  if (!signature.includes('CN=Android Debug') || !signature.includes('APK Signature Scheme v2): true')) throw new Error('APK is not the expected verified debug-signed artifact.')
  const certificateSha256 = signature.match(/Signer #1 certificate SHA-256 digest: ([0-9a-f]+)/i)?.[1]
  const permissionsOutput = run(join(buildTools, 'aapt.exe'), ['dump', 'permissions', apk])
  if (!permissionsOutput.includes('package: org.diwan.relay.experimental')) throw new Error('APK application ID is unexpected.')
  const permissions = [...permissionsOutput.matchAll(/uses-permission: name='([^']+)'/g)].map(match => match[1])
  const expectedPermissions = ['android.permission.BLUETOOTH', 'android.permission.BLUETOOTH_ADMIN', 'android.permission.BLUETOOTH_CONNECT', 'android.permission.POST_NOTIFICATIONS', 'android.permission.FOREGROUND_SERVICE', 'android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE']
  if (permissions.length !== expectedPermissions.length || permissions.some(permission => !expectedPermissions.includes(permission))) throw new Error('APK permissions differ from its bounded Bluetooth/foreground-service scope.')
  report.androidArtifact = { debugSigned: true, signatureVerified: true, signatureSchemeV2: true, signingCertificateSha256: certificateSha256, sha256: digest(await readFile(apk)), bytes: (await stat(apk)).size, applicationId: 'org.diwan.relay.experimental', permissions, internetPermission: false }
  report.debugSigned = true

  const metadata = JSON.parse(await readFile(join(packageRoot, 'web', '.diwan-offline.json'), 'utf8'))
  if (metadata.experimental !== true) throw new Error('Windows smoke test must use the isolated experimental package.')
  report.windowsArtifact = { exeSha256: digest(await readFile(executable)), cacheVersion: metadata.cacheVersion, nativeVersion: metadata.nativeVersion, experimentalPort: 8768, smokePort: 8769 }
  app = spawn(executable, ['-addr', '127.0.0.1:8769'], { cwd: packageRoot, windowsHide: true, stdio: 'ignore', env: { ...process.env, DIWAN_EXPERIMENTAL_RELAY_CODE: `DRL1-${randomBytes(32).toString('base64url')}` } })
  app.on('error', error => { appSpawnError = error })
  let ready = false
  for (let attempt = 0; attempt < 50; attempt++) {
    if (appSpawnError || app.exitCode !== null) throw new Error('The isolated experimental Windows server stopped during startup.')
    try {
      const current = await health(origin)
      if (current.cache_version === metadata.cacheVersion && current.native_version === metadata.nativeVersion) { ready = true; break }
    } catch { /* Wait only for our spawned server. */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (!ready) throw new Error('The isolated experimental Windows server did not report the expected versions.')
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ serviceWorkers: 'allow' })
  const page = await context.newPage()
  const externalOrDocumentApiRequests = []
  const errors = []
  let localNativeRequests = 0
  context.on('request', request => {
    const url = new URL(request.url())
    const allowedStartup = ['/api/offline-launch', '/api/offline-launch.js', '/api/offline-launch-health'].includes(url.pathname)
    if (url.origin !== origin || (!allowedStartup && /^\/(api|v1)(\/|$)/.test(url.pathname))) externalOrDocumentApiRequests.push(`${url.origin}${url.pathname}`)
    if (url.origin === origin && url.pathname.startsWith('/_nearby/')) localNativeRequests++
  })
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${origin}/api/offline-launch`)
  await expect(page.getByText(/Experimental Android relay.*Separate test workspace/)).toBeVisible({ timeout: 45000 })
  await expect(page.getByRole('button', { name: 'Bluetooth sharing', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Bluetooth sharing', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Connect two Windows laptops' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Paired laptop', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Load invitation file', exact: true })).toBeVisible()
  await expect.poll(() => localNativeRequests).toBeGreaterThan(0)
  expect(externalOrDocumentApiRequests).toEqual([])
  expect(errors).toEqual([])
  report.windowsSmoke = { passed: true, launcherActivated: true, experimentalBannerVisible: true, bluetoothSharingVisible: true, nativeDialogVisible: true, localNativeRequests, externalOrDocumentApiRequests, browserErrors: errors, testDocumentCreated: false, remoteBluetoothConnectionAttempted: false }
} catch (error) {
  failure = error
  report.error = error instanceof Error ? error.message : String(error)
} finally {
  try { if (browser) await browser.close() }
  catch (error) { failure ||= error; report.browserCleanupError = error.message }
  if (app && !appSpawnError && app.exitCode === null && app.signalCode === null) {
    const stopped = new Promise(resolve => app.once('exit', resolve))
    app.kill()
    await Promise.race([stopped, new Promise(resolve => setTimeout(resolve, 3000))])
    if (app.exitCode === null && app.signalCode === null) { failure ||= new Error('Experimental test server did not stop.'); report.serverCleanupError = 'Experimental test server did not stop.' }
  }
  try {
    const stable = await health(stableOrigin)
    report.stableAfter = { cacheVersion: stable.cache_version, nativeVersion: stable.native_version }
    report.stableVersionsPreserved = !!report.stableBefore && JSON.stringify(report.stableBefore) === JSON.stringify(report.stableAfter)
    if (!report.stableVersionsPreserved) { failure ||= new Error('Stable app versions changed during experimental checks.'); report.stableVersionError = 'Stable app versions changed during experimental checks.' }
  } catch (error) { failure ||= error; report.stableHealthError = error.message }
  report.passed = !failure
  await writeFile(reportPath, JSON.stringify(report, null, 2))
}
console.log(JSON.stringify({ passed: report.passed, javaCoreChecks: report.jvmCore?.checks, goRelayScenarios: report.goProtocolTests?.distinctLeafScenarios, goRelayExecutions: report.goProtocolTests?.leafExecutions, androidLintIssues: report.androidLint?.issues, debugSigned: report.debugSigned, windowsSmokePassed: report.windowsSmoke?.passed, stableVersionsPreserved: report.stableVersionsPreserved, physicalBluetoothRelayVerified: false, productionReady: false, report: reportPath }, null, 2))
if (failure) { process.stderr.write(`${report.error || failure.message}\n`); process.exitCode = 1 }
