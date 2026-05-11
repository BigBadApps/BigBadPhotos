import { useState } from 'react'
import { useStore } from '../store'
import { useExporter } from '../hooks/useExporter'

const HAS_DIR_PICKER = typeof window !== 'undefined' && 'showDirectoryPicker' in window

function StatCard({ label, value, color }) {
  return (
    <div className="bg-surface-container p-6 flex-1 min-w-0">
      <p className="text-on-surface-variant tracking-widest mb-2" style={{ fontSize: '10px', fontWeight: 600 }}>{label}</p>
      <span className={`font-display font-bold text-4xl ${color || 'text-on-surface'}`}>{value ?? '—'}</span>
    </div>
  )
}

function Toggle({ enabled, onToggle }) {
  return (
    <button
      onClick={onToggle}
      className={`w-10 h-5 relative transition-colors shrink-0 ${enabled ? 'bg-primary' : 'bg-surface-container-highest'}`}
    >
      <div className={`absolute top-0.5 w-4 h-4 bg-white transition-all ${enabled ? 'left-5' : 'left-0.5'}`} />
    </button>
  )
}

function ExportButton({ onExport, onReset, exporting, exportDone, exportedCount, exportTotal, hasDestDir }) {
  if (exportDone) {
    return (
      <button
        onClick={onReset}
        className="w-full bg-secondary text-on-secondary py-4 px-6 font-display font-bold text-sm tracking-widest flex items-center justify-center gap-3 hover:opacity-80 transition-opacity"
      >
        <span className="material-symbols-outlined" style={{ fontSize: '20px', fontVariationSettings: "'FILL' 1" }}>check_circle</span>
        EXPORT COMPLETE · EXPORT AGAIN
      </button>
    )
  }

  if (exporting) {
    const pct = exportTotal > 0 ? Math.round((exportedCount / exportTotal) * 100) : 0
    return (
      <div className="w-full">
        <div className="w-full bg-primary/20 py-4 px-6 flex items-center justify-between">
          <span className="font-display font-bold text-sm tracking-widest text-primary">EXPORTING…</span>
          <span className="text-primary font-bold">{pct}%</span>
        </div>
        <div className="w-full h-1 bg-surface-container-highest">
          <div className="h-full bg-primary transition-all duration-300" style={{ width: `${pct}%` }} />
        </div>
        <p className="text-on-surface-variant/50 text-center mt-2 tracking-wider" style={{ fontSize: '9px' }}>
          {exportedCount} / {exportTotal} FILES WRITTEN
        </p>
      </div>
    )
  }

  return (
    <button
      onClick={onExport}
      disabled={!hasDestDir}
      className={`w-full py-4 px-6 font-display font-bold text-sm tracking-widest flex items-center justify-center gap-3 transition-colors ${
        hasDestDir
          ? 'bg-primary text-on-primary hover:opacity-90'
          : 'bg-surface-container text-on-surface-variant cursor-not-allowed'
      }`}
    >
      INITIATE EXPORT
      <span className="material-symbols-outlined" style={{ fontSize: '20px', fontVariationSettings: "'wght' 300" }}>arrow_forward</span>
    </button>
  )
}

function ScorePill({ photo }) {
  if (photo.overallScore == null) return null
  const pct = Math.round(photo.overallScore * 100)
  const color = pct >= 75 ? 'text-secondary' : pct >= 50 ? 'text-tertiary' : 'text-error'
  return (
    <div className="absolute top-2 right-2 bg-black/70 px-1.5 py-0.5 flex items-center gap-1">
      <span className="material-symbols-outlined text-primary/80" style={{ fontSize: '9px', fontVariationSettings: "'FILL' 1" }}>auto_awesome</span>
      <span className={`font-bold font-mono ${color}`} style={{ fontSize: '9px' }}>{pct}</span>
    </div>
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
    <div className="flex h-full overflow-hidden">

      {/* Left: main content */}
      <div className="flex-1 overflow-y-auto px-8 py-8 min-w-0">

        {/* Header */}
        <div className="mb-8">
          <p className="text-primary tracking-widest text-xs font-bold mb-2">SESSION SUMMARY</p>
          <h1 className="font-display font-bold text-on-surface leading-none mb-3" style={{ fontSize: '3rem' }}>
            Review &amp;<br />Export
          </h1>
          <p className="text-on-surface-variant text-sm leading-relaxed max-w-md">
            The final selection is ready for the digital darkroom. High-precision culling session complete.
          </p>
        </div>

        {/* Stats row */}
        <div className="flex gap-3 mb-8">
          <StatCard label="TOTAL"  value={total || 0} />
          <StatCard label="KEEPS"  value={keeps.length}  color="text-secondary" />
          <StatCard label="MAYBE"  value={maybes.length} color="text-tertiary" />
          <StatCard label="REJECT" value={rejects.length} color="text-error" />
        </div>

        {/* Export done summary */}
        {exportDone && (
          <div className="mb-6 bg-secondary/10 border border-secondary/30 p-4 flex items-center gap-3">
            <span className="material-symbols-outlined text-secondary" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
            <div>
              <p className="text-secondary text-sm font-bold tracking-wider">
                {exportedCount - failedFiles.length} of {exportedCount} files exported successfully
              </p>
              {failedFiles.length > 0 && (
                <p className="text-error text-xs mt-1">{failedFiles.length} failed — check destination permissions</p>
              )}
            </div>
          </div>
        )}

        {/* Error */}
        {exportError && (
          <div className="mb-6 bg-error/10 border border-error/30 p-4 flex items-center gap-3">
            <span className="material-symbols-outlined text-error" style={{ fontSize: '20px' }}>error_outline</span>
            <p className="text-error text-sm">{exportError}</p>
          </div>
        )}

        {/* Keeps grid */}
        <div className="mb-4 flex items-center justify-between">
          <p className="text-on-surface tracking-widest text-xs font-bold">
            FINAL SELECTION ({includeMaybes ? 'KEEPS + MAYBES' : 'KEEPS'})
          </p>
          <p className="text-on-surface-variant tracking-wider" style={{ fontSize: '9px' }}>
            {exportQueue} QUEUED FOR EXPORT
          </p>
        </div>

        {keeps.length === 0 && (!includeMaybes || maybes.length === 0) ? (
          <div className="bg-surface-container h-48 flex flex-col items-center justify-center gap-3">
            <span className="material-symbols-outlined text-on-surface-variant/30" style={{ fontSize: '48px' }}>photo_library</span>
            <p className="text-on-surface-variant text-sm tracking-wider">No photos selected yet</p>
            <p className="text-on-surface-variant/50 text-xs">Use P in Cull view to keep photos</p>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {[...keeps, ...(includeMaybes ? maybes : [])].map(photo => (
              <div key={photo.id} className="relative overflow-hidden bg-surface-container-high aspect-square">
                {photo.url ? (
                  <img src={photo.url} alt={photo.filename || ''} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center bg-surface-container-high">
                    <span className="material-symbols-outlined text-on-surface-variant/30" style={{ fontSize: '32px' }}>photo</span>
                  </div>
                )}
                <div
                  className="absolute bottom-0 left-0 right-0 px-2 py-1.5 flex items-center justify-between"
                  style={{ background: 'rgba(0,0,0,0.55)' }}
                >
                  <span className="text-on-surface-variant tracking-wider truncate" style={{ fontSize: '9px' }}>{photo.filename}</span>
                  <span
                    className={`px-1.5 py-0.5 font-bold tracking-wider shrink-0 ml-2 ${
                      photo.decision === 'keep' ? 'bg-secondary text-on-secondary' : 'bg-tertiary text-on-tertiary'
                    }`}
                    style={{ fontSize: '8px' }}
                  >
                    {photo.decision === 'keep' ? 'KEEP' : 'MAYBE'}
                  </span>
                </div>
                <ScorePill photo={photo} />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Right: export config panel */}
      <div className="w-64 shrink-0 border-l border-outline-variant/20 bg-surface-container-low flex flex-col overflow-y-auto">
        <div className="p-6 border-b border-outline-variant/20">
          <p className="text-on-surface tracking-widest text-xs font-bold">EXPORT CONFIGURATION</p>
        </div>

        {/* Destination — desktop only */}
        {HAS_DIR_PICKER ? (
          <div className="p-6 border-b border-outline-variant/20">
            <p className="text-on-surface-variant tracking-widest mb-3" style={{ fontSize: '9px', fontWeight: 600 }}>OUTPUT DESTINATION</p>
            {destDir ? (
              <button onClick={handlePickDest} className="w-full flex items-center gap-3 px-4 py-3 bg-secondary/10 border border-secondary/30 text-left">
                <span className="material-symbols-outlined text-secondary" style={{ fontSize: '18px', fontVariationSettings: "'FILL' 1" }}>folder</span>
                <span className="text-secondary text-xs flex-1 truncate">{destDir.name}</span>
                <span className="material-symbols-outlined text-secondary/50" style={{ fontSize: '14px' }}>edit</span>
              </button>
            ) : (
              <button onClick={handlePickDest} className="w-full flex items-center gap-3 px-4 py-3 bg-surface-container hover:bg-surface-container-high transition-colors text-left border border-outline-variant/20">
                <span className="material-symbols-outlined text-on-surface-variant" style={{ fontSize: '18px' }}>folder_open</span>
                <span className="text-on-surface-variant text-xs flex-1">Select destination folder</span>
              </button>
            )}
          </div>
        ) : (
          <div className="p-6 border-b border-outline-variant/20">
            <p className="text-on-surface-variant tracking-widest mb-3" style={{ fontSize: '9px', fontWeight: 600 }}>OUTPUT DESTINATION</p>
            <div className="flex items-center gap-3 px-4 py-3 bg-surface-container border border-outline-variant/20">
              <span className="material-symbols-outlined text-primary/60" style={{ fontSize: '18px', fontVariationSettings: "'FILL' 1" }}>ios_share</span>
              <span className="text-on-surface-variant text-xs flex-1">Files will be shared via iOS Share Sheet</span>
            </div>
          </div>
        )}

        {/* New subfolder */}
        {HAS_DIR_PICKER && (
          <div className="p-6 border-b border-outline-variant/20">
            <p className="text-on-surface-variant tracking-widest mb-3" style={{ fontSize: '9px', fontWeight: 600 }}>NEW SUBFOLDER <span className="opacity-50">(OPTIONAL)</span></p>
            <input
              type="text"
              value={newFolderName}
              onChange={e => setNewFolderName(e.target.value)}
              placeholder="e.g. Wedding Selects"
              className="w-full bg-surface-container border border-outline-variant/20 px-3 py-2.5 text-on-surface text-xs tracking-wider placeholder:text-on-surface-variant/30 focus:outline-none focus:border-primary/50"
            />
            {newFolderName.trim() && (
              <p className="text-primary/60 tracking-wider mt-2" style={{ fontSize: '8px' }}>
                FILES WILL BE WRITTEN TO /{newFolderName.trim()}
              </p>
            )}
          </div>
        )}

        {/* Selection & format */}
        <div className="p-6 border-b border-outline-variant/20 flex flex-col gap-5">
          <p className="text-on-surface-variant tracking-widest" style={{ fontSize: '9px', fontWeight: 600 }}>SELECTION</p>

          <div className="flex items-center justify-between">
            <div>
              <span className="text-on-surface text-xs tracking-wider">INCLUDE MAYBES</span>
              {maybes.length > 0 && (
                <p className="text-on-surface-variant/50 tracking-wider mt-0.5" style={{ fontSize: '9px' }}>+{maybes.length} PHOTOS</p>
              )}
            </div>
            <Toggle enabled={includeMaybes} onToggle={() => setIncludeMaybes(v => !v)} />
          </div>

          <div>
            <p className="text-on-surface-variant tracking-widest mb-3" style={{ fontSize: '9px', fontWeight: 600 }}>OUTPUT FORMAT</p>
            <div className="flex flex-col gap-1">
              {[
                { id: 'original', label: 'ORIGINAL', sub: 'Copy file as-is' },
                { id: 'jpg',      label: 'JPEG',     sub: 'Re-encode at 95% quality' },
              ].map(fmt => (
                <button
                  key={fmt.id}
                  onClick={() => setFileFormat(fmt.id)}
                  className={`flex items-center justify-between px-3 py-2.5 text-left transition-colors ${
                    fileFormat === fmt.id
                      ? 'bg-primary/15 border border-primary/40'
                      : 'bg-surface-container border border-transparent hover:bg-surface-container-high'
                  }`}
                >
                  <div>
                    <span className={`font-bold tracking-wider block ${fileFormat === fmt.id ? 'text-primary' : 'text-on-surface-variant'}`} style={{ fontSize: '10px' }}>{fmt.label}</span>
                    <span className="text-on-surface-variant/50 tracking-wider" style={{ fontSize: '8px' }}>{fmt.sub}</span>
                  </div>
                  {fileFormat === fmt.id && (
                    <span className="material-symbols-outlined text-primary" style={{ fontSize: '14px', fontVariationSettings: "'FILL' 1" }}>radio_button_checked</span>
                  )}
                </button>
              ))}
            </div>
            {fileFormat === 'jpg' && (
              <p className="text-on-surface-variant/40 tracking-wider mt-2" style={{ fontSize: '8px' }}>
                RAW files are always copied as original regardless of this setting.
              </p>
            )}
          </div>
        </div>

        {/* Export button */}
        <div className="p-6 mt-auto">
          <ExportButton
            onExport={handleExport}
            onReset={reset}
            exporting={exporting}
            exportDone={exportDone}
            exportedCount={exportedCount}
            exportTotal={exportTotal}
            hasDestDir={hasDestDir}
          />

          {!hasDestDir && (
            <p className="text-error/60 text-center mt-3 tracking-wider" style={{ fontSize: '9px' }}>
              SELECT A DESTINATION FIRST
            </p>
          )}

          {!exporting && !exportDone && hasDestDir && (
            <p className="text-on-surface-variant/40 text-center mt-3 tracking-wider" style={{ fontSize: '9px' }}>
              QUEUE: {exportQueue} ASSET{exportQueue !== 1 ? 'S' : ''}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
