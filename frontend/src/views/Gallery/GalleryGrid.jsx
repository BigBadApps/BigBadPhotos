import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useGallery } from './GalleryShell';
import * as galleryClient from '../../api/galleryClient';
import GalleryLanding from './GalleryLanding';
import GalleryLightbox from './GalleryLightbox';

export default function GalleryGrid() {
  const { token, photoId: urlPhotoId } = useParams();
  const navigate = useNavigate();
  const { galleryInfo, isFavorited, toggleFavorite } = useGallery();

  const [photos, setPhotos] = useState([]);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [activePhotoId, setActivePhotoId] = useState(() => {
    return urlPhotoId ? Number(urlPhotoId) : null;
  });

  const photosRef = useRef(photos);
  photosRef.current = photos;

  // Initial load of photos
  useEffect(() => {
    if (!token) return;

    let isMounted = true;
    setLoadingInitial(true);

    galleryClient.fetchPhotos(token, { limit: 100 })
      .then((data) => {
        if (!isMounted) return;
        if (Array.isArray(data)) {
          setPhotos(data);
        }
      })
      .catch((err) => {
        console.error('Failed to load gallery photos:', err);
      })
      .finally(() => {
        if (isMounted) setLoadingInitial(false);
      });

    return () => {
      isMounted = false;
    };
  }, [token]);

  // Sync URL photoId to activePhotoId
  useEffect(() => {
    if (urlPhotoId) {
      setActivePhotoId(Number(urlPhotoId));
    }
  }, [urlPhotoId]);

  // Live polling every 5 seconds for new photos
  useEffect(() => {
    if (!token) return;

    const interval = setInterval(async () => {
      const currentList = photosRef.current;
      const lastPhoto = currentList.length > 0 ? currentList[currentList.length - 1] : null;
      const afterId = lastPhoto ? lastPhoto.id : null;

      try {
        const newPhotos = await galleryClient.fetchPhotos(token, {
          afterId: afterId || undefined,
          limit: 50,
        });

        if (Array.isArray(newPhotos) && newPhotos.length > 0) {
          setPhotos((prev) => {
            const existingIds = new Set(prev.map((p) => p.id));
            const fresh = newPhotos.filter((p) => !existingIds.has(p.id));
            if (fresh.length === 0) return prev;
            return [...prev, ...fresh];
          });
        }
      } catch (err) {
        // Silent fail on polling error so UX isn't interrupted
        console.debug('Polling error (will retry):', err);
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [token]);

  const handleCardClick = useCallback((photo) => {
    setActivePhotoId(photo.id);
  }, []);

  const handleCloseLightbox = useCallback(() => {
    setActivePhotoId(null);
    if (urlPhotoId) {
      navigate(`/gallery/${token}`, { replace: true });
    }
  }, [navigate, token, urlPhotoId]);

  const handleNavigateLightbox = useCallback((nextId) => {
    setActivePhotoId(nextId);
  }, []);

  if (loadingInitial && photos.length === 0) {
    return (
      <div className="gallery-empty-state">
        <div className="gallery-pulse-indicator">
          <span className="gallery-pulse-dot" />
          <span>Curating your gallery&hellip;</span>
        </div>
      </div>
    );
  }

  // If no photos exist, show the empty landing state
  if (photos.length === 0) {
    const sessionName = galleryInfo?.session_name || galleryInfo?.sessionName || 'Photo Session';
    return <GalleryLanding sessionName={sessionName} />;
  }

  return (
    <>
      <div className="gallery-masonry">
        {photos.map((photo) => {
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
          photos={photos}
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
