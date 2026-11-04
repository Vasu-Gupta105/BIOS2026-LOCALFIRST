import { spawn } from 'node:child_process'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { chromium, expect } from './diwan/web/node_modules/@playwright/test/index.mjs'

const packages = resolve('diwan/offline-package')
const name = (await readdir(packages)).filter(name => name.startsWith('windows-x64-')).sort().at(-1)
if (!name) throw new Error('No Windows offline package exists.')
const root = join(packages, name)
const metadata = JSON.parse(await readFile(join(root, 'web', '.localfirst-offline.json'), 'utf8'))
const app = spawn(join(root, 'localfirst-offline.exe'), ['-addr', '127.0.0.1:8766'], { cwd: root, windowsHide: true, env: { ...process.env, PATH: 'C:\\Windows\\System32' }, stdio: ['ignore', 'ignore', 'pipe'] })
let error = ''
app.stderr.on('data', data => { error += data.toString() })
const url = 'http://127.0.0.1:8766'
let ready = false
for (let attempt = 0; attempt < 40; attempt++) {
  if (app.exitCode !== null) throw new Error(error)
  try {
    const response = await fetch(`${url}/healthz`)
    const health = await response.json()
    if (response.ok && health.server === 'localfirst-offline' && health.cache_version === metadata.cacheVersion && health.native_version === metadata.nativeVersion) { ready = true; break }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 250))
}
if (!ready) { app.kill(); throw new Error('Packaged asset server did not become ready.') }
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext({ serviceWorkers: 'allow' })
const page = await context.newPage()
const forbidden = []
const errors = []
let nativeRequests = 0
const hardware = { radioAvailable: false, hostEntryFromHomeVerified: false, ownerSharingStarted: false, shortPairingCodeGeneratedAndDisplayed: false, invitationExportImportVerified: false, ownerSharingStopped: false, twoPhysicalDeviceTransferVerified: false }
context.on('request', request => {
  const location = new URL(request.url())
  if (location.origin !== url || /^\/(api|v1)(\/|$)/.test(location.pathname)) forbidden.push(request.url())
  if (location.pathname.startsWith('/_nearby/')) nativeRequests++
})
page.on('pageerror', error => errors.push(error.message))
try {
  await page.goto(`${url}/docs`)
  await expect(page.getByText('Local workspace · Internet access disabled')).toBeVisible()
  await page.getByRole('button', { name: 'New Document', exact: true }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel(/Name/i).fill('Offline package check')
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'true')
  await page.locator('.ProseMirror').click()
  await page.keyboard.type('This document opens and saves locally, without an internet API.')
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible()
  const bootstrap = await (await fetch(`${url}/_nearby/bootstrap`)).json()
  const nativeHeaders = { 'X-LocalFirst-Native-Token': bootstrap.token }
  const localStatus = () => fetch(`${url}/_nearby/status`, { headers: nativeHeaders }).then(response => response.json())
  hardware.radioAvailable = (await localStatus()).radio.available
  if (hardware.radioAvailable) {
    const documentId = new URL(page.url()).pathname.split('/').pop()
    await page.goto(url)
    await page.getByRole('button', { name: 'Bluetooth sharing', exact: true }).click()
    const bluetooth = page.getByRole('dialog', { name: 'Connect two Windows laptops' })
    await bluetooth.getByLabel('Document to share', { exact: true }).selectOption(documentId)
    await bluetooth.getByRole('button', { name: 'Open document to share', exact: true }).click()
    await expect(page.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'true')
    await expect(bluetooth).toBeVisible()
    await bluetooth.getByText('Invitation file and full code', { exact: true }).click()
    await expect(bluetooth.getByRole('button', { name: 'Save invitation file', exact: true })).toBeVisible()
    await expect(bluetooth.getByRole('button', { name: 'Save invitation file', exact: true })).toBeDisabled()
    hardware.hostEntryFromHomeVerified = true
    await bluetooth.getByRole('button', { name: 'Share this document', exact: true }).click()
    await expect(bluetooth.getByText('Waiting for the other laptop…', { exact: true })).toBeVisible()
    await expect.poll(async () => (await localStatus()).status.state).toBe('listening')
    hardware.ownerSharingStarted = true
    const pairingStatus = (await localStatus()).status
    if (!/^[0-9]{4}$/.test(pairingStatus.pairingCode) || Date.parse(pairingStatus.pairingExpiresAt) <= Date.now()) throw new Error('The native helper did not generate an active four-digit pairing code.')
    await expect(bluetooth.getByLabel('Pairing code', { exact: true })).toHaveValue(pairingStatus.pairingCode)
    await expect(bluetooth.getByRole('button', { name: 'Copy pairing code', exact: true })).toBeEnabled()
    hardware.shortPairingCodeGeneratedAndDisplayed = true
    // Use the actual Go-generated invitation and the exact browser download,
    // then load it through the receiving UI. This is file interoperability
    // evidence only; no second physical radio is simulated or claimed here.
    const invitationDownload = page.waitForEvent('download')
    await bluetooth.getByRole('button', { name: 'Save invitation file', exact: true }).click()
    const invitationFile = await invitationDownload
    expect(invitationFile.suggestedFilename()).toBe('localfirst-bluetooth-invitation.json')
    const invitationPath = await invitationFile.path()
    if (!invitationPath) throw new Error('Invitation download is missing.')
    const invitationEntry = JSON.parse(await readFile(invitationPath, 'utf8'))
    const ownerInvitation = (await localStatus()).status.invitation
    // Only compare the secret in memory; never write it to a report/log.
    if (invitationEntry.format !== 'localfirst-bluetooth-invitation' || invitationEntry.version !== 1 || invitationEntry.invitation !== ownerInvitation) throw new Error('Native invitation did not survive its exported JSON file.')
    await bluetooth.getByLabel('Choose Bluetooth invitation file', { exact: true }).setInputFiles(invitationPath)
    await expect.poll(() => bluetooth.getByLabel('Host invitation', { exact: true }).inputValue().then(value => value === ownerInvitation)).toBe(true)
    await expect(bluetooth.getByRole('alert')).toHaveCount(0)
    hardware.invitationExportImportVerified = true
    await bluetooth.getByRole('button', { name: 'Close', exact: true }).last().click()
    await expect(page.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'true')
    await expect(page.locator('.ProseMirror')).toContainText('opens and saves locally')
    await page.locator('.ProseMirror').click(); await page.keyboard.press('Control+End')
    await page.keyboard.insertText(' Native Bluetooth owner journal checked.')
    await page.keyboard.press('Control+s')
    await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Bluetooth', exact: true }).click()
    await bluetooth.getByRole('button', { name: 'Disconnect', exact: true }).click()
    await expect.poll(async () => (await localStatus()).status.state).toBe('idle')
    hardware.ownerSharingStopped = true
    await bluetooth.getByRole('button', { name: 'Close', exact: true }).last().click()
  }
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30000 }).toBe(true)
  await context.setOffline(true)
  await page.reload()
  await expect(page.locator('.ProseMirror')).toContainText('opens and saves locally')
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible()
  await page.screenshot({ path: 'Diwan-offline-foundation.png', fullPage: true })
  expect(forbidden).toEqual([])
  expect(errors).toEqual([])
  const e2e = JSON.parse(await readFile(resolve('diwan/web/test-results/offline-report.json'), 'utf8')).stats
  expect(e2e.unexpected).toBe(0); expect(e2e.skipped).toBe(0); expect(e2e.flaky).toBe(0)
  await writeFile('Diwan-offline-package-verification.json', JSON.stringify({ passed: true, verifiedAt: new Date().toISOString(), package: root, cacheVersion: metadata.cacheVersion, nativeVersion: metadata.nativeVersion, testServerUrl: url, launcherUrl: 'http://127.0.0.1:8765', assetCount: metadata.assets, offlineE2e: { passed: e2e.expected, failed: e2e.unexpected, skipped: e2e.skipped, flaky: e2e.flaky }, localNativeRequests: nativeRequests, hardware, externalOrCloudApiRequests: forbidden, browserErrors: errors, checks: ['Packaged executable starts without Node/Go on its PATH and serves the expected frontend/native versions', 'Fresh browser creates and saves a local document', 'When a radio is active, the real native host starts/stops document sharing and the editor retains its content', 'Fully offline reload preserves the committed document and correct save status', 'No cloud/document API or external requests; native-control traffic stays on loopback'] }, null, 2))
  console.log(JSON.stringify({ passed: true, package: root, url, hardware, externalOrCloudApiRequests: forbidden.length }, null, 2))
} finally { await browser.close(); app.kill() }
