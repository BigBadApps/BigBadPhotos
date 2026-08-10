import { useCallback, useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import Icon from '../components/Icon'
import * as sessionsClient from '../api/sessionsClient'
import { useSessionRun } from '../hooks/useSessionRun'

const STATE_LABELS = {
  claimed: 'Claimed',
  downloaded: 'Downloaded',
  scored: 'Scored',
  awaiting_review: 'Awaiting review',
  approved: 'Approved',
  rejected: 'Rejected',
  editing: 'Editing',
  exporting: 'Exporting',
  exported: 'Exported',
  archived: 'Archived',
  failed: 'Failed',
}

function CheckRow({ check }) {
  return (
    <div style={{ padding: 'var(--sp-4)', borderTop: '1px solid var(--line)' }}>
      <div className="flex jcsb aic">
        <span className="fs-sm" style={{ fontWeight: 600 }}>{check.check}</span>
        {check.ok ? (
          <span className="fs-xs mono upper" style={{ color: 'var(--keep)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icon name="check" size={14} /> OK
          </span>
        ) : (
          <span className="fs-xs mono upper" style={{ color: 'var(--reject)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icon name="x" size={14} /> Failed
          </span>
        )}
      </div>
      {check.detail && (
        <p className="fs-xs" style={{ color: 'var(--fg-2)', margin: '6px 0 0' }}>{check.detail}</p>
      )}
      {!check.ok && check.fix && (
        <div style={{
          marginTop: 'var(--sp-2)',
          background: 'color-mix(in oklab, var(--warning) 12%, transparent)',
          border: '1px solid color-mix(in oklab, var(--warning) 35%, var(--line))',
          borderRadius: 8,
          padding: 'var(--sp-3)',
          display: 'flex',
          gap: 10,
          alignItems: 'flex-start',
        }}>
          <Icon name="info" size={16} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: 1 }} />
          <div>
            <div className="fs-xxs mono upper" style={{ color: 'var(--warning)' }}>Fix</div>
            <p className="fs-sm" style={{ color: 'var(--fg)', margin: '4px 0 0', lineHeight: 1.5 }}>{check.fix}</p>
          </div>
        </div>
      )}
    </div>
  )
}

export default function RunView() {
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const [session, setSession] = useState(null)
  const [sessionError, setSessionError] = useState(null)
  const [checks, setChecks] = useState(null)
  const [preflightBusy, setPreflightBusy] = useState(false)
  const [preflightError, setPreflightError] = useState(null)
  const [starting, setStarting] = useState(false)
  const [actionError, setActionError] = useState(null)
  const { status, loading, error, refresh, stop } = useSessionRun()

  useEffect(() => {
    let cancelled = false
    sessionsClient.getSession(sessionId)
      .then((data) => { if (!cancelled) setSession(data.session) })
      .catch((err) => { if (!cancelled) setSessionError(err.message) })
    return () => { cancelled = true }
  }, [sessionId])

  const runPreflight = useCallback(async () => {
    setPreflightBusy(true)
    setPreflightError(null)
    setActionError(null)
    try {
      const data = await sessionsClient.preflight(sessionId)
      setChecks(data.checks || [])
    } catch (err) {
      setPreflightError(err.message)
    } finally {
      setPreflightBusy(false)
    }
  }, [sessionId])

  const handleStart = useCallback(async () => {
    if (starting) return
    setStarting(true)
    setActionError(null)
    try {
      await sessionsClient.startRun(sessionId)
      refresh()
    } catch (err) {
      setActionError(err.message)
    } finally {
      setStarting(false)
    }
  }, [sessionId, starting, refresh])

  const handleStop = useCallback(async () => {
    setActionError(null)
    await stop()
  }, [stop])

  const running = Boolean(status?.running)
  const belongsToThisSession = status?.runId != null && Number(status?.sessionId) === Number(sessionId)
  const failedCount = status?.counts?.failed || 0
  const nonZeroCounts = Object.entries(status?.counts || {})
    .filter(([, n]) => n > 0)

  return (
    <div className="view" style={{ padding: 'var(--pad)', paddingBottom: 96 }}>
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => navigate('/sessions')}
        style={{ alignSelf: 'flex-start', marginBottom: 'var(--sp-4)' }}
      >
        <Icon name="arrowL" size={16} />
        All sessions
      </button>

      <div style={{ marginBottom: 'var(--sp-6)' }}>
        <div className="meta" style={{ color: 'var(--accent)', marginBottom: 8 }}>· Session Run</div>
        <h1 style={{ margin: 0, fontSize: 'clamp(28px, 4vw, 40px)', fontWeight: 700, letterSpacing: 'var(--tracking-tight)', lineHeight: 1.05 }}>
          {session?.name || 'Session'}
        </h1>
        {session && (
          <p className="fs-xs dim" style={{ margin: '8px 0 0' }}>
            {session.autonomous ? 'Autonomous' : 'Human-gated'} · preset {session.preset} · threshold {Math.round(session.threshold * 100)}% · edit {session.editMode}
          </p>
        )}
      </div>

      {sessionError && (
        <div style={{
          marginBottom: 'var(--sp-4)',
          background: 'color-mix(in oklab, var(--reject) 10%, transparent)',
          border: '1px solid color-mix(in oklab, var(--reject) 30%, transparent)',
          borderRadius: 10,
          padding: 'var(--sp-3)',
        }}>
          <p className="fs-sm" style={{ color: 'var(--reject)', margin: 0 }}>{sessionError}</p>
        </div>
      )}

      {running && !belongsToThisSession && (
        <div style={{
          marginBottom: 'var(--sp-4)',
          background: 'color-mix(in oklab, var(--warning) 12%, transparent)',
          border: '1px solid color-mix(in oklab, var(--warning) 35%, var(--line))',
          borderRadius: 10,
          padding: 'var(--sp-3)',
        }}>
          <p className="fs-sm" style={{ color: 'var(--warning)', margin: 0 }}>
            A run for “{status.sessionName}” is already active. Stop it before starting this session.
          </p>
        </div>
      )}

      {actionError && (
        <div style={{
          marginBottom: 'var(--sp-4)',
          background: 'color-mix(in oklab, var(--reject) 10%, transparent)',
          border: '1px solid color-mix(in oklab, var(--reject) 30%, transparent)',
          borderRadius: 10,
          padding: 'var(--sp-3)',
        }}>
          <p className="fs-sm" style={{ color: 'var(--reject)', margin: 0 }}>{actionError}</p>
        </div>
      )}

      <div className="card" style={{ marginBottom: 'var(--sp-4)' }}>
        <div className="flex jcsb aic" style={{ marginBottom: checks ? 'var(--sp-2)' : 0 }}>
          <div>
            <div className="meta" style={{ marginBottom: 4 }}>Preflight</div>
            <p className="fs-xs dim" style={{ margin: 0 }}>Verify Google, folders, edits, disk, and DB before starting.</p>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-uppercase"
            onClick={runPreflight}
            disabled={preflightBusy}
            style={{ flexShrink: 0 }}
          >
            {preflightBusy ? 'Checking…' : checks ? 'Re-run' : 'Run checks'}
          </button>
        </div>

        {preflightError && (
          <div style={{
            marginTop: 'var(--sp-3)',
            background: 'color-mix(in oklab, var(--reject) 10%, transparent)',
            border: '1px solid color-mix(in oklab, var(--reject) 30%, transparent)',
            borderRadius: 8,
            padding: 'var(--sp-3)',
          }}>
            <p className="fs-sm" style={{ color: 'var(--reject)', margin: 0 }}>{preflightError}</p>
          </div>
        )}

        {checks && (
          <div style={{ marginTop: 'var(--sp-3)' }}>
            {checks.map((check, index) => (
              <CheckRow key={`${check.check}-${index}`} check={check} />
            ))}
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 'var(--sp-4)' }}>
        <div className="meta" style={{ marginBottom: 'var(--sp-3)' }}>Live run</div>

        <div className="flex aic" style={{ gap: 'var(--sp-3)', marginBottom: 'var(--sp-3)' }}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: running ? 'var(--keep)' : 'var(--fg-4)',
              boxShadow: running ? '0 0 10px var(--keep)' : 'none',
              flexShrink: 0,
            }}
          />
          <div>
            <div className="fs-sm" style={{ fontWeight: 600 }}>
              {loading ? 'Checking run status…' : running ? `Running · ${status.phase || 'starting'}` : 'Idle'}
            </div>
            <div className="fs-xxs dim mono upper" style={{ marginTop: 2 }}>
              {status?.lastPollAt ? `Last poll ${new Date(status.lastPollAt).toLocaleTimeString()}` : 'No run yet'}
            </div>
          </div>
        </div>

        {error && (
          <p className="fs-xs" style={{ color: 'var(--reject)', margin: '0 0 var(--sp-3)' }}>{error}</p>
        )}

        {status?.sessionName && status?.sessionName !== session?.name && (
          <p className="fs-xs dim" style={{ margin: '0 0 var(--sp-3)' }}>
            Active run: {status.sessionName}
          </p>
        )}

        {nonZeroCounts.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 'var(--sp-3)' }}>
            {nonZeroCounts.map(([state, count]) => (
              <div
                key={state}
                style={{
                  padding: 'var(--sp-3)',
                  borderRadius: 8,
                  background: state === 'failed' ? 'color-mix(in oklab, var(--reject) 12%, var(--bg-3))' : 'var(--bg-3)',
                  border: `1px solid ${state === 'failed' ? 'color-mix(in oklab, var(--reject) 35%, var(--line))' : 'var(--line)'}`,
                  textAlign: 'center',
                }}
              >
                <div className="mono fs-xl" style={{ fontWeight: 500, color: state === 'failed' ? 'var(--reject)' : 'var(--accent)' }}>
                  {count}
                </div>
                <div className="fs-xxs dim mono upper" style={{ marginTop: 4 }}>
                  {STATE_LABELS[state] || state}
                </div>
              </div>
            ))}
          </div>
        )}

        {(status?.errors || []).length > 0 && (
          <div>
            <div className="meta" style={{ marginBottom: 'var(--sp-2)' }}>Errors</div>
            {status.errors.map((err, index) => (
              <div key={`${err.at}-${index}`} style={{
                padding: 'var(--sp-3)',
                borderRadius: 8,
                marginBottom: 'var(--sp-2)',
                background: 'color-mix(in oklab, var(--reject) 8%, var(--bg-3))',
                border: '1px solid color-mix(in oklab, var(--reject) 30%, var(--line))',
              }}>
                <div className="flex jcsb aic" style={{ gap: 'var(--sp-2)' }}>
                  <span className="fs-xs mono upper" style={{ color: 'var(--reject)' }}>{err.code}</span>
                  <span className="fs-xxs dim">{err.at ? new Date(err.at).toLocaleTimeString() : ''}</span>
                </div>
                <p className="fs-xs" style={{ color: 'var(--fg-2)', margin: '6px 0 0' }}>{err.detail}</p>
                {err.fix && (
                  <div style={{
                    marginTop: 'var(--sp-2)',
                    background: 'color-mix(in oklab, var(--warning) 12%, transparent)',
                    border: '1px solid color-mix(in oklab, var(--warning) 35%, var(--line))',
                    borderRadius: 6,
                    padding: '8px 10px',
                    display: 'flex',
                    gap: 8,
                    alignItems: 'flex-start',
                  }}>
                    <Icon name="info" size={14} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: 1 }} />
                    <p className="fs-xs" style={{ color: 'var(--fg)', margin: 0, lineHeight: 1.5 }}>{err.fix}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {failedCount > 0 && (
          <p className="fs-xs dim" style={{ margin: 'var(--sp-2) 0 0' }}>
            {failedCount} photo{failedCount !== 1 ? 's' : ''} failed — the run continues.
          </p>
        )}
      </div>

      <div style={{ position: 'sticky', bottom: 56, marginTop: 'var(--sp-4)', paddingTop: 'var(--sp-3)', background: 'var(--bg)', zIndex: 5 }}>
        {running && belongsToThisSession ? (
          <button
            type="button"
            className="btn btn-uppercase"
            onClick={handleStop}
            style={{
              width: '100%',
              background: 'color-mix(in oklab, var(--reject) 15%, var(--bg-3))',
              color: 'var(--reject)',
              borderColor: 'color-mix(in oklab, var(--reject) 45%, var(--line))',
            }}
          >
            <Icon name="x" size={16} />
            Stop run
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-uppercase"
            onClick={handleStart}
            disabled={starting || !session}
            style={{ width: '100%' }}
          >
            {starting ? 'Starting…' : 'Start run'}
          </button>
        )}
      </div>
    </div>
  )
}
