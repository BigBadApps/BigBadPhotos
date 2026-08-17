import { useCallback, useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import Icon from '../components/Icon'
import CheckRow from '../components/CheckRow'
import GoogleDriveFolderPicker from '../components/GoogleDriveFolderPicker'
import { OblToggle, Chip, FieldLabel, PickerRow, PRESETS } from '../components/SessionFormParts'
import * as sessionsClient from '../api/sessionsClient'
import { useSessionRun } from '../hooks/useSessionRun'
import { formatRunDateRange, formatStatus } from '../utils/formatters'

export default function SessionAreaView() {
  const { sessionId } = useParams()
  const navigate = useNavigate()

  const [session, setSession] = useState(null)
  const [loadingSession, setLoadingSession] = useState(true)
  const [sessionError, setSessionError] = useState(null)

  const [runs, setRuns] = useState([])
  const [loadingRuns, setLoadingRuns] = useState(true)
  const [runsError, setRunsError] = useState(null)

  // Gallery state
  const [galleryInfo, setGalleryInfo] = useState(null)
  const [loadingGallery, setLoadingGallery] = useState(true)
  const [galleryError, setGalleryError] = useState(null)
  const [copiedLink, setCopiedLink] = useState(false)
  const [galleryActionBusy, setGalleryActionBusy] = useState(false)
  const [confirmRevoke, setConfirmRevoke] = useState(false)
  const [confirmRegen, setConfirmRegen] = useState(false)
  const [togglingGallery, setTogglingGallery] = useState(false)

  const [checks, setChecks] = useState(null)
  const [preflightBusy, setPreflightBusy] = useState(false)
  const [preflightError, setPreflightError] = useState(null)
  const [starting, setStarting] = useState(false)
  const [actionError, setActionError] = useState(null)

  const [togglingAutonomous, setTogglingAutonomous] = useState(false)

  // Session Edit Form state
  const [editOpen, setEditOpen] = useState(false)
  const [editForm, setEditForm] = useState(null)
  const [savingEdit, setSavingEdit] = useState(false)
  const [saveEditError, setSaveEditError] = useState(null)
  const [pickerTarget, setPickerTarget] = useState(null)

  const { status, refresh: refreshRunStatus, stop } = useSessionRun()

  const fetchSession = useCallback(async () => {
    try {
      const data = await sessionsClient.getSession(sessionId)
      setSession(data.session)
      setSessionError(null)
    } catch (err) {
      setSessionError(err.message || 'Failed to load session')
    } finally {
      setLoadingSession(false)
    }
  }, [sessionId])

  const fetchRuns = useCallback(async () => {
    try {
      const data = await sessionsClient.listRuns(sessionId)
      setRuns(data.runs || [])
      setRunsError(null)
    } catch (err) {
      setRunsError(err.message || 'Failed to load run history')
    } finally {
      setLoadingRuns(false)
    }
  }, [sessionId])

  const fetchGallery = useCallback(async (isPolling = false) => {
    if (!sessionId) return
    if (!isPolling) setLoadingGallery(true)
    try {
      const data = await sessionsClient.fetchGalleryInfo(sessionId)
      setGalleryInfo(data)
      setGalleryError(null)
    } catch (err) {
      if (!isPolling) {
        setGalleryError(err.message || 'Failed to load gallery info')
      }
    } finally {
      if (!isPolling) setLoadingGallery(false)
    }
  }, [sessionId])

  useEffect(() => {
    fetchSession()
    fetchRuns()
    fetchGallery(false)
    const interval = setInterval(() => {
      fetchGallery(true)
    }, 15000)
    return () => clearInterval(interval)
  }, [fetchSession, fetchRuns, fetchGallery])

  const handleAutonomousToggle = useCallback(async (nextVal) => {
    if (!session || togglingAutonomous) return
    setTogglingAutonomous(true)
    setActionError(null)
    const prevVal = session.autonomous
    setSession((prev) => ({ ...prev, autonomous: nextVal }))
    try {
      const res = await sessionsClient.updateSession(sessionId, { autonomous: nextVal })
      if (res.session) setSession(res.session)
    } catch (err) {
      setSession((prev) => ({ ...prev, autonomous: prevVal }))
      setActionError(`Failed to update autonomous mode: ${err.message}`)
    } finally {
      setTogglingAutonomous(false)
    }
  }, [session, togglingAutonomous, sessionId])

  const handleStart = useCallback(async () => {
    if (starting || preflightBusy) return
    setPreflightBusy(true)
    setPreflightError(null)
    setActionError(null)
    try {
      const preflightData = await sessionsClient.preflight(sessionId)
      const checkList = preflightData.checks || []
      setChecks(checkList)
      const allPassed = checkList.length > 0 && checkList.every((c) => c.ok)
      if (!allPassed) {
        setPreflightBusy(false)
        return
      }
      setStarting(true)
      setPreflightBusy(false)
      const result = await sessionsClient.startRun(sessionId)
      refreshRunStatus()
      const newRunId = result.runId || result.id
      if (newRunId) {
        navigate(`/sessions/${sessionId}/run/${newRunId}`)
      } else {
        fetchRuns()
      }
    } catch (err) {
      setPreflightError(err.message || 'Failed to start run')
    } finally {
      setPreflightBusy(false)
      setStarting(false)
    }
  }, [starting, preflightBusy, sessionId, refreshRunStatus, navigate, fetchRuns])

  const handleStop = useCallback(async () => {
    setActionError(null)
    try {
      await stop()
      fetchRuns()
    } catch (err) {
      setActionError(err.message || 'Failed to stop run')
    }
  }, [stop, fetchRuns])

  const handleCopyLink = useCallback((url) => {
    if (!url) return
    navigator.clipboard.writeText(url).then(() => {
      setCopiedLink(true)
      setTimeout(() => setCopiedLink(false), 2000)
    }).catch(() => {})
  }, [])

  const handleGalleryToggle = useCallback(async (nextVal) => {
    if (!session || togglingGallery) return
    setTogglingGallery(true)
    setActionError(null)
    const prevVal = session.galleryEnabled ?? session.gallery_enabled ?? true
    setSession((prev) => ({ ...prev, galleryEnabled: nextVal, gallery_enabled: nextVal }))
    try {
      const res = await sessionsClient.updateSession(sessionId, { galleryEnabled: nextVal })
      if (res.session) setSession(res.session)
      await fetchGallery(false)
    } catch (err) {
      setSession((prev) => ({ ...prev, galleryEnabled: prevVal, gallery_enabled: prevVal }))
      setActionError(`Failed to update gallery status: ${err.message}`)
    } finally {
      setTogglingGallery(false)
    }
  }, [session, togglingGallery, sessionId, fetchGallery])

  const handleRevoke = useCallback(async () => {
    if (galleryActionBusy) return
    setGalleryActionBusy(true)
    setActionError(null)
    try {
      await sessionsClient.revokeGallery(sessionId)
      setConfirmRevoke(false)
      await fetchGallery(false)
    } catch (err) {
      setActionError(`Failed to revoke gallery link: ${err.message}`)
    } finally {
      setGalleryActionBusy(false)
    }
  }, [galleryActionBusy, sessionId, fetchGallery])

  const handleRegenerate = useCallback(async () => {
    if (galleryActionBusy) return
    setGalleryActionBusy(true)
    setActionError(null)
    try {
      await sessionsClient.regenerateGallery(sessionId)
      setConfirmRegen(false)
      await fetchGallery(false)
    } catch (err) {
      setActionError(`Failed to regenerate gallery link: ${err.message}`)
    } finally {
      setGalleryActionBusy(false)
    }
  }, [galleryActionBusy, sessionId, fetchGallery])


  // Edit form handlers
  const openEdit = useCallback(() => {
    if (!session) return
    setEditForm({
      name: session.name || '',
      sourceFolderId: session.sourceFolderId || '',
      sourceFolderName: session.sourceFolderName || '',
      exportFolderId: session.exportFolderId || '',
      exportFolderName: session.exportFolderName || '',
      autonomous: Boolean(session.autonomous),
      preset: session.preset || 'balanced',
      threshold: typeof session.threshold === 'number' ? session.threshold : PRESETS.balanced,
      burstBestOnly: session.burstBestOnly !== false,
      editMode: session.editMode || 'off',
      editStrength: session.editStrength || 'medium',
      pollSeconds: session.pollSeconds || 30,
    })
    setSaveEditError(null)
    setEditOpen(true)
  }, [session])

  const closeEdit = useCallback(() => {
    setEditOpen(false)
    setEditForm(null)
    setSaveEditError(null)
    setConfirmDelete(false)
  }, [])

  const setEditField = useCallback((key, value) => {
    setEditForm((prev) => (prev ? { ...prev, [key]: value } : prev))
  }, [])

  const handleEditPreset = useCallback((preset) => {
    setEditField('preset', preset)
    setEditField('threshold', PRESETS[preset])
  }, [setEditField])

  const handleEditThreshold = useCallback((value) => {
    setEditField('threshold', value)
    setEditField('preset', 'custom')
  }, [setEditField])

  const handlePickFolder = useCallback(({ id, name }) => {
    if (pickerTarget === 'source') {
      setEditField('sourceFolderId', id)
      setEditField('sourceFolderName', name)
    } else if (pickerTarget === 'export') {
      setEditField('exportFolderId', id)
      setEditField('exportFolderName', name)
    }
    setPickerTarget(null)
  }, [pickerTarget, setEditField])

  const handleSaveEdit = useCallback(async () => {
    if (!editForm || savingEdit) return
    if (!editForm.name.trim()) {
      setSaveEditError('Name is required')
      return
    }
    if (!editForm.sourceFolderId || !editForm.exportFolderId) {
      setSaveEditError('Pick a source and an export folder')
      return
    }
    setSavingEdit(true)
    setSaveEditError(null)
    const payload = {
      name: editForm.name.trim(),
      sourceFolderId: editForm.sourceFolderId,
      sourceFolderName: editForm.sourceFolderName,
      exportFolderId: editForm.exportFolderId,
      exportFolderName: editForm.exportFolderName,
      autonomous: editForm.autonomous,
      preset: editForm.preset,
      threshold: editForm.threshold,
      burstBestOnly: editForm.burstBestOnly,
      editMode: editForm.editMode,
      editStrength: editForm.editStrength,
      pollSeconds: Number(editForm.pollSeconds) || 30,
    }
    try {
      const res = await sessionsClient.updateSession(sessionId, payload)
      if (res.session) setSession(res.session)
      closeEdit()
    } catch (err) {
      setSaveEditError(err.message || 'Failed to update session')
    } finally {
      setSavingEdit(false)
    }
  }, [editForm, savingEdit, sessionId, closeEdit])

  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const handleDelete = useCallback(async () => {
    if (!confirmDelete || deleting) return
    setDeleting(true)
    try {
      await sessionsClient.deleteSession(sessionId)
      navigate('/')
    } catch (err) {
      setSaveEditError(err.message || 'Failed to delete session')
      setConfirmDelete(false)
    } finally {
      setDeleting(false)
    }
  }, [confirmDelete, deleting, sessionId, navigate])

  const isRunning = Boolean(status?.running)
  const belongsToThisSession = isRunning && Number(status?.sessionId) === Number(sessionId)
  const isOtherSessionRunning = isRunning && !belongsToThisSession

  const thresholdPct = Math.round(((session?.threshold ?? PRESETS.balanced) * 100))
  const presetName = session?.preset
    ? session.preset.charAt(0).toUpperCase() + session.preset.slice(1)
    : 'Balanced'

  const editModeDisplay = session?.editMode === 'off'
    ? 'Off'
    : session?.editMode === 'topaz'
    ? 'Topaz Photo AI'
    : `Auto (${session?.editStrength || 'medium'})`

  if (loadingSession) {
    return (
      <div className="view" style={{ padding: 'var(--pad)', display: 'grid', placeItems: 'center' }}>
        <p className="fs-sm dim">Loading session…</p>
      </div>
    )
  }

  if (sessionError) {
    return (
      <div className="view" style={{ padding: 'var(--pad)' }}>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => navigate('/')}
          style={{ alignSelf: 'flex-start', marginBottom: 'var(--sp-4)' }}
        >
          <Icon name="arrowL" size={16} />
          Sessions
        </button>
        <div style={{
          background: 'color-mix(in oklab, var(--reject) 10%, transparent)',
          border: '1px solid color-mix(in oklab, var(--reject) 30%, transparent)',
          borderRadius: 10,
          padding: 'var(--sp-4)',
        }}>
          <p className="fs-sm" style={{ color: 'var(--reject)', margin: 0 }}>{sessionError}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="view" style={{ padding: 'var(--pad)', paddingBottom: 96 }}>
      {/* 1. Back button */}
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => navigate('/')}
        style={{ alignSelf: 'flex-start', marginBottom: 'var(--sp-4)' }}
      >
        <Icon name="arrowL" size={16} />
        Sessions
      </button>

      {/* 2. Config summary */}
      <div style={{ marginBottom: 'var(--sp-6)' }}>
        <div className="flex jcsb aic" style={{ gap: 'var(--sp-3)', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="meta" style={{ color: 'var(--accent)', marginBottom: 6 }}>· Photo Session</div>
            <h1 style={{
              margin: 0,
              fontSize: 'clamp(28px, 4vw, 40px)',
              fontWeight: 700,
              letterSpacing: 'var(--tracking-tight)',
              lineHeight: 1.05,
              wordBreak: 'break-word',
            }}>
              {session?.name || 'Session'}
            </h1>
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={openEdit}
            title="Edit session settings"
            aria-label="Edit session settings"
            style={{ height: 40, padding: '0 12px', gap: 6, flexShrink: 0 }}
          >
            <Icon name="pencil" size={16} />
            <span className="fs-xs">Edit</span>
          </button>
        </div>

        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          marginTop: 'var(--sp-3)',
          color: 'var(--fg-2)',
          fontSize: 'var(--fs-sm)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="meta" style={{ width: 64, flexShrink: 0 }}>Source</span>
            <span style={{ color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              Drive · {session?.sourceFolderName || session?.sourceFolderId || '—'}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="meta" style={{ width: 64, flexShrink: 0 }}>Export</span>
            <span style={{ color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              Drive · {session?.exportFolderName || session?.exportFolderId || '—'}
            </span>
          </div>
        </div>
      </div>

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

      {isOtherSessionRunning && (
        <div style={{
          marginBottom: 'var(--sp-4)',
          background: 'color-mix(in oklab, var(--warning) 12%, transparent)',
          border: '1px solid color-mix(in oklab, var(--warning) 35%, var(--line))',
          borderRadius: 10,
          padding: 'var(--sp-3)',
        }}>
          <p className="fs-sm" style={{ color: 'var(--warning)', margin: 0 }}>
            A run for “{status.sessionName || 'another session'}” is already active. Stop it before starting this session.
          </p>
        </div>
      )}

      {/* 3. Run controls card */}
      <div className="card" style={{ marginBottom: 'var(--sp-6)', padding: 'var(--sp-5)' }}>
        <div className="meta" style={{ color: 'var(--accent)', marginBottom: 'var(--sp-4)' }}>Run Controls</div>

        {/* Active run banner if run belongs to this session */}
        {belongsToThisSession ? (
          <div style={{
            background: 'color-mix(in oklab, var(--keep) 8%, var(--bg-3))',
            border: '1px solid color-mix(in oklab, var(--keep) 30%, var(--line))',
            borderRadius: 10,
            padding: 'var(--sp-4)',
            marginBottom: 'var(--sp-5)',
          }}>
            <div className="flex jcsb aic" style={{ gap: 'var(--sp-3)', flexWrap: 'wrap', marginBottom: 'var(--sp-3)' }}>
              <div className="flex aic" style={{ gap: 10 }}>
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    background: 'var(--keep)',
                    boxShadow: '0 0 10px var(--keep)',
                    flexShrink: 0,
                  }}
                />
                <div>
                  <div className="fs-sm" style={{ fontWeight: 600, color: 'var(--fg)' }}>
                    Run in progress · {status.phase || 'running'}
                  </div>
                  <div className="fs-xxs dim mono upper" style={{ marginTop: 2 }}>
                    Run #{status.runId} {status.lastPollAt ? `· last poll ${new Date(status.lastPollAt).toLocaleTimeString()}` : ''}
                  </div>
                </div>
              </div>

              <div className="flex aic" style={{ gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-primary btn-uppercase"
                  onClick={() => navigate(`/sessions/${sessionId}/run/${status.runId}`)}
                  style={{ height: 38, fontSize: 'var(--fs-xs)', padding: '0 14px', gap: 6 }}
                >
                  <Icon name="arrowR" size={14} />
                  View run
                </button>
                <button
                  type="button"
                  className="btn btn-uppercase"
                  onClick={handleStop}
                  style={{
                    height: 38,
                    fontSize: 'var(--fs-xs)',
                    padding: '0 14px',
                    background: 'color-mix(in oklab, var(--reject) 15%, var(--bg-3))',
                    color: 'var(--reject)',
                    borderColor: 'color-mix(in oklab, var(--reject) 45%, var(--line))',
                  }}
                >
                  <Icon name="x" size={14} />
                  Stop
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {/* Controls config summary & autonomous toggle */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: 'var(--sp-4)',
          paddingBottom: 'var(--sp-4)',
          borderBottom: '1px solid var(--line)',
          marginBottom: 'var(--sp-4)',
        }}>
          {/* Autonomous toggle */}
          <div className="flex jcsb aic" style={{
            background: 'var(--bg-3)',
            padding: 'var(--sp-3) var(--sp-4)',
            borderRadius: 8,
            border: '1px solid var(--line)',
          }}>
            <div>
              <div className="fs-sm" style={{ fontWeight: 600 }}>Autonomous</div>
              <div className="fs-xxs dim mono upper" style={{ marginTop: 2 }}>
                {session?.autonomous ? 'Exports without review' : 'Human review required'}
              </div>
            </div>
            <OblToggle
              checked={Boolean(session?.autonomous)}
              disabled={togglingAutonomous}
              onChange={handleAutonomousToggle}
            />
          </div>

          {/* Threshold display */}
          <div style={{
            background: 'var(--bg-3)',
            padding: 'var(--sp-3) var(--sp-4)',
            borderRadius: 8,
            border: '1px solid var(--line)',
          }}>
            <div className="meta" style={{ marginBottom: 2 }}>Keeper Threshold</div>
            <div className="fs-sm" style={{ fontWeight: 600, color: 'var(--accent)' }}>
              {presetName} · {thresholdPct}%
            </div>
          </div>

          {/* Edit mode display */}
          <div style={{
            background: 'var(--bg-3)',
            padding: 'var(--sp-3) var(--sp-4)',
            borderRadius: 8,
            border: '1px solid var(--line)',
          }}>
            <div className="meta" style={{ marginBottom: 2 }}>Edit Mode</div>
            <div className="fs-sm" style={{ fontWeight: 600 }}>
              {editModeDisplay}
            </div>
          </div>
        </div>

        {/* Preflight error */}
        {preflightError && (
          <div style={{
            marginBottom: 'var(--sp-4)',
            background: 'color-mix(in oklab, var(--reject) 10%, transparent)',
            border: '1px solid color-mix(in oklab, var(--reject) 30%, transparent)',
            borderRadius: 8,
            padding: 'var(--sp-3)',
          }}>
            <p className="fs-sm" style={{ color: 'var(--reject)', margin: 0 }}>{preflightError}</p>
          </div>
        )}

        {/* Preflight checks results */}
        {checks && checks.length > 0 && (
          <div style={{
            marginBottom: 'var(--sp-4)',
            background: 'var(--bg-3)',
            borderRadius: 8,
            border: '1px solid var(--line)',
            overflow: 'hidden',
          }}>
            <div className="flex jcsb aic" style={{ padding: 'var(--sp-3) var(--sp-4)', background: 'var(--bg-2)' }}>
              <span className="meta">Preflight Results</span>
              {checks.every((c) => c.ok) ? (
                <span className="fs-xs mono upper" style={{ color: 'var(--keep)' }}>All checks passed</span>
              ) : (
                <span className="fs-xs mono upper" style={{ color: 'var(--reject)' }}>Some checks failed</span>
              )}
            </div>
            {checks.map((check, idx) => (
              <CheckRow key={`${check.check}-${idx}`} check={check} />
            ))}
          </div>
        )}

        {/* Start button */}
        {!belongsToThisSession && (
          <button
            type="button"
            className="btn btn-primary btn-uppercase"
            onClick={handleStart}
            disabled={starting || preflightBusy || isOtherSessionRunning}
            style={{ width: '100%', height: 48, fontSize: 'var(--fs-sm)', gap: 8 }}
          >
            {preflightBusy ? 'Running preflight checks…' : starting ? 'Starting run…' : (
              <>
                <Icon name="arrowR" size={16} />
                <span>Start run</span>
              </>
            )}
          </button>
        )}
      </div>

      {/* 4. Client Gallery card */}
      <div className="card" style={{ marginBottom: 'var(--sp-6)', padding: 'var(--sp-5)' }}>
        <div className="flex jcsb aic" style={{ marginBottom: 'var(--sp-4)' }}>
          <div className="meta" style={{ color: 'var(--accent)' }}>Client Gallery</div>
          <div className="flex aic" style={{ gap: 8 }}>
            <span className="fs-xs dim">Enabled</span>
            <OblToggle
              checked={Boolean(session?.galleryEnabled ?? session?.gallery_enabled ?? true)}
              disabled={togglingGallery}
              onChange={handleGalleryToggle}
            />
          </div>
        </div>

        {galleryError && (
          <div style={{
            marginBottom: 'var(--sp-4)',
            background: 'color-mix(in oklab, var(--reject) 10%, transparent)',
            border: '1px solid color-mix(in oklab, var(--reject) 30%, transparent)',
            borderRadius: 8,
            padding: 'var(--sp-3)',
          }}>
            <p className="fs-sm" style={{ color: 'var(--reject)', margin: 0 }}>{galleryError}</p>
          </div>
        )}

        {!(session?.galleryEnabled ?? session?.gallery_enabled ?? true) ? (
          <div style={{
            padding: 'var(--sp-4)',
            borderRadius: 8,
            background: 'var(--bg-3)',
            border: '1px solid var(--line)',
            textAlign: 'center',
          }}>
            <p className="fs-sm" style={{ color: 'var(--fg-3)', margin: 0 }}>
              Client gallery is currently disabled for this session. Enable it above to share photos and collect client favorites.
            </p>
          </div>
        ) : (
          <>
            {/* Live Stats */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
              gap: 'var(--sp-3)',
              marginBottom: 'var(--sp-4)',
            }}>
              <div style={{
                padding: 'var(--sp-3)',
                background: 'var(--bg-3)',
                borderRadius: 8,
                border: '1px solid var(--line)',
              }}>
                <div className="meta" style={{ marginBottom: 4 }}>Favorites</div>
                <div className="fs-xl mono" style={{ fontWeight: 700, color: 'var(--keep)' }}>
                  {galleryInfo?.stats?.favoritesCount ?? galleryInfo?.stats?.favorites_count ?? 0}
                </div>
              </div>
              <div style={{
                padding: 'var(--sp-3)',
                background: 'var(--bg-3)',
                borderRadius: 8,
                border: '1px solid var(--line)',
              }}>
                <div className="meta" style={{ marginBottom: 4 }}>Comments</div>
                <div className="fs-xl mono" style={{ fontWeight: 700, color: 'var(--accent)' }}>
                  {galleryInfo?.stats?.commentsCount ?? galleryInfo?.stats?.comments_count ?? 0}
                </div>
              </div>
              <div style={{
                padding: 'var(--sp-3)',
                background: 'var(--bg-3)',
                borderRadius: 8,
                border: '1px solid var(--line)',
              }}>
                <div className="meta" style={{ marginBottom: 4 }}>Unique Visitors</div>
                <div className="fs-xl mono" style={{ fontWeight: 700, color: 'var(--fg)' }}>
                  {galleryInfo?.stats?.uniqueVisitors ?? galleryInfo?.stats?.unique_visitors ?? 0}
                </div>
              </div>
            </div>

            {/* Gallery URL Link Bar */}
            {galleryInfo?.token ? (
              <div style={{ marginBottom: 'var(--sp-4)' }}>
                <FieldLabel>Gallery Share Link</FieldLabel>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  background: 'var(--bg-3)',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  padding: '6px 8px 6px 12px',
                }}>
                  <span className="mono fs-xs" style={{
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    color: 'var(--fg-2)',
                  }}>
                    {`${window.location.origin}/gallery/${galleryInfo.token}`}
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => handleCopyLink(`${window.location.origin}/gallery/${galleryInfo.token}`)}
                    style={{ height: 34, padding: '0 10px', gap: 6, flexShrink: 0 }}
                  >
                    <Icon name={copiedLink ? 'check' : 'sparkle'} size={14} style={{ color: copiedLink ? 'var(--keep)' : undefined }} />
                    <span className="fs-xs">{copiedLink ? 'Copied!' : 'Copy Link'}</span>
                  </button>
                  <a
                    href={`/gallery/${galleryInfo.token}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-ghost"
                    style={{ height: 34, padding: '0 10px', gap: 6, flexShrink: 0, textDecoration: 'none' }}
                  >
                    <Icon name="arrowR" size={14} />
                    <span className="fs-xs">View</span>
                  </a>
                </div>
              </div>
            ) : (
              <div style={{
                padding: 'var(--sp-3)',
                marginBottom: 'var(--sp-4)',
                background: 'var(--bg-3)',
                borderRadius: 8,
                border: '1px solid var(--line)',
                color: 'var(--fg-3)',
                fontSize: 'var(--fs-sm)',
              }}>
                No active gallery link. Click Regenerate below to create one.
              </div>
            )}

            {/* Primary & Secondary Action Buttons */}
            <div className="flex jcsb aic" style={{ gap: 'var(--sp-3)', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => navigate(`/sessions/${sessionId}/favorites`)}
                style={{ height: 40, padding: '0 16px', gap: 8, fontSize: 'var(--fs-xs)' }}
              >
                <Icon name="sparkle" size={15} />
                <span>Review Favorites</span>
              </button>

              <div className="flex aic" style={{ gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setConfirmRegen(true)}
                  disabled={galleryActionBusy}
                  style={{ height: 36, padding: '0 12px', fontSize: 'var(--fs-xs)' }}
                >
                  Regenerate Link
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setConfirmRevoke(true)}
                  disabled={galleryActionBusy || !galleryInfo?.token}
                  style={{
                    height: 36,
                    padding: '0 12px',
                    fontSize: 'var(--fs-xs)',
                    color: 'var(--reject)',
                  }}
                >
                  Revoke Link
                </button>
              </div>
            </div>

            {/* Revoke Confirmation Dialog */}
            {confirmRevoke && (
              <div style={{
                marginTop: 'var(--sp-4)',
                padding: 'var(--sp-4)',
                background: 'color-mix(in oklab, var(--reject) 8%, var(--bg-3))',
                border: '1px solid color-mix(in oklab, var(--reject) 30%, var(--line))',
                borderRadius: 8,
              }}>
                <div className="fs-sm" style={{ fontWeight: 600, color: 'var(--reject)', marginBottom: 4 }}>
                  Revoke gallery link?
                </div>
                <p className="fs-xs" style={{ color: 'var(--fg-2)', margin: '0 0 var(--sp-3)' }}>
                  Anyone with the current link will lose access immediately.
                </p>
                <div className="flex" style={{ gap: 8 }}>
                  <button
                    type="button"
                    className="btn"
                    onClick={handleRevoke}
                    disabled={galleryActionBusy}
                    style={{
                      background: 'var(--reject)',
                      color: '#000',
                      fontWeight: 600,
                      height: 32,
                      padding: '0 12px',
                      fontSize: 'var(--fs-xs)',
                    }}
                  >
                    {galleryActionBusy ? 'Revoking…' : 'Yes, Revoke'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => setConfirmRevoke(false)}
                    disabled={galleryActionBusy}
                    style={{ height: 32, padding: '0 12px', fontSize: 'var(--fs-xs)' }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Regenerate Confirmation Dialog */}
            {confirmRegen && (
              <div style={{
                marginTop: 'var(--sp-4)',
                padding: 'var(--sp-4)',
                background: 'color-mix(in oklab, var(--warning) 8%, var(--bg-3))',
                border: '1px solid color-mix(in oklab, var(--warning) 30%, var(--line))',
                borderRadius: 8,
              }}>
                <div className="fs-sm" style={{ fontWeight: 600, color: 'var(--warning)', marginBottom: 4 }}>
                  Regenerate gallery link?
                </div>
                <p className="fs-xs" style={{ color: 'var(--fg-2)', margin: '0 0 var(--sp-3)' }}>
                  A new gallery URL will be created. The previous link will immediately stop working.
                </p>
                <div className="flex" style={{ gap: 8 }}>
                  <button
                    type="button"
                    className="btn"
                    onClick={handleRegenerate}
                    disabled={galleryActionBusy}
                    style={{
                      background: 'var(--warning)',
                      color: '#000',
                      fontWeight: 600,
                      height: 32,
                      padding: '0 12px',
                      fontSize: 'var(--fs-xs)',
                    }}
                  >
                    {galleryActionBusy ? 'Regenerating…' : 'Yes, Regenerate'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => setConfirmRegen(false)}
                    disabled={galleryActionBusy}
                    style={{ height: 32, padding: '0 12px', fontSize: 'var(--fs-xs)' }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* 5. Run history section */}
      <div>
        <div className="flex jcsb aic" style={{ marginBottom: 'var(--sp-4)' }}>
          <h2 style={{
            margin: 0,
            fontSize: 'var(--fs-xl)',
            fontWeight: 700,
            letterSpacing: 'var(--tracking-tight)',
          }}>
            Run History
          </h2>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={fetchRuns}
            disabled={loadingRuns}
            style={{ height: 32, padding: '0 10px', gap: 6 }}
          >
            <Icon name="undo" size={13} />
            <span className="fs-xxs mono upper">{loadingRuns ? 'Refreshing…' : 'Refresh'}</span>
          </button>
        </div>

        {runsError && (
          <div style={{
            marginBottom: 'var(--sp-4)',
            background: 'color-mix(in oklab, var(--reject) 10%, transparent)',
            border: '1px solid color-mix(in oklab, var(--reject) 30%, transparent)',
            borderRadius: 10,
            padding: 'var(--sp-3)',
          }}>
            <p className="fs-sm" style={{ color: 'var(--reject)', margin: 0 }}>{runsError}</p>
          </div>
        )}

        {loadingRuns && runs.length === 0 ? (
          <div className="fs-sm dim" style={{ padding: 'var(--sp-5)', textAlign: 'center' }}>
            Loading run history…
          </div>
        ) : runs.length === 0 ? (
          <div style={{
            background: 'var(--bg-2)',
            border: '1px solid var(--line)',
            borderRadius: 10,
            padding: 'var(--sp-6)',
            textAlign: 'center',
          }}>
            <Icon name="aperture" size={40} style={{ color: 'var(--fg-4)', margin: '0 auto' }} />
            <p className="fs-sm" style={{ color: 'var(--fg-2)', margin: '12px 0 0' }}>
              No runs yet. Start a run above to process photos from the source folder.
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
            {runs.map((run) => {
              const counts = run.counts || {}
              const exported = counts.exported || 0
              const rejected = counts.rejected || 0
              const awaiting = counts.awaiting_review || 0
              const failed = counts.failed || 0

              return (
                <div
                  key={run.id}
                  className="card"
                  style={{
                    padding: 'var(--sp-4)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--sp-3)',
                  }}
                >
                  <div className="flex jcsb aic" style={{ gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
                    <div>
                      <div className="fs-md" style={{ fontWeight: 600 }}>
                        Run #{run.id} · <span style={{ color: run.status === 'running' ? 'var(--keep)' : 'var(--fg-2)' }}>{formatStatus(run.status)}</span>
                      </div>
                      <div className="fs-xs dim mono" style={{ marginTop: 2 }}>
                        {formatRunDateRange(run.startedAt, run.endedAt)}
                      </div>
                    </div>

                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => navigate(`/sessions/${sessionId}/run/${run.id}`)}
                      style={{ padding: '0 14px', height: 36, gap: 6, flexShrink: 0 }}
                    >
                      <span className="fs-xs">View</span>
                      <Icon name="arrowR" size={14} />
                    </button>
                  </div>

                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: '6px 12px',
                    paddingTop: 'var(--sp-3)',
                    borderTop: '1px solid var(--line)',
                    fontSize: 'var(--fs-xs)',
                  }}>
                    <span style={{ color: 'var(--keep)', fontWeight: 500 }}>{exported} exported</span>
                    <span style={{ color: 'var(--fg-4)' }}>·</span>
                    <span style={{ color: 'var(--reject)', fontWeight: 500 }}>{rejected} rejected</span>
                    <span style={{ color: 'var(--fg-4)' }}>·</span>
                    <span style={{ color: 'var(--maybe)', fontWeight: 500 }}>{awaiting} awaiting review</span>
                    {failed > 0 && (
                      <>
                        <span style={{ color: 'var(--fg-4)' }}>·</span>
                        <span style={{ color: 'var(--reject)', fontWeight: 500 }}>{failed} failed</span>
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Edit Session Full-Screen Overlay */}
      {editOpen && editForm && (
        <div className="view" style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'var(--bg)', padding: 'var(--pad)', paddingBottom: 96, overflowY: 'auto' }}>
          <div className="flex jcsb aic" style={{ marginBottom: 'var(--sp-5)' }}>
            <div>
              <div className="meta" style={{ color: 'var(--accent)', marginBottom: 4 }}>Edit session</div>
              <h2 style={{ margin: 0, fontSize: 'var(--fs-2xl)', fontWeight: 700, letterSpacing: 'var(--tracking-tight)' }}>
                {editForm.name || 'Untitled'}
              </h2>
            </div>
            <button type="button" className="btn btn-ghost" onClick={closeEdit} aria-label="Close edit form">
              <Icon name="x" size={18} />
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-5)' }}>
            <div>
              <FieldLabel>Name</FieldLabel>
              <input
                type="text"
                value={editForm.name}
                onChange={(e) => setEditField('name', e.target.value)}
                placeholder="e.g. Soccer Saturday"
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
            </div>

            <PickerRow
              label="Source folder (inbox)"
              value={editForm.sourceFolderName}
              placeholder="Select the Drive folder image.canon writes to"
              onPick={() => setPickerTarget('source')}
            />
            <PickerRow
              label="Export folder"
              value={editForm.exportFolderName}
              placeholder="Select or create where keepers land"
              onPick={() => setPickerTarget('export')}
            />

            <div className="flex jcsb aic">
              <div>
                <div className="fs-sm">Autonomous</div>
                <p className="fs-xxs dim mono upper" style={{ margin: '4px 0 0' }}>
                  Keepers export with no review
                </p>
              </div>
              <OblToggle checked={editForm.autonomous} onChange={(v) => setEditField('autonomous', v)} />
            </div>

            <div>
              <div className="flex jcsb aic" style={{ marginBottom: 'var(--sp-2)' }}>
                <div className="meta">Keeper preset</div>
                <span className="mono fs-xs" style={{ color: 'var(--accent)' }}>
                  {editForm.preset === 'custom' ? `custom · ${Math.round(editForm.threshold * 100)}%` : `${Math.round(editForm.threshold * 100)}%`}
                </span>
              </div>
              <div className="flex" style={{ gap: 'var(--sp-2)' }}>
                <Chip active={editForm.preset === 'strict'} onClick={() => handleEditPreset('strict')}>Strict</Chip>
                <Chip active={editForm.preset === 'balanced'} onClick={() => handleEditPreset('balanced')}>Balanced</Chip>
                <Chip active={editForm.preset === 'loose'} onClick={() => handleEditPreset('loose')}>Loose</Chip>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={editForm.threshold}
                onChange={(e) => handleEditThreshold(parseFloat(e.target.value))}
                style={{ width: '100%', marginTop: 'var(--sp-4)' }}
                aria-label="Keep threshold"
              />
              <div className="flex jcsb">
                <span className="fs-xxs dim">0%</span>
                <span className="fs-xxs dim">Moving the slider sets Custom</span>
                <span className="fs-xxs dim">100%</span>
              </div>
            </div>

            <div className="flex jcsb aic">
              <div>
                <div className="fs-sm">Burst best only</div>
                <p className="fs-xxs dim mono upper" style={{ margin: '4px 0 0' }}>
                  One photo per burst group
                </p>
              </div>
              <OblToggle checked={editForm.burstBestOnly} onChange={(v) => setEditField('burstBestOnly', v)} />
            </div>

            <div>
              <FieldLabel>Edit mode</FieldLabel>
              <div className="flex" style={{ gap: 'var(--sp-2)' }}>
                <Chip active={editForm.editMode === 'off'} onClick={() => setEditField('editMode', 'off')}>Off</Chip>
                <Chip active={editForm.editMode === 'auto'} onClick={() => setEditField('editMode', 'auto')}>Auto</Chip>
                <Chip active={editForm.editMode === 'topaz'} onClick={() => setEditField('editMode', 'topaz')}>Topaz</Chip>
              </div>
            </div>

            {editForm.editMode === 'auto' && (
              <div>
                <FieldLabel>Auto strength</FieldLabel>
                <div className="flex" style={{ gap: 'var(--sp-2)' }}>
                  <Chip active={editForm.editStrength === 'light'} onClick={() => setEditField('editStrength', 'light')}>Light</Chip>
                  <Chip active={editForm.editStrength === 'medium'} onClick={() => setEditField('editStrength', 'medium')}>Medium</Chip>
                </div>
              </div>
            )}

            <div>
              <FieldLabel>Poll interval (seconds)</FieldLabel>
              <input
                type="number"
                min={1}
                step={1}
                value={editForm.pollSeconds}
                onChange={(e) => setEditField('pollSeconds', parseInt(e.target.value, 10) || 1)}
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
              <p className="fs-xxs dim" style={{ margin: '6px 0 0' }}>
                How often the worker checks the inbox for new photos.
              </p>
            </div>

            {saveEditError && (
              <div style={{
                background: 'color-mix(in oklab, var(--reject) 10%, transparent)',
                border: '1px solid color-mix(in oklab, var(--reject) 30%, transparent)',
                borderRadius: 10,
                padding: 'var(--sp-3)',
              }}>
                <p className="fs-sm" style={{ color: 'var(--reject)', margin: 0 }}>{saveEditError}</p>
              </div>
            )}
          </div>

          <div style={{ position: 'sticky', bottom: 56, marginTop: 'var(--sp-6)', paddingTop: 'var(--sp-3)', background: 'var(--bg)', zIndex: 5, display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
            <button
              type="button"
              className="btn btn-primary btn-uppercase"
              style={{ width: '100%' }}
              onClick={handleSaveEdit}
              disabled={savingEdit}
            >
              {savingEdit ? 'Saving…' : 'Save changes'}
            </button>
            {!confirmDelete ? (
              <button
                type="button"
                className="btn btn-uppercase"
                style={{ width: '100%', color: 'var(--reject)', border: '1px solid color-mix(in oklab, var(--reject) 30%, transparent)', background: 'transparent' }}
                onClick={() => setConfirmDelete(true)}
                disabled={belongsToThisSession}
              >
                Delete session
              </button>
            ) : (
              <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
                <button
                  type="button"
                  className="btn btn-uppercase"
                  style={{ flex: 1, color: 'var(--fg-2)' }}
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-uppercase"
                  style={{ flex: 1, background: 'var(--reject)', color: '#fff' }}
                  onClick={handleDelete}
                  disabled={deleting}
                >
                  {deleting ? 'Deleting…' : 'Confirm delete'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <GoogleDriveFolderPicker
        open={pickerTarget != null}
        title={pickerTarget === 'source' ? 'Choose source folder' : 'Choose export folder'}
        allowCreate={pickerTarget === 'export'}
        onClose={() => setPickerTarget(null)}
        onSelect={handlePickFolder}
      />
    </div>
  )
}
