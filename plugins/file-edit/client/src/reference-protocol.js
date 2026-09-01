const V2_PREFIX = 'dsh-file-ref:v2:'

function legacyReference(ref) {
  const raw = String(ref || '')
  const match = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(raw)
  const path = match && match[1] ? match[1] : raw
  const start = match && match[2] ? Number.parseInt(match[2], 10) : 0
  const end = match && match[3] ? Number.parseInt(match[3], 10) : start
  return { path, start, end, kind: 'file' }
}

export function decodeFileReference(ref, fallbackKind = 'file') {
  const raw = String(ref || '')
  if (raw.startsWith(V2_PREFIX)) {
    try {
      const value = JSON.parse(decodeURIComponent(raw.slice(V2_PREFIX.length)))
      if (value && typeof value.path === 'string' && value.path) {
        const start = Number.isInteger(value.start) && value.start > 0 ? value.start : 0
        const end = Number.isInteger(value.end) && value.end > 0 ? value.end : start
        return {
          path: value.path,
          start,
          end,
          kind: value.kind === 'folder' ? 'folder' : 'file',
        }
      }
    } catch (error) {}
  }
  const decoded = legacyReference(raw)
  return { ...decoded, kind: fallbackKind === 'folder' && decoded.start === 0 ? 'folder' : 'file' }
}

export function encodeFileReference(ref, fallbackKind = 'file') {
  const decoded = ref && typeof ref === 'object' && typeof ref.path === 'string'
    ? {
        path: ref.path,
        start: Number.isInteger(ref.start) && ref.start > 0 ? ref.start : 0,
        end: Number.isInteger(ref.end) && ref.end > 0 ? ref.end : (Number.isInteger(ref.start) ? ref.start : 0),
        kind: ref.kind === 'folder' ? 'folder' : 'file',
      }
    : decodeFileReference(ref, fallbackKind)
  return V2_PREFIX + encodeURIComponent(JSON.stringify(decoded))
}

export function fileReferenceClipboardText(ref) {
  const value = decodeFileReference(ref)
  const range = value.start > 0
    ? ':' + value.start + (value.end !== value.start ? '-' + value.end : '')
    : ''
  return '@' + value.path + range
}

export function escapeXmlAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function cdata(value) {
  return '<![CDATA[\n' + String(value).replace(/\]\]>/g, ']]]]><![CDATA[>') + '\n]]>'
}

export function fileReferenceTag(value, options = {}) {
  const path = escapeXmlAttribute(value.path)
  const kind = value.kind === 'folder' ? 'folder' : 'file'
  if (value.start <= 0) {
    return '<file-reference version="2" kind="' + kind + '" mode="path" path="' + path + '"/>'
  }
  const start = Number.isInteger(options.start) ? options.start : value.start
  const end = Number.isInteger(options.end) ? options.end : value.end
  const attrs = 'version="2" kind="file" mode="lines" trust="untrusted-data" path="' + path
    + '" start="' + start + '" end="' + end + '"'
  if (options.status && options.status !== 'ok') {
    return '<file-reference ' + attrs + ' status="' + escapeXmlAttribute(options.status) + '"/>'
  }
  return '<file-reference ' + attrs + '>\n' + cdata(options.numbered || '') + '\n</file-reference>'
}
