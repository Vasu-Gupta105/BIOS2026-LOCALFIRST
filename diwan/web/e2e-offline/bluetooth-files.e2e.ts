import { test, expect, type Page, type BrowserContext } from '@playwright/test'
import { PDFDocument } from 'pdf-lib'
import { randomBytes } from 'node:crypto'

test.setTimeout(90000)
const id = '97a562f0-0751-4ee1-8634-78b80914077d'
const routes = { sheet: 'sheets', slide: 'slides', whiteboard: 'whiteboards', pdf: 'pdf' } as const

async function seed(page: Page, type: string, content: unknown, fileId = id) {
  await page.evaluate(async ({ type, content, fileId }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('diwan-local-workspace', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite')
      tx.objectStore('files').put({ id: fileId, name: `Shared ${type}`, type, content, rev: 1, owner: 'self', parent_id: '', starred: false, trashed: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  }, { type, content, fileId })
}
async function saved(page: Page, fileId = id) {
  return page.evaluate(fileId => new Promise<{ name: string; type: string; content: any }>((resolve, reject) => {
    const request = indexedDB.open('diwan-local-workspace')
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction('files', 'readonly')
      const read = tx.objectStore('files').get(fileId)
      read.onsuccess = () => { resolve(read.result); db.close() }
      read.onerror = () => reject(read.error)
    }
  }), fileId)
}

/** Only the native radio boundary is stubbed. Editors, Yjs and IndexedDB are real. */
async function bridge(contexts: BrowserContext[]) {
  const states: any[] = contexts.map(() => ({ state: 'idle' }))
  const queues: Array<Array<{ seq: number; session: string; message: unknown }>> = contexts.map(() => [])
  const cursors = contexts.map(() => 0)
  await Promise.all(contexts.map((context, index) => context.route('**/_nearby/**', async route => {
    const url = new URL(route.request().url())
    const path = url.pathname.split('/').pop()
    let body: unknown = {}
    if (path === 'bootstrap') body = { token: 'test-token', version: 1, transport: 'windows-bluetooth-rfcomm' }
    else if (path === 'status') body = { status: states[index], radio: { available: true, name: 'Test radio' } }
    else if (path === 'devices') body = [{ address: '001122334455', name: 'Paired test laptop' }]
    else if (path === 'host') {
      const { document } = route.request().postDataJSON()
      states[0] = { state: contexts.length > 1 ? 'connected' : 'listening', role: 'host', session: 'file-test-session', document, invitation: 'DBT1-' + 'A'.repeat(86) }
      if (contexts.length > 1) states[1] = { state: 'connected', role: 'join', session: 'file-test-session', document }
      body = states[index]
    } else if (path === 'send') {
      const peer = index === 0 ? 1 : 0
      queues[peer].push({ seq: ++cursors[peer], session: 'file-test-session', message: route.request().postDataJSON().message })
      body = states[index]
    } else if (path === 'events') {
      await new Promise(resolve => setTimeout(resolve, 40))
      body = { status: states[index], cursor: cursors[index], events: queues[index].filter(event => event.seq > Number(url.searchParams.get('after') || 0)), reset: false }
    } else if (path === 'stop') {
      states[index] = { state: 'idle' }; body = states[index]
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {})
  })))
}

for (const type of Object.keys(routes) as Array<keyof typeof routes>) {
  test(`${type}: opens in the correct editor, shares live changes, and reloads the received file`, async ({ browser, baseURL }) => {
    if (!baseURL) throw new Error('The offline test server URL is required.')
    const contexts = await Promise.all([browser.newContext({ baseURL }), browser.newContext({ baseURL })])
    try {
      await bridge(contexts)
      const [host, peer] = await Promise.all(contexts.map(context => context.newPage()))
      const errors: string[] = []
      for (const page of [host, peer]) page.on('pageerror', error => errors.push(error.message))
      await Promise.all([host.goto('/'), peer.goto('/')])
      await expect(host.getByText('Local workspace · Internet access disabled', { exact: true })).toBeVisible()
      let content: unknown
      if (type === 'sheet') content = [{ id: 'sheet_1', name: 'Sheet1', celldata: [{ r: 0, c: 0, v: { v: 'Keep original', m: 'Keep original', ct: { fa: 'General', t: 's' } } }], config: {}, row: 100, column: 26, order: 0, status: 1 }]
      if (type === 'slide') content = { themeId: 'obsidian', theme: 'black', transition: 'slide', slides: [{ id: 'slide-a', title: 'Keep original', content: '<p>Original body</p>', notes: '', objects: [] }] }
      if (type === 'whiteboard') content = { type: 'excalidraw', elements: [], files: {} }
      if (type === 'pdf') {
        const pdf = await PDFDocument.create(); pdf.addPage([320, 440])
        content = { format: 'localfirst-pdf-v1', data: Buffer.from(await pdf.save()).toString('base64'), annotations: {}, pageOrder: [1], pageRotations: {}, drawPaths: {}, blankPages: {} }
      }
      await seed(host, type, content)
      await host.goto(`/${routes[type]}/${id}?bluetooth=share`)
      const panel = host.getByRole('dialog', { name: 'Connect two Windows laptops' })
      await expect(panel).toBeVisible()
      await panel.getByRole('button', { name: 'Share this document', exact: true }).click()
      await expect(panel.getByText('Authenticated Bluetooth link connected.', { exact: true })).toBeVisible()
      await test.step('Close the host sharing dialog', async () => {
        await panel.getByRole('button', { name: 'Close', exact: true }).last().click()
        await expect(panel).toHaveCount(0)
      })
      await peer.getByRole('button', { name: 'Bluetooth connected', exact: true }).click()
      await peer.getByRole('button', { name: 'Open shared file', exact: true }).click()
      await expect(peer).toHaveURL(new RegExp(`/${routes[type]}/${id}$`))
      await expect.poll(async () => (await saved(peer)).content, { timeout: 25000 }).not.toBeNull()
      expect((await saved(peer)).type).toBe(type)
      if (type === 'sheet') {
        await expect(peer.getByLabel('Sheet title')).toHaveValue('Shared sheet')
        const overlay = host.locator('.fortune-sheet-overlay').first()
        await expect(overlay).toBeVisible()
        await overlay.click({ position: { x: 140, y: 40 } })
        const formula = host.locator('.fortune-fx-input')
        await formula.click(); await formula.pressSequentially('Live spreadsheet data'); await formula.press('Enter')
        await expect.poll(async () => JSON.stringify((await saved(peer)).content)).toContain('Live spreadsheet data')
        await peer.getByLabel('Sheet title').fill('Renamed from peer')
        await expect(host.getByLabel('Sheet title')).toHaveValue('Renamed from peer')
        expect(JSON.stringify((await saved(peer)).content)).toContain('Keep original')
      } else if (type === 'slide') {
        await expect(peer.getByLabel('Slide title', { exact: true })).toHaveValue('Keep original')
        await host.getByLabel('Slide title', { exact: true }).fill('Live slide content')
        await expect(peer.getByLabel('Slide title', { exact: true })).toHaveValue('Live slide content')
        await peer.getByLabel('Speaker notes', { exact: true }).fill('Notes from peer')
        await expect(host.getByLabel('Speaker notes', { exact: true })).toHaveValue('Notes from peer')
      } else if (type === 'whiteboard') {
        const canvas = peer.locator('.excalidraw__canvas.interactive')
        await expect(canvas).toBeVisible()
        await peer.locator('label').filter({ has: peer.getByTestId('toolbar-rectangle') }).click()
        const box = (await canvas.boundingBox())!
        await peer.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4); await peer.mouse.down()
        await peer.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.65, { steps: 8 }); await peer.mouse.up()
        await expect.poll(async () => (await saved(host)).content.elements.filter((element: { type: string }) => element.type === 'rectangle').length).toBe(1)
        await host.getByLabel('Whiteboard title').fill('Renamed from host')
        await expect(peer.getByLabel('Whiteboard title')).toHaveValue('Renamed from host')
      } else {
        await expect(peer.getByLabel('PDF filename')).toHaveValue('Shared pdf')
        await expect(peer.locator('.lf-editor-pdf canvas').first()).toBeVisible()
        await peer.getByRole('button', { name: 'Rotate 90°', exact: true }).first().click()
        await expect.poll(async () => (await saved(host)).content.pageRotations['1']).toBe(90)
        expect((await saved(peer)).content.data).toBe((content as { data: string }).data)
      }
      await peer.reload()
      await expect.poll(async () => (await saved(peer)).content).not.toBeNull()
      await expect(peer.getByText('Waiting for the shared file over Bluetooth. Keep the hosting laptop connected.', { exact: true })).toHaveCount(0)
      expect(errors).toEqual([])
    } finally {
      await Promise.all(contexts.map(async context => {
        await context.unrouteAll({ behavior: 'ignoreErrors' })
        await context.close()
      }))
    }
  })
}

test('the file picker includes all workspace types and the dialog fits above editor scrollbars', async ({ page }) => {
  await bridge([page.context()])
  await page.goto('/')
  await expect(page.getByText('Local workspace · Internet access disabled', { exact: true })).toBeVisible()
  for (const [index, type] of ['doc', 'sheet', 'slide', 'whiteboard', 'pdf'].entries()) await seed(page, type, null, `97a562f0-0751-4ee1-8634-${String(index).padStart(12, '0')}`)
  await page.reload()
  await page.getByRole('button', { name: 'Bluetooth sharing', exact: true }).click()
  const panel = page.getByRole('dialog', { name: 'Connect two Windows laptops' })
  await expect(panel.getByLabel('File to share').locator('option')).toHaveCount(6)
  await expect(panel.getByLabel('Choose file to share')).toHaveAttribute('accept', /\.xlsx.*\.pptx.*\.pdf.*\.excalidraw/)
  for (const size of [{ width: 1440, height: 900 }, { width: 640, height: 480 }, { width: 375, height: 667 }]) {
    await page.setViewportSize(size)
    const geometry = await panel.evaluate(dialog => {
      const rect = dialog.getBoundingClientRect()
      const body = dialog.children[1] as HTMLElement
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: body.clientWidth, scrollWidth: body.scrollWidth }
    })
    expect(geometry.left).toBeGreaterThanOrEqual(0); expect(geometry.right).toBeLessThanOrEqual(size.width)
    expect(geometry.top).toBeGreaterThanOrEqual(0); expect(geometry.bottom).toBeLessThanOrEqual(size.height)
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width)
    await expect(panel.getByRole('button', { name: 'Close', exact: true }).last()).toBeInViewport()
  }
})

test('a PDF imported through sharing is saved intact, and opening another PDF preserves the shared original', async ({ page }) => {
  await bridge([page.context()])
  await page.goto('/')
  await page.getByRole('button', { name: 'Bluetooth sharing', exact: true }).click()
  const panel = page.getByRole('dialog', { name: 'Connect two Windows laptops' })
  const pdf = await PDFDocument.create(); pdf.addPage([320, 440])
  await pdf.attach(randomBytes(160000), 'sample.bin')
  const source = Buffer.from(await pdf.save())
  expect(source.length).toBeGreaterThan(128000)
  await panel.getByLabel('Choose file to share').setInputFiles({ name: 'Large import.pdf', mimeType: 'application/pdf', buffer: source })
  await expect(page).toHaveURL(/\/pdf\/[^/?]+$/)
  const originalId = new URL(page.url()).pathname.split('/').pop()!
  await expect(page.getByLabel('PDF filename')).toHaveValue('Large import.pdf')
  await expect.poll(async () => (await saved(page, originalId)).content.data).toBe(source.toString('base64'))
  await page.getByRole('button', { name: 'Bluetooth', exact: true }).click()
  await panel.getByRole('button', { name: 'Share this document', exact: true }).click()
  await expect(panel.getByText('Waiting for the other laptop…', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'Close', exact: true }).last().click()
  const replacement = await PDFDocument.create(); replacement.addPage([200, 300])
  const replacementBytes = Buffer.from(await replacement.save())
  const choosing = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click()
  await (await choosing).setFiles({ name: 'Second PDF.pdf', mimeType: 'application/pdf', buffer: replacementBytes })
  await expect(page.getByLabel('PDF filename')).toHaveValue('Second PDF.pdf')
  await expect.poll(() => new URL(page.url()).pathname.split('/').pop()).not.toBe(originalId)
  expect((await saved(page, originalId)).content.data).toBe(source.toString('base64'))
  const newId = new URL(page.url()).pathname.split('/').pop()!
  await page.reload()
  await expect(page.getByLabel('PDF filename')).toHaveValue('Second PDF.pdf')
  expect((await saved(page, newId)).content.data).toBe(replacementBytes.toString('base64'))
})
