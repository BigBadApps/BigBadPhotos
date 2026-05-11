// Max longest-edge in pixels for the display copy.
// 1920px covers full HD and looks sharp on retina at the viewer size.
const MAX_DISPLAY_PX = 1920

// JPEG quality for the resized display blob (0–1).
const DISPLAY_QUALITY = 0.88

function blobUrlFromCanvas(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('canvas.toBlob failed'))
          return
        }
        resolve(URL.createObjectURL(blob))
      },
      'image/jpeg',
      DISPLAY_QUALITY,
    )
  })
}

async function createDisplayUrlWithBitmap(file) {
  const bitmap = await createImageBitmap(file)
  const { width: w, height: h } = bitmap

  if (w <= MAX_DISPLAY_PX && h <= MAX_DISPLAY_PX) {
    bitmap.close()
    return URL.createObjectURL(file)
  }

  const scale = Math.min(MAX_DISPLAY_PX / w, MAX_DISPLAY_PX / h)
  const dw = Math.round(w * scale)
  const dh = Math.round(h * scale)

  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(dw, dh)
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, dw, dh)
    bitmap.close()
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: DISPLAY_QUALITY })
    return URL.createObjectURL(blob)
  }

  const canvas = document.createElement('canvas')
  canvas.width = dw
  canvas.height = dh
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, dw, dh)
  bitmap.close()
  return blobUrlFromCanvas(canvas)
}

function createDisplayUrlWithImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const tempUrl = URL.createObjectURL(file)

    img.onload = () => {
      const { naturalWidth: w, naturalHeight: h } = img

      if (w <= MAX_DISPLAY_PX && h <= MAX_DISPLAY_PX) {
        URL.revokeObjectURL(tempUrl)
        resolve(URL.createObjectURL(file))
        return
      }

      const scale = Math.min(MAX_DISPLAY_PX / w, MAX_DISPLAY_PX / h)
      const dw = Math.round(w * scale)
      const dh = Math.round(h * scale)

      const canvas = document.createElement('canvas')
      canvas.width = dw
      canvas.height = dh

      const ctx = canvas.getContext('2d')
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, 0, 0, dw, dh)

      URL.revokeObjectURL(tempUrl)
      blobUrlFromCanvas(canvas).then(resolve, reject)
    }

    img.onerror = () => {
      URL.revokeObjectURL(tempUrl)
      reject(new Error(`Failed to decode ${file.name}`))
    }

    img.src = tempUrl
  })
}

/**
 * Load a File into a resized display blob URL when needed.
 * The original File is never modified.
 *
 * @param {File} file
 * @returns {Promise<string>} blob URL — caller must revoke when done
 */
export async function createDisplayUrl(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createDisplayUrlWithBitmap(file)
    } catch {
      // Fall back to Image/canvas when decode fails.
    }
  }
  return createDisplayUrlWithImage(file)
}
