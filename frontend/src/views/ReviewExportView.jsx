import { useState } from 'react'
import { useStore } from '../store'
import { useExporter } from '../hooks/useExporter'
import Icon from '../components/Icon'

const HAS_DIR_PICKER = typeof window !== 'undefined' && 'showDirectoryPicker' in window

function Stat({ label, value, accent }) {
  return (
    <div className="stat" style={{ flex: 1, minWidth: 0 }}>
      <div className="meta">{label}</div>
      <div className="stat-num" style={accent ? { color: `var(--${accent})` } : null}>{value ?? '—'}</div>
    </div>
  )
}

function OblToggle({ checked, onChange }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span className="toggle-track"><span className="toggle-thumb" /></span>
    </label>
  )
}

function ExportProgress({ onExport, onReset, exporting, exportDone, exportedCount, exportTotal, hasDestDir }) {
  if (exportDone) {
    return (
      <button className="btn btn-primary btn-uppercase" onClick={onReset} style={{ width: '100%', height: 48 }}>
        <Icon name="check" size={16} />
        Complete · Export Again
      </button>
    )
  }

  if (exporting) {
    const pct = exportTotal > 0 ? Math.round((exportedCount / exportTotal) * 100) : 0
    return (
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span className="meta" style={{ color: 'var(--accent)' }}>Exporting…</span>
          <span className="mono fs-xs" style={{ color: 'var(--accent)' }}>{pct}%</span>
        </div>
        <div style={{ height: 6, background: 'var(--bg-4)', borderRadius: 3, overflow: 'hidden', marginBottom: 6 }}>
          <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent)', borderRadius: 3, transition: 'width .3s var(--ease-out)' }} />
        </div>
        <p className="fs-xxs dim mono upper ta-c">{exportedCount} / {exportTotal} files</p>
      </div>
    )
  }

  return (
    <button
      className="btn btn-primary btn-uppercase"
      onClick={onExport}
      disabled={!hasDestDir}
      style={{ width: '100%', height: 48 }}
    >
      <Icon name="arrowR" size={16} />
      Initiate Export
    </button>
  )
}

export default function ReviewExportView() {
  const photos = useStore(state => state.photos)
  const destDir = useStore(state => state.destDir)
  const setDestDir = useStore(state => state.setDestDir)

  const [includeMaybes, setIncludeMaybes] = useState(false)
  const [fileFormat, setFileFormat] = useState('original')
  const [newFolderName, setNewFolderName] = useState('')

  const {
    exporting, exportedCount, exportTotal,
    exportError, exportDone, failedFiles,
    startExport, reset, hasDestDir,
  } = useExporter()

  const keeps = Object.values(photos).filter(p => p.decision === 'keep')
  const maybes = Object.values(photos).filter(p => p.decision === 'maybe')
  const rejects = Object.values(photos).filter(p => p.decision === 'reject')
  const total = Object.keys(photos).length
  const exportQueue = includeMaybes ? keeps.length + maybes.length : keeps.length

  const handlePickDest = async () => {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
      setDestDir(handle)
    } catch (err) {
      if (err.name !== 'AbortError') console.error(err)
    }
  }

  const handleExport = () => startExport({ fileFormat, includeMaybes, newFolderName })

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>

      {/* Left: main content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--pad)', minWidth: 0 }}>

        {/* Header */}
        <div style={{ marginBottom: 'var(--sp-7)' }}>
          <div className="meta" style={{ color: 'var(--accent)', marginBottom: 8 }}>· Session Summary</div>
          <h1 style={{ margin: 0, fontSize: 'clamp(32px, 4vw, 48px)', fontWeight: 700, letterSpacing: 'var(--tracking-tight)', lineHeight: 1.05 }}>
            Review &amp; Export
          </h1>
          <p style={{ margin: '12px 0 0', color: 'var(--fg-2)', fontSize: 'var(--fs-md)', maxWidth: '45ch' }}>
            Review your decisions, configure the output, and export to your destination.
          </p>
        </div>

        {/* Stats row */}
        <div style={{ display: 'flex', gap: 'var(--sp-3)', marginBottom: 'var(--sp-7)' }}>
          <Stat label="Total"  value={total || 0} />
          <Stat label="Keeps"  value={keeps.length}  accent="keep" />
          <Stat label="Maybe"  value={maybes.length} accent="maybe" />
          <Stat label="Reject" value={rejects.length} accent="reject" />
        </div>

        {/* Export done */}
        {exportDone && (
          <div style={{
            marginBottom: 'var(--sp-5)',
            background: 'color-mix(in oklab, var(--keep) 10%, transparent)',
            border: '1px solid color-mix(in oklab, var(--keep) 30%, transparent)',
            borderRadius: 10, padding: 'var(--sp-4)',
            display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <Icon name="check" size={20} style={{ color: 'var(--keep)', flexShrink: 0 }} />
            <div>
              <p className="fs-sm" style={{ color: 'var(--keep)', fontWeight: 600 }}>
                {exportedCount - failedFiles.length} of {exportedCount} files exported successfully
              </p>
              {failedFiles.length > 0 && (
                <p className="fs-xs" style={{ color: 'var(--reject)', marginTop: 4 }}>{failedFiles.length} failed — check destination permissions</p>
              )}
            </div>
          </div>
        )}

        {/* Error */}
        {exportError && (
          <div style={{
            marginBottom: 'var(--sp-5)',
            background: 'color-mix(in oklab, var(--reject) 10%, transparent)',
            border: '1px solid color-mix(in oklab, var(--reject) 30%, transparent)',
            borderRadius: 10, padding: 'var(--sp-4)',
            display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <Icon name="info" size={20} style={{ color: 'var(--reject)', flexShrink: 0 }} />
            <p className="fs-sm" style={{ color: 'var(--reject)' }}>{exportError}</p>
          </div>
        )}

        {/* Selection header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--sp-4)' }}>
          <span className="meta">Final Selection ({includeMaybes ? 'Keeps + Maybes' : 'Keeps'})</span>
          <span className="meta" style={{ color: 'var(--fg-4)' }}>{exportQueue} queued</span>
        </div>

        {/* Photo grid */}
        {keeps.length === 0 && (!includeMaybes || maybes.length === 0) ? (
          <div style={{
            background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 10,
            height: 200, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12,
          }}>
            <Icon name="image" size={48} style={{ color: 'var(--fg-4)' }} />
            <p className="fs-sm" style={{ color: 'var(--fg-3)' }}>No photos selected yet</p>
            <p className="meta">Use P in Cull view to keep photos</p>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
            {[...keeps, ...(includeMaybes ? maybes : [])].map(photo => (
              <div key={photo.id} style={{ position: 'relative', aspectRatio: '1', borderRadius: 8, overflow: 'hidden', background: 'var(--bg-3)' }}>
                {photo.url ? (
                  <img src={photo.url} alt={photo.filename || ''} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Icon name="image" size={32} style={{ color: 'var(--fg-4)' }} />
                  </div>
                )}
                <div style={{
                  position: 'absolute', bottom: 0, left: 0, right: 0,
                  padding: '6px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  background: 'rgba(0,0,0,.6)',
                }}>
                  <span className="fs-xxs mono" style={{ color: 'var(--fg-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{photo.filename}</span>
                  <span className={`dbadge ${photo.decision}`} style={{ marginLeft: 6, flexShrink: 0, fontSize: 9, height: 18, padding: '0 6px' }}>
                    <span className="glyph" />
                    {photo.decision === 'keep' ? 'Keep' : 'Maybe'}
                  </span>
                </div>
                {photo.overallScore != null && (
                  <div style={{
                    position: 'absolute', top: 8, right: 8,
                    background: 'rgba(0,0,0,.7)', padding: '3px 6px', borderRadius: 4,
                    display: 'flex', alignItems: 'center', gap: 4,
                  }}>
                    <Icon name="sparkle" size={9} style={{ color: 'var(--accent)' }} />
                    <span className="mono" style={{
                      fontSize: 9, fontWeight: 600,
                      color: photo.overallScore >= .75 ? 'var(--keep)' : photo.overallScore >= .5 ? 'var(--warning)' : 'var(--reject)',
                    }}>{Math.round(photo.overallScore * 100)}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Right: export config panel */}
      <div style={{
        width: 260, flexShrink: 0,
        borderLeft: '1px solid var(--line)',
        background: 'var(--bg-2)',
        display: 'flex', flexDirection: 'column',
        overflowY: 'auto',
      }}>
        <div style={{ padding: 'var(--sp-5)', borderBottom: '1px solid var(--line)' }}>
          <span className="meta">Export Configuration</span>
        </div>

        {/* Destination */}
        {HAS_DIR_PICKER ? (
          <div style={{ padding: 'var(--sp-5)', borderBottom: '1px solid var(--line)' }}>
            <div className="meta" style={{ marginBottom: 12 }}>Output Destination</div>
            {destDir ? (
              <button onClick={handlePickDest} style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 12px', borderRadius: 8, textAlign: 'left',
                background: 'color-mix(in oklab, var(--keep) 10%, transparent)',
                border: '1px solid color-mix(in oklab, var(--keep) 30%, transparent)',
              }}>
                <Icon name="folderOpen" size={18} style={{ color: 'var(--keep)', flexShrink: 0 }} />
                <span className="fs-sm" style={{ color: 'var(--keep)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{destDir.name}</span>
                <Icon name="arrowR" size={14} style={{ color: 'var(--keep)', opacity: .5, flexShrink: 0 }} />
              </button>
            ) : (
              <button onClick={handlePickDest} style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 12px', borderRadius: 8, textAlign: 'left',
                background: 'var(--bg-3)', border: '1px solid var(--line)',
                color: 'var(--fg-2)',
              }}>
                <Icon name="folder" size={18} style={{ color: 'var(--fg-3)', flexShrink: 0 }} />
                <span className="fs-sm">Select destination folder</span>
              </button>
            )}
          </div>
        ) : (
          <div style={{ padding: 'var(--sp-5)', borderBottom: '1px solid var(--line)' }}>
            <div className="meta" style={{ marginBottom: 12 }}>Output Destination</div>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '10px 12px', borderRadius: 8,
              background: 'var(--bg-3)', border: '1px solid var(--line)',
            }}>
              <Icon name="arrowR" size={18} style={{ color: 'var(--accent)', opacity: .6, flexShrink: 0 }} />
              <span className="fs-xs" style={{ color: 'var(--fg-2)' }}>Files shared via iOS Share Sheet</span>
            </div>
          </div>
        )}

        {/* Subfolder */}
        {HAS_DIR_PICKER && (
          <div style={{ padding: 'var(--sp-5)', borderBottom: '1px solid var(--line)' }}>
            <div className="meta" style={{ marginBottom: 12 }}>New Subfolder <span style={{ opacity: .5 }}>(optional)</span></div>
            <input
              type="text"
              value={newFolderName}
              onChange={e => setNewFolderName(e.target.value)}
              placeholder="e.g. Wedding Selects"
              style={{
                width: '100%', padding: '8px 12px', borderRadius: 8,
                background: 'var(--bg-3)', border: '1px solid var(--line)',
                color: 'var(--fg)', fontSize: 'var(--fs-xs)',
                outline: 'none',
              }}
            />
            {newFolderName.trim() && (
              <p className="fs-xxs mono upper" style={{ color: 'var(--accent)', opacity: .7, marginTop: 6 }}>
                → /{newFolderName.trim()}
              </p>
            )}
          </div>
        )}

        {/* Selection & format */}
        <div style={{ padding: 'var(--sp-5)', borderBottom: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-5)' }}>
          <div className="meta">Selection</div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <span className="fs-sm">Include Maybes</span>
              {maybes.length > 0 && (
                <p className="fs-xxs dim mono upper" style={{ marginTop: 2 }}>+{maybes.length} photos</p>
              )}
            </div>
            <OblToggle checked={includeMaybes} onChange={setIncludeMaybes} />
          </div>

          <div>
            <div className="meta" style={{ marginBottom: 10 }}>Output Format</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {[
                { id: 'original', label: 'Original', sub: 'Copy file as-is' },
                { id: 'jpg',      label: 'JPEG',     sub: 'Re-encode at 95%' },
              ].map(fmt => (
                <button
                  key={fmt.id}
                  onClick={() => setFileFormat(fmt.id)}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '8px 12px', borderRadius: 8, textAlign: 'left',
                    background: fileFormat === fmt.id
                      ? 'color-mix(in oklab, var(--accent) 12%, transparent)'
                      : 'var(--bg-3)',
                    border: `1px solid ${
                      fileFormat === fmt.id
                        ? 'color-mix(in oklab, var(--accent) 40%, transparent)'
                        : 'var(--line)'
                    }`,
                    transition: 'all .15s',
                  }}
                >
                  <div>
                    <span className="fs-xs mono upper" style={{ color: fileFormat === fmt.id ? 'var(--accent)' : 'var(--fg-2)', display: 'block' }}>{fmt.label}</span>
                    <span className="fs-xxs" style={{ color: 'var(--fg-4)' }}>{fmt.sub}</span>
                  </div>
                  {fileFormat === fmt.id && (
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)', boxShadow: '0 0 8px var(--accent)', flexShrink: 0 }} />
                  )}
                </button>
              ))}
            </div>
            {fileFormat === 'jpg' && (
              <p className="fs-xxs dim" style={{ marginTop: 8 }}>RAW files are always copied as original.</p>
            )}
          </div>
        </div>

        {/* Export CTA */}
        <div style={{ padding: 'var(--sp-5)', marginTop: 'auto' }}>
          <ExportProgress
            onExport={handleExport}
            onReset={reset}
            exporting={exporting}
            exportDone={exportDone}
            exportedCount={exportedCount}
            exportTotal={exportTotal}
            hasDestDir={HAS_DIR_PICKER ? hasDestDir : true}
          />
          {!hasDestDir && !exporting && !exportDone && (
            <p className="fs-xxs dim mono upper ta-c" style={{ marginTop: 8 }}>Select a destination first</p>
          )}
          {!exporting && !exportDone && hasDestDir && (
            <p className="fs-xxs dim mono upper ta-c" style={{ marginTop: 8 }}>Queue: {exportQueue} asset{exportQueue !== 1 ? 's' : ''}</p>
          )}
        </div>
      </div>
    </div>
  )
}
