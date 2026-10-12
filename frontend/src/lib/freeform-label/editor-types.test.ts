import { describe, expect, it } from 'vitest'

import fr from '../../i18n/fr.json'
import { ApiError } from '../api'
import { localizedErrorMessage } from './editor-types'

function translateFr(key: string, fallback: string) {
  const value = key.split('.').reduce<unknown>((node, part) => (
    node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined
  ), fr)
  return typeof value === 'string' ? value : fallback
}

const uploadFailed = (error: unknown) =>
  localizedErrorMessage(error, translateFr, 'labelDesigner.imageUploadFailed', 'Upload failed')

describe('label image error messages', () => {
  it.each([
    ['invalid_label_asset', 422, 'Animated images are not supported', fr.labelDesigner.imageAnimated],
    ['invalid_label_asset', 422, 'Label images cannot exceed 5 MiB', fr.labelDesigner.imageTooLarge],
    ['invalid_label_asset', 422, 'Label image limit reached (maximum 100 images)', fr.labelDesigner.imageLimitReached],
    ['request_too_large', 413, 'Label image request cannot exceed 6 MiB', fr.labelDesigner.imageTooLarge],
    ['label_asset_conflict', 409, 'Label images changed concurrently; retry the upload', fr.labelDesigner.imageConflict],
    ['label_asset_not_found', 404, 'Label image not found', fr.labelDesigner.imageNotFound],
  ])('translates the server code %s (%s)', (code, status, message, expected) => {
    expect(uploadFailed(new ApiError(status, code, message))).toBe(expected)
  })

  it('translates the HTML 413 page that nginx sends before the API sees a too large image', () => {
    expect(uploadFailed(new ApiError(413, 'unknown_error', 'HTTP 413'))).toBe(fr.labelDesigner.imageTooLarge)
  })

  it('names the presets that still use an image', () => {
    const error = new ApiError(409, 'label_asset_in_use', 'This image is still used by: A, B', {
      code: 'label_asset_in_use',
      preset_names: ['A', 'B'],
    })
    expect(uploadFailed(error)).toBe(fr.labelDesigner.imageInUseBy.replace('{names}', 'A, B'))
    expect(uploadFailed(new ApiError(409, 'label_asset_in_use', 'This image is still used by a label preset')))
      .toBe(fr.labelDesigner.imageInUse)
  })

  it('shows the translated generic message for an unknown image validation text', () => {
    expect(uploadFailed(new ApiError(422, 'invalid_label_asset', 'A text the client does not know')))
      .toBe(fr.labelDesigner.imageUploadFailed)
  })

  it('shows the network error when the server cannot be reached', () => {
    expect(uploadFailed(new TypeError('Failed to fetch'))).toBe(fr.common.networkError)
  })

  it('keeps the server text for other codes and plain errors', () => {
    expect(uploadFailed(new ApiError(403, 'csrf_failed', 'CSRF token mismatch'))).toBe('CSRF token mismatch')
    expect(uploadFailed(new Error('Library unavailable'))).toBe('Library unavailable')
  })
})
