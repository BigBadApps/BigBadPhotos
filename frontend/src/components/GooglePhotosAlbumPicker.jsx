// frontend/src/components/GooglePhotosAlbumPicker.jsx
/**
 * Pick or create the target Google Photos album (app-created albums only —
 * the Photos API cannot list or write to hand-made albums).
 * Reads/writes `photosAlbum` in the zustand store.
 */
import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../store'
import {
  listPhotosAlbums, createPhotosAlbum, defaultAlbumTitle,
  isPhotosAuthError, serverGoogleConnectUrl,
} from '../utils/googlePhotos'

export default function GooglePhotosAlbumPicker({ compact = false }) {
  const photosAlbum = useStore(s => s.photosAlbum)
  const setPhotosAlbum = useStore(s => s.setPhotosAlbum)

  const [albums, setAlbums] = useState(null)   // null = not loaded yet
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState(defaultAlbumTitle())
  const [error, setError] = useState(null)
  const [needsConnect, setNeedsConnect] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await listPhotosAlbums()
      setAlbums(list)
      setNeedsConnect(false)
    } catch (err) {
      if (isPhotosAuthError(err)) setNeedsConnect(true)
      else setError(err.message)
      setAlbums([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const handleCreate = async () => {
    const title = newTitle.trim()
    if (!title) return
    setCreating(true)
    setError(null)
    try {
      const album = await createPhotosAlbum(title)
      setPhotosAlbum({ id: album.id, title: album.title })
      await refresh()
    } catch (err) {
      if (isPhotosAuthError(err)) setNeedsConnect(true)
      else setError(err.message)
    } finally {
      setCreating(false)
    }
  }

  if (needsConnect) {
    return (
      <div className="fs-xs" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span className="dim">Google Photos is not connected on the server yet.</span>
        <a
          className="btn btn-primary btn-uppercase"
          href={serverGoogleConnectUrl()}
          style={{ textAlign: 'center', textDecoration: 'none', padding: '10px 12px' }}
        >
          Connect Google Photos
        </a>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <select
          className="fs-xs"
          value={photosAlbum?.id || ''}
          onChange={(e) => {
            const found = (albums || []).find(a => a.id === e.target.value)
            setPhotosAlbum(found ? { id: found.id, title: found.title } : null)
          }}
          style={{
            flex: 1, padding: '8px 10px', borderRadius: 6,
            background: 'var(--bg-3)', color: 'var(--fg-1)', border: '1px solid var(--line)',
          }}
        >
          <option value="">{loading ? 'Loading albums…' : 'Select album…'}</option>
          {(albums || []).map(a => (
            <option key={a.id} value={a.id}>
              {a.title}{a.mediaItemsCount ? ` (${a.mediaItemsCount})` : ''}
            </option>
          ))}
        </select>
        <button className="btn fs-xs" onClick={refresh} disabled={loading} title="Refresh albums">↻</button>
      </div>

      {!compact && (
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            className="fs-xs"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="New album name"
            style={{
              flex: 1, padding: '8px 10px', borderRadius: 6,
              background: 'var(--bg-3)', color: 'var(--fg-1)', border: '1px solid var(--line)',
            }}
          />
          <button className="btn fs-xs" onClick={handleCreate} disabled={creating || !newTitle.trim()}>
            {creating ? 'Creating…' : '+ Create'}
          </button>
        </div>
      )}

      {photosAlbum && (
        <div className="fs-xxs dim">Publishing to: <strong>{photosAlbum.title}</strong></div>
      )}
      {error && <div className="fs-xxs" style={{ color: 'var(--reject)' }}>{error}</div>}
    </div>
  )
}
