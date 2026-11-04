import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { resolve, join } from 'node:path'
import net from 'node:net'
import { chromium, expect } from './diwan/web/node_modules/@playwright/test/index.mjs'

const report = { tested: 'installed Diwan binary, isolated real Go server, separate Chrome contexts, no mocked API responses', updateLogEnabled: false, checks: [], browserErrors: [] }
const recoveryOnly = process.argv.includes('--recovery-only')
const offlineOnly = process.argv.includes('--offline-only') || recoveryOnly
if (offlineOnly) {
  const previous = JSON.parse(await readFile('Diwan-offline-realtime-report.json', 'utf8'))
  report.checks = previous.checks
}
const root = await mkdtemp(resolve('.tools/offline-realtime-'))
await mkdir(join(root, 'data'))
await mkdir(join(root, 'uploads'))
const listener = net.createServer()
listener.listen(0, '127.0.0.1')
await once(listener, 'listening')
const port = listener.address().port
await new Promise(resolve => listener.close(resolve))
const base = `http://127.0.0.1:${port}`
await writeFile(join(root, 'config.yaml'), JSON.stringify({ server: { addr: `127.0.0.1:${port}`, data_dir: join(root, 'data'), uploads_dir: join(root, 'uploads') }, auth: { enabled: false }, storage: { type: 'local' }, collab: { builtin_rendezvous: true } }))
const server = spawn(resolve('diwan/diwan.exe'), [], { cwd: root, env: { ...process.env, GIN_MODE: 'release', DEPLOY_MODE: 'standalone', IDENTITY_URL: '', VULOS_CP_BASE_URL: '' }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
let serverErrors = ''
server.stderr.on('data', bytes => { serverErrors += bytes.toString() })
let browser
const contexts = []
const ids = []
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function api(path, options) {
  const response = await fetch(`${base}/api${path}`, { ...options, headers: { 'Content-Type': 'application/json' } })
  assert.ok(response.ok, `${path}: ${response.status}`)
  return response.json()
}
async function createDoc(name) {
  const doc = await api('/files', { method: 'POST', body: JSON.stringify({ name, type: 'doc', content: '<p>Offline test document.</p>' }) })
  ids.push(doc.id)
  return doc.id
}
async function context() {
  const ctx = await browser.newContext({ serviceWorkers: 'allow' })
  contexts.push(ctx)
  const page = await ctx.newPage()
  page.on('pageerror', error => report.browserErrors.push(error.message))
  page.setDefaultTimeout(20000)
  await page.addInitScript(() => {
    window.__pcs = []
    const Native = window.RTCPeerConnection
    window.RTCPeerConnection = class extends Native {
      constructor(...args) { super(...args); window.__pcs.push(this) }
    }
  })
  return { ctx, page }
}
async function append(page, text) {
  const editor = page.locator('.ProseMirror')
  await expect(editor).toBeVisible()
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(` ${text}`)
  await expect(editor).toContainText(text)
}
async function draft(page, id) {
  return page.evaluate(id => new Promise(resolve => {
    const open = indexedDB.open('diwan-drafts')
    open.onerror = () => resolve(null)
    open.onsuccess = () => {
      const db = open.result
      if (!db.objectStoreNames.contains('drafts')) return resolve(null)
      const get = db.transaction('drafts', 'readonly').objectStore('drafts').get(id)
      get.onsuccess = () => resolve(get.result || null)
      get.onerror = () => resolve(null)
    }
  }), id)
}
async function pairStats(page) {
  return page.evaluate(async () => {
    const pairs = []
    for (const pc of window.__pcs || []) {
      if (pc.connectionState !== 'connected') continue
      const stats = await pc.getStats()
      stats.forEach(item => {
        if (item.type === 'candidate-pair' && item.state === 'succeeded' && item.nominated) {
          pairs.push({ state: pc.connectionState, local: stats.get(item.localCandidateId)?.candidateType, remote: stats.get(item.remoteCandidateId)?.candidateType })
        }
      })
    }
    return pairs
  })
}
async function record(name, fn) {
  console.log(`Checking: ${name}`)
  let result
  try { const details = await fn(); result = { name, passed: true, ...details }; console.log(`PASS: ${name}`) }
  catch (error) { result = { name, passed: false, error: String(error).slice(0,1800) }; console.log(`FAIL: ${name}: ${String(error).slice(0,350)}`) }
  const existing = report.checks.findIndex(check => check.name === name)
  if (existing >= 0) report.checks[existing] = result
  else report.checks.push(result)
  await writeFile('Diwan-offline-realtime-report.json', JSON.stringify(report, null, 2))
}

try {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (server.exitCode !== null) throw new Error(serverErrors)
    try { if ((await fetch(`${base}/healthz`)).ok) break } catch {}
    await pause(250)
  }
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--allow-loopback-in-peer-connection'] })
  if (!offlineOnly) {
  const sharedId = await createDoc('Realtime offline verification')
  const a = await context()
  const b = await context()
  let invite
  const onlineA = `online-A-${Date.now()}`
  const onlineB = `online-B-${Date.now()}`
  await record('Live edits sync in both directions over real WebRTC', async () => {
    await a.page.goto(`${base}/docs/${sharedId}`)
    await expect(a.page.locator('.ProseMirror')).toBeVisible()
    await a.page.getByRole('button', { name: /Share.*with people/i }).click()
    await a.page.getByRole('button', { name: /Share via link.*P2P/i }).click()
    await expect(a.page.getByText('Editor link')).toBeVisible({ timeout: 30000 })
    invite = await a.page.locator('input[readonly]').evaluateAll(els => els.map(el => el.value).find(value => value.includes('#vp2p=')))
    assert.ok(invite?.includes('#vp2p='))
    await a.page.keyboard.press('Escape')
    await b.page.goto(`${base}/docs/${sharedId}#${invite.split('#')[1]}`)
    await expect(b.page.locator('.ProseMirror')).toBeVisible()
    await expect.poll(async () => [...await pairStats(a.page), ...await pairStats(b.page)].length, { timeout: 60000 }).toBeGreaterThan(0)
    const startA = Date.now()
    await append(a.page, onlineA)
    await expect(b.page.locator('.ProseMirror')).toContainText(onlineA, { timeout: 30000 })
    const latencyA = Date.now() - startA
    const startB = Date.now()
    await append(b.page, onlineB)
    await expect(a.page.locator('.ProseMirror')).toContainText(onlineB, { timeout: 30000 })
    return { millisecondsIncludingTyping: { AtoB: latencyA, BtoA: Date.now() - startB }, candidatePairs: await pairStats(a.page) }
  })

  await record('Established P2P collaboration continues when HTTP is offline', async () => {
    const marker = `no-HTTP-${Date.now()}`
    await a.ctx.setOffline(true)
    await b.ctx.setOffline(true)
    await append(a.page, marker)
    await expect(b.page.locator('.ProseMirror')).toContainText(marker, { timeout: 20000 })
    await expect.poll(async () => JSON.stringify(await draft(a.page, sharedId)), { timeout: 10000 }).toContain(marker)
    const saved = await api(`/files/${sharedId}`)
    assert.ok(!JSON.stringify(saved.content).includes(marker), 'Server should not have received an offline save')
    return { localDraftSaved: true, serverCopyUnchangedDuringOutage: true, candidatePairs: await pairStats(a.page) }
  })
  await a.ctx.setOffline(false)
  await b.ctx.setOffline(false)

  await record('Disconnected concurrent edits merge automatically after reconnection', async () => {
    await b.ctx.setOffline(true)
    await b.page.evaluate(() => { for (const pc of window.__pcs || []) pc.close() })
    await a.page.evaluate(() => { for (const pc of window.__pcs || []) pc.close() })
    const markerA = `partition-A-${Date.now()}`
    const markerB = `partition-B-${Date.now()}`
    await append(a.page, markerA)
    await append(b.page, markerB)
    await expect.poll(async () => JSON.stringify(await draft(b.page, sharedId)), { timeout: 10000 }).toContain(markerB)
    assert.ok(!(await a.page.locator('.ProseMirror').innerText()).includes(markerB), 'Offline peer should not transmit its edit')
    await b.ctx.setOffline(false)
    const reconnectedAt = Date.now()
    await expect(a.page.locator('.ProseMirror')).toContainText(markerB, { timeout: 75000 })
    await expect(b.page.locator('.ProseMirror')).toContainText(markerA, { timeout: 75000 })
    const textA = await a.page.locator('.ProseMirror').innerText()
    const textB = await b.page.locator('.ProseMirror').innerText()
    assert.equal(textA, textB)
    await a.page.keyboard.press('Control+s')
    await expect.poll(async () => JSON.stringify((await api(`/files/${sharedId}`)).content), { timeout: 15000 }).toContain(markerB)
    return { reconnectedAndMergedInMs: Date.now() - reconnectedAt, bothOfflineEditsPreserved: true }
  })
  await a.ctx.close()
  await b.ctx.close()
  }

  const offlineId = await createDoc('Offline draft and reload verification')
  const c = await context()
  let offlineMarker = `offline-local-draft-${Date.now()}`
  await record('Offline editing keeps an unsaved draft in IndexedDB', async () => {
    await c.page.goto(`${base}/docs/${offlineId}`)
    await expect(c.page.locator('.ProseMirror')).toBeVisible()
    await expect.poll(() => c.page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 20000 }).toBe(true)
    await c.page.reload()
    await expect(c.page.locator('.ProseMirror')).toBeVisible()
    await c.ctx.setOffline(true)
    await append(c.page, offlineMarker)
    await expect.poll(async () => JSON.stringify(await draft(c.page, offlineId)), { timeout: 15000 }).toContain(offlineMarker)
    assert.ok(!JSON.stringify((await api(`/files/${offlineId}`)).content).includes(offlineMarker))
    return { localDraftSaved: true, serverNotFalselyReportedAsUpdated: true }
  })
  if (!recoveryOnly) await record('Reconnection saves an offline draft automatically after retries expire', async () => {
    // Saves retry after 4, 8 and 12 seconds. Wait past all three retries
    // before reconnecting, so a delayed retry cannot give a false pass.
    await pause(30000)
    await c.ctx.setOffline(false)
    await expect.poll(async () => JSON.stringify((await api(`/files/${offlineId}`)).content), { timeout: 10000 }).toContain(offlineMarker)
    return { automaticSaveWithoutAnotherKeystroke: true }
  })
  // Use a fresh unsaved edit for reload/recovery. A successful earlier save
  // correctly clears its draft and cannot serve as a recovery test fixture.
  await c.ctx.setOffline(true)
  offlineMarker = `offline-reload-draft-${Date.now()}`
  await append(c.page, offlineMarker)
  await expect.poll(async () => JSON.stringify(await draft(c.page, offlineId)), { timeout: 15000 }).toContain(offlineMarker)
  await record('A previously opened document can reopen while fully offline', async () => {
    await c.ctx.setOffline(true)
    await c.page.reload({ waitUntil: 'domcontentloaded' })
    report.offlineReloadLocation = { url: c.page.url(), origin: await c.page.evaluate(() => location.origin) }
    await expect(c.page.locator('.ProseMirror')).toContainText(offlineMarker, { timeout: 10000 })
    return { offlineDocumentReopened: true }
  })
  await record('Unsaved draft survives reload and can be restored after reconnection', async () => {
    await c.ctx.setOffline(false)
    await c.page.goto(`${base}/docs/${offlineId}`)
    await expect(c.page.locator('.ProseMirror')).toBeVisible({ timeout: 15000 })
    const recovered = await draft(c.page, offlineId)
    report.draftRecovery = { origin: await c.page.evaluate(() => location.origin), hasDraft: !!recovered, containsOfflineEdit: JSON.stringify(recovered).includes(offlineMarker) }
    assert.ok(JSON.stringify(recovered).includes(offlineMarker))
    await expect(c.page.getByText('Unsaved changes from a previous session were found.')).toBeVisible({ timeout: 15000 })
    await c.page.getByRole('button', { name: 'Restore', exact: true }).click()
    await expect(c.page.locator('.ProseMirror')).toContainText(offlineMarker)
    await c.page.keyboard.press('Control+s')
    await expect.poll(async () => JSON.stringify((await api(`/files/${offlineId}`)).content), { timeout: 15000 }).toContain(offlineMarker)
    return { recoveredFromIndexedDB: true, savedToServer: true }
  })
} finally {
  for (const ctx of contexts) await ctx.close().catch(() => {})
  if (browser) await browser.close()
  for (const id of ids) await api(`/files/${id}`, { method: 'DELETE' }).catch(() => {})
  if (server.exitCode === null) { const closed = once(server, 'close'); server.kill(); await closed }
  report.passed = report.checks.every(check => check.passed)
  await writeFile('Diwan-offline-realtime-report.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
