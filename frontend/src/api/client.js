// Relative URLs — works on localhost (proxied by Vite) and on the Tailscale HTTPS hostname.
export async function checkHealth() {
  const res = await fetch('/health')
  if (!res.ok) throw new Error(`Health check failed: ${res.status}`)
  return res.json()
}

export async function rankPhotos(photos) {
  const formData = new FormData()
  formData.append('manifest', JSON.stringify(photos.map(p => ({ id: p.id, filename: p.filename }))))
  for (const photo of photos) {
    formData.append(photo.id, photo.file, photo.filename)
  }

  const res = await fetch('/rank', { method: 'POST', body: formData })
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const body = await res.json()
      message = body.error || body.detail || message
    } catch { /* ignore */ }
    const err = new Error(message)
    err.status = res.status
    throw err
  }
  return (await res.json()).results
}
