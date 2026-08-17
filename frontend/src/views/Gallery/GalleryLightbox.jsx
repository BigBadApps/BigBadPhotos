import React, { useState, useEffect, useCallback, useRef } from 'react';
import * as galleryClient from '../../api/galleryClient';

export default function GalleryLightbox({
  photos = [],
  activePhotoId,
  token,
  isFavorited,
  onToggleFavorite,
  onClose,
  onNavigate,
}) {
  const currentIndex = photos.findIndex((p) => p.id === activePhotoId);
  const currentPhoto = currentIndex >= 0 ? photos[currentIndex] : null;

  // Comments state
  const [comments, setComments] = useState([]);
  const [loadingComments, setLoadingComments] = useState(false);
  const [commentBody, setCommentBody] = useState('');
  const [displayName, setDisplayName] = useState(() => {
    try {
      return localStorage.getItem('bbp_gallery_name') || '';
    } catch {
      return '';
    }
  });
  const [submittingComment, setSubmittingComment] = useState(false);
  const [showComments, setShowComments] = useState(false);

  // Swipe detection ref
  const touchStartX = useRef(null);

  // Navigation handlers
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < photos.length - 1;

  const goToPrev = useCallback(() => {
    if (hasPrev) {
      onNavigate(photos[currentIndex - 1].id);
    }
  }, [hasPrev, currentIndex, photos, onNavigate]);

  const goToNext = useCallback(() => {
    if (hasNext) {
      onNavigate(photos[currentIndex + 1].id);
    }
  }, [hasNext, currentIndex, photos, onNavigate]);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  // Keyboard navigation
  useEffect(() => {
    function onKeyDown(e) {
      if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goToPrev();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        goToNext();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, goToPrev, goToNext]);

  // Preload adjacent images
  useEffect(() => {
    if (!token) return;
    if (hasPrev) {
      const prevImg = new Image();
      prevImg.src = `/gallery/api/${encodeURIComponent(token)}/photos/${photos[currentIndex - 1].id}/full`;
    }
    if (hasNext) {
      const nextImg = new Image();
      nextImg.src = `/gallery/api/${encodeURIComponent(token)}/photos/${photos[currentIndex + 1].id}/full`;
    }
  }, [token, currentIndex, photos, hasPrev, hasNext]);

  // Fetch comments when photo changes
  useEffect(() => {
    if (!token || !activePhotoId) return;

    let isMounted = true;
    setLoadingComments(true);

    galleryClient.fetchComments(token, activePhotoId)
      .then((data) => {
        if (!isMounted || !Array.isArray(data)) return;
        setComments(data);
      })
      .catch((err) => {
        console.warn('Failed to fetch comments for photo:', err);
      })
      .finally(() => {
        if (isMounted) setLoadingComments(false);
      });

    return () => {
      isMounted = false;
    };
  }, [token, activePhotoId]);

  // Touch handlers for mobile swipe
  const handleTouchStart = (e) => {
    touchStartX.current = e.touches[0].clientX;
  };

  const handleTouchEnd = (e) => {
    if (touchStartX.current === null) return;
    const touchEndX = e.changedTouches[0].clientX;
    const diff = touchStartX.current - touchEndX;
    if (diff > 50) {
      // Swiped left -> next photo
      goToNext();
    } else if (diff < -50) {
      // Swiped right -> prev photo
      goToPrev();
    }
    touchStartX.current = null;
  };

  // Submit comment
  const handleCommentSubmit = async (e) => {
    e?.preventDefault();
    if (!commentBody.trim() || submittingComment || !activePhotoId || !token) return;

    const trimmedBody = commentBody.trim();
    const finalName = displayName.trim() || 'Guest';

    // Persist display name locally for convenience
    try {
      if (displayName.trim()) {
        localStorage.setItem('bbp_gallery_name', displayName.trim());
      }
    } catch {}

    const tempComment = {
      id: `temp-${Date.now()}`,
      photo_id: activePhotoId,
      display_name: finalName,
      displayName: finalName,
      body: trimmedBody,
      created_at: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };

    // Optimistic UI update
    setComments((prev) => [...prev, tempComment]);
    setCommentBody('');
    setSubmittingComment(true);

    try {
      const savedComment = await galleryClient.addComment(token, {
        body: trimmedBody,
        photoId: activePhotoId,
        displayName: finalName !== 'Guest' ? finalName : null,
      });

      if (savedComment) {
        setComments((prev) =>
          prev.map((c) => (c.id === tempComment.id ? savedComment : c))
        );
      }
    } catch (err) {
      console.error('Failed to submit comment:', err);
      // Remove failed comment
      setComments((prev) => prev.filter((c) => c.id !== tempComment.id));
      alert('Unable to post comment. Please try again.');
    } finally {
      setSubmittingComment(false);
    }
  };

  if (!currentPhoto) return null;

  const fullImageUrl = `/gallery/api/${encodeURIComponent(token)}/photos/${currentPhoto.id}/full`;
  const favorited = isFavorited ? isFavorited(currentPhoto.id) : false;

  return (
    <div
      className="gallery-lightbox-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Photo viewer: ${currentPhoto.filename}`}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* Top Bar */}
      <div className="gallery-lightbox-topbar">
        <div className="gallery-lightbox-counter">
          {currentIndex + 1} &nbsp;/&nbsp; {photos.length}
          <span style={{ opacity: 0.5, marginLeft: '0.85rem', fontFamily: 'var(--gallery-font-serif)', fontStyle: 'italic' }}>
            {currentPhoto.filename}
          </span>
        </div>

        <div className="gallery-lightbox-actions">
          {/* Comments Toggle Button */}
          <button
            type="button"
            className="gallery-lightbox-icon-btn"
            onClick={() => setShowComments((v) => !v)}
            title={showComments ? 'Hide comments' : 'Show comments'}
            aria-label="Toggle comments"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </button>

          {/* Favorite Toggle Button */}
          <button
            type="button"
            className={`gallery-lightbox-icon-btn ${favorited ? 'favorited' : ''}`}
            onClick={() => onToggleFavorite && onToggleFavorite(currentPhoto.id)}
            title={favorited ? 'Remove from favorites' : 'Add to favorites'}
            aria-label={favorited ? 'Favorited' : 'Add favorite'}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill={favorited ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
            </svg>
          </button>

          {/* Close Button */}
          <button
            type="button"
            className="gallery-lightbox-icon-btn"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close viewer"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Main Image Area */}
      <div className="gallery-lightbox-body" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        {hasPrev && (
          <button
            type="button"
            className="gallery-lightbox-nav-btn prev"
            onClick={(e) => { e.stopPropagation(); goToPrev(); }}
            aria-label="Previous photo"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
        )}

        <img
          key={currentPhoto.id}
          src={fullImageUrl}
          alt={currentPhoto.filename}
          className="gallery-lightbox-img"
        />

        {hasNext && (
          <button
            type="button"
            className="gallery-lightbox-nav-btn next"
            onClick={(e) => { e.stopPropagation(); goToNext(); }}
            aria-label="Next photo"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        )}
      </div>

      {/* Comment Section (Collapsible drawer or visible panel) */}
      {showComments && (
        <div className="gallery-lightbox-comments-bar">
          <div style={{ width: '100%', maxWidth: 680, display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {/* Existing comments */}
            <div className="gallery-comments-panel">
              {loadingComments ? (
                <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: '0.8rem', textAlign: 'center', padding: '0.5rem' }}>
                  Loading comments&hellip;
                </div>
              ) : comments.length === 0 ? (
                <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.85rem', fontStyle: 'italic', textAlign: 'center', padding: '0.5rem' }}>
                  No comments yet. Leave a note for the photographer below.
                </div>
              ) : (
                comments.map((c) => (
                  <div key={c.id} className="gallery-comment-item">
                    <div className="gallery-comment-header">
                      <span className="gallery-comment-author">
                        {c.display_name || c.displayName || 'Guest'}
                      </span>
                      {c.created_at && (
                        <span className="gallery-comment-time">
                          {new Date(c.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      )}
                    </div>
                    <p className="gallery-comment-body">{c.body}</p>
                  </div>
                ))
              )}
            </div>

            {/* Add Comment Form */}
            <form onSubmit={handleCommentSubmit} className="gallery-comment-form">
              <div className="gallery-comment-inputs">
                <input
                  type="text"
                  placeholder="Your name (optional)"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="gallery-input"
                  style={{ maxWidth: 200 }}
                />
                <input
                  type="text"
                  placeholder="Add a comment or note..."
                  value={commentBody}
                  onChange={(e) => setCommentBody(e.target.value)}
                  maxLength={2000}
                  className="gallery-input"
                  style={{ flex: 1 }}
                />
                <button
                  type="submit"
                  disabled={!commentBody.trim() || submittingComment}
                  className="gallery-btn gallery-btn-primary"
                  style={{ whiteSpace: 'nowrap' }}
                >
                  Post
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
