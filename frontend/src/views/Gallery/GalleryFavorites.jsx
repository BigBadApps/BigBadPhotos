import React, { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useGallery } from './GalleryShell';
import * as galleryClient from '../../api/galleryClient';
import GalleryLightbox from './GalleryLightbox';

export default function GalleryFavorites() {
  const { token } = useParams();
  const { favorites, isFavorited, toggleFavorite, loadingFavorites } = useGallery();

  const [allPhotos, setAllPhotos] = useState([]);
  const [loadingPhotos, setLoadingPhotos] = useState(true);
  const [activePhotoId, setActivePhotoId] = useState(null);

  useEffect(() => {
    if (!token) return;

    let isMounted = true;
    setLoadingPhotos(true);

    (async () => {
      const PAGE = 200;
      let all = [];
      let offset = 0;
      let done = false;
      while (!done) {
        const batch = await galleryClient.fetchPhotos(token, { limit: PAGE, offset });
        if (!isMounted) return;
        if (!Array.isArray(batch) || batch.length === 0) { done = true; break; }
        all = all.concat(batch);
        if (batch.length < PAGE) { done = true; break; }
        offset += PAGE;
      }
      if (isMounted) setAllPhotos(all);
    })()
      .catch((err) => {
        console.error('Failed to load photos in favorites view:', err);
      })
      .finally(() => {
        if (isMounted) setLoadingPhotos(false);
      });

    return () => {
      isMounted = false;
    };
  }, [token]);

  const favoritePhotos = allPhotos.filter((p) => favorites.has(Number(p.id)));

  const handleCardClick = useCallback((photo) => {
    setActivePhotoId(photo.id);
  }, []);

  const handleCloseLightbox = useCallback(() => {
    setActivePhotoId(null);
  }, []);

  const handleNavigateLightbox = useCallback((nextId) => {
    setActivePhotoId(nextId);
  }, []);

  if (loadingPhotos || loadingFavorites) {
    return (
      <div className="gallery-empty-state">
        <div className="gallery-pulse-indicator">
          <span className="gallery-pulse-dot" />
          <span>Loading favorites&hellip;</span>
        </div>
      </div>
    );
  }

  // If no favorited photos
  if (favoritePhotos.length === 0) {
    return (
      <div className="gallery-empty-state">
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: '50%',
            background: 'var(--gallery-bg-alt)',
            border: '1px solid var(--gallery-border)',
            display: 'grid',
            placeItems: 'center',
            color: 'var(--gallery-heart)',
            marginBottom: '1.5rem',
          }}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
          </svg>
        </div>
        <h2 className="gallery-empty-title">No Favorites Yet</h2>
        <p className="gallery-empty-subtitle">
          Tap the heart on any photo to save your favorites. They will be saved to your private collection.
        </p>
        <Link to={`/gallery/${token}`} className="gallery-btn gallery-btn-primary">
          Explore Gallery
        </Link>
      </div>
    );
  }

  return (
    <>
      <div className="gallery-masonry">
        {favoritePhotos.map((photo) => {
          const favorited = isFavorited(photo.id);
          const thumbUrl = photo.thumbnail_url || photo.thumbnailUrl || `/gallery/api/${encodeURIComponent(token)}/photos/${photo.id}/thumb`;

          return (
            <div
              key={photo.id}
              className="gallery-card"
              onClick={() => handleCardClick(photo)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleCardClick(photo);
                }
              }}
            >
              <div className="gallery-card-img-wrap">
                <img
                  src={thumbUrl}
                  alt={photo.filename}
                  className="gallery-card-img loaded"
                  loading="lazy"
                />

                <button
                  type="button"
                  className={`gallery-card-favorite-btn ${favorited ? 'favorited' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleFavorite(photo.id);
                  }}
                  title={favorited ? 'Favorited' : 'Favorite'}
                  aria-label={favorited ? `Remove ${photo.filename} from favorites` : `Add ${photo.filename} to favorites`}
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill={favorited ? 'currentColor' : 'none'}
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                  </svg>
                </button>
              </div>

              <div className="gallery-card-caption">
                <span className="gallery-card-filename">{photo.filename}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Lightbox Modal */}
      {activePhotoId != null && (
        <GalleryLightbox
          photos={favoritePhotos}
          activePhotoId={activePhotoId}
          token={token}
          isFavorited={isFavorited}
          onToggleFavorite={toggleFavorite}
          onClose={handleCloseLightbox}
          onNavigate={handleNavigateLightbox}
        />
      )}
    </>
  );
}
