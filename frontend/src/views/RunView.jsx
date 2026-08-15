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

function formatRunDateRange(startedAt, endedAt) {
  if (!startedAt) return '—'
  const start = new Date(startedAt)
  const datePart = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const startTime = start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (!endedAt) {
    return `${datePart}, ${startTime} – ongoing`
  }
  const end = new Date(endedAt)
  const endTime = end.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${datePart}, ${startTime}–${endTime}`
}

function formatStatus(status) {
  if (!status) return 'Unknown'
  if (status === 'running') return 'Running'
  if (status === 'stopped') return 'Stopped'
  return status.charAt(0).toUpperCase() + status.slice(1)
}

export default function RunView() {
  const { sessionId, runId } = useParams()
  const navigate = useNavigate()

  const [session, setSession] = useState(null)
  const [sessionError, setSessionError] = useState(null)
  const [pastRun, setPastRun] = useState(null)
  const [loadingPastRun, setLoadingPastRun] = useState(true)
  const [actionError, setActionError] = useState(null)
  const [approving, setApproving] = useState(false)
  const [toast, setToast] = useState(null)

  const { status, loading: pollingLoading, error: runError, refresh, stop } = useSessionRun()

  const isLiveRun = Boolean(
    status?.running &&
    String(status?.runId) === String(runId) &&
    Number(status?.sessionId) === Number(sessionId)
  )

  useEffect(() => {
    let cancelled = false
    sessionsClient.getSession(sessionId)
      .then((data) => { if (!cancelled) setSession(data.session) })
      .catch((err) => { if (!cancelled) setSessionError(err.message) })
    return () => { cancelled = true }
  }, [sessionId])

  const fetchPastRun = useCallback(async () => {
    setLoadingPastRun(true)
    try {
      const data = await sessionsClient.listRuns(sessionId)
      const runs = data.runs || []
      const found = runs.find((r) => String(r.id) === String(runId))
      setPastRun(found || null)
    } catch {
      setPastRun(null)
    } finally {
      setLoadingPastRun(false)
    }
  }, [sessionId, runId])

  useEffect(() => {
    fetchPastRun()
  }, [fetchPastRun])

  const handleStop = useCallback(async () => {
    setActionError(null)
    try {
      await stop()
      await fetchPastRun()
    } catch (err) {
      setActionError(err.message)
    }
  }, [stop, fetchPastRun])

  const handleApproveAll = useCallback(async () => {
    if (approving) return
    setApproving(true)
    setActionError(null)
    try {
      const res = await sessionsClient.approveAll(runId)
      setToast(`Approved ${res.count || 0} photo${res.count === 1 ? '' : 's'}`)
      refresh()
      fetchPastRun()
    } catch (err) {
      setActionError(err.message)
    } finally {
      setApproving(false)
    }
  }, [approving, runId, refresh, fetchPastRun])

  useEffect(() => {
    if (!toast) return undefined
    const t = setTimeout(() => setToast(null), 2500)
    return () => clearTimeout(t)
  }, [toast])

  // Determine active vs past run data
  const currentCounts = isLiveRun ? (status?.counts || {}) : (pastRun?.counts || {})
  const currentStatus = isLiveRun ? 'running' : (pastRun?.status || 'stopped')
  const currentPhase = isLiveRun ? (status?.phase || 'running') : (pastRun?.phase || null)
  const currentErrors = isLiveRun ? (status?.errors || []) : (pastRun?.error ? [{ detail: pastRun.error }] : [])
  const lastPollAt = isLiveRun ? status?.lastPollAt : pastRun?.lastPollAt

  const failedCount = currentCounts.failed || 0
  const awaitingReviewCount = currentCounts.awaiting_review || 0
  const nonZeroCounts = Object.entries(currentCounts).filter(([, n]) => n > 0)

  const isNotFound = !isLiveRun && !loadingPastRun && !pastRun

  return (
    <div className="view" style={{ padding: 'var(--pad)', paddingBottom: 96 }}>
      {/* Back button */}
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => navigate(`/sessions/${sessionId}`)}
        style={{ alignSelf: 'flex-start', marginBottom: 'var(--sp-4)' }}
      >
        <Icon name="arrowL" size={16} />
        Back to session
      </button>

      {/* Header */}
      <div style={{ marginBottom: 'var(--sp-6)' }}>
        <div className="meta" style={{ color: 'var(--accent)', marginBottom: 8 }}>· Session Run</div>
        <h1 style={{ margin: 0, fontSize: 'clamp(28px, 4vw, 40px)', fontWeight: 700, letterSpacing: 'var(--tracking-tight)', lineHeight: 1.05 }}>
          Run #{runId} {session?.name ? `· ${session.name}` : ''}
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

      {toast && (
        <div role="status" aria-live="polite" style={{
          position: 'fixed', bottom: 92, left: '50%', transform: 'translateX(-50%)', zIndex: 120,
          padding: '10px 18px', borderRadius: 10,
          background: 'var(--bg-2)', border: '1px solid var(--line)', boxShadow: 'var(--shadow-2)',
          fontSize: 'var(--fs-xs)', color: 'var(--fg)',
          animation: 'bbp-fade-in .25s var(--ease-out)', pointerEvents: 'none', whiteSpace: 'nowrap',
        }}>
          <span style={{ width: 6, height: 6, borderRadius: 99, background: 'var(--accent)', boxShadow: '0 0 6px var(--accent)', display: 'inline-block', marginRight: 8, verticalAlign: 'middle' }} />
          {toast}
        </div>
      )}

      {isNotFound ? (
        <div className="card" style={{ padding: 'var(--sp-7)', textAlign: 'center', maxWidth: 480, margin: 'var(--sp-6) auto' }}>
          <Icon name="aperture" size={48} style={{ color: 'var(--fg-4)', margin: '0 auto var(--sp-4)' }} />
          <div className="fs-lg" style={{ fontWeight: 600, marginBottom: 'var(--sp-2)' }}>Run not found or inactive</div>
          <p className="fs-sm" style={{ color: 'var(--fg-3)', lineHeight: 1.5, margin: '0 0 var(--sp-5)' }}>
            Run #{runId} could not be found for this session or has ended.
          </p>
          <button
            type="button"
            className="btn btn-primary btn-uppercase"
            onClick={() => navigate(`/sessions/${sessionId}`)}
            style={{ margin: '0 auto', height: 44, padding: '0 20px' }}
          >
            Go to session workspace
          </button>
        </div>
      ) : (
        <>
          {/* Status Card */}
          <div className="card" style={{ marginBottom: 'var(--sp-4)' }}>
            <div className="meta" style={{ marginBottom: 'var(--sp-3)' }}>
              {isLiveRun ? 'Live Run' : 'Run Summary'}
            </div>

            <div className="flex aic" style={{ gap: 'var(--sp-3)', marginBottom: 'var(--sp-3)' }}>
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  background: isLiveRun ? 'var(--keep)' : 'var(--fg-4)',
                  boxShadow: isLiveRun ? '0 0 10px var(--keep)' : 'none',
                  flexShrink: 0,
                }}
              />
              <div>
                <div className="fs-sm" style={{ fontWeight: 600 }}>
                  {isLiveRun
                    ? `Running · ${currentPhase}`
                    : `${formatStatus(currentStatus)}${currentPhase ? ` (${currentPhase})` : ''}`}
                </div>
                <div className="fs-xxs dim mono upper" style={{ marginTop: 2 }}>
                  {isLiveRun && lastPollAt
                    ? `Last poll ${new Date(lastPollAt).toLocaleTimeString()}`
                    : pastRun
                    ? formatRunDateRange(pastRun.startedAt, pastRun.endedAt)
                    : ''}
                </div>
              </div>
            </div>

            {runError && isLiveRun && (
              <p className="fs-xs" style={{ color: 'var(--reject)', margin: '0 0 var(--sp-3)' }}>{runError}</p>
            )}

            {/* Awaiting review action callout */}
            {awaitingReviewCount > 0 && (
              <div style={{
                background: 'color-mix(in oklab, var(--maybe) 10%, var(--bg-3))',
                border: '1px solid color-mix(in oklab, var(--maybe) 35%, var(--line))',
                borderRadius: 8,
                padding: 'var(--sp-3) var(--sp-4)',
                marginBottom: 'var(--sp-4)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: 'var(--sp-2)',
              }}>
                <div>
                  <div className="fs-sm" style={{ fontWeight: 600, color: 'var(--fg)' }}>
                    {awaitingReviewCount} photo{awaitingReviewCount !== 1 ? 's' : ''} awaiting review
                  </div>
                  <div className="fs-xxs dim">Photos scored above threshold are queued for review</div>
                </div>
                <div className="flex aic" style={{ gap: 8 }}>
                  <button
                    type="button"
                    className="btn btn-primary btn-uppercase"
                    onClick={() => navigate('/review-queue')}
                    style={{ height: 36, fontSize: 'var(--fs-xs)', padding: '0 12px' }}
                  >
                    Review queue
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-uppercase"
                    onClick={handleApproveAll}
                    disabled={approving}
                    style={{ height: 36, fontSize: 'var(--fs-xs)', padding: '0 12px' }}
                  >
                    {approving ? 'Approving…' : 'Approve all'}
                  </button>
                </div>
              </div>
            )}

            {/* Photo State Counts */}
            {nonZeroCounts.length > 0 ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8, marginBottom: 'var(--sp-3)' }}>
                {nonZeroCounts.map(([state, count]) => (
                  <div
                    key={state}
                    style={{
                      padding: 'var(--sp-3)',
                      borderRadius: 8,
                      background: state === 'failed'
                        ? 'color-mix(in oklab, var(--reject) 12%, var(--bg-3))'
                        : state === 'awaiting_review'
                        ? 'color-mix(in oklab, var(--maybe) 10%, var(--bg-3))'
                        : 'var(--bg-3)',
                      border: `1px solid ${
                        state === 'failed'
                          ? 'color-mix(in oklab, var(--reject) 35%, var(--line))'
                          : state === 'awaiting_review'
                          ? 'color-mix(in oklab, var(--maybe) 35%, var(--line))'
                          : 'var(--line)'
                      }`,
                      textAlign: 'center',
                    }}
                  >
                    <div className="mono fs-xl" style={{
                      fontWeight: 500,
                      color: state === 'failed'
                        ? 'var(--reject)'
                        : state === 'awaiting_review'
                        ? 'var(--maybe)'
                        : state === 'exported'
                        ? 'var(--keep)'
                        : 'var(--accent)',
                    }}>
                      {count}
                    </div>
                    <div className="fs-xxs dim mono upper" style={{ marginTop: 4 }}>
                      {STATE_LABELS[state] || state}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="fs-xs dim" style={{ margin: 'var(--sp-2) 0' }}>
                {isLiveRun ? 'Watching inbox for photos…' : 'No photos recorded for this run.'}
              </p>
            )}

            {/* Errors */}
            {currentErrors.length > 0 && (
              <div style={{ marginTop: 'var(--sp-3)' }}>
                <div className="meta" style={{ marginBottom: 'var(--sp-2)' }}>Errors</div>
                {currentErrors.map((err, index) => (
                  <div key={`${err.at || index}-${index}`} style={{
                    padding: 'var(--sp-3)',
                    borderRadius: 8,
                    marginBottom: 'var(--sp-2)',
                    background: 'color-mix(in oklab, var(--reject) 8%, var(--bg-3))',
                    border: '1px solid color-mix(in oklab, var(--reject) 30%, var(--line))',
                  }}>
                    <div className="flex jcsb aic" style={{ gap: 'var(--sp-2)' }}>
                      <span className="fs-xs mono upper" style={{ color: 'var(--reject)' }}>{err.code || 'Error'}</span>
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
                {failedCount} photo{failedCount !== 1 ? 's' : ''} failed.
              </p>
            )}
          </div>

          {/* Sticky Action Footer */}
          <div style={{ position: 'sticky', bottom: 56, marginTop: 'var(--sp-4)', paddingTop: 'var(--sp-3)', background: 'var(--bg)', zIndex: 5 }}>
            {isLiveRun ? (
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
                className="btn btn-ghost btn-uppercase"
                onClick={() => navigate(`/sessions/${sessionId}`)}
                style={{ width: '100%' }}
              >
                <Icon name="arrowL" size={16} />
                Back to session workspace
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
