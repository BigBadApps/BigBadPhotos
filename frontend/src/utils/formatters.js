export function formatRunDateRange(startedAt, endedAt) {
  if (!startedAt) return '—'
  const start = new Date(startedAt)
  const datePart = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const startTime = start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (!endedAt) {
    return `${datePart}, ${startTime} – ongoing`
  }
  const end = new Date(endedAt)
  const endTime = end.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${datePart}, ${startTime}–${endTime}`
}

export function formatStatus(status) {
  if (!status) return 'Unknown'
  if (status === 'running') return 'Running'
  if (status === 'stopped') return 'Stopped'
  return status.charAt(0).toUpperCase() + status.slice(1)
}
