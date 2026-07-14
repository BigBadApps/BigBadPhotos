export function getCsrfToken() {
  const match = document.cookie.match(/(^|;)\s*csrf_token\s*=\s*([^;]+)/);
  return match ? match[2] : null;
}

export function getCsrfHeaders() {
  const token = getCsrfToken();
  return token ? { 'X-CSRFToken': token } : {};
}
