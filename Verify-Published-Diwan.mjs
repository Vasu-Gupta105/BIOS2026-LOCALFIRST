import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium, expect } from './diwan/web/node_modules/@playwright/test/index.mjs'

const base = 'https://diwan-phi.vercel.app'
const password = execFileSync('powershell.exe', ['-NoProfile', '-Command', "$s=Import-Clixml -LiteralPath $env:LOCALFIRST_CLOUD_SECRETS; [Console]::Write([System.Net.NetworkCredential]::new('', $s.Password).Password)"], {
  encoding: 'utf8', windowsHide: true,
  env: { ...process.env, LOCALFIRST_CLOUD_SECRETS: resolve(import.meta.dirname, 'Diwan-Cloud', 'secrets.clixml') },
}).trim()
const report = { url: base, checks: [], browserErrors: [] }
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--allow-loopback-in-peer-connection'] })
let a
let b
let id
async function login() {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  const page = await context.newPage()
  page.on('pageerror', error => report.browserErrors.push(error.message))
  await page.addInitScript(() => {
    window.__pcs = []
    const Native = window.RTCPeerConnection
    window.RTCPeerConnection = class extends Native { constructor(...args) { super(...args); window.__pcs.push(this) } }
  })
  await page.goto(base)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Docs', exact: true })).toBeVisible({ timeout: 30000 })
  return { context, page }
}
async function append(page, marker) {
  await page.locator('.ProseMirror').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(` ${marker}`)
}
try {
  assert.equal((await fetch(`${base}/healthz`)).status, 200)
  assert.equal((await fetch(`${base}/api/files`)).status, 401)
  assert.equal((await fetch(`${base}/api/local-files`)).status, 404)
  const register = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account_id: 'uninvited', password: 'A-strong-test-password-12345' }) })
  assert.equal(register.status, 403)
  report.checks.push('Public health, login protection, closed registration, and disabled server file browsing')
  console.log('PASS: Public endpoint and access protection')
  a = await login()
  const sourceFiles = await fetch('http://127.0.0.1:8080/api/files').then(response => response.json())
  const cloudFiles = await (await a.context.request.get(`${base}/api/files`)).json()
  const cloudIds = new Set(cloudFiles.map(file => file.id))
  for (const file of sourceFiles) assert.ok(cloudIds.has(file.id), 'An existing local document was not copied')
  report.copiedDocuments = sourceFiles.length
  report.checks.push('Existing documents copied with original IDs')
  await a.page.goto(`${base}/docs`)
  await a.page.getByRole('button', { name: 'New Document', exact: true }).click()
  const dialog = a.page.getByRole('dialog')
  await dialog.getByLabel(/Name/i).fill('Published deployment verification')
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(a.page).toHaveURL(/\/docs\/[^/]+$/, { timeout: 30000 })
  id = new URL(a.page.url()).pathname.split('/').pop()
  await expect(a.page.locator('.ProseMirror')).toBeVisible({ timeout: 30000 })
  const savedMarker = `public-save-${Date.now()}`
  await append(a.page, savedMarker)
  await expect.poll(async () => JSON.stringify((await (await a.context.request.get(`${base}/api/files/${id}`)).json()).content), { timeout: 30000 }).toContain(savedMarker)
  await a.page.reload()
  await expect(a.page.locator('.ProseMirror')).toContainText(savedMarker, { timeout: 30000 })
  report.checks.push('Browser login, document creation, autosave, and reload through Vercel and Cloudflare')
  console.log('PASS: Public login, save, and reload')
  await a.page.getByRole('button', { name: /Share.*with people/i }).click()
  await a.page.getByRole('button', { name: /Share via link.*P2P/i }).click()
  await expect(a.page.getByText('Editor link')).toBeVisible({ timeout: 30000 })
  const invite = await a.page.locator('input[readonly]').evaluateAll(elements => elements.map(element => element.value).find(value => value.includes('#vp2p=')))
  assert.ok(invite)
  await a.page.keyboard.press('Escape')
  b = await login()
  await b.page.goto(`${base}/docs/${id}#${invite.split('#')[1]}`)
  await expect(b.page.locator('.ProseMirror')).toBeVisible({ timeout: 30000 })
  const markerA = `live-A-${Date.now()}`
  const markerB = `live-B-${Date.now()}`
  await append(a.page, markerA)
  await expect(b.page.locator('.ProseMirror')).toContainText(markerA, { timeout: 60000 })
  await append(b.page, markerB)
  await expect(a.page.locator('.ProseMirror')).toContainText(markerB, { timeout: 60000 })
  report.checks.push('Two independent browsers exchange real-time edits in both directions through the published app')
  report.connectedPeerConnections = await a.page.evaluate(() => (window.__pcs || []).filter(pc => pc.connectionState === 'connected').length)
  assert.ok(report.connectedPeerConnections > 0)
  assert.deepEqual(report.browserErrors, [])
  report.passed = true
  console.log('PASS: Public real-time collaboration')
} catch (error) {
  report.passed = false
  report.error = String(error)
  throw error
} finally {
  if (b) await b.context.close()
  if (a && id) {
    const removed = await a.context.request.delete(`${base}/api/files/${id}`).catch(() => null)
    report.testDocumentRemoved = removed?.ok() || false
  }
  if (a) await a.context.close()
  await browser.close()
  await writeFile('Diwan-published-verification.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
