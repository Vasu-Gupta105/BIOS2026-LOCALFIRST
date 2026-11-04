import { writeFile } from 'node:fs/promises'

const origin = 'http://127.0.0.1:8765'
const health = await (await fetch(`${origin}/healthz`)).json()
if (health.server !== 'diwan-offline' || health.nearby_protocol !== 'windows-rfcomm-v1') throw new Error('Start the current Windows Bluetooth package first.')
const bootstrap = await (await fetch(`${origin}/_nearby/bootstrap`)).json()
const headers = { 'X-Diwan-Native-Token': bootstrap.token }
const { status, radio } = await (await fetch(`${origin}/_nearby/status`, { headers })).json()
const received = { vector: 0, update: 0, acknowledgement: 0, nonEmptyUpdate: 0 }
if (status.state === 'connected') {
  const batch = await (await fetch(`${origin}/_nearby/events?after=0`, { headers })).json()
  for (const event of batch.events) {
    if (event.session !== status.session || !event.message) continue
    if (event.message.kind === 'vector') received.vector++
    if (event.message.kind === 'ack') received.acknowledgement++
    if (event.message.kind === 'update') {
      received.update++
      if (Buffer.from(event.message.data || '', 'base64').length > 2) received.nonEmptyUpdate++
    }
  }
}
const report = {
  checkedAt: new Date().toISOString(),
  transport: bootstrap.transport,
  frontendVersion: health.cache_version,
  nativeVersion: health.native_version,
  radioAvailable: radio.available,
  state: status.state,
  role: status.role || '',
  documentSelected: !!status.document,
  sentBytes: status.sentBytes || 0,
  receivedBytes: status.receivedBytes || 0,
  receivedPackets: received,
  error: status.error || '',
}
// Never persist invitation, token, document title or document payload here.
await writeFile('Diwan-Bluetooth-Live-Status.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
