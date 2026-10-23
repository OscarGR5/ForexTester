// Shared wire types. Error codes are stable; messages may become more specific.
export type StorageCode = 'HISTORY_MISSING' | 'HISTORY_CORRUPT' | 'HISTORY_FINGERPRINT_MISMATCH' |
  'HISTORY_INVALID' | 'STORAGE_UNAVAILABLE' | 'STORAGE_UNSAFE_PATH' | 'STORAGE_FULL' |
  'STORAGE_PERMISSION_DENIED' | 'STORAGE_DATA_MISSING' | 'STORAGE_REQUEST_INVALID' |
  'SESSION_CONFLICT' | 'SESSION_NOT_FOUND' | 'CLEANUP_UNSAFE'

export class StorageApiError extends Error {
  constructor(public code: StorageCode, message: string) { super(message) }
}
export const fingerprintMismatch = () => new StorageApiError('HISTORY_FINGERPRINT_MISMATCH',
  'The provider returned different historical data. Replacement was rejected; the saved session and available files were kept. Retry later or restore the original dataset from a separate backup while the backend is stopped.')
export const repairableHistory = (error: unknown) => error instanceof StorageApiError && ['HISTORY_MISSING', 'HISTORY_CORRUPT'].includes(error.code)

export type CleanupCategory = 'checkpoints' | 'equity' | 'history' | 'temporary'
export interface CleanupPreview {
  safe: boolean
  candidateFiles: number
  reclaimableBytes: number
  categories: Record<CleanupCategory, { files: number; bytes: number }>
  error?: string
  code?: 'CLEANUP_UNSAFE'
}
export interface CleanupResult extends CleanupPreview {
  removedFiles: number
  reclaimedBytes: number
  remainingFiles: number
  failures: { file: string; error: string }[]
}
