import { useCallback, useEffect, useState } from 'react'
import Icon from './Icon'
import { browseDrive } from '../utils/googleDrive'
import { createDriveFolder } from '../api/sessionsClient'

export default function GoogleDriveFolderPicker({
  open,
  title,
  onClose,
  onSelect,
  allowCreate = true,
}) {
  const [trail, setTrail] = useState([{ id: 'root', name: 'My Drive' }])
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState(null)

  const loadFolders = useCallback(async (folderId) => {
    setLoading(true)
    setError(null)
    try {
      const data = await browseDrive(folderId, 'folders')
      setItems(data.items || [])
    } catch (err) {
      setError(err.message)
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setTrail([{ id: 'root', name: 'My Drive' }])
    loadFolders('root')
  }, [open, loadFolders])

  if (!open) return null

  const currentFolder = trail[trail.length - 1]

  function openFolder(folder) {
    setTrail((prev) => [...prev, { id: folder.id, name: folder.name }])
    loadFolders(folder.id)
    setCreating(false)
    setNewName('')
    setCreateError(null)
  }

  function jumpTo(index) {
    const next = trail.slice(0, index + 1)
    setTrail(next)
    loadFolders(next[next.length - 1].id)
    setCreating(false)
    setNewName('')
    setCreateError(null)
  }

  async function handleCreateFolder() {
    const name = newName.trim()
    if (!name || createBusy) return
    setCreateBusy(true)
    setCreateError(null)
    try {
      const result = await createDriveFolder(currentFolder.id, name)
      onSelect({ id: result.folder.id, name: result.folder.name })
    } catch (err) {
      setCreateError(err.message)
    } finally {
      setCreateBusy(false)
    }
  }

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        background: 'rgba(0,0,0,.55)',
        display: 'grid',
        placeItems: 'center',
        padding: 'var(--sp-5)',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="card"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(560px, 100%)',
          maxHeight: 'min(80vh, 720px)',
          overflow: 'auto',
          padding: 'var(--sp-5)',
        }}
      >
        <PickerHeader title={title} onClose={onClose} />

        <div className="flex aic" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 'var(--sp-4)' }}>
          {trail.map((crumb, index) => (
            <button
              key={crumb.id}
              type="button"
              className="btn btn-ghost fs-xs"
              onClick={() => jumpTo(index)}
              style={{ padding: '8px 10px' }}
            >
              {crumb.name}
            </button>
          ))}
        </div>

        {allowCreate && !creating && (
          <button
            type="button"
            className="btn btn-ghost fs-xs"
            onClick={() => setCreating(true)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              minHeight: 44,
              justifyContent: 'center',
              marginBottom: 'var(--sp-3)',
              color: 'var(--accent)',
              borderColor: 'color-mix(in oklab, var(--accent) 35%, var(--line))',
            }}
          >
            ＋ Create folder
          </button>
        )}

        {allowCreate && creating && (
          <div style={{ marginBottom: 'var(--sp-3)' }}>
            <input
              type="text"
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateFolder()
                if (e.key === 'Escape') setCreating(false)
              }}
              placeholder="Folder name"
              style={{
                width: '100%',
                minHeight: 44,
                padding: '0 12px',
                borderRadius: 8,
                background: 'var(--bg-3)',
                border: '1px solid var(--line)',
                color: 'var(--fg)',
                fontSize: 'var(--fs-sm)',
                outline: 'none',
              }}
            />
            {createError && (
              <div className="fs-xs" style={{ color: 'var(--reject)', marginTop: 'var(--sp-2)' }}>
                {createError}
              </div>
            )}
            <div className="flex" style={{ gap: 'var(--sp-2)', marginTop: 'var(--sp-2)' }}>
              <button
                type="button"
                className="btn btn-ghost btn-uppercase"
                onClick={() => setCreating(false)}
                disabled={createBusy}
                style={{ flex: 1, minHeight: 44 }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary btn-uppercase"
                onClick={handleCreateFolder}
                disabled={createBusy || !newName.trim()}
                style={{ flex: 1, minHeight: 44 }}
              >
                {createBusy ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="fs-xs" style={{ color: 'var(--reject)', marginBottom: 'var(--sp-3)' }}>
            {error}
          </div>
        )}

        <div style={{
          minHeight: 220,
          maxHeight: 320,
          overflowY: 'auto',
          border: '1px solid var(--line)',
          borderRadius: 12,
          background: 'var(--bg-2)',
        }}>
          {loading ? (
            <div className="fs-sm dim" style={{ padding: 'var(--sp-5)', textAlign: 'center' }}>
              Loading folders…
            </div>
          ) : items.length === 0 ? (
            <div className="fs-sm dim" style={{ padding: 'var(--sp-5)', textAlign: 'center' }}>
              No subfolders here. Select this folder or go back.
            </div>
          ) : (
            items.map((folder) => (
              <button
                key={folder.id}
                type="button"
                onClick={() => openFolder(folder)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  width: '100%',
                  padding: '12px 14px',
                  border: 'none',
                  borderBottom: '1px solid var(--line)',
                  background: 'transparent',
                  color: 'var(--fg)',
                  textAlign: 'left',
                  cursor: 'pointer',
                }}
              >
                <Icon name="folder" size={18} />
                <span className="fs-sm">{folder.name}</span>
              </button>
            ))
          )}
        </div>

        <div className="flex" style={{ gap: 'var(--sp-3)', justifyContent: 'flex-end', marginTop: 'var(--sp-4)' }}>
          <button type="button" className="btn btn-secondary btn-uppercase" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary btn-uppercase"
            disabled={loading}
            onClick={() => onSelect({ id: currentFolder.id, name: currentFolder.name })}
          >
            Use this folder
          </button>
        </div>
      </div>
    </div>
  )
}

function PickerHeader({ title, onClose }) {
  return (
    <div className="flex jcsb aic" style={{ marginBottom: 'var(--sp-4)' }}>
      <div className="fs-md" style={{ fontWeight: 600 }}>{title}</div>
      <button type="button" className="btn btn-ghost" onClick={onClose} aria-label="Close">
        <Icon name="x" size={18} />
      </button>
    </div>
  )
}
