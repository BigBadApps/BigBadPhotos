// navigator.clipboard is only defined in secure contexts (https, or localhost).
// Testing over a plain-http LAN/Tailscale address is an insecure context, so
// this falls back to the deprecated execCommand copy path, and if that's
// also blocked, a prompt() the user can Cmd/Ctrl+C out of manually.
export function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text)
  }
  return execCommandCopy(text).catch((err) => {
    window.prompt('Copy this link:', text)
    throw err
  })
}

function execCommandCopy(text) {
  return new Promise((resolve, reject) => {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    try {
      const ok = document.execCommand('copy')
      ok ? resolve() : reject(new Error('copy command failed'))
    } catch (err) {
      reject(err)
    } finally {
      document.body.removeChild(textarea)
    }
  })
}
