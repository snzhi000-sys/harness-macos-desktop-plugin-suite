import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'

const forbiddenNames = [
  /(^|\/)\.credentials\.ya?ml$/i,
  /(^|\/)\.env(?:\.|$)/,
  /(^|\/)\.sessions?(\/|$)/,
  /(^|\/)quarantine(\/|$)/,
  /(^|\/)dsh-file-edit-state(\/|$)/,
  /\.(?:sqlite3?|db|key|keystore|jks|p12|mobileprovision)$/i,
]

/**
 * Scan an extracted release tree for personal state and build-machine paths.
 * @param {string} root - Extracted App, Runtime, or Profile directory.
 * @param {{ label?: string, markers?: string[] }} [options] - Diagnostic label and private text markers.
 * @returns {Array<[string, string]>} Relative paths and violated privacy rules.
 */
export function scanReleaseTree(root, options = {}) {
  const label = options.label ?? 'release'
  const markers = options.markers ?? [homedir()]
  const violations = []
  const visit = path => {
    const stat = lstatSync(path)
    const relativePath = relative(root, path).split('\\').join('/') || '.'
    const displayPath = `${label}/${relativePath}`
    if (stat.isSymbolicLink()) {
      if (isAbsolute(readlinkSync(path))) violations.push([displayPath, 'absolute-symlink'])
      return
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) visit(join(path, entry))
      return
    }
    if (!stat.isFile()) return
    if (forbiddenNames.some(pattern => pattern.test(relativePath))) {
      violations.push([displayPath, 'forbidden-state-file'])
    }
    if (stat.size > 5 * 1024 * 1024) return
    const buffer = readFileSync(path)
    if (buffer.includes(0)) return
    const content = buffer.toString('utf8')
    if (markers.some(marker => marker.length > 0 && content.includes(marker))) {
      violations.push([displayPath, 'private-content-marker'])
    }
    if (/\.(?:pem|key)$/i.test(relativePath) && [
      ['-----BEGIN ', 'PRIVATE KEY-----'].join(''),
      ['-----BEGIN OPENSSH ', 'PRIVATE KEY-----'].join(''),
    ].some(marker => content.includes(marker))) {
      violations.push([displayPath, 'private-key-content'])
    }
  }
  visit(root)
  return violations
}
