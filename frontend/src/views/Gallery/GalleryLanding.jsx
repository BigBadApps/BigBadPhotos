import React from 'react';

export default function GalleryLanding({ sessionName = 'Photo Session' }) {
  return (
    <div className="gallery-empty-state" aria-live="polite">
      <p className="gallery-brand-sub" style={{ marginBottom: '1.25rem' }}>Live Session Feed</p>
      <h2 className="gallery-empty-title">{sessionName}</h2>
      <p className="gallery-empty-subtitle">
        Your photography team is currently shooting and processing images.
        New photos will appear here automatically as they are published.
      </p>
      <div className="gallery-pulse-indicator">
        <span className="gallery-pulse-dot" />
        <span>Photos arriving soon&hellip;</span>
      </div>
    </div>
  );
}
