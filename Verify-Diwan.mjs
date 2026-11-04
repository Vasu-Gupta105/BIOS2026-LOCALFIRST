import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { chromium, expect } from './diwan/web/node_modules/@playwright/test/index.mjs'

const baseURL = 'http://127.0.0.1:8080'
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' })
const page = await context.newPage()
const errors = []
const createdIds = []
const checks = []
page.on('pageerror', error => errors.push(error.message))
page.setDefaultTimeout(30000)

async function api(path, options) {
  const response = await fetch(`${baseURL}/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  })
  assert.ok(response.ok, `${options?.method || 'GET'} ${path}: ${response.status} ${await response.clone().text()}`)
  return response.status === 204 ? null : response.json()
}

try {
  const health = await fetch(`${baseURL}/healthz`).then(r => r.json())
  assert.equal(health.status, 'ok')
  checks.push('Server health')
  await page.goto(`${baseURL}/docs`)
  await page.getByRole('button', { name: 'New Document', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel(/Name/i).fill('Diwan setup verification')
  await dialog.getByRole('button', { name: /^Create$/ }).click()
  await expect(page).toHaveURL(/\/docs\/[^/]+$/)
  const docId = new URL(page.url()).pathname.split('/').pop()
  createdIds.push(docId)
  const editor = page.locator('.ProseMirror')
  await expect(editor).toBeVisible()
  await editor.click()
  const marker = `Verified local editing ${Date.now()}`
  await page.keyboard.type(marker)
  await expect(editor).toContainText(marker)
  await expect.poll(async () => JSON.stringify((await api(`/files/${docId}`)).content), { timeout: 20000 }).toContain(marker)
  await page.reload()
  await expect(page.locator('.ProseMirror')).toContainText(marker)
  checks.push('Create document through UI, edit, autosave, and reload from real backend')
  await page.screenshot({ path: 'Diwan-verification.png', fullPage: true })

  const surfaces = [
    { type: 'sheet', route: 'sheets', label: 'Sheet title', name: 'Setup sheet', content: [{ name: 'Sheet1', celldata: [{ r: 0, c: 0, v: { v: 'Working', m: 'Working' } }], config: {} }] },
    { type: 'slide', route: 'slides', label: 'Presentation title', name: 'Setup presentation', content: { themeId: 'obsidian', theme: 'black', transition: 'slide', slides: [{ id: 's1', title: 'Working', content: '<p>Working</p>', notes: '' }], masters: null, customTheme: null } },
    { type: 'whiteboard', route: 'whiteboards', label: 'Whiteboard title', name: 'Setup whiteboard', content: { elements: [], files: {} } },
  ]
  for (const surface of surfaces) {
    const file = await api('/files', { method: 'POST', body: JSON.stringify(surface) })
    createdIds.push(file.id)
    await page.goto(`${baseURL}/${surface.route}/${file.id}`)
    await expect(page.getByLabel(surface.label, { exact: true })).toHaveValue(surface.name)
    if (surface.type === 'sheet') await expect(page.locator('.fortune-sheet-overlay, [id^="luckysheet-sheettable"]').first()).toBeVisible()
    if (surface.type === 'whiteboard') await expect(page.locator('.excalidraw').first()).toBeVisible()
    checks.push(`Create, persist, and open ${surface.type}`)
  }
  await page.goto(`${baseURL}/pdf`)
  await expect(page.getByRole('heading', { name: 'PDFs', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open file', exact: true }).first()).toBeVisible()
  checks.push('PDF file list opens')
  assert.deepEqual(errors, [], `Browser errors: ${errors.join('; ')}`)
  writeFileSync('Diwan-verification.json', JSON.stringify({ passed: true, checks, browserErrors: errors }, null, 2))
  console.log(JSON.stringify({ passed: true, checks, browserErrors: errors }, null, 2))
} catch (error) {
  await page.screenshot({ path: 'Diwan-verification-failed.png', fullPage: true }).catch(() => {})
  writeFileSync('Diwan-verification.json', JSON.stringify({ passed: false, checks, browserErrors: errors, error: String(error) }, null, 2))
  throw error
} finally {
  await browser.close()
  for (const id of createdIds) await api(`/files/${id}`, { method: 'DELETE' }).catch(error => console.error(`Cleanup ${id}: ${error}`))
}
