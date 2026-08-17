import { getCsrfHeaders } from '../utils/csrf';

async function galleryFetch(path, { method = 'GET', body } = {}) {
  const isMutating = method !== 'GET';
  const headers = {};
  if (isMutating) {
    Object.assign(headers, getCsrfHeaders());
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
  }

  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (res.status === 404) {
    const parsed = await res.json().catch(() => ({}));
    const msg = parsed.detail || parsed.error || 'Gallery not found';
    throw new Error(msg === 'gallery not found' ? 'Gallery not found' : msg);
  }

  if (!res.ok) {
    const parsed = await res.json().catch(() => ({}));
    throw new Error(parsed.detail || parsed.error || `Request failed (${res.status})`);
  }

  // Some endpoints return 204 or empty bodies
  if (res.status === 204) return null;
  return res.json().catch(() => null);
}

/**
 * Fetch gallery metadata and stats for a token.
 * GET /gallery/api/{token}/info
 */
export async function fetchGalleryInfo(token) {
  return galleryFetch(`/gallery/api/${encodeURIComponent(token)}/info`);
}

/**
 * Fetch photos in the gallery.
 * GET /gallery/api/{token}/photos?limit=...&offset=...&after_id=...
 */
export async function fetchPhotos(token, { limit, offset, afterId } = {}) {
  const params = new URLSearchParams();
  if (limit != null) params.set('limit', String(limit));
  if (offset != null) params.set('offset', String(offset));
  if (afterId != null) params.set('after_id', String(afterId));
  const query = params.toString();
  return galleryFetch(`/gallery/api/${encodeURIComponent(token)}/photos${query ? `?${query}` : ''}`);
}

/**
 * Fetch visitor's list of favorited photo IDs.
 * GET /gallery/api/{token}/favorites
 */
export async function fetchFavorites(token) {
  return galleryFetch(`/gallery/api/${encodeURIComponent(token)}/favorites`);
}

/**
 * Mark a photo as favorite for this visitor.
 * POST /gallery/api/{token}/favorites/{photoId}
 */
export async function addFavorite(token, photoId) {
  return galleryFetch(`/gallery/api/${encodeURIComponent(token)}/favorites/${encodeURIComponent(photoId)}`, {
    method: 'POST',
  });
}

/**
 * Remove a photo from favorites for this visitor.
 * DELETE /gallery/api/{token}/favorites/{photoId}
 */
export async function removeFavorite(token, photoId) {
  return galleryFetch(`/gallery/api/${encodeURIComponent(token)}/favorites/${encodeURIComponent(photoId)}`, {
    method: 'DELETE',
  });
}

/**
 * Fetch comments for the whole gallery or a specific photo.
 * GET /gallery/api/{token}/comments?photo_id=...
 */
export async function fetchComments(token, photoId = null) {
  const params = new URLSearchParams();
  if (photoId != null) {
    params.set('photo_id', String(photoId));
  }
  const query = params.toString();
  return galleryFetch(`/gallery/api/${encodeURIComponent(token)}/comments${query ? `?${query}` : ''}`);
}

/**
 * Submit a comment on a photo or gallery.
 * POST /gallery/api/{token}/comments
 */
export async function addComment(token, { body, photoId, displayName } = {}) {
  return galleryFetch(`/gallery/api/${encodeURIComponent(token)}/comments`, {
    method: 'POST',
    body: {
      body,
      photo_id: photoId ?? null,
      display_name: displayName || null,
    },
  });
}
