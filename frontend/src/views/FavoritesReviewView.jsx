import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import Icon from '../components/Icon'
import * as sessionsClient from '../api/sessionsClient'
import { copyText } from '../utils/clipboard'

function formatDate(isoStr) {
  if (!isoStr) return ''
  try {
    const d = new Date(isoStr)
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return isoStr
  }
}

export default function FavoritesReviewView() {
  const { sessionId } = useParams()
  const navigate = useNavigate()

  const [session, setSession] = useState(null)
  const [favorites, setFavorites] = useState([])
  const [comments, setComments] = useState([])
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [approving, setApproving] = useState(false)
  const [approveError, setApproveError] = useState(null)
  const [approveResult, setApproveResult] = useState(null)
  const [copiedLink, setCopiedLink] = useState(false)

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [sessionData, favsData, commsData] = await Promise.all([
        sessionsClient.getSession(sessionId),
        sessionsClient.fetchGalleryFavorites(sessionId),
        sessionsClient.fetchGalleryComments(sessionId),
      ])

      setSession(sessionData.session)
      const favList = Array.isArray(favsData) ? favsData : []
      setFavorites(favList)
      setComments(Array.isArray(commsData) ? commsData : [])

      // Default to selecting all favorited photos
      const initialSelected = new Set(favList.map((p) => p.photoId ?? p.photo_id))
      setSelectedIds(initialSelected)
    } catch (err) {
      setError(err.message || 'Failed to load gallery favorites')
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    loadData()
  }, [loadData])

  // Group comments by photoId vs gallery-level
  const { commentsByPhotoId, galleryComments } = useMemo(() => {
    const byPhoto = new Map()
    const galleryOnly = []

    for (const c of comments) {
      const pid = c.photoId ?? c.photo_id
      if (pid != null) {
        if (!byPhoto.has(pid)) {
          byPhoto.set(pid, [])
        }
        byPhoto.get(pid).push(c)
      } else {
        galleryOnly.push(c)
      }
    }

    return { commentsByPhotoId: byPhoto, galleryComments: galleryOnly }
  }, [comments])

  // Selection handlers
  const handleToggleSelect = useCallback((photoId) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(photoId)) {
        next.delete(photoId)
      } else {
        next.add(photoId)
      }
      return next
    })
  }, [])

  const handleSelectAll = useCallback(() => {
    const allIds = new Set(favorites.map((p) => p.photoId ?? p.photo_id))
    setSelectedIds(allIds)
  }, [favorites])

  const handleDeselectAll = useCallback(() => {
    setSelectedIds(new Set())
  }, [])

  const handleCopyLink = useCallback((url) => {
    if (!url) return
    copyText(url).then(() => {
      setCopiedLink(true)
      setTimeout(() => setCopiedLink(false), 2000)
    }).catch(() => {})
  }, [])

  const handleApprove = useCallback(async () => {
    if (approving || selectedIds.size === 0) return
    setApproving(true)
    setApproveError(null)
    try {
      const idsArray = Array.from(selectedIds)
      const res = await sessionsClient.approveFavorites(sessionId, idsArray)
      setApproveResult(res)
    } catch (err) {
      setApproveError(err.message || 'Failed to approve favorites')
    } finally {
      setApproving(false)
    }
  }, [approving, selectedIds, sessionId])

  const allSelected = favorites.length > 0 && selectedIds.size === favorites.length

  return (
    <div className="view" style={{ padding: 'var(--pad)', paddingBottom: 110, maxWidth: 1200, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: 'var(--sp-6)' }}>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => navigate(`/sessions/${sessionId}`)}
          style={{ height: 36, padding: '0 10px', gap: 6, marginBottom: 'var(--sp-3)' }}
        >
          <Icon name="arrowL" size={16} />
          <span className="fs-xs">Back to Session</span>
        </button>

        <div className="flex jcsb aic" style={{ gap: 'var(--sp-3)', flexWrap: 'wrap' }}>
          <div>
            <div className="meta" style={{ color: 'var(--accent)', marginBottom: 4 }}>
              · {session?.name || 'Session'} / Client Favorites
            </div>
            <h1 style={{
              margin: 0,
              fontSize: 'clamp(26px, 3.5vw, 36px)',
              fontWeight: 700,
              letterSpacing: 'var(--tracking-tight)',
              lineHeight: 1.1,
            }}>
              Client Favorites & Comments
            </h1>
          </div>

          <button
            type="button"
            className="btn btn-ghost"
            onClick={loadData}
            disabled={loading}
            style={{ height: 36, padding: '0 12px', gap: 6 }}
          >
            <Icon name="undo" size={14} />
            <span className="fs-xs">{loading ? 'Refreshing…' : 'Refresh'}</span>
          </button>
        </div>
      </div>

      {error && (
        <div style={{
          marginBottom: 'var(--sp-5)',
          background: 'color-mix(in oklab, var(--reject) 10%, transparent)',
          border: '1px solid color-mix(in oklab, var(--reject) 30%, transparent)',
          borderRadius: 10,
          padding: 'var(--sp-4)',
        }}>
          <p className="fs-sm" style={{ color: 'var(--reject)', margin: 0 }}>{error}</p>
        </div>
      )}

      {approveError && (
        <div style={{
          marginBottom: 'var(--sp-5)',
          background: 'color-mix(in oklab, var(--reject) 10%, transparent)',
          border: '1px solid color-mix(in oklab, var(--reject) 30%, transparent)',
          borderRadius: 10,
          padding: 'var(--sp-4)',
        }}>
          <p className="fs-sm" style={{ color: 'var(--reject)', margin: 0 }}>{approveError}</p>
        </div>
      )}

      {/* Approve Success Banner */}
      {approveResult && (
        <div style={{
          marginBottom: 'var(--sp-6)',
          background: 'color-mix(in oklab, var(--keep) 10%, var(--bg-2))',
          border: '1px solid color-mix(in oklab, var(--keep) 35%, var(--line))',
          borderRadius: 12,
          padding: 'var(--sp-5)',
        }}>
          <div className="flex jcsb aic" style={{ marginBottom: 'var(--sp-3)' }}>
            <div className="flex aic" style={{ gap: 8 }}>
              <span style={{
                width: 24,
                height: 24,
                borderRadius: '50%',
                background: 'var(--keep)',
                color: '#000',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 700,
                fontSize: 14,
              }}>✓</span>
              <span className="fs-md" style={{ fontWeight: 600, color: 'var(--fg)' }}>
                Favorites Folder Created ({approveResult.copied_count ?? selectedIds.size} photos copied)
              </span>
            </div>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setApproveResult(null)}
              aria-label="Dismiss success"
            >
              <Icon name="x" size={16} />
            </button>
          </div>

          <p className="fs-sm" style={{ color: 'var(--fg-2)', margin: '0 0 var(--sp-4)', lineHeight: 1.5 }}>
            A dedicated favorites folder has been created in Google Drive and a client favorites gallery link is ready to share.
          </p>

          {(() => {
            const favToken = approveResult.favorites_token || approveResult.favoritesToken
            const favUrl = approveResult.favorites_url || approveResult.favoritesUrl || (favToken ? `/gallery/${favToken}` : '')
            const fullFavUrl = favToken ? `${window.location.origin}/gallery/${favToken}` : `${window.location.origin}${favUrl}`
            return (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                background: 'var(--bg-3)',
                border: '1px solid var(--line)',
                borderRadius: 8,
                padding: '6px 10px',
                flexWrap: 'wrap',
              }}>
                <span className="meta" style={{ flexShrink: 0 }}>Favorites Gallery:</span>
                <span className="mono fs-xs" style={{ flex: 1, minWidth: 200, color: 'var(--fg)' }}>
                  {fullFavUrl}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => handleCopyLink(fullFavUrl)}
                  style={{ height: 32, padding: '0 10px', gap: 6 }}
                >
                  <Icon name={copiedLink ? 'check' : 'sparkle'} size={14} style={{ color: copiedLink ? 'var(--keep)' : undefined }} />
                  <span className="fs-xs">{copiedLink ? 'Copied!' : 'Copy Link'}</span>
                </button>
                <a
                  href={`/gallery/${favToken}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-primary"
                  style={{ height: 32, padding: '0 12px', gap: 6, fontSize: 'var(--fs-xs)', textDecoration: 'none' }}
                >
                  <span>Open Gallery</span>
                  <Icon name="arrowR" size={13} />
                </a>
              </div>
            )
          })()}
        </div>
      )}

      {/* Action Toolbar */}
      <div className="card" style={{
        marginBottom: 'var(--sp-6)',
        padding: 'var(--sp-4) var(--sp-5)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 'var(--sp-4)',
        flexWrap: 'wrap',
      }}>
        <div className="flex aic" style={{ gap: 'var(--sp-4)', flexWrap: 'wrap' }}>
          <div>
            <span className="fs-sm" style={{ fontWeight: 600 }}>
              {selectedIds.size} of {favorites.length}
            </span>
            <span className="fs-xs dim" style={{ marginLeft: 6 }}>photos selected</span>
          </div>

          {favorites.length > 0 && (
            <div className="flex aic" style={{ gap: 8 }}>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={allSelected ? handleDeselectAll : handleSelectAll}
                style={{ height: 32, padding: '0 10px', fontSize: 'var(--fs-xs)' }}
              >
                {allSelected ? 'Deselect All' : 'Select All'}
              </button>
            </div>
          )}
        </div>

        <button
          type="button"
          className="btn btn-primary btn-uppercase"
          onClick={handleApprove}
          disabled={approving || selectedIds.size === 0}
          style={{ height: 42, padding: '0 18px', gap: 8, fontSize: 'var(--fs-xs)' }}
        >
          {approving ? (
            <span>Creating Drive Folder…</span>
          ) : (
            <>
              <Icon name="folderOpen" size={16} />
              <span>Create Favorites Folder ({selectedIds.size})</span>
            </>
          )}
        </button>
      </div>

      {/* Gallery-Level Feedback Section */}
      {galleryComments.length > 0 && (
        <div className="card" style={{ marginBottom: 'var(--sp-6)', padding: 'var(--sp-5)' }}>
          <div className="meta" style={{ color: 'var(--accent)', marginBottom: 'var(--sp-3)' }}>
            Gallery-Level Feedback ({galleryComments.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
            {galleryComments.map((gc) => (
              <div
                key={gc.id}
                style={{
                  padding: 'var(--sp-3) var(--sp-4)',
                  background: 'var(--bg-3)',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                }}
              >
                <div className="flex jcsb aic" style={{ marginBottom: 4 }}>
                  <span className="fs-xs" style={{ fontWeight: 600, color: 'var(--fg)' }}>
                    {gc.displayName || gc.display_name || 'Guest'}
                  </span>
                  <span className="fs-xxs dim mono">
                    {formatDate(gc.createdAt || gc.created_at)}
                  </span>
                </div>
                <p className="fs-sm" style={{ margin: 0, color: 'var(--fg-2)', whiteSpace: 'pre-wrap' }}>
                  {gc.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Content: Favorites Grid or Empty State */}
      {loading && favorites.length === 0 ? (
        <div className="card" style={{ padding: 'var(--sp-8)', textAlign: 'center' }}>
          <p className="fs-sm dim" style={{ margin: 0 }}>Loading client favorites…</p>
        </div>
      ) : favorites.length === 0 ? (
        <div className="card" style={{ padding: 'var(--sp-8)', textAlign: 'center' }}>
          <Icon name="sparkle" size={44} style={{ color: 'var(--fg-4)', margin: '0 auto var(--sp-3)' }} />
          <h3 style={{ margin: '0 0 var(--sp-2)', fontSize: 'var(--fs-lg)', fontWeight: 600 }}>
            No Client Favorites Yet
          </h3>
          <p className="fs-sm" style={{ color: 'var(--fg-3)', maxWidth: '42ch', margin: '0 auto var(--sp-5)' }}>
            Your client hasn’t favorited any photos yet. Share the gallery link with them to let them browse and select their favorite shots.
          </p>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => navigate(`/sessions/${sessionId}`)}
            style={{ height: 38, padding: '0 16px', gap: 6, margin: '0 auto' }}
          >
            <Icon name="arrowL" size={14} />
            <span className="fs-xs">Back to Session</span>
          </button>
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: 'var(--sp-4)',
        }}>
          {favorites.map((p) => {
            const photoId = p.photoId ?? p.photo_id
            const isSelected = selectedIds.has(photoId)
            const photoComments = commentsByPhotoId.get(photoId) || []
            const favCount = p.favoriteCount ?? p.favorite_count ?? 1

            return (
              <div
                key={photoId}
                className="card"
                style={{
                  overflow: 'hidden',
                  display: 'flex',
                  flexDirection: 'column',
                  border: isSelected
                    ? '1px solid color-mix(in oklab, var(--accent) 60%, var(--line))'
                    : '1px solid var(--line)',
                  background: isSelected
                    ? 'color-mix(in oklab, var(--accent) 4%, var(--bg-2))'
                    : 'var(--bg-2)',
                  transition: 'border-color .15s ease',
                }}
              >
                {/* Photo Thumbnail Container */}
                <div
                  style={{
                    position: 'relative',
                    aspectRatio: '3 / 2',
                    background: 'var(--bg-4)',
                    cursor: 'pointer',
                    overflow: 'hidden',
                  }}
                  onClick={() => handleToggleSelect(photoId)}
                >
                  <img
                    src={`/photos/${photoId}/thumb`}
                    alt={p.filename || `Photo ${photoId}`}
                    loading="lazy"
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      display: 'block',
                    }}
                    onError={(e) => {
                      e.currentTarget.style.display = 'none'
                    }}
                  />

                  {/* Selection Checkbox Pill */}
                  <div
                    style={{
                      position: 'absolute',
                      top: 10,
                      left: 10,
                      zIndex: 2,
                    }}
                    onClick={(e) => {
                      e.stopPropagation()
                      handleToggleSelect(photoId)
                    }}
                  >
                    <label
                      style={{
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 26,
                        height: 26,
                        borderRadius: 6,
                        background: isSelected ? 'var(--accent)' : 'rgba(0,0,0,0.6)',
                        border: isSelected ? '1px solid var(--accent)' : '1px solid rgba(255,255,255,0.4)',
                        color: isSelected ? '#000' : 'transparent',
                        backdropFilter: 'blur(4px)',
                        transition: 'all .15s ease',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => handleToggleSelect(photoId)}
                        style={{ display: 'none' }}
                      />
                      <Icon name="check" size={15} stroke={2.4} />
                    </label>
                  </div>

                  {/* Favorite Count Badge */}
                  <div
                    style={{
                      position: 'absolute',
                      top: 10,
                      right: 10,
                      background: 'rgba(0, 0, 0, 0.75)',
                      backdropFilter: 'blur(4px)',
                      border: '1px solid color-mix(in oklab, var(--keep) 40%, transparent)',
                      color: 'var(--keep)',
                      borderRadius: 999,
                      padding: '2px 8px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      fontSize: 'var(--fs-xxs)',
                      fontWeight: 600,
                      zIndex: 2,
                    }}
                  >
                    <span style={{ fontSize: 13 }}>★</span>
                    <span>{favCount}</span>
                  </div>

                  {/* Overall Score Badge (if available) */}
                  {(p.overallScore != null || p.overall_score != null) && (
                    <div
                      style={{
                        position: 'absolute',
                        bottom: 10,
                        right: 10,
                        background: 'rgba(0, 0, 0, 0.75)',
                        backdropFilter: 'blur(4px)',
                        borderRadius: 6,
                        padding: '2px 6px',
                        fontSize: 'var(--fs-xxs)',
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--fg-2)',
                        zIndex: 2,
                      }}
                    >
                      {Math.round((p.overallScore ?? p.overall_score) * 100)}%
                    </div>
                  )}
                </div>

                {/* Photo Details & Inline Comments */}
                <div style={{ padding: 'var(--sp-3)', flex: 1, display: 'flex', flexDirection: 'column' }}>
                  <div className="fs-xs mono" style={{
                    color: 'var(--fg-2)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    marginBottom: photoComments.length > 0 ? 'var(--sp-2)' : 0,
                  }}>
                    {p.filename}
                  </div>

                  {/* Inline Comments */}
                  {photoComments.length > 0 && (
                    <div style={{
                      marginTop: 'auto',
                      paddingTop: 'var(--sp-2)',
                      borderTop: '1px solid var(--line)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                    }}>
                      <div className="meta" style={{ fontSize: '10px', color: 'var(--accent)' }}>
                        Comments ({photoComments.length})
                      </div>
                      {photoComments.map((pc) => (
                        <div
                          key={pc.id}
                          style={{
                            background: 'var(--bg-3)',
                            borderRadius: 6,
                            padding: '6px 8px',
                            fontSize: 'var(--fs-xs)',
                          }}
                        >
                          <div className="flex jcsb aic" style={{ marginBottom: 2 }}>
                            <span style={{ fontWeight: 600, color: 'var(--fg)', fontSize: 'var(--fs-xxs)' }}>
                              {pc.displayName || pc.display_name || 'Guest'}
                            </span>
                            <span className="dim mono" style={{ fontSize: '10px' }}>
                              {formatDate(pc.createdAt || pc.created_at)}
                            </span>
                          </div>
                          <p style={{ margin: 0, color: 'var(--fg-2)', lineHeight: 1.35, fontSize: 'var(--fs-xs)' }}>
                            {pc.body}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
