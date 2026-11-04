import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/offline/mode', () => ({ OFFLINE_ONLY: true }))
vi.mock('../../lib/api', () => ({ api: { getFile: vi.fn(), updateFile: vi.fn() } }))
import { api } from '../../lib/api'
import { useFilesStore } from '../filesStore'

beforeEach(() => { vi.clearAllMocks(); useFilesStore.setState({ files: [] }) })
describe('saving an offline editor opened from a bookmark', () => {
  it('loads the durable revision before saving and retains the file in the workspace list', async () => {
    const file = { id: 'bookmarked', name: 'Workbook', type: 'sheet', rev: 7, content: [] }
    vi.mocked(api.getFile).mockResolvedValue(file)
    vi.mocked(api.updateFile).mockResolvedValue({ ...file, rev: 8, content: ['edited'] })
    await useFilesStore.getState().updateFile(file.id, file.name, ['edited'])
    expect(api.updateFile).toHaveBeenCalledWith(file.id, file.name, ['edited'], 7)
    expect(useFilesStore.getState().files).toEqual([{ ...file, rev: 8, content: ['edited'] }])
  })
  it('preserves the stale editor on a real revision conflict', async () => {
    const file = { id: 'bookmarked', name: 'Workbook', type: 'sheet', rev: 7, content: ['mine'] }
    useFilesStore.setState({ files: [file] })
    vi.mocked(api.updateFile).mockRejectedValue(Object.assign(new Error('Another tab saved a newer version.'), { status: 409, current: { ...file, rev: 8, content: ['theirs'] } }))
    await expect(useFilesStore.getState().updateFile(file.id, file.name, ['my unsaved edit'])).rejects.toMatchObject({ status: 409 })
    expect(api.getFile).not.toHaveBeenCalled()
    expect(useFilesStore.getState().files).toEqual([file])
  })
})
