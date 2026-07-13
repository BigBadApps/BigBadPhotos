import { test, expect } from '@playwright/test'
import { isDriveExportAbortError } from '../src/utils/googleDrive.js'

test.describe('isDriveExportAbortError', () => {
  test('returns true for AbortError by name', () => {
    expect(isDriveExportAbortError({ name: 'AbortError' })).toBeTruthy()
  })

  test('returns true when message includes Abort', () => {
    expect(isDriveExportAbortError(new Error('Abort'))).toBeTruthy()
    expect(isDriveExportAbortError({ message: 'Aborted by user' })).toBeTruthy()
    expect(isDriveExportAbortError(new Error('Something went wrong. Abort.'))).toBeTruthy()
  })

  test('returns false for other errors', () => {
    expect(isDriveExportAbortError(new TypeError('Network error'))).toBeFalsy()
    expect(isDriveExportAbortError(new Error('Could not reach the server'))).toBeFalsy()
    expect(isDriveExportAbortError(new Error('drive_upload_failed'))).toBeFalsy()
    expect(isDriveExportAbortError({ name: 'OtherError' })).toBeFalsy()
    expect(isDriveExportAbortError({ message: 'Unknown failure' })).toBeFalsy()
  })

  test('handles edge cases safely and returns false', () => {
    expect(isDriveExportAbortError(null)).toBeFalsy()
    expect(isDriveExportAbortError(undefined)).toBeFalsy()
    expect(isDriveExportAbortError({})).toBeFalsy()
    expect(isDriveExportAbortError({ code: 500 })).toBeFalsy()
    expect(isDriveExportAbortError('')).toBeFalsy()
    expect(isDriveExportAbortError(123)).toBeFalsy()
  })
})
