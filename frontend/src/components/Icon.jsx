export default function Icon({ name, size = 18, stroke = 1.6, style, className }) {
  const s = size;
  const sw = stroke;
  const p = { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: sw, strokeLinecap: 'round', strokeLinejoin: 'round' };
  const map = {
    folder:     <svg {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>,
    folderOpen: <svg {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H3V7z"/><path d="M3 9h18l-2 8a2 2 0 0 1-2 1.5H5A2 2 0 0 1 3 17V9z"/></svg>,
    arrowR:     <svg {...p}><path d="M5 12h14M13 6l6 6-6 6"/></svg>,
    arrowL:     <svg {...p}><path d="M19 12H5M11 18l-6-6 6-6"/></svg>,
    check:      <svg {...p}><path d="M5 12l4 4 10-10"/></svg>,
    qmark:      <svg {...p}><path d="M9 9a3 3 0 1 1 4.5 2.6c-.9.5-1.5 1.2-1.5 2.4V15"/><circle cx="12" cy="18.5" r=".8" fill="currentColor"/></svg>,
    x:          <svg {...p}><path d="M6 6l12 12M18 6L6 18"/></svg>,
    undo:       <svg {...p}><path d="M9 14l-5-5 5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>,
    info:       <svg {...p}><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.5"/></svg>,
    image:      <svg {...p}><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 15l-5-4-9 8"/></svg>,
    sparkle:    <svg {...p}><path d="M12 4v4M12 16v4M4 12h4M16 12h4M6.3 6.3l2.8 2.8M14.9 14.9l2.8 2.8M17.7 6.3l-2.8 2.8M9.1 14.9l-2.8 2.8"/></svg>,
    swipe:      <svg {...p}><path d="M9 11l-3 3 3 3M15 5l3 3-3 3"/><path d="M6 14h12"/><path d="M9 8h9"/></svg>,
    keyboard:   <svg {...p}><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/></svg>,
    aperture:   <svg {...p}><circle cx="12" cy="12" r="9"/><path d="M12 3l4.5 7.8M12 21l-4.5-7.8M21 12l-9 0M3 12l9 0M16.5 19.8L12 12M7.5 4.2L12 12"/></svg>,
    lock:       <svg {...p}><rect x="4" y="11" width="16" height="9" rx="2"/><path d="M8 11V8a4 4 0 1 1 8 0v3"/></svg>,
    cog:        <svg {...p}><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4.8a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.4a7 7 0 0 0-2 1.2l-2.4-.8-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-.8a7 7 0 0 0 2 1.2L10 21h4l.5-2.4a7 7 0 0 0 2-1.2l2.4.8 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z"/></svg>,
    pencil:     <svg {...p}><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/><path d="M15 5l4 4"/></svg>,
    edit:       <svg {...p}><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/><path d="M15 5l4 4"/></svg>,
  };
  const icon = map[name] || null;
  if (!icon || (!style && !className)) return icon;
  return <span style={{ display: 'inline-flex', alignItems: 'center', ...style }} className={className}>{icon}</span>;
}
