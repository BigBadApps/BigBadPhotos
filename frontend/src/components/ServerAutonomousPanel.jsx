// frontend/src/components/ServerAutonomousPanel.jsx
/**
 * Phone-first control for the Mac session worker: pick album, set threshold,
 * toggle Topaz edits, start/stop, watch live counts. The Drive source folder
 * comes from the store (same folder the app is browsing).
 */
import { useState } from 'react'
import { useStore } from '../store'
import { useServerAutonomous } from '../hooks/useServerAutonomous'
import GooglePhotosAlbumPicker from './GooglePhotosAlbumPicker'

const PHASE_LABEL = {
  idle: '—', polling: 'Checking Drive…', scoring: 'Scoring…',
  editing: 'Editing (Topaz)…', publishing: 'Publishing…',
  watching: 'Watching for new photos', auth_error: 'Google auth problem',
  stopped: 'Stopped',
}

export default function ServerAutonomousPanel() {
  const sourceDir = useStore(s => s.sourceDir)
  const photosAlbum = useStore(s => s.photosAlbum)
  const { running, status, error, start, stop } = useServerAutonomous()

  const [threshold, setThreshold] = useState(0.6)
  const [edit, setEdit] = useState(true)
  const [starting, setStarting] = useState(false)

  const canStart = !!sourceDir?._drive && !!photosAlbum?.id && !running

  const handleStart = async () => {
    setStarting(true)
    await start({
      sourceFolderId: sourceDir.folderId,
      albumId: photosAlbum.id,
      threshold,
      edit,
      pollSeconds: 30,
    })
    setStarting(false)
  }

  const counts = status?.counts || {}
  const phase = status?.phase || 'idle'

  return (
    <div className="card" style={{ padding: 'var(--sp-5)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div className="meta">Autonomous Session (Mac worker)</div>
          <div className="fs-xxs dim" style={{ marginTop: 2 }}>
            Drive → score → Topaz → Google Photos, runs even when this phone sleeps
          </div>
        </div>
        <button
          onClick={running ? stop : handleStart}
          disabled={(!canStart && !running) || starting}
          className="btn btn-uppercase"
          style={{
            padding: '8px 16px', borderRadius: 6, fontWeight: 700,
            background: running ? 'color-mix(in oklab, var(--accent) 20%, var(--bg-3))' : 'var(--bg-3)',
            color: running ? 'var(--accent)' : 'var(--fg-2)',
            border: '1px solid var(--line)',
            opacity: (!canStart && !running) ? 0.4 : 1,
          }}
        >
          {starting ? 'Starting…' : running ? '⏹ Stop' : '▶ Start'}
        </button>
      </div>

      {!running && (
        <>
          <div>
            <div className="meta" style={{ marginBottom: 6 }}>Google Photos album</div>
            <GooglePhotosAlbumPicker />
          </div>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <span className="meta">Quality threshold</span>
              <span className="mono fs-xs" style={{ color: 'var(--accent)' }}>{Math.round(threshold * 100)}%</span>
            </div>
            <input
              type="range" min="0" max="0.95" step="0.05" value={threshold}
              onChange={e => setThreshold(parseFloat(e.target.value))}
              style={{ width: '100%', accentColor: 'var(--accent)' }}
            />
          </div>
          <label className="fs-xs" style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={edit} onChange={e => setEdit(e.target.checked)} />
            Topaz auto-edit before publishing
          </label>
          {!sourceDir?._drive && (
            <div className="fs-xxs dim mono upper" style={{ textAlign: 'center' }}>
              Select a Google Drive source folder to enable
            </div>
          )}
        </>
      )}

      {running && (
        <>
          <div className="fs-sm" style={{ color: 'var(--accent)', fontWeight: 500 }}>
            {PHASE_LABEL[phase] || phase}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--sp-3)' }}>
            {[
              ['New', counts.seen], ['Scored', counts.scored],
              ['Published', counts.published], ['Skipped', counts.skipped],
            ].map(([label, value]) => (
              <div key={label} style={{ textAlign: 'center' }}>
                <div className="mono" style={{ fontSize: 20, fontWeight: 700 }}>{value ?? 0}</div>
                <div className="meta" style={{ marginTop: 2 }}>{label}</div>
              </div>
            ))}
          </div>
          {status?.lastPollAt && (
            <div className="fs-xxs dim mono upper" style={{ textAlign: 'center' }}>
              Last scan: {new Date(status.lastPollAt).toLocaleTimeString()}
            </div>
          )}
        </>
      )}

      {(error || (status?.errors?.length > 0)) && (
        <div style={{
          padding: 'var(--sp-3)', borderRadius: 6, maxHeight: 120, overflowY: 'auto',
          background: 'color-mix(in oklab, var(--reject) 10%, var(--bg-3))',
          border: '1px solid color-mix(in oklab, var(--reject) 30%, var(--line))',
        }}>
          {error && <div className="fs-xxs mono" style={{ color: 'var(--reject)' }}>{error}</div>}
          {(status?.errors || []).map((e, i) => (
            <div key={i} className="fs-xxs mono" style={{ color: 'var(--reject)', marginBottom: 2 }}>{e}</div>
          ))}
        </div>
      )}
    </div>
  )
}
