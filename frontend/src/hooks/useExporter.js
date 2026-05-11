import { useState, useCallback } from 'react'
import { useStore } from '../store'
import {
  ensureDriveWriteSession,
  isDriveExportAbortError,
  uploadDriveFile,
} from '../utils/googleDrive'

const HAS_DIR_PICKER = typeof window !== 'undefined' && 'showDirectoryPicker' in window

async function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
  // Small delay between downloads so iOS doesn't drop them
  await new Promise(r => setTimeout(r, 300))
}

async function encodeAsJpeg(file) {
  const url = URL.createObjectURL(file)
  const img = new Image()
  await new Promise((resolve, reject) => {
    img.onload = resolve
    img.onerror = reject
    img.src = url
  })
  URL.revokeObjectURL(url)
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  canvas.getContext('2d').drawImage(img, 0, 0)
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.95))
}

export function useExporter() {
  const photos = useStore(state => state.photos)
  const destDir = useStore(state => state.destDir)

  const [exporting, setExporting] = useState(false)
  const [exportedCount, setExportedCount] = useState(0)
  const [exportTotal, setExportTotal] = useState(0)
  const [exportError, setExportError] = useState(null)
  const [exportDone, setExportDone] = useState(false)
  const [failedFiles, setFailedFiles] = useState([])

  const startExport = useCallback(async ({ fileFormat = 'original', includeMaybes = false, newFolderName = '' } = {}) => {
    const queue = Object.values(photos).filter(p =>
      p.file && (p.decision === 'keep' || (includeMaybes && p.decision === 'maybe'))
    )
    if (queue.length === 0) {
      setExportError('No photos to export.')
      return
    }

    if (!HAS_DIR_PICKER && !destDir) {
      // iOS — no dest dir needed, we use downloads/share
    } else if (!destDir) {
      setExportError('No destination folder selected.')
      return
    }

    const driveDest = destDir?._drive ? destDir.folderId : null

    setExporting(true)
    setExportDone(false)
    setExportError(null)
    setFailedFiles([])
    setExportedCount(0)
    setExportTotal(queue.length)

    const failed = []
    let completedOk = false
    let driveBackendDown = false
    const keeps = Object.values(photos).filter(p => p.decision === 'keep').map(p => p.filename)
    const maybes = Object.values(photos).filter(p => p.decision === 'maybe').map(p => p.filename)
    const rejects = Object.values(photos).filter(p => p.decision === 'reject').map(p => p.filename)
    const decisions = {}
    for (const p of Object.values(photos)) {
      if (p.decision) decisions[p.filename] = p.decision
    }
    const decisionsPayload = {
      schema: 'bigbadphotos.decisions.v1',
      exported_at: new Date().toISOString(),
      include_maybes: !!includeMaybes,
      keeps,
      maybes,
      rejects,
      decisions,
    }

    try {
      if (driveDest) {
        await ensureDriveWriteSession()
        for (let i = 0; i < queue.length; i++) {
          const photo = queue[i]
          try {
            const convertToJpeg = fileFormat === 'jpg' && !photo.isRaw
            const exportName = convertToJpeg
              ? photo.filename.replace(/\.[^.]+$/, '.jpg')
              : photo.filename
            const blob = convertToJpeg ? await encodeAsJpeg(photo.file) : photo.file
            const file = blob instanceof File
              ? new File([blob], exportName, { type: blob.type || 'application/octet-stream' })
              : new File([blob], exportName, { type: blob.type || 'application/octet-stream' })
            await uploadDriveFile(driveDest, file)
            setExportedCount(i + 1)
          } catch (err) {
            failed.push({ filename: photo.filename, reason: err.message })
            setExportedCount(i + 1)
            if (isDriveExportAbortError(err)) {
              setExportError(err.message)
              driveBackendDown = true
              break
            }
          }
        }

        if (!driveBackendDown) {
          try {
            const jsonBlob = new Blob([JSON.stringify(decisionsPayload, null, 2)], { type: 'application/json' })
            await uploadDriveFile(
              driveDest,
              new File([jsonBlob], 'bigbad_decisions.json', { type: 'application/json' }),
            )
          } catch (err) {
            failed.push({ filename: 'bigbad_decisions.json', reason: err.message })
            if (isDriveExportAbortError(err)) {
              setExportError(err.message)
              driveBackendDown = true
            }
          }
        }
        completedOk = !driveBackendDown
      } else if (!HAS_DIR_PICKER) {
        try {
          const files = await Promise.all(queue.map(async (photo) => {
            const blob = fileFormat === 'jpg' && !photo.isRaw
              ? await encodeAsJpeg(photo.file)
              : photo.file
            const name = fileFormat === 'jpg' && !photo.isRaw
              ? photo.filename.replace(/\.[^.]+$/, '.jpg')
              : photo.filename
            return new File([blob], name, { type: blob.type || 'image/jpeg' })
          }))

          if (navigator.canShare && navigator.canShare({ files })) {
            await navigator.share({ files, title: 'BigBadPhotos Export' })
            setExportedCount(queue.length)
          } else {
            for (let i = 0; i < files.length; i++) {
              await triggerDownload(files[i], files[i].name)
              setExportedCount(i + 1)
            }
          }

          await triggerDownload(
            new Blob([JSON.stringify(decisionsPayload, null, 2)], { type: 'application/json' }),
            'bigbad_decisions.json'
          )
          completedOk = true
        } catch (err) {
          if (err.name !== 'AbortError') {
            setExportError(`Export failed: ${err.message}`)
          }
        }
      } else {
        let exportDir = destDir
        if (newFolderName.trim()) {
          try {
            exportDir = await destDir.getDirectoryHandle(newFolderName.trim(), { create: true })
          } catch (err) {
            setExportError(`Could not create folder "${newFolderName.trim()}": ${err.message}`)
            return
          }
        }

        for (let i = 0; i < queue.length; i++) {
          const photo = queue[i]
          try {
            const convertToJpeg = fileFormat === 'jpg' && !photo.isRaw
            const exportName = convertToJpeg
              ? photo.filename.replace(/\.[^.]+$/, '.jpg')
              : photo.filename
            const blob = convertToJpeg ? await encodeAsJpeg(photo.file) : photo.file
            const fileHandle = await exportDir.getFileHandle(exportName, { create: true })
            const writable = await fileHandle.createWritable()
            await writable.write(blob)
            await writable.close()
            setExportedCount(i + 1)
          } catch (err) {
            failed.push({ filename: photo.filename, reason: err.message })
            setExportedCount(i + 1)
          }
        }

        try {
          const fileHandle = await exportDir.getFileHandle('bigbad_decisions.json', { create: true })
          const writable = await fileHandle.createWritable()
          await writable.write(new Blob([JSON.stringify(decisionsPayload, null, 2)], { type: 'application/json' }))
          await writable.close()
        } catch (err) {
          failed.push({ filename: 'bigbad_decisions.json', reason: err.message })
        }
        completedOk = true
      }
    } finally {
      setFailedFiles(failed)
      setExporting(false)
      if (completedOk) setExportDone(true)
    }
  }, [photos, destDir])

  const reset = useCallback(() => {
    setExportDone(false)
    setExportError(null)
    setFailedFiles([])
    setExportedCount(0)
    setExportTotal(0)
  }, [])

  return {
    exporting,
    exportedCount,
    exportTotal,
    exportError,
    exportDone,
    failedFiles,
    startExport,
    reset,
    hasDestDir: HAS_DIR_PICKER ? !!destDir : true,
  }
}
