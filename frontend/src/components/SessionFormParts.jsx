import { useState } from 'react'
import Icon from './Icon'

export const PRESETS = { strict: 0.72, balanced: 0.60, loose: 0.45 }

export function OblToggle({ checked, onChange, disabled }) {
  return (
    <label className="toggle" style={{ opacity: disabled ? 0.5 : 1 }}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="toggle-track"><span className="toggle-thumb" /></span>
    </label>
  )
}

export function Chip({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="btn fs-xs"
      style={{
        flex: 1,
        minHeight: 44,
        background: active ? 'color-mix(in oklab, var(--accent) 18%, var(--bg-3))' : 'var(--bg-3)',
        color: active ? 'var(--accent)' : 'var(--fg-2)',
        border: active ? '1px solid color-mix(in oklab, var(--accent) 55%, var(--line))' : '1px solid var(--line)',
      }}
    >
      {children}
    </button>
  )
}

export function FieldLabel({ children }) {
  return (
    <div className="meta" style={{ marginBottom: 'var(--sp-2)' }}>{children}</div>
  )
}

export function PickerRow({ label, value, placeholder, onPick }) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <button
        type="button"
        onClick={onPick}
        style={{
          width: '100%',
          minHeight: 44,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 12px',
          borderRadius: 8,
          textAlign: 'left',
          background: value ? 'color-mix(in oklab, var(--keep) 10%, transparent)' : 'var(--bg-3)',
          border: value
            ? '1px solid color-mix(in oklab, var(--keep) 30%, transparent)'
            : '1px solid var(--line)',
          color: value ? 'var(--keep)' : 'var(--fg-2)',
        }}
      >
        <Icon name={value ? 'folderOpen' : 'folder'} size={18} style={{ flexShrink: 0 }} />
        <span className="fs-sm" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {value || placeholder}
        </span>
        <Icon name="arrowR" size={14} style={{ opacity: 0.5, flexShrink: 0 }} />
      </button>
    </div>
  )
}

export function IngestKeyField({ apiKey }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    if (!apiKey) return
    navigator.clipboard.writeText(apiKey).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  if (!apiKey) return null

  return (
    <div>
      <FieldLabel>Ingest API Key</FieldLabel>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <code style={{
          flex: 1, padding: '8px 12px', borderRadius: 8,
          background: 'var(--bg-3)', fontSize: '0.8rem',
          overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {apiKey}
        </code>
        <button type="button" className="btn" onClick={handleCopy}
          style={{ minHeight: 36, padding: '0 12px' }}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  )
}
