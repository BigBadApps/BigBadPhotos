import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { createDisplayUrl } from '../utils/imageResize'
import { runWithConcurrency } from '../utils/displayUrlQueue'
import { browseDrive, downloadDriveFile } from '../utils/googleDrive'

const WEB_FORMATS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp'])
const RAW_FORMATS = new Set(['raw', 'arw', 'cr2', 'cr3', 'nef', 'dng', 'orf', 'rw2', 'raf', 'tif', 'tiff'])

// Ingest only reads files from disk; display resizing runs in a separate queue.
const INGEST_BATCH_SIZE = 40
const DRIVE_DOWNLOAD_CONCURRENCY = 6
const DISPLAY_CONCURRENCY = 3
const DISPLAY_URL_FLUSH_SIZE = 12

function deferRevokeObjectUrls(urls) {
  if (!urls.length) return
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      urls.forEach((url) => URL.revokeObjectURL(url))
    })
  })
}

function createDisplayUpgrader(cancelled, objectUrls) {
  const displayQueue = []
  let ingestDone = false
  const pendingUrlUpdates = []

  const flushDisplayUrls = () => {
    if (!pendingUrlUpdates.length) return
    const batch = pendingUrlUpdates.splice(0, pendingUrlUpdates.length)
    useStore.getState().batchSetPhotoDisplayUrls(
      batch.map(({ id, url }) => ({ id, url })),
    )
  }

  const start = async () => {
    const pendingUpdates = []

    const flushPending = () => {
      if (!pendingUpdates.length) return
      pendingUrlUpdates.push(...pendingUpdates.splice(0, pendingUpdates.length))
      if (pendingUrlUpdates.length >= DISPLAY_URL_FLUSH_SIZE) {
        flushDisplayUrls()
      }
    }

    const worker = async () => {
      while (!cancelled()) {
        const job = displayQueue.shift()
        if (!job) {
          if (ingestDone) break
          await new Promise((resolve) => setTimeout(resolve, 16))
          continue
        }

        try {
          const nextUrl = await createDisplayUrl(job.file)
          if (cancelled()) {
            URL.revokeObjectURL(nextUrl)
            break
          }

          objectUrls.current.push(nextUrl)
          pendingUpdates.push({ id: job.id, url: nextUrl })
          if (pendingUpdates.length >= DISPLAY_URL_FLUSH_SIZE) {
            flushPending()
          }
        } catch {
          // Keep the lightweight preview URL when resize fails.
        }
      }
    }

    await runWithConcurrency(
      Array.from({ length: DISPLAY_CONCURRENCY }, (_, i) => i),
      DISPLAY_CONCURRENCY,
      worker,
    )

    flushPending()
    flushDisplayUrls()
  }

  return {
    displayQueue,
    markIngestDone: () => { ingestDone = true },
    start,
  }
}

async function buildDrivePhoto(item, displayQueue, objectUrls) {
  const file = await downloadDriveFile(item.id, {
    name: item.name,
    mimeType: item.mimeType,
  })
  const ext = file.name.split('.').pop().toLowerCase()
  const isWeb = WEB_FORMATS.has(ext)
  let url = null
  if (isWeb) {
    url = URL.createObjectURL(file)
    objectUrls.current.push(url)
    displayQueue.push({ id: item.id, file, previewUrl: url })
  }
  return {
    id: item.id,
    filename: file.name,
    url,
    fileHandle: null,
    file,
    isRaw: !isWeb,
    decision: null,
    rank: null,
    sharpness: null,
  }
}

export function usePhotoLoader() {
  const sourceDir = useStore(state => state.sourceDir)
  const addPhotos = useStore(state => state.addPhotos)
  const setCurrentId = useStore(state => state.setCurrentId)
  const [loading, setLoading] = useState(false)
  const [loadingComplete, setLoadingComplete] = useState(false)
  const [loadedCount, setLoadedCount] = useState(0)
  const [totalCount, setTotalCount] = useState(0)
  const [loadError, setLoadError] = useState(null)

  const objectUrls = useRef([])

  useEffect(() => {
    const prevUrls = objectUrls.current
    objectUrls.current = []
    deferRevokeObjectUrls(prevUrls)

    if (sourceDir?._ios) {
      setLoading(false)
      setLoadingComplete(true)
      const count = useStore.getState().order.length
      setLoadedCount(count)
      setTotalCount(count)
      return
    }

    if (sourceDir?._drive) {
      let cancelled = false

      async function loadDriveFolder() {
        setLoading(true)
        setLoadingComplete(false)
        setLoadError(null)
        setLoadedCount(0)
        setTotalCount(0)

        const isCancelled = () => cancelled
        const display = createDisplayUpgrader(isCancelled, objectUrls)
        const displayTask = display.start()
        let firstBatch = true

        try {
          const listing = await browseDrive(sourceDir.folderId, 'images')
          const files = (listing.items || []).slice().sort((a, b) => a.name.localeCompare(b.name))
          if (cancelled) return
          setTotalCount(files.length)

          for (let i = 0; i < files.length; i += INGEST_BATCH_SIZE) {
            if (cancelled) break
            const slice = files.slice(i, i + INGEST_BATCH_SIZE)
            const photos = new Array(slice.length)

            await runWithConcurrency(
              slice.map((item, index) => ({ item, index })),
              DRIVE_DOWNLOAD_CONCURRENCY,
              async ({ item, index }) => {
                photos[index] = await buildDrivePhoto(item, display.displayQueue, objectUrls)
              },
            )

            if (cancelled) break
            addPhotos(photos)
            setLoadedCount(i + photos.length)
            if (firstBatch && photos.length > 0) {
              setCurrentId(photos[0].id)
              firstBatch = false
            }
          }
        } catch (err) {
          if (!cancelled) setLoadError(err.message)
        } finally {
          display.markIngestDone()
          if (!cancelled) {
            setLoading(false)
            setLoadingComplete(true)
          }
          await displayTask
        }
      }

      loadDriveFolder()
      return () => { cancelled = true }
    }

    if (!sourceDir) return

    let cancelled = false
    let firstBatch = true

    async function load() {
      setLoading(true)
      setLoadingComplete(false)
      setLoadError(null)
      setLoadedCount(0)
      setTotalCount(0)

      const isCancelled = () => cancelled
      const display = createDisplayUpgrader(isCancelled, objectUrls)
      const displayTask = display.start()

      try {
        const handles = []
        for await (const entry of sourceDir.values()) {
          if (entry.kind !== 'file') continue
          const ext = entry.name.split('.').pop().toLowerCase()
          if (WEB_FORMATS.has(ext) || RAW_FORMATS.has(ext)) {
            handles.push(entry)
          }
        }

        if (cancelled) return

        handles.sort((a, b) => a.name.localeCompare(b.name))
        setTotalCount(handles.length)

        for (let i = 0; i < handles.length; i += INGEST_BATCH_SIZE) {
          if (cancelled) break

          const slice = handles.slice(i, i + INGEST_BATCH_SIZE)

          const photos = await Promise.all(
            slice.map(async (handle) => {
              const file = await handle.getFile()
              const ext = file.name.split('.').pop().toLowerCase()
              const isWeb = WEB_FORMATS.has(ext)

              let url = null
              if (isWeb) {
                url = URL.createObjectURL(file)
                objectUrls.current.push(url)
                display.displayQueue.push({ id: file.name, file, previewUrl: url })
              }

              return {
                id: file.name,
                filename: file.name,
                url,
                fileHandle: handle,
                file,
                isRaw: !isWeb,
                decision: null,
                rank: null,
                sharpness: null,
              }
            }),
          )

          if (cancelled) break

          addPhotos(photos)
          setLoadedCount(i + photos.length)

          if (firstBatch && photos.length > 0) {
            setCurrentId(photos[0].id)
            firstBatch = false
          }
        }
      } catch (err) {
        if (!cancelled) setLoadError(err.message)
      } finally {
        display.markIngestDone()
        if (!cancelled) {
          setLoading(false)
          setLoadingComplete(true)
        }
        await displayTask
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [sourceDir, addPhotos, setCurrentId])

  return { loading, loadingComplete, loadedCount, totalCount, loadError }
}
