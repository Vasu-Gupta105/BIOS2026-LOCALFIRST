import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { resolve, join } from 'node:path'
import net from 'node:net'
import { chromium, expect } from './diwan/web/node_modules/@playwright/test/index.mjs'

const cwd = await mkdtemp(resolve('.tools/cloud-verification-'))
await mkdir(join(cwd, 'data'))
await mkdir(join(cwd, 'uploads'))
const listener = net.createServer()
listener.listen(0, '127.0.0.1')
await once(listener, 'listening')
const port = listener.address().port
await new Promise(resolve => listener.close(resolve))
const base = `http://127.0.0.1:${port}`
const password = randomBytes(24).toString('hex')
const env = { ...process.env, DIWAN_JWT_SECRET: randomBytes(32).toString('hex'), DEPLOY_MODE: 'standalone', IDENTITY_URL: '', VULOS_CP_BASE_URL: '', GIN_MODE: 'release' }
await writeFile(join(cwd, 'config.yaml'), JSON.stringify({ server: { addr: `127.0.0.1:${port}`, data_dir: join(cwd, 'data'), uploads_dir: join(cwd, 'uploads') }, auth: { enabled: true, password }, storage: { type: 'local' } }))
const binary = resolve('.tools/diwan-cloud-check.exe')
const bootstrap = spawnSync(binary, ['migrate-credential', '-admin', 'self', '-db', join(cwd, 'data', 'userauth.db')], { cwd, env, windowsHide: true, encoding: 'utf8' })
assert.equal(bootstrap.status, 0, bootstrap.stderr)

let server
let browser
let stderr = ''
async function start() {
  server = spawn(binary, [], { cwd, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  server.stderr.on('data', chunk => { stderr += chunk.toString() })
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null) throw new Error(`Server exited: ${stderr}`)
    try { if ((await fetch(`${base}/healthz`)).ok) return } catch {}
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Server readiness timed out: ${stderr}`)
}
async function stop() {
  if (server && server.exitCode === null) { const closed = once(server, 'close'); server.kill(); await closed }
}
try {
  await start()
  const registration = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account_id: 'stranger', password: `Some-strong-password-${Date.now()}` }) })
  assert.equal(registration.status, 403, 'Anonymous registration must be closed after bootstrap')
  const protectedFiles = await fetch(`${base}/api/files`)
  assert.equal(protectedFiles.status, 401)
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage({ serviceWorkers: 'block' })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(base)
  await page.getByLabel('Password', { exact: true }).fill(password)
  const loginRequest = page.waitForRequest(request => request.url().endsWith('/api/auth/login') && request.method() === 'POST')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  assert.equal((await loginRequest).postDataJSON().account_id, 'self')
  await expect(page.getByRole('link', { name: 'Docs', exact: true })).toBeVisible()
  await page.goto(`${base}/docs`)
  await page.getByRole('button', { name: 'New Document', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel(/Name/i).fill('Cloud persistence verification')
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page).toHaveURL(/\/docs\/[^/]+$/)
  const editor = page.locator('.ProseMirror')
  await expect(editor).toBeVisible()
  await editor.click()
  const marker = `Saved through authenticated cloud setup ${Date.now()}`
  const saved = page.waitForResponse(response => response.url().includes('/api/files/') && response.request().method() === 'PUT' && response.status() === 200)
  await page.keyboard.type(marker)
  await saved
  await stop()
  await start()
  await page.reload()
  await expect(page.locator('.ProseMirror')).toContainText(marker)
  assert.deepEqual(errors, [])
  const result = { passed: true, checks: ['Owner bootstrap', 'Anonymous registration rejected', 'Anonymous file reads rejected', 'Cloud password login supplies owner account', 'Document creation and autosave', 'Session and document survive server restart'], browserErrors: errors }
  await writeFile('Diwan-cloud-verification.json', JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
} finally {
  if (browser) await browser.close()
  await stop()
}
