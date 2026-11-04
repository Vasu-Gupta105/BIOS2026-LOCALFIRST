import type { SyncState } from '../lib/nearby/documentSync'

export default function NearbyFileStatus({ sync, waiting }: { sync: SyncState; waiting: boolean }) {
  return <p role={sync.phase === 'error' ? 'alert' : 'status'} className={`px-4 py-1 text-xs break-words ${sync.phase === 'error' ? 'text-danger' : 'text-ink-muted'}`}>
    {sync.phase === 'error' ? `Bluetooth sync error: ${sync.error}` : waiting ? 'Waiting for the shared file over Bluetooth. Keep the hosting laptop connected.' : sync.phase === 'acknowledged' ? 'Other laptop acknowledged this version' : sync.phase === 'syncing' ? 'Synchronizing over Bluetooth…' : 'Bluetooth link offline · local edits retained'}
  </p>
}
