import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, expect } from './diwan/web/node_modules/@playwright/test/index.mjs'
import { workspaceRoot, resolveArchivePath } from './Diwan-Archive-Paths.mjs'

const packages = join(workspaceRoot, 'diwan', 'offline-package')
const latest = (await readdir(packages)).filter(name => name.startsWith('windows-x64-')).sort().at(-1)
const root = join(packages, latest)
// Exercise the exact Bluetooth-capable release that was running before this update.
const old = resolveArchivePath(join(packages, 'windows-x64-1793488092292', 'web'))
const origin = 'http://127.0.0.1:8767'
const metadata = JSON.parse(await readFile(join(root, 'web', '.localfirst-offline.json'), 'utf8'))
let app
async function start(assets) {
  app = spawn(join(root, 'localfirst-offline.exe'), ['-addr', '127.0.0.1:8767', '-assets', assets], { cwd: root, windowsHide: true, stdio: 'ignore' })
  for (let attempt = 0; attempt < 40; attempt++) {
    if (app.exitCode !== null) throw new Error('Upgrade test server stopped.')
    try { if ((await fetch(`${origin}/healthz`)).ok) return } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Upgrade test server did not start.')
}
async function stop() {
  if (app && app.exitCode === null) { const closed = once(app, 'exit'); app.kill(); await closed }
}
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext({ serviceWorkers: 'allow' })
const errors = []
try {
  await start(old)
  const oldTab = await context.newPage()
  oldTab.on('pageerror', error => errors.push(error.message))
  await oldTab.goto(`${origin}/docs`)
  await expect(oldTab.getByRole('button', { name: 'Bluetooth sharing', exact: true })).toBeVisible()
  await oldTab.getByRole('button', { name: 'New Document', exact: true }).first().click()
  await oldTab.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Preserved through app update')
  await oldTab.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click()
  await expect(oldTab.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'true')
  await oldTab.locator('.ProseMirror').fill('Saved work from the old version must survive.')
  await oldTab.keyboard.press('Control+s')
  await expect(oldTab.getByText('Saved on this device', { exact: true })).toBeVisible()
  const documentPath = new URL(oldTab.url()).pathname
  await expect.poll(() => oldTab.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30000 }).toBe(true)
  const oldAsset = await oldTab.evaluate(() => [...document.scripts].find(script => script.src.includes('/assets/'))?.src)
  await stop()
  await start(join(root, 'web'))
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(origin)
  // Reproduce the user's exact failure with the current server and old cache.
  await expect(page.getByRole('button', { name: 'Bluetooth sharing', exact: true })).toBeVisible()
  expect(await page.evaluate(() => [...document.scripts].find(script => script.src.includes('/assets/'))?.src)).toBe(oldAsset)
  await page.goto(`${origin}/api/offline-launch`)
  await expect(page.getByRole('button', { name: 'Bluetooth sharing', exact: true })).toBeVisible({ timeout: 45000 })
  expect(await page.evaluate(() => new Promise(resolve => {
    const channel = new MessageChannel()
    channel.port1.onmessage = event => resolve(event.data.cacheVersion)
    navigator.serviceWorker.controller.postMessage({ type: 'GET_VERSION' }, [channel.port2])
  }))).toBe(metadata.cacheVersion)
  // Do not reload existing editors or strand their old lazy-loaded assets.
  await expect(oldTab.getByRole('button', { name: 'Bluetooth', exact: true })).toBeVisible()
  await expect(oldTab.locator('.ProseMirror')).toContainText('Saved work from the old version must survive.')
  expect(await page.evaluate(url => fetch(url).then(response => response.ok), oldAsset)).toBe(true)
  await page.getByRole('button', { name: 'Bluetooth sharing', exact: true }).click()
  await expect(page.getByRole('dialog').getByLabel('Document to share', { exact: true }).getByRole('option', { name: 'Preserved through app update', exact: true })).toHaveCount(1)
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).last().click()
  await page.screenshot({ path: 'Diwan-updated-home.png', fullPage: true })
  await page.goto(`${origin}${documentPath}?bluetooth=share`)
  const pairingDialog = page.getByRole('dialog', { name: 'Connect two Windows laptops' })
  await expect(pairingDialog.getByLabel('Pairing code', { exact: true })).toBeVisible()
  await pairingDialog.getByRole('button', { name: 'Close', exact: true }).last().click()
  await expect(page.locator('.ProseMirror')).toContainText('Saved work from the old version must survive.')
  await context.setOffline(true)
  await page.reload()
  await expect(page.locator('.ProseMirror')).toContainText('Saved work from the old version must survive.')
  expect(errors).toEqual([])
  const report = { passed: true, package: root, cacheVersion: metadata.cacheVersion, staleHomeReproduced: true, launcherActivatedNewVersionWithOldTabOpen: true, bluetoothVisible: true, existingEditorPreserved: true, previousAssetsReadable: true, savedDocumentPreserved: true, offlineReloadPassed: true, browserErrors: errors }
  await writeFile('Diwan-offline-upgrade-verification.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally { await browser.close(); await stop() }
