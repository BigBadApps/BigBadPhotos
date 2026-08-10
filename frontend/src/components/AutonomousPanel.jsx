/**
 * AutonomousPanel — toggle and live status for autonomous mode.
 *
 * When disabled: toggle button + threshold slider + Drive scope notice.
 * When enabled:  live phase indicator, counters, poll countdown, error list.
 */
import { useState, useEffect, useCallback } from 'react'

const PHASE_LABEL = {
  idle:      '—',
  loading:   'Loading images…',
  scoring:   'Scoring…',
  exporting: 'Exporting…',
  watching:  'Watching for new images',
}

const PHASE_COLOR = {
  idle:      'var(--fg-4)',
  loading:   'var(--accent)',
  scoring:   'var(--accent)',
  exporting: 'var(--keep)',
  watching:  'var(--fg-2)',
}

function PollCountdown({ lastPollAt, pollIntervalSec = 30 }) {
  const [left, setLeft] = useState(pollIntervalSec)
  useEffect(() => {
    if (!lastPollAt) return
    const tick = () => setLeft(Math.max(0, pollIntervalSec - Math.floor((Date.now() - lastPollAt.getTime()) / 1000)))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [lastPollAt, pollIntervalSec])
  if (!lastPollAt) return null
  return <span className="mono fs-xxs" style={{ color: 'var(--fg-4)' }}>next scan in {left}s</span>
}

function LegacyAutonomousPanel({
  enabled, canEnable, phase,
  processedCount, skippedCount, newArrivals,
  lastPollAt, errors,
  threshold, onThresholdChange,
  isDriveSource, isDriveDest,
  onToggle,
}) {
  const needsDriveWrite = isDriveSource || isDriveDest
  const [localThreshold, setLocalThreshold] = useState(threshold)

  useEffect(() => {
    // Sync from parent only when value actually changed externally
    // (e.g. on mount from localStorage). Ignore during active slider use.
    if (localThreshold !== threshold) {
      setLocalThreshold(threshold)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threshold])

  const handleSliderChange = useCallback((e) => {
    const val = parseFloat(e.target.value)
    setLocalThreshold(val)
    onThresholdChange(val)
  }, [onThresholdChange])

  return (
    <div className="card" style={{ padding: 'var(--sp-5)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div className="meta">Autonomous Mode</div>
          <div className="fs-xxs dim" style={{ marginTop: 2 }}>
            Auto-score, export best, watch for new images
          </div>
        </div>
        <button
          onClick={onToggle}
          disabled={!canEnable && !enabled}
          title={!canEnable ? 'Select source and export folders first' : undefined}
          style={{
            padding: '8px 16px', borderRadius: 6,
            fontWeight: 700, fontSize: 'var(--fs-xs)',
            letterSpacing: '0.06em', textTransform: 'uppercase',
            cursor: canEnable || enabled ? 'pointer' : 'not-allowed',
            opacity: canEnable || enabled ? 1 : 0.4,
            background: enabled ? 'color-mix(in oklab, var(--accent) 20%, var(--bg-3))' : 'var(--bg-3)',
            color:      enabled ? 'var(--accent)' : 'var(--fg-2)',
            border:     enabled
              ? '1px solid color-mix(in oklab, var(--accent) 50%, var(--line))'
              : '1px solid var(--line)',
            transition: 'all .2s',
          }}
        >
          {enabled ? '⏹ Stop' : '▶ Start'}
        </button>
      </div>

      {/* Config — only when stopped */}
      {!enabled && (
        <>
          {/* Threshold slider */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <span className="meta">Quality threshold</span>
              <span className="mono fs-xs" style={{ color: 'var(--accent)' }}>{Math.round(localThreshold * 100)}%</span>
            </div>
            <input
              type="range" min="0" max="0.95" step="0.05"
              value={Math.min(0.95, Math.max(0, localThreshold))}
              onChange={handleSliderChange}
              onInput={handleSliderChange}
              style={{ width: '100%', accentColor: 'var(--accent)' }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
              <span className="fs-xxs dim">Export all (0%)</span>
              <span className="fs-xxs dim">Strict (95%)</span>
            </div>
          </div>

          {/* Drive write scope notice */}
          {needsDriveWrite && canEnable && (
            <div
              className="fs-xxs"
              style={{
                padding: 'var(--sp-3)',
                background: 'color-mix(in oklab, var(--accent) 8%, var(--bg-3))',
                border: '1px solid color-mix(in oklab, var(--accent) 25%, var(--line))',
                borderRadius: 6,
                color: 'var(--fg-2)',
                lineHeight: 1.5,
              }}
            >
              ℹ️ Autonomous mode needs <strong>write access to your Google Drive</strong> to save
              processing records alongside your images. Google will ask you to confirm this when
              you click Start.
            </div>
          )}

          {/* Prerequisites missing */}
          {!canEnable && (
            <div className="fs-xxs dim mono upper" style={{ color: 'var(--fg-4)', textAlign: 'center' }}>
              Select a source folder and export folder to enable
            </div>
          )}
        </>
      )}

      {/* Live status — only when running */}
      {enabled && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
              background: PHASE_COLOR[phase],
              animation: ['loading','scoring','exporting'].includes(phase)
                ? 'bbp-pulse 1s ease-in-out infinite' : 'none',
            }} />
            <span className="fs-sm" style={{ color: PHASE_COLOR[phase], fontWeight: 500 }}>
              {PHASE_LABEL[phase]}
            </span>
            {phase === 'watching' && <PollCountdown lastPollAt={lastPollAt} />}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--sp-3)' }}>
            {[
              { label: 'Exported',        value: processedCount, color: 'var(--keep)'   },
              { label: 'Below threshold', value: skippedCount,   color: 'var(--fg-3)'   },
              { label: 'New this poll',   value: newArrivals,    color: 'var(--accent)'  },
            ].map(({ label, value, color }) => (
              <div key={label} style={{ textAlign: 'center' }}>
                <div className="mono" style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
                <div className="meta" style={{ marginTop: 2 }}>{label}</div>
              </div>
            ))}
          </div>

          {lastPollAt && (
            <div className="fs-xxs dim mono upper" style={{ textAlign: 'center' }}>
              Last scan: {lastPollAt.toLocaleTimeString()}
            </div>
          )}
        </>
      )}

      {/* Errors */}
      {errors.length > 0 && (
        <div style={{
          padding: 'var(--sp-3)', borderRadius: 6,
          background: 'color-mix(in oklab, var(--reject) 10%, var(--bg-3))',
          border: '1px solid color-mix(in oklab, var(--reject) 30%, var(--line))',
          maxHeight: 120, overflowY: 'auto',
        }}>
          {errors.map((e, i) => (
            <div key={i} className="fs-xxs mono" style={{ color: 'var(--reject)', marginBottom: 2 }}>{e}</div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function AutonomousPanel(props) {
  return <LegacyAutonomousPanel {...props} />
}
