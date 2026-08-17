import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, Outlet, useLocation, useNavigate, Link } from 'react-router-dom';
import * as galleryClient from '../../api/galleryClient';
import './Gallery.css';

export const GalleryContext = createContext(null);

export function useGallery() {
  const ctx = useContext(GalleryContext);
  if (!ctx) {
    throw new Error('useGallery must be used within a GalleryShell');
  }
  return ctx;
}

export default function GalleryShell() {
  const { token } = useParams();
  const location = useLocation();
  const navigate = useNavigate();

  const [galleryInfo, setGalleryInfo] = useState(null);
  const [loadingInfo, setLoadingInfo] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState(null);

  const [favorites, setFavorites] = useState(new Set());
  const [loadingFavorites, setLoadingFavorites] = useState(true);

  // The main app locks html/body to a fixed 100dvh with overflow:hidden and
  // scrolls internal panels instead (see index.css). The gallery is a plain
  // scrolling document, so it needs that reset lifted while mounted — without
  // this, iOS Safari has no scrollable element and the page is stuck in place.
  useEffect(() => {
    document.documentElement.classList.add('gallery-mode');
    document.body.classList.add('gallery-mode');
    return () => {
      document.documentElement.classList.remove('gallery-mode');
      document.body.classList.remove('gallery-mode');
    };
  }, []);

  // Fetch gallery metadata
  useEffect(() => {
    if (!token) {
      setNotFound(true);
      setLoadingInfo(false);
      return;
    }

    let isMounted = true;
    setLoadingInfo(true);
    setError(null);
    setNotFound(false);

    galleryClient.fetchGalleryInfo(token)
      .then((info) => {
        if (!isMounted) return;
        setGalleryInfo(info);
        setNotFound(false);
      })
      .catch((err) => {
        if (!isMounted) return;
        console.error('Gallery info load error:', err);
        if (err.message && err.message.toLowerCase().includes('not found')) {
          setNotFound(true);
        } else {
          setError(err.message || 'Unable to load gallery');
        }
      })
      .finally(() => {
        if (isMounted) setLoadingInfo(false);
      });

    return () => {
      isMounted = false;
    };
  }, [token]);

  // Fetch visitor favorites on mount
  useEffect(() => {
    if (!token || notFound) return;

    let isMounted = true;
    galleryClient.fetchFavorites(token)
      .then((favIds) => {
        if (!isMounted || !Array.isArray(favIds)) return;
        setFavorites(new Set(favIds.map(Number)));
      })
      .catch((err) => {
        console.warn('Failed to load favorites:', err);
      })
      .finally(() => {
        if (isMounted) setLoadingFavorites(false);
      });

    return () => {
      isMounted = false;
    };
  }, [token, notFound]);

  // Optimistic favorite toggle
  const toggleFavorite = useCallback(async (photoId) => {
    if (!token || !photoId) return;
    const id = Number(photoId);
    const wasFavorited = favorites.has(id);

    // Optimistic state update
    setFavorites((prev) => {
      const next = new Set(prev);
      if (wasFavorited) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

    try {
      if (wasFavorited) {
        await galleryClient.removeFavorite(token, id);
      } else {
        await galleryClient.addFavorite(token, id);
      }
    } catch (err) {
      console.error('Failed to update favorite status:', err);
      // Rollback on error
      setFavorites((prev) => {
        const rollback = new Set(prev);
        if (wasFavorited) {
          rollback.add(id);
        } else {
          rollback.delete(id);
        }
        return rollback;
      });
    }
  }, [token, favorites]);

  const isFavorited = useCallback((photoId) => {
    return favorites.has(Number(photoId));
  }, [favorites]);

  const contextValue = useMemo(() => ({
    token,
    galleryInfo,
    favorites,
    isFavorited,
    toggleFavorite,
    loadingFavorites,
  }), [token, galleryInfo, favorites, isFavorited, toggleFavorite, loadingFavorites]);

  // 404 Not Found View
  if (notFound) {
    return (
      <div data-gallery>
        <div className="gallery-error-page">
          <p className="gallery-brand-sub" style={{ marginBottom: '1rem' }}>BigBadPhotos Client Gallery</p>
          <h1 className="gallery-empty-title">Gallery Not Found</h1>
          <p className="gallery-empty-subtitle" style={{ maxWidth: 440 }}>
            This gallery link may be invalid, expired, or has been revoked by the photographer.
          </p>
        </div>
      </div>
    );
  }

  // Generic Error View
  if (error) {
    return (
      <div data-gallery>
        <div className="gallery-error-page">
          <p className="gallery-brand-sub" style={{ marginBottom: '1rem' }}>BigBadPhotos</p>
          <h1 className="gallery-empty-title">Unable to Load Gallery</h1>
          <p className="gallery-empty-subtitle">{error}</p>
          <button
            type="button"
            className="gallery-btn gallery-btn-primary"
            onClick={() => window.location.reload()}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Initial Loading View
  if (loadingInfo) {
    return (
      <div data-gallery>
        <div className="gallery-error-page">
          <div className="gallery-brand-sub" style={{ marginBottom: '1.5rem' }}>BigBadPhotos</div>
          <div className="gallery-pulse-indicator">
            <span className="gallery-pulse-dot" />
            <span>Loading Gallery&hellip;</span>
          </div>
        </div>
      </div>
    );
  }

  const isFavoritesView = location.pathname.endsWith('/favorites');
  const sessionName = galleryInfo?.session_name || galleryInfo?.sessionName || 'Client Gallery';
  const galleryLabel = galleryInfo?.gallery_label || galleryInfo?.galleryLabel;

  return (
    <div data-gallery>
      {/* Editorial Header */}
      <header className="gallery-header">
        <div className="gallery-header-inner">
          <div className="gallery-brand-wrap">
            <span className="gallery-brand-sub">{galleryLabel || 'Photo Gallery'}</span>
            <h1 className="gallery-title">{sessionName}</h1>
          </div>

          <nav className="gallery-nav-tabs" aria-label="Gallery Navigation">
            <Link
              to={`/gallery/${token}`}
              className={`gallery-nav-tab ${!isFavoritesView ? 'active' : ''}`}
            >
              All Photos
            </Link>
            <Link
              to={`/gallery/${token}/favorites`}
              className={`gallery-nav-tab ${isFavoritesView ? 'active' : ''}`}
            >
              <span>My Favorites</span>
              {favorites.size > 0 && (
                <span className="tab-badge">{favorites.size}</span>
              )}
            </Link>
          </nav>
        </div>
      </header>

      {/* Main Outlet */}
      <main className="gallery-main">
        <GalleryContext.Provider value={contextValue}>
          <Outlet />
        </GalleryContext.Provider>
      </main>
    </div>
  );
}
