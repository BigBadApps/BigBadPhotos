import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { createDisplayUrl } from '../utils/imageResize'

const WEB_FORMATS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp'])
const RAW_FORMATS = new Set(['raw', 'arw', 'cr2', 'cr3', 'nef', 'dng', 'orf', 'rw2', 'raf', 'tif', 'tiff'])

const BATCH_SIZE = 10

export function usePhotoLoader() {
  const sourceDir = useStore(state => state.sourceDir)
  const addPhotos = useStore(state => state.addPhotos)
  const setCurrentId = useStore(state => state.setCurrentId)
  const orderLength = useStore(state => state.order.length)

  const [loading, setLoading] = useState(false)
  const [loadingComplete, setLoadingComplete] = useState(false)
  const [loadedCount, setLoadedCount] = useState(0)
  const [totalCount, setTotalCount] = useState(0)
  const [loadError, setLoadError] = useState(null)

  const objectUrls = useRef([])

  useEffect(() => {
    // Revoke URLs from the previous folder whenever sourceDir changes.
    const prevUrls = objectUrls.current
    objectUrls.current = []
    prevUrls.forEach(url => URL.revokeObjectURL(url))

    // iOS path: photos were already loaded via <input type="file"> in App.
    // Mark loading complete so the landing flow can offer AI scoring.
    if (sourceDir?._ios) {
      setLoading(false)
      setLoadingComplete(true)
      const count = useStore.getState().order.length
      setLoadedCount(count)
      setTotalCount(count)
      return
    }

    if (!sourceDir || orderLength > 0) return

    let cancelled = false
    let firstBatch = true

    async function load() {
      setLoading(true)
      setLoadingComplete(false)
      setLoadError(null)
      setLoadedCount(0)
      setTotalCount(0)

      try {
        // Collect all matching file handles first (fast — just filenames)
        const handles = []
        for await (const entry of sourceDir.values()) {
          if (entry.kind !== 'file') continue
          const ext = entry.name.split('.').pop().toLowerCase()
          if (WEB_FORMATS.has(ext) || RAW_FORMATS.has(ext)) {
            handles.push(entry)
          }
        }

        if (cancelled) return

        // Sort alphabetically — matches camera file naming (DSC_0001, IMG_0002, etc.)
        handles.sort((a, b) => a.name.localeCompare(b.name))
        setTotalCount(handles.length)

        // Load and add in batches so UI updates progressively
        for (let i = 0; i < handles.length; i += BATCH_SIZE) {
          if (cancelled) break

          const slice = handles.slice(i, i + BATCH_SIZE)

          const photos = await Promise.all(
            slice.map(async (handle) => {
              const file = await handle.getFile()
              const ext = file.name.split('.').pop().toLowerCase()
              const isWeb = WEB_FORMATS.has(ext)

              let url = null
              if (isWeb) {
                url = await createDisplayUrl(file)
                objectUrls.current.push(url)
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
            })
          )

          if (cancelled) break

          addPhotos(photos)
          setLoadedCount(i + photos.length)

          // Set first photo as active as soon as the first batch lands
          if (firstBatch && photos.length > 0) {
            setCurrentId(photos[0].id)
            firstBatch = false
          }
        }
      } catch (err) {
        if (!cancelled) setLoadError(err.message)
      } finally {
        if (!cancelled) {
          setLoading(false)
          setLoadingComplete(true)
        }
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [sourceDir]) // sourceDir identity change = new folder selected

  return { loading, loadingComplete, loadedCount, totalCount, loadError }
}
