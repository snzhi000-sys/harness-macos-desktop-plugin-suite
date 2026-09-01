import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  cdata, decodeFileReference, encodeFileReference, escapeXmlAttribute,
  fileReferenceClipboardText, fileReferenceTag,
} from '../client/src/reference-protocol.js'

test('v2 owner ref preserves file kind, path, and line range while clipboard stays readable', () => {
  const encoded = encodeFileReference({ path: '目录/示例.md', start: 5, end: 12, kind: 'file' })
  assert.deepEqual(decodeFileReference(encoded), {
    path: '目录/示例.md', start: 5, end: 12, kind: 'file',
  })
  assert.equal(fileReferenceClipboardText(encoded), '@目录/示例.md:5-12')
})

test('legacy refs remain decodable and can acquire a folder kind at insertion', () => {
  assert.deepEqual(decodeFileReference('src/example.ts:8-9'), {
    path: 'src/example.ts', start: 8, end: 9, kind: 'file',
  })
  assert.equal(decodeFileReference('src', 'folder').kind, 'folder')
})

test('model tags are explicit, readable, and safe around XML boundaries', () => {
  const tag = fileReferenceTag(
    { path: 'a&"<b>.ts', start: 2, end: 3, kind: 'file' },
    { start: 2, end: 3, numbered: '2| const close = "</file-reference>"\n3| const end = "]]>>"' },
  )
  assert.match(tag, /version="2" kind="file" mode="lines" trust="untrusted-data"/)
  assert.match(tag, /path="a&amp;&quot;&lt;b&gt;\.ts"/)
  assert.match(tag, /<!\[CDATA\[/)
  assert.match(tag, /<\/file-reference>"/)
  assert.equal(escapeXmlAttribute('&"<>'), '&amp;&quot;&lt;&gt;')
  assert.equal(cdata('a]]>b'), '<![CDATA[\na]]]]><![CDATA[>b\n]]>')
})

test('path, folder, and failed line references have unambiguous modes', () => {
  assert.equal(
    fileReferenceTag({ path: 'src', start: 0, end: 0, kind: 'folder' }),
    '<file-reference version="2" kind="folder" mode="path" path="src"/>',
  )
  assert.match(
    fileReferenceTag({ path: 'a.ts', start: 50, end: 60, kind: 'file' }, { status: 'line-range-out-of-range' }),
    /mode="lines"[^>]+status="line-range-out-of-range"\/>$/,
  )
})
