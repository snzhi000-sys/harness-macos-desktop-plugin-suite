import { join } from 'node:path'

/** Match the readiness line printed only after the complete Web profile settles. */
export const READY_URL_PATTERN = /^dsh web: (http:\/\/127\.0\.0\.1:\d+)(?:\s|$)/m

/**
 * Return the first ready URL in accumulated Harness output.
 * @param {string} output complete accumulated stdout text
 * @returns {string | undefined} the loopback URL after readiness, when present
 */
export function readyUrl(output) {
  return READY_URL_PATTERN.exec(output)?.[1]
}

/**
 * Build the Finder-safe executable search path used by agent subprocesses.
 * @param {string} runtimeDir packaged runtime root
 * @param {string | undefined} inheritedPath parent process PATH
 * @returns {string} ordered, de-duplicated PATH
 */
export function executablePath(runtimeDir, inheritedPath) {
  return [...new Set([
    join(runtimeDir, 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    ...(inheritedPath ?? '').split(':').filter(Boolean),
  ])].join(':')
}
