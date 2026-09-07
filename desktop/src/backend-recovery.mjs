/** Return the loopback port that must be reused to preserve the loaded Renderer origin. */
export function backendPort(url) {
  const parsed = new URL(url)
  const port = Number.parseInt(parsed.port, 10)
  if (parsed.hostname !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Cannot recover an invalid backend URL: ${url}`)
  }
  return port
}

/** Bounded retry delay for Desktop-owned backend recovery. */
export function backendRecoveryDelay(attempt) {
  return Math.min(4_000, 500 * 2 ** Math.max(0, attempt - 1))
}
