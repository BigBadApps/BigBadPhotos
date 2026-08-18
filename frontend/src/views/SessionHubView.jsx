import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Icon from '../components/Icon'
import GoogleDriveFolderPicker from '../components/GoogleDriveFolderPicker'
import { OblToggle, Chip, FieldLabel, PickerRow, PRESETS } from '../components/SessionFormParts'
import * as sessionsClient from '../api/sessionsClient'
import { useStore } from '../store'
import { copyText } from '../utils/clipboard'

export default function SessionHubView() {
  const navigate = useNavigate()
  const setSessions = useStore((s) => s.setSessions)
  const [sessions, setLocalSessions] = useState([])
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState(null)
  const [inbox, setInbox] = useState(null)
  const [showList, setShowList] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [pickerTarget, setPickerTarget] = useState(null)
  const [createdSession, setCreatedSession] = useState(null)
  const [copiedLink, setCopiedLink] = useState(false)

  const createdGalleryUrl = useMemo(() => {
    if (!createdSession) return ''
    const galToken = createdSession.gallery_token || createdSession.galleryToken
    const rawUrl = createdSession.gallery_url || createdSession.galleryUrl || (galToken ? `/gallery/${galToken}` : '')
    return galToken ? `${window.location.origin}/gallery/${galToken}` : (rawUrl.startsWith('http') ? rawUrl : `${window.location.origin}${rawUrl}`)
  }, [createdSession])

  const handleCopyLink = useCallback((url) => {
    if (!url) return
    copyText(url).then(() => {
      setCopiedLink(true)
      setTimeout(() => setCopiedLink(false), 2000)
    }).catch(() => {})
  }, [])

  const refreshSessions = useCallback(async () => {
    setLoading(true)
    try {
      const data = await sessionsClient.listSessions()
      const list = data.sessions || []
      setLocalSessions(list)
      setSessions(list)
      setListError(null)
    } catch (err) {
      setListError(err.message || 'Failed to load sessions')
    } finally {
      setLoading(false)
    }
  }, [setSessions])

  useEffect(() => {
    sessionsClient.getSettings()
      .then((data) => setInbox(data))
      .catch(() => {})
  }, [])

  const blankForm = useCallback(() => ({
    name: '',
    sourceFolderId: inbox?.inboxFolderId || '',
    sourceFolderName: inbox?.inboxFolderName || '',
    exportFolderId: '',
    exportFolderName: '',
    autonomous: false,
    preset: 'balanced',
    threshold: PRESETS.balanced,
    burstBestOnly: true,
    editMode: 'off',
    editStrength: 'medium',
    pollSeconds: 30,
  }), [inbox])

  const openCreate = useCallback(() => {
    setForm(blankForm())
    setSaveError(null)
    setFormOpen(true)
  }, [blankForm])

  const closeForm = useCallback(() => {
    setFormOpen(false)
    setForm(null)
    setSaveError(null)
  }, [])

  const toggleOpenList = useCallback(() => {
    setShowList((prev) => {
      const next = !prev
      if (next) {
        refreshSessions()
      }
      return next
    })
  }, [refreshSessions])

  const setField = useCallback((key, value) => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev))
  }, [])

  const handlePreset = useCallback((preset) => {
    setField('preset', preset)
    setField('threshold', PRESETS[preset])
  }, [setField])

  const handleThreshold = useCallback((value) => {
    setField('threshold', value)
    setField('preset', 'custom')
  }, [setField])

  const handlePickFolder = useCallback(({ id, name }) => {
    if (pickerTarget === 'source') {
      setField('sourceFolderId', id)
      setField('sourceFolderName', name)
    } else if (pickerTarget === 'export') {
      setField('exportFolderId', id)
      setField('exportFolderName', name)
    }
    setPickerTarget(null)
  }, [pickerTarget, setField])

  const handleSave = useCallback(async () => {
    if (!form || saving) return
    if (!form.name.trim()) {
      setSaveError('Name is required')
      return
    }
    if (!form.sourceFolderId || !form.exportFolderId) {
      setSaveError('Pick a source and an export folder')
      return
    }
    setSaving(true)
    setSaveError(null)
    const payload = {
      name: form.name.trim(),
      sourceFolderId: form.sourceFolderId,
      sourceFolderName: form.sourceFolderName,
      exportFolderId: form.exportFolderId,
      exportFolderName: form.exportFolderName,
      autonomous: form.autonomous,
      preset: form.preset,
      threshold: form.threshold,
      burstBestOnly: form.burstBestOnly,
      editMode: form.editMode,
      editStrength: form.editStrength,
      pollSeconds: Number(form.pollSeconds) || 30,
    }
    try {
      const res = await sessionsClient.createSession(payload)
      const created = res.session || res
      await refreshSessions()
      setFormOpen(false)
      setForm(null)
      if (created && (created.gallery_token || created.galleryToken || created.gallery_url || created.galleryUrl)) {
        setCreatedSession(created)
      } else if (created?.id) {
        navigate(`/sessions/${created.id}`)
      }
    } catch (err) {
      setSaveError(err.message || 'Failed to create session')
    } finally {
      setSaving(false)
    }
  }, [form, saving, navigate, refreshSessions])

  const sessionSummary = useMemo(() => {
    const summaries = {}
    for (const s of sessions) {
      const bits = []
      bits.push(s.autonomous ? 'Autonomous' : 'Human-gated')
      bits.push(`Preset · ${s.preset}`)
      if (s.editMode && s.editMode !== 'off') {
        bits.push(`Edit · ${s.editMode}${s.editMode === 'auto' ? `/${s.editStrength}` : ''}`)
      }
      summaries[s.id] = bits.join('   ')
    }
    return summaries
  }, [sessions])

  return (
    <div className="view" style={{ padding: 'var(--pad)', paddingBottom: 96 }}>
      <div style={{ marginBottom: 'var(--sp-7)' }}>
        <div className="meta" style={{ color: 'var(--accent)', marginBottom: 8 }}>· Photo Sessions</div>
        <h1 style={{ margin: 0, fontSize: 'clamp(32px, 4vw, 48px)', fontWeight: 700, letterSpacing: 'var(--tracking-tight)', lineHeight: 1.05 }}>
          Session Configuration
        </h1>
        <p style={{ margin: '12px 0 0', color: 'var(--fg-2)', fontSize: 'var(--fs-md)', maxWidth: '45ch' }}>
          A session ties a Drive inbox to an export folder, a keeper rule, and an edit mode.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 'var(--sp-4)', maxWidth: 560, marginBottom: 'var(--sp-6)' }}>
        <button
          type="button"
          className="btn btn-primary btn-uppercase"
          style={{ height: 56, fontSize: 'var(--fs-sm)', gap: 10 }}
          onClick={openCreate}
        >
          <span style={{ fontSize: 18, lineHeight: 1 }}>＋</span>
          <span>New</span>
        </button>
        <button
          type="button"
          className={showList ? 'btn btn-primary btn-uppercase' : 'btn btn-ghost btn-uppercase'}
          style={{ height: 56, fontSize: 'var(--fs-sm)', gap: 10 }}
          onClick={toggleOpenList}
        >
          <Icon name="folderOpen" size={18} />
          <span>Open</span>
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-uppercase"
          style={{ height: 56, fontSize: 'var(--fs-sm)', gap: 10 }}
          onClick={() => navigate('/one-off')}
        >
          <Icon name="zap" size={18} />
          <span>One-off</span>
        </button>
      </div>

      {showList && (
        <div style={{ maxWidth: 640 }}>
          {listError && (
            <div style={{
              marginBottom: 'var(--sp-4)',
              background: 'color-mix(in oklab, var(--reject) 10%, transparent)',
              border: '1px solid color-mix(in oklab, var(--reject) 30%, transparent)',
              borderRadius: 10,
              padding: 'var(--sp-3)',
            }}>
              <p className="fs-sm" style={{ color: 'var(--reject)', margin: 0 }}>{listError}</p>
            </div>
          )}

          {loading ? (
            <div className="fs-sm dim" style={{ padding: 'var(--sp-5)', textAlign: 'center' }}>
              Loading sessions…
            </div>
          ) : sessions.length === 0 ? (
            <div style={{
              background: 'var(--bg-2)',
              border: '1px solid var(--line)',
              borderRadius: 10,
              padding: 'var(--sp-6)',
              textAlign: 'center',
            }}>
              <Icon name="folder" size={48} style={{ color: 'var(--fg-4)' }} />
              <p className="fs-sm" style={{ color: 'var(--fg-2)', margin: '12px 0 0' }}>
                No sessions yet. Create one to start shooting into a named workflow.
              </p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
              {sessions.map((session) => (
                <div
                  key={session.id}
                  className="card"
                  onClick={() => navigate(`/sessions/${session.id}`)}
                  style={{
                    padding: 'var(--sp-4)',
                    cursor: 'pointer',
                    transition: 'border-color .15s var(--ease-out), background-color .15s var(--ease-out)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = 'color-mix(in oklab, var(--accent) 50%, var(--line))'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = 'var(--line)'
                  }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      navigate(`/sessions/${session.id}`)
                    }
                  }}
                >
                  <div className="flex jcsb aic" style={{ gap: 'var(--sp-2)' }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="fs-md" style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {session.name}
                      </div>
                      <div className="meta" style={{ marginTop: 4 }}>
                        {sessionSummary[session.id]}
                      </div>
                    </div>
                    <div
                      className="btn btn-ghost"
                      style={{ padding: '0 12px', height: 32, flexShrink: 0, gap: 6, pointerEvents: 'none' }}
                    >
                      <span className="fs-xs">Open</span>
                      <Icon name="arrowR" size={14} />
                    </div>
                  </div>
                  <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                    marginTop: 'var(--sp-3)',
                    paddingTop: 'var(--sp-3)',
                    borderTop: '1px solid var(--line)',
                  }}>
                    <div className="fs-xs dim" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      Source · {session.sourceFolderName || session.sourceFolderId}
                    </div>
                    <div className="fs-xs dim" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      Export · {session.exportFolderName || session.exportFolderId}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {formOpen && form && (
        <div className="view" style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'var(--bg)', padding: 'var(--pad)', paddingBottom: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
          <div className="flex jcsb aic" style={{ marginBottom: 'var(--sp-5)' }}>
            <div>
              <div className="meta" style={{ color: 'var(--accent)', marginBottom: 4 }}>New session</div>
              <h2 style={{ margin: 0, fontSize: 'var(--fs-2xl)', fontWeight: 700, letterSpacing: 'var(--tracking-tight)' }}>
                Create a Session
              </h2>
            </div>
            <button type="button" className="btn btn-ghost" onClick={closeForm} aria-label="Close form">
              <Icon name="x" size={18} />
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-5)', paddingBottom: 80 }}>
            <div>
              <FieldLabel>Name</FieldLabel>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setField('name', e.target.value)}
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
              value={form.sourceFolderName}
              placeholder="Select the Drive folder image.canon writes to"
              onPick={() => setPickerTarget('source')}
            />
            <PickerRow
              label="Export folder"
              value={form.exportFolderName}
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
              <OblToggle checked={form.autonomous} onChange={(v) => setField('autonomous', v)} />
            </div>

            <div>
              <div className="flex jcsb aic" style={{ marginBottom: 'var(--sp-2)' }}>
                <div className="meta">Keeper preset</div>
                <span className="mono fs-xs" style={{ color: 'var(--accent)' }}>
                  {form.preset === 'custom' ? `custom · ${Math.round(form.threshold * 100)}%` : `${Math.round(form.threshold * 100)}%`}
                </span>
              </div>
              <div className="flex" style={{ gap: 'var(--sp-2)' }}>
                <Chip active={form.preset === 'strict'} onClick={() => handlePreset('strict')}>Strict</Chip>
                <Chip active={form.preset === 'balanced'} onClick={() => handlePreset('balanced')}>Balanced</Chip>
                <Chip active={form.preset === 'loose'} onClick={() => handlePreset('loose')}>Loose</Chip>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={form.threshold}
                onChange={(e) => handleThreshold(parseFloat(e.target.value))}
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
              <OblToggle checked={form.burstBestOnly} onChange={(v) => setField('burstBestOnly', v)} />
            </div>

            <div>
              <FieldLabel>Edit mode</FieldLabel>
              <div className="flex" style={{ gap: 'var(--sp-2)' }}>
                <Chip active={form.editMode === 'off'} onClick={() => setField('editMode', 'off')}>Off</Chip>
                <Chip active={form.editMode === 'auto'} onClick={() => setField('editMode', 'auto')}>Auto</Chip>
                <Chip active={form.editMode === 'topaz'} onClick={() => setField('editMode', 'topaz')}>Topaz</Chip>
              </div>
            </div>

            {form.editMode === 'auto' && (
              <div>
                <FieldLabel>Auto strength</FieldLabel>
                <div className="flex" style={{ gap: 'var(--sp-2)' }}>
                  <Chip active={form.editStrength === 'light'} onClick={() => setField('editStrength', 'light')}>Light</Chip>
                  <Chip active={form.editStrength === 'medium'} onClick={() => setField('editStrength', 'medium')}>Medium</Chip>
                </div>
              </div>
            )}

            <div>
              <FieldLabel>Poll interval (seconds)</FieldLabel>
              <input
                type="number"
                min={1}
                step={1}
                value={form.pollSeconds}
                onChange={(e) => setField('pollSeconds', parseInt(e.target.value, 10) || 1)}
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

            {saveError && (
              <div style={{
                background: 'color-mix(in oklab, var(--reject) 10%, transparent)',
                border: '1px solid color-mix(in oklab, var(--reject) 30%, transparent)',
                borderRadius: 10,
                padding: 'var(--sp-3)',
              }}>
                <p className="fs-sm" style={{ color: 'var(--reject)', margin: 0 }}>{saveError}</p>
              </div>
            )}
          </div>

          <div style={{ position: 'sticky', bottom: 56, marginTop: 'var(--sp-8)', paddingTop: 'var(--sp-4)', paddingBottom: 'var(--sp-3)', background: 'var(--bg)', zIndex: 5 }}>
            <button
              type="button"
              className="btn btn-primary btn-uppercase"
              style={{ width: '100%' }}
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Create session'}
            </button>
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

      {/* Session Created & Gallery Link Modal */}
      {createdSession && (
        <div style={{
          position: 'fixed',
          inset: 0,
          zIndex: 80,
          background: 'rgba(0, 0, 0, 0.7)',
          backdropFilter: 'blur(8px)',
          display: 'grid',
          placeItems: 'center',
          padding: 'var(--sp-5)',
        }}>
          <div className="card" style={{
            width: 'min(520px, 100%)',
            padding: 'var(--sp-6)',
            background: 'var(--bg-2)',
            border: '1px solid var(--line)',
            borderRadius: 12,
            boxShadow: 'var(--shadow-2)',
          }}>
            <div className="flex jcsb aic" style={{ marginBottom: 'var(--sp-3)' }}>
              <span className="meta" style={{ color: 'var(--keep)' }}>✓ Session Created</span>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  const id = createdSession.id
                  setCreatedSession(null)
                  navigate(`/sessions/${id}`)
                }}
                aria-label="Close"
              >
                <Icon name="x" size={18} />
              </button>
            </div>

            <h2 style={{
              margin: '0 0 var(--sp-2)',
              fontSize: 'var(--fs-xl)',
              fontWeight: 700,
              letterSpacing: 'var(--tracking-tight)',
            }}>
              {createdSession.name || 'New Session'}
            </h2>

            <p className="fs-sm" style={{ color: 'var(--fg-2)', margin: '0 0 var(--sp-5)', lineHeight: 1.5 }}>
              Your session is ready with an active client gallery link. Share this link with your client so they can view exported photos and select their favorites.
            </p>

            <div style={{ marginBottom: 'var(--sp-5)' }}>
              <FieldLabel>Client Gallery Link</FieldLabel>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                background: 'var(--bg-3)',
                border: '1px solid var(--line)',
                borderRadius: 8,
                padding: '8px 10px 8px 12px',
                marginBottom: 8,
              }}>
                <span className="mono fs-xs" style={{
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: 'var(--fg)',
                }}>
                  {createdGalleryUrl}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => handleCopyLink(createdGalleryUrl)}
                  style={{ height: 34, padding: '0 10px', gap: 6, flexShrink: 0 }}
                >
                  <Icon name={copiedLink ? 'check' : 'sparkle'} size={14} style={{ color: copiedLink ? 'var(--keep)' : undefined }} />
                  <span className="fs-xs">{copiedLink ? 'Copied!' : 'Copy Link'}</span>
                </button>
              </div>
              <p className="fs-xxs dim mono upper" style={{ margin: 0 }}>
                Share this link with your client
              </p>
            </div>

            <div className="flex" style={{ gap: 'var(--sp-3)', justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="btn btn-primary btn-uppercase"
                style={{ width: '100%', height: 44, fontSize: 'var(--fs-sm)' }}
                onClick={() => {
                  const id = createdSession.id
                  setCreatedSession(null)
                  navigate(`/sessions/${id}`)
                }}
              >
                Go to Session Workspace →
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

