import assert from 'node:assert/strict'
import test from 'node:test'
import { executablePath, readyUrl } from '../src/runtime-paths.mjs'

test('accepts only the settled loopback readiness line', () => {
  assert.equal(readyUrl('noise\ndsh web: http://127.0.0.1:43123\n'), 'http://127.0.0.1:43123')
  assert.equal(readyUrl('dsh web: http://192.168.1.2:3080\n'), undefined)
})

test('prepends packaged and standard Finder paths without duplicates', () => {
  assert.equal(
    executablePath('/App/runtime', '/custom/bin:/usr/bin'),
    '/App/runtime/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/custom/bin',
  )
})
