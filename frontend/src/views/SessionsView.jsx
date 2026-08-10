import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Icon from '../components/Icon'
import GoogleDriveFolderPicker from '../components/GoogleDriveFolderPicker'
import * as sessionsClient from '../api/sessionsClient'
import { useStore } from '../store'

const PRESETS = { strict: 0.72, balanced: 0.60, loose: 0.45 }

function OblToggle({ checked, onChange }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track"><span className="toggle-thumb" /></span>
    </label>
  )
}

function Chip({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="btn fs-xs"
      style={{
        flex: 1,
        minHeight: 44,
        background: active ? 'color-mix(in oklab, var(--accent) 18%, var(--bg-3))' : 'var(--bg-3)',
        color: active ? 'var(--accent)' : 'var(--fg-2)',
        border: active ? '1px solid color-mix(in oklab, var(--accent) 55%, var(--line))' : '1px solid var(--line)',
      }}
    >
      {children}
    </button>
  )
}

function FieldLabel({ children }) {
  return (
    <div className="meta" style={{ marginBottom: 'var(--sp-2)' }}>{children}</div>
  )
}

function PickerRow({ label, value, placeholder, onPick }) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <button
        type="button"
        onClick={onPick}
        style={{
          width: '100%',
          minHeight: 44,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 12px',
          borderRadius: 8,
          textAlign: 'left',
          background: value ? 'color-mix(in oklab, var(--keep) 10%, transparent)' : 'var(--bg-3)',
          border: value
            ? '1px solid color-mix(in oklab, var(--keep) 30%, transparent)'
            : '1px solid var(--line)',
          color: value ? 'var(--keep)' : 'var(--fg-2)',
        }}
      >
        <Icon name={value ? 'folderOpen' : 'folder'} size={18} style={{ flexShrink: 0 }} />
        <span className="fs-sm" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {value || placeholder}
        </span>
        <Icon name="arrowR" size={14} style={{ opacity: 0.5, flexShrink: 0 }} />
      </button>
    </div>
  )
}

export default function SessionsView() {
  const navigate = useNavigate()
  const setSessions = useStore((s) => s.setSessions)
  const setActiveSession = useStore((s) => s.setActiveSession)
  const [sessions, setLocalSessions] = useState([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState(null)
  const [inbox, setInbox] = useState(null)
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [pickerTarget, setPickerTarget] = useState(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [deleting, setDeleting] = useState(false)

  const refreshSessions = useCallback(async () => {
    try {
      const data = await sessionsClient.listSessions()
      setLocalSessions(data.sessions || [])
      setSessions(data.sessions || [])
      setListError(null)
    } catch (err) {
      setListError(err.message)
    } finally {
      setLoading(false)
    }
  }, [setSessions])

  useEffect(() => {
    refreshSessions()
    sessionsClient.getSettings()
      .then((data) => setInbox(data))
      .catch(() => {})
  }, [refreshSessions])

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
    setEditingId(null)
    setForm(blankForm())
    setSaveError(null)
    setFormOpen(true)
  }, [blankForm])

  const openEdit = useCallback((session) => {
    setEditingId(session.id)
    setActiveSession(session)
    setForm({
      name: session.name,
      sourceFolderId: session.sourceFolderId,
      sourceFolderName: session.sourceFolderName,
      exportFolderId: session.exportFolderId,
      exportFolderName: session.exportFolderName,
      autonomous: Boolean(session.autonomous),
      preset: session.preset || 'balanced',
      threshold: typeof session.threshold === 'number' ? session.threshold : PRESETS.balanced,
      burstBestOnly: session.burstBestOnly !== false,
      editMode: session.editMode || 'off',
      editStrength: session.editStrength || 'medium',
      pollSeconds: session.pollSeconds || 30,
    })
    setSaveError(null)
    setFormOpen(true)
  }, [setActiveSession])

  const closeForm = useCallback(() => {
    setFormOpen(false)
    setEditingId(null)
    setForm(null)
    setSaveError(null)
  }, [])

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
      if (editingId) {
        await sessionsClient.updateSession(editingId, payload)
      } else {
        await sessionsClient.createSession(payload)
      }
      await refreshSessions()
      closeForm()
    } catch (err) {
      setSaveError(err.message)
    } finally {
      setSaving(false)
    }
  }, [form, saving, editingId, refreshSessions, closeForm])

  const handleDelete = useCallback(async (sessionId) => {
    if (deleting) return
    setDeleting(true)
    try {
      await sessionsClient.deleteSession(sessionId)
      setConfirmDeleteId(null)
      await refreshSessions()
    } catch (err) {
      setListError(err.message)
      setConfirmDeleteId(null)
    } finally {
      setDeleting(false)
    }
  }, [deleting, refreshSessions])

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
          Sessions
        </h1>
        <p style={{ margin: '12px 0 0', color: 'var(--fg-2)', fontSize: 'var(--fs-md)', maxWidth: '45ch' }}>
          A session ties a Drive inbox to an export folder, a keeper rule, and an edit mode.
        </p>
      </div>

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
            <div key={session.id} className="card" style={{ padding: 'var(--sp-4)' }}>
              <div className="flex jcsb aic" style={{ gap: 'var(--sp-2)' }}>
                <div style={{ minWidth: 0 }}>
                  <div className="fs-md" style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {session.name}
                  </div>
                  <div className="meta" style={{ marginTop: 4 }}>
                    {sessionSummary[session.id]}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => navigate(`/sessions/${session.id}`)}
                  className="btn btn-primary"
                  style={{ padding: '0 14px', flexShrink: 0 }}
                  aria-label={`Run ${session.name}`}
                >
                  <Icon name="arrowR" size={16} />
                  Run
                </button>
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
              <div className="flex" style={{ gap: 'var(--sp-2)', marginTop: 'var(--sp-3)' }}>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ flex: 1, padding: '0 14px' }}
                  onClick={() => openEdit(session)}
                >
                  <Icon name="cog" size={16} />
                  Edit
                </button>
                {confirmDeleteId === session.id ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ flex: 1, padding: '0 14px' }}
                      onClick={() => setConfirmDeleteId(null)}
                      disabled={deleting}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="btn btn-uppercase"
                      style={{
                        flex: 1,
                        padding: '0 14px',
                        background: 'color-mix(in oklab, var(--reject) 15%, var(--bg-3))',
                        color: 'var(--reject)',
                        borderColor: 'color-mix(in oklab, var(--reject) 40%, var(--line))',
                      }}
                      onClick={() => handleDelete(session.id)}
                      disabled={deleting}
                    >
                      {deleting ? 'Deleting…' : 'Confirm'}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ flex: 1, padding: '0 14px', color: 'var(--reject)' }}
                    onClick={() => setConfirmDeleteId(session.id)}
                  >
                    <Icon name="x" size={16} />
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ position: 'sticky', bottom: 56, marginTop: 'var(--sp-6)', paddingTop: 'var(--sp-3)', background: 'var(--bg)', zIndex: 5 }}>
        <button type="button" className="btn btn-primary btn-uppercase" style={{ width: '100%' }} onClick={openCreate}>
          ＋ New Session
        </button>
      </div>

      {formOpen && form && (
        <div className="view" style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'var(--bg)', padding: 'var(--pad)', paddingBottom: 96 }}>
          <div className="flex jcsb aic" style={{ marginBottom: 'var(--sp-5)' }}>
            <div>
              <div className="meta" style={{ color: 'var(--accent)', marginBottom: 4 }}>{editingId ? 'Edit session' : 'New session'}</div>
              <h2 style={{ margin: 0, fontSize: 'var(--fs-2xl)', fontWeight: 700, letterSpacing: 'var(--tracking-tight)' }}>
                {editingId ? form.name || 'Untitled' : 'Create a Session'}
              </h2>
            </div>
            <button type="button" className="btn btn-ghost" onClick={closeForm} aria-label="Close form">
              <Icon name="x" size={18} />
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-5)' }}>
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

          <div style={{ position: 'sticky', bottom: 56, marginTop: 'var(--sp-6)', paddingTop: 'var(--sp-3)', background: 'var(--bg)', zIndex: 5 }}>
            <button
              type="button"
              className="btn btn-primary btn-uppercase"
              style={{ width: '100%' }}
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? 'Saving…' : editingId ? 'Save changes' : 'Create session'}
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
    </div>
  )
}
