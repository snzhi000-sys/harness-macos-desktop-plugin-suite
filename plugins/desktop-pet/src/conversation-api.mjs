/** Same-origin pet API; private credential values never arrive through read endpoints. */
export async function conversationApi(path = '', body, options = {}) {
  const response = await fetch(`/desktop-pet/api/conversation${path}`, { ...options, method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const value = await response.json(); if (!response.ok) throw new Error(value.error ?? '桌宠请求失败'); return value
}
