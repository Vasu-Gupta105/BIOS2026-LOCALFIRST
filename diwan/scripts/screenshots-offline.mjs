#!/usr/bin/env node
// Capture the real offline build with fabricated files in a fresh browser profile.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'web/package.json'))
const { chromium, expect } = require('@playwright/test')
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib')
const output = join(root, 'docs/screenshots')
const port = 47525
const base = `http://127.0.0.1:${port}`
const ids = {
  doc: '04f4519e-d268-4a36-a23c-d909cb7361de',
  notes: '9ad2d8d9-2213-4e6f-92fb-2b772d3322bb',
  sheet: 'da46a921-4105-4c83-af71-3c1048d5e325',
  slides: 'b0606619-6aca-47ec-973b-62412d511efd',
  board: '79a9b150-214a-4cf7-ad77-47a8e15ee00b',
}
const text = value => ({ type: 'text', text: value })
const paragraph = value => ({ type: 'paragraph', content: [text(value)] })
const heading = (value, level = 2) => ({ type: 'heading', attrs: { level }, content: [text(value)] })
const now = new Date().toISOString()
const file = (id, name, type, content, starred = false) => ({
  id, name, type, content, starred, rev: 1, owner: 'self', parent_id: '',
  trashed: false, created_at: now, updated_at: now,
})
const rows = [
  ['Month', 'Revenue', 'Expenses', 'Profit', 'Margin'],
  ['January', 42000, 26000, 16000, '38.1%'],
  ['February', 48500, 28500, 20000, '41.2%'],
  ['March', 56000, 32000, 24000, '42.9%'],
  ['April', 62500, 35000, 27500, '44.0%'],
  ['May', 71000, 39500, 31500, '44.4%'],
  ['June', 79000, 42900, 36100, '45.7%'],
  ['TOTAL', 359000, 203900, 155100, '43.2%'],
]
const cells = rows.flatMap((row, r) => row.map((value, c) => ({ r, c, v: {
  v: value, m: String(value), ct: { fa: 'General', t: typeof value === 'number' ? 'n' : 'g' },
  ...(r === 0 ? { bg: '#2563eb', fc: '#ffffff', bl: 1 } : {}),
  ...(r === 7 ? { bg: '#dbeafe', fc: '#172554', bl: 1 } : {}),
  ...(r > 0 && r < 7 && c === 3 ? { f: `=B${r + 1}-C${r + 1}` } : {}),
  ...(r === 7 && c > 0 && c < 4 ? { f: `=SUM(${String.fromCharCode(65 + c)}2:${String.fromCharCode(65 + c)}7)` } : {}),
} })))
const slide = (id, title, content) => ({ id, title, content, master: 'content', notes: '', background: '', transition: 'none' })
const element = (id, type, x, y, width, height, extra = {}) => ({
  id, type, x, y, width, height, angle: 0, strokeColor: '#1e3a5f', backgroundColor: 'transparent',
  fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100,
  groupIds: [], frameId: null, roundness: null, seed: 42, version: 1, versionNonce: 42,
  isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
  ...extra,
})
const label = (id, x, y, value, width = 210) => element(id, 'text', x, y, width, 25, {
  text: value, originalText: value, fontSize: 20, fontFamily: 1, textAlign: 'center',
  verticalAlign: 'middle', containerId: null, lineHeight: 1.25, autoResize: true,
})
const files = [
  file(ids.doc, 'LocalFirst project overview', 'doc', { type: 'doc', content: [
    heading('Your ideas. Your device.', 1),
    paragraph('LocalFirst brings documents, spreadsheets, presentations, whiteboards and PDFs together in one workspace. Start with an idea and keep your work close.'),
    heading('A workspace that stays with you'),
    paragraph('The offline app stores files in this browser on your computer. Keep writing without an internet connection, then download a backup whenever you need one.'),
    heading('One place for every kind of work'),
    { type: 'bulletList', content: [
      'Write and format documents with headings, tables and images.',
      'Turn numbers into a plan with spreadsheets and formulas.',
      'Build a presentation, sketch an idea or annotate a PDF.',
    ].map(value => ({ type: 'listItem', content: [paragraph(value)] })) },
    heading('Make room for good work'),
    paragraph('Search your files, keep favorites nearby and choose a light or dark workspace. A clear interface keeps the focus on what you are creating.'),
  ] }, true),
  file(ids.notes, 'Getting started notes', 'doc', { type: 'doc', content: [
    heading('A fresh start', 1), paragraph('Create a file, give it a name and make it your own. Your offline files stay on this device.'),
  ] }),
  file(ids.sheet, 'Revenue tracker H1 2026', 'sheet', [{
    id: 'revenue', name: 'Revenue', celldata: cells, row: 40, column: 16,
    config: { columnlen: { 0: 140, 1: 140, 2: 140, 3: 140, 4: 120 } },
  }], true),
  file(ids.slides, 'LocalFirst product overview', 'slide', {
    themeId: 'obsidian', theme: 'black', transition: 'none', masters: null, customTheme: null,
    slides: [
      slide('intro', 'Your ideas. Your device.', '<p>LocalFirst</p><p>Documents, spreadsheets, slides, whiteboards and PDFs.</p><p>One workspace. Room for your next idea.</p>'),
      slide('workspace', 'A place for good work', '<ul><li>Write a document</li><li>Explore a spreadsheet</li><li>Present your next idea</li></ul>'),
      slide('offline', 'Keep your work close', '<p>Work offline. Save on this device. Download your own backups.</p>'),
    ],
  }),
  file(ids.board, 'Workspace architecture sketch', 'whiteboard', {
    type: 'excalidraw', files: {}, elements: [
      element('app', 'rectangle', 100, 120, 240, 100, { backgroundColor: '#dbeafe', roundness: { type: 3 } }),
      label('app-label', 115, 157, 'LocalFirst workspace'),
      element('storage', 'rectangle', 500, 120, 240, 100, { backgroundColor: '#d1fae5', roundness: { type: 3 } }),
      label('storage-label', 515, 157, 'Files on your device'),
      element('backup', 'rectangle', 300, 350, 240, 100, { backgroundColor: '#fef3c7', roundness: { type: 3 } }),
      label('backup-label', 315, 387, 'Your own backups'),
      element('save-arrow', 'arrow', 345, 170, 150, 0, { points: [[0, 0], [150, 0]], startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: 'arrow' }),
      label('save-label', 355, 135, 'Save', 120),
      element('backup-arrow', 'arrow', 620, 230, 180, 110, { points: [[0, 0], [-180, 110]], startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: 'arrow', strokeStyle: 'dashed' }),
    ],
  }),
]

const pdf = await PDFDocument.create()
const pdfPage = pdf.addPage([595, 742])
const regular = await pdf.embedFont(StandardFonts.Helvetica)
const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
pdfPage.drawRectangle({ x: 0, y: 630, width: 595, height: 112, color: rgb(0.14, 0.30, 0.70) })
pdfPage.drawText('LocalFirst', { x: 44, y: 682, size: 30, font: bold, color: rgb(1, 1, 1) })
pdfPage.drawText('Project brief / sample document', { x: 45, y: 650, size: 12, font: regular, color: rgb(0.85, 0.91, 1) })
for (const [index, value] of [
  'Your ideas. Your device.', '',
  'A single workspace for documents, spreadsheets,',
  'presentations, whiteboards and PDFs.', '',
  'Create and review',
  'Write, format, explore numbers and present your next idea.', '',
  'Keep work close',
  'The offline workspace saves files on this device.',
  'Download backups to keep a separate copy of your work.', '',
  'This is a sample PDF for the README screenshot gallery.',
].entries()) {
  if (value) pdfPage.drawText(value, { x: 44, y: 583 - index * 29, size: index === 0 ? 24 : 12, font: [0, 5, 8].includes(index) ? bold : regular, color: rgb(0.12, 0.18, 0.28) })
}
const pdfBuffer = Buffer.from(await pdf.save())

const server = spawn(process.execPath, [join(dirname(require.resolve('vite/package.json')), 'bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort', '--outDir', join(root, 'dist-offline')], {
  cwd: join(root, 'web'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
})
let serverError = ''
server.stderr.on('data', chunk => { serverError += chunk })
server.on('error', error => { serverError += error.message })
let browser
const results = []
try {
  await expect.poll(async () => {
    if (server.exitCode !== null) throw new Error(serverError || 'Screenshot preview exited')
    return fetch(base).then(response => response.ok).catch(() => false)
  }, { timeout: 20000 }).toBe(true)
  await mkdir(output, { recursive: true })
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: theme, locale: 'en-US', serviceWorkers: 'block' })
    await context.addInitScript(value => { localStorage.setItem('localfirst.theme', value) }, theme)
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(base)
    await expect(page.getByRole('heading', { name: 'Good work starts here.' })).toBeVisible()
    // The same IndexedDB schema used by the released offline app; no production profile is opened.
    await page.evaluate(async records => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('diwan-local-workspace', 1)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      await new Promise((resolve, reject) => {
        const tx = db.transaction('files', 'readwrite')
        records.forEach(record => tx.objectStore('files').put(record))
        tx.oncomplete = resolve
        tx.onerror = () => reject(tx.error)
      })
      db.close()
    }, files)
    const routes = [
      ['home', '/', async () => { await expect(page.getByRole('heading', { name: 'Good work starts here.' })).toBeVisible(); await expect(page.getByRole('button', { name: 'Open LocalFirst project overview', exact: true })).toBeVisible() }],
      ['apphome-docs', '/docs', () => expect(page.getByText('Getting started notes', { exact: true }).first()).toBeVisible()],
      ['docs-editor', `/docs/${ids.doc}`, () => expect(page.locator('.ProseMirror')).toContainText('Your ideas. Your device.')],
      ['sheets-editor', `/sheets/${ids.sheet}`, async () => { await expect(page.getByText('Revenue', { exact: true }).last()).toBeVisible(); await expect(page.locator('.fortune-sheet-container canvas').first()).toBeVisible() }],
      ['slides-editor', `/slides/${ids.slides}`, () => expect(page.getByRole('group', { name: 'Slide canvas', exact: true })).toContainText('Your ideas. Your device.')],
      ['whiteboard-editor', `/whiteboards/${ids.board}`, async () => { await expect(page.locator('.excalidraw__canvas.interactive')).toBeVisible(); await expect(page.getByRole('status', { name: 'Opening whiteboard…', exact: true })).toHaveCount(0) }],
      ['pdf-editor', '/', async () => {
        await page.getByLabel('Open a PDF file', { exact: true }).setInputFiles({ name: 'LocalFirst-project-brief.pdf', mimeType: 'application/pdf', buffer: pdfBuffer })
        await expect(page.getByLabel('PDF filename')).toHaveValue('LocalFirst-project-brief.pdf')
        await expect(page.locator('.lf-editor-pdf canvas[class="block"]')).toBeVisible()
      }],
      ['settings', '/settings', () => expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()],
    ]
    for (const [name, route, ready] of routes) {
      await page.goto(`${base}${route}`)
      await ready()
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(name === 'whiteboard-editor' ? 2000 : 1000)
      await page.mouse.move(1435, 895)
      await page.screenshot({ path: join(output, `${name}-${theme}.png`), animations: 'disabled' })
      results.push(`${name}-${theme}.png`)
      console.log(`Captured ${name}-${theme}.png`)
    }
    assert.deepEqual(errors, [], 'The gallery must not contain a broken editor')
    await context.close()
  }
  await writeFile(join(output, 'README.md'), [
    '# Current LocalFirst screenshots', '',
    'Real screenshots of the offline build at 1440 × 900, with a 2× device scale, in light and dark themes.',
    'The gallery uses fabricated sample files in a fresh browser profile. Existing user data is never opened.', '',
    'From `web/`, run:', '', '```sh', 'npm run build:offline', 'npm run screenshots:offline', '```', '',
    'Requires Playwright and Google Chrome. The script starts and stops its own loopback preview server.',
    'Each editor must load its sample content before capture; browser runtime errors fail the run.', '',
    ...results.map(name => `- ${name}`), '',
  ].join('\n'))
  console.log(`Verified ${results.length} screenshots; no browser runtime errors.`)
} finally {
  await browser?.close()
  server.kill()
}
