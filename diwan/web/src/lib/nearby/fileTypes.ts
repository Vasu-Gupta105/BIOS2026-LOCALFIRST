export const SHARED_FILE_TYPES = {
  doc: { route: 'docs', label: 'Document' },
  sheet: { route: 'sheets', label: 'Spreadsheet' },
  slide: { route: 'slides', label: 'Presentation' },
  whiteboard: { route: 'whiteboards', label: 'Whiteboard' },
  pdf: { route: 'pdf', label: 'PDF' },
} as const

export type SharedFileType = keyof typeof SHARED_FILE_TYPES
export function isSharedFileType(type: string): type is SharedFileType {
  return Object.hasOwn(SHARED_FILE_TYPES, type)
}
export function sharedFilePath(id: string, type: string = 'doc'): string {
  if (!isSharedFileType(type)) throw new Error('This file type cannot be shared by this version of the app.')
  return `/${SHARED_FILE_TYPES[type].route}/${encodeURIComponent(id)}`
}
