import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

const TOOL_NAME = 'lark_cli'
const MAX_ARGS = 64
const MAX_ARG_BYTES = 16 * 1024
const MAX_TOTAL_ARG_BYTES = 64 * 1024
const MAX_OUTPUT_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 10 * 60_000
const GRACE_MS = 2_000

const COMMANDS = new Map([
  ['auth', new Map([
    ['check', 'read'], ['list', 'read'], ['qrcode', 'read'], ['scopes', 'read'], ['status', 'read'],
    ['login', 'write'], ['logout', 'write'],
  ])],
  ['docs', new Map([
    ['+fetch', 'read'], ['+history-list', 'read'], ['+history-revert-status', 'read'],
    ['+media-download', 'read'], ['+media-preview', 'read'], ['+resource-download', 'read'], ['+search', 'read'],
    ['+create', 'write'], ['+history-revert', 'write'], ['+media-insert', 'write'], ['+media-upload', 'write'],
    ['+resource-delete', 'write'], ['+resource-update', 'write'], ['+update', 'write'], ['+whiteboard-update', 'write'],
  ])],
  ['drive', new Map([
    ['+cover', 'read'], ['+download', 'read'], ['+export', 'read'], ['+export-download', 'read'],
    ['+inspect', 'read'], ['+preview', 'read'], ['+pull', 'read'], ['+search', 'read'],
    ['+secure-label-list', 'read'], ['+task_result', 'read'],
    ['+version-get', 'read'], ['+version-history', 'read'],
    ['+add-comment', 'write'], ['+apply-permission', 'write'], ['+create-folder', 'write'],
    ['+create-shortcut', 'write'], ['+delete', 'write'], ['+import', 'write'], ['+member-add', 'write'],
    ['+move', 'write'], ['+secure-label-update', 'write'],
    ['+upload', 'write'], ['+version-delete', 'write'], ['+version-revert', 'write'],
  ])],
  ['wiki', new Map([
    ['+member-list', 'read'], ['+node-get', 'read'], ['+node-list', 'read'], ['+space-list', 'read'],
    ['+delete-space', 'write'], ['+member-add', 'write'], ['+member-remove', 'write'], ['+move', 'write'],
    ['+node-copy', 'write'], ['+node-create', 'write'], ['+node-delete', 'write'], ['+space-create', 'write'],
  ])],
  ['markdown', new Map([
    ['+diff', 'read'], ['+fetch', 'read'],
    ['+create', 'write'], ['+overwrite', 'write'], ['+patch', 'write'],
  ])],
])

const HIGH_RISK = new Set([
  'auth logout',
  'docs +history-revert', 'docs +resource-delete',
  'drive +delete', 'drive +version-delete', 'drive +version-revert',
  'wiki +delete-space', 'wiki +member-remove', 'wiki +node-delete',
])
const BLOCKED_FLAGS = new Set(['--profile', '--from-clipboard', '--output', '--url'])
const FILE_FLAGS = new Map([
  ['--file', 'file'],
])
const AT_FILE_FLAGS = new Set(['--content', '--source', '--pattern', '--reference-map'])

function utf8Bytes(value) {
  return Buffer.byteLength(value, 'utf8')
}

function splitFlag(arg) {
  const index = arg.indexOf('=')
  return index > 0 ? [arg.slice(0, index), arg.slice(index + 1)] : [arg, undefined]
}

function hasBooleanFlag(args, name) {
  return args.some(arg => arg === name || arg === `${name}=true`)
}

function assertInsideWorkspace(rawPath, workspace, expectedType, label) {
  if (typeof workspace !== 'string' || workspace.length === 0) {
    throw new Error(`${TOOL_NAME}: ${label} requires an agent workspace`)
  }
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath === '-') {
    throw new Error(`${TOOL_NAME}: ${label} must name an existing workspace ${expectedType}`)
  }
  const workspaceReal = realpathSync(workspace)
  const candidate = isAbsolute(rawPath) ? rawPath : resolve(workspaceReal, rawPath)
  const candidateReal = realpathSync(candidate)
  const rel = relative(workspaceReal, candidateReal)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${TOOL_NAME}: ${label} must stay inside the current workspace`)
  }
  const info = statSync(candidateReal)
  if (expectedType === 'file' && !info.isFile()) throw new Error(`${TOOL_NAME}: ${label} must be a regular file`)
  if (expectedType === 'directory' && !info.isDirectory()) throw new Error(`${TOOL_NAME}: ${label} must be a directory`)
  return candidateReal
}

export function validateInvocation(rawArgs, workspace) {
  if (!Array.isArray(rawArgs) || rawArgs.length < 2) {
    throw new Error(`${TOOL_NAME}: args must start with an allowed domain and command`)
  }
  if (rawArgs.length > MAX_ARGS) throw new Error(`${TOOL_NAME}: too many arguments`)
  const args = rawArgs.map((arg, index) => {
    if (typeof arg !== 'string') throw new Error(`${TOOL_NAME}: args[${String(index)}] must be a string`)
    if (arg.includes('\0')) throw new Error(`${TOOL_NAME}: arguments cannot contain NUL bytes`)
    if (utf8Bytes(arg) > MAX_ARG_BYTES) throw new Error(`${TOOL_NAME}: one argument exceeds the size limit`)
    return arg
  })
  if (args.reduce((sum, arg) => sum + utf8Bytes(arg), 0) > MAX_TOTAL_ARG_BYTES) {
    throw new Error(`${TOOL_NAME}: arguments exceed the total size limit`)
  }

  const domain = args[0]
  const command = args[1]
  const risk = COMMANDS.get(domain)?.get(command)
  if (risk === undefined) {
    throw new Error(`${TOOL_NAME}: command is not allowed: ${domain} ${command}`)
  }

  for (let index = 2; index < args.length; index += 1) {
    const [flag, inlineValue] = splitFlag(args[index])
    if (BLOCKED_FLAGS.has(flag)) throw new Error(`${TOOL_NAME}: flag is not allowed: ${flag}`)
    const pathType = FILE_FLAGS.get(flag)
    const needsAtFileCheck = AT_FILE_FLAGS.has(flag)
    if (pathType === undefined && !needsAtFileCheck) continue
    const value = inlineValue ?? args[index + 1]
    if (inlineValue === undefined) index += 1
    if (typeof value !== 'string') throw new Error(`${TOOL_NAME}: ${flag} requires a value`)
    if (pathType !== undefined) {
      const normalized = assertInsideWorkspace(value, workspace, pathType, flag)
      if (inlineValue === undefined) args[index] = normalized
      else args[index] = `${flag}=${normalized}`
    }
    if (needsAtFileCheck && (value === '-' || value.startsWith('@'))) {
      if (value === '-') throw new Error(`${TOOL_NAME}: stdin payloads are not supported; use @file`)
      const normalized = `@${assertInsideWorkspace(value.slice(1), workspace, 'file', flag)}`
      if (inlineValue === undefined) args[index] = normalized
      else args[index] = `${flag}=${normalized}`
    }
  }

  const dryRun = hasBooleanFlag(args, '--dry-run') || hasBooleanFlag(args, '--help') || hasBooleanFlag(args, '-h')
  return {
    args,
    domain,
    command,
    risk: dryRun ? 'read' : risk,
    highRisk: !dryRun && HIGH_RISK.has(`${domain} ${command}`),
  }
}

export function redactOutput(value, { preserveDeviceCode = false } = {}) {
  let text = String(value ?? '')
  text = text.replace(/(authorization\s*:\s*bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
  text = text.replace(/("?(?:access_token|refresh_token|tenant_access_token|app_access_token|user_access_token)"?\s*[:=]\s*"?)[^"\s,}]+/gi, '$1[REDACTED]')
  if (!preserveDeviceCode) {
    text = text.replace(/("?device_code"?\s*[:=]\s*"?)[^"\s,}]+/gi, '$1[REDACTED]')
  }
  return text
}

function trustedExecutable(configured) {
  const candidates = configured === undefined
    ? [
        '/opt/homebrew/bin/lark-cli',
        '/usr/local/bin/lark-cli',
        join(homedir(), '.npm-global', 'bin', 'lark-cli'),
      ]
    : [configured]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !isAbsolute(candidate) || !existsSync(candidate)) continue
    try {
      accessSync(candidate, constants.X_OK)
      const link = lstatSync(candidate)
      if (!link.isFile() && !link.isSymbolicLink()) continue
      const real = realpathSync(candidate)
      if (!statSync(real).isFile()) continue
      return candidate
    } catch {}
  }
  throw new Error(`${TOOL_NAME}: trusted lark-cli executable was not found`)
}

function minimalEnvironment(callTemp) {
  const env = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]))
  const keep = ['LANG', 'LC_ALL', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR']
  for (const key of keep) if (process.env[key] !== undefined) env[key] = process.env[key]
  env.HOME = homedir()
  env.TMPDIR = callTemp
  env.PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
  return env
}

function approvalReason(invocation, purpose) {
  const risk = '高风险远程写操作'
  const cleanPurpose = redactOutput(String(purpose ?? '')).replace(/\s+/g, ' ').trim().slice(0, 240)
  return `允许 lark_cli 执行${risk}：${invocation.domain} ${invocation.command}${cleanPurpose ? `。用途：${cleanPurpose}` : ''}`
}

function readCollected(handle, stream) {
  const value = handle.collected?.[stream]?.readFrom(0)
  if (value === undefined) throw new Error(`${TOOL_NAME}: subprocess did not provide collected ${stream}`)
  return value
}

async function waitForTree(handle) {
  const bound = AbortSignal.timeout(GRACE_MS)
  if (await handle.waitForExit(bound)) return
  handle.terminate()
  const killed = await handle.waitForExit(AbortSignal.timeout(GRACE_MS * 3))
  if (!killed) throw new Error(`${TOOL_NAME}: process tree did not stop after termination`)
}

export function createTool(ctx, config = {}) {
  const stateDir = config.stateDir ?? join(homedir(), 'Library', 'Application Support', 'lark-cli')
  if (!isAbsolute(stateDir)) throw new Error(`${TOOL_NAME}: stateDir must be absolute`)
  let executable
  const timeoutMs = Number.isFinite(config.timeoutMs)
    ? Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Number(config.timeoutMs)))
    : DEFAULT_TIMEOUT_MS

  return {
    name: TOOL_NAME,
    description: 'Run a constrained lark-cli command without a shell. Only auth, docs, drive, wiki, and markdown shortcuts are allowed. Destructive or access-changing remote writes require one-time user approval; local upload inputs must be existing files inside the current workspace.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exact lark-cli argv after the executable, beginning with an allowed domain and command. Do not include lark-cli itself.',
        },
        purpose: { type: 'string', description: 'Short user-facing reason for this operation and approval request.' },
      },
      required: ['args', 'purpose'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          command: { type: 'string' },
          exit_code: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          signal: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          truncated: { type: 'boolean' },
        },
        required: ['ok', 'command', 'exit_code', 'signal', 'stdout', 'stderr', 'truncated'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.stdout}${value.stdout && value.stderr ? '\n' : ''}${value.stderr}${value.stdout || value.stderr ? '\n' : ''}[${value.command}; exit ${value.exit_code ?? value.signal ?? 'unknown'}]`,
      }],
    },
    async execute(raw, exec) {
      exec.signal.throwIfAborted()
      const invocation = validateInvocation(raw?.args, exec.agent?.session?.header?.cwd)
      executable ??= trustedExecutable(config.executable)
      mkdirSync(stateDir, { recursive: true, mode: 0o700 })
      if (invocation.highRisk) {
        if (exec.agent === undefined) throw new Error(`${TOOL_NAME}: remote writes require an agent-scoped approval`)
        const outcome = await ctx.approval.request({
          agent: exec.agent,
          toolName: TOOL_NAME,
          callId: exec.callId,
          reason: approvalReason(invocation, raw?.purpose),
          signal: exec.signal,
        })
        if (outcome !== 'allowed-once') {
          throw new Error(`${TOOL_NAME}: approval did not grant this operation (${outcome})`)
        }
      }

      const callTemp = mkdtempSync(join(tmpdir(), 'dsh-lark-cli-'))
      const timeout = new AbortController()
      const timer = setTimeout(() => timeout.abort(new Error(`${TOOL_NAME}: command timed out`)), timeoutMs)
      const signal = AbortSignal.any([exec.signal, timeout.signal])
      try {
        const policy = {
          mode: 'workspace-write',
          workspaceRoot: stateDir,
          ...(exec.agent?.session?.header?.id !== undefined ? { sessionId: exec.agent.session.header.id } : {}),
        }
        const confined = ctx.sandbox.confine([executable, ...invocation.args], policy)
        if (confined.enforcement !== 'full') {
          throw new Error(`${TOOL_NAME}: full filesystem sandbox enforcement is required`)
        }
        const handle = ctx.subprocess.spawn({
          argv: confined.argv,
          cwd: callTemp,
          env: minimalEnvironment(callTemp),
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: MAX_OUTPUT_BYTES },
            stderr: { maxBytes: MAX_OUTPUT_BYTES },
          },
          graceMs: GRACE_MS,
          signal,
        })
        const outcome = await handle.done
        await waitForTree(handle)
        const stdoutRaw = readCollected(handle, 'stdout')
        const stderrRaw = readCollected(handle, 'stderr')
        if (timeout.signal.aborted) throw timeout.signal.reason
        exec.signal.throwIfAborted()
        const preserveDeviceCode = invocation.domain === 'auth' && invocation.command === 'login' && hasBooleanFlag(invocation.args, '--no-wait')
        return {
          ok: outcome.exitCode === 0 && outcome.signal === null,
          command: `${invocation.domain} ${invocation.command}`,
          exit_code: outcome.exitCode,
          signal: outcome.signal,
          stdout: redactOutput(stdoutRaw.text, { preserveDeviceCode }),
          stderr: redactOutput(stderrRaw.text),
          truncated: stdoutRaw.lossy || stderrRaw.lossy,
        }
      } finally {
        clearTimeout(timer)
        rmSync(callTemp, { recursive: true, force: true })
      }
    },
  }
}

export const inject = ['tools', 'systemPrompt', 'approval', 'sandbox', 'subprocess']

export function apply(ctx, config = {}) {
  ctx.effect(() => ctx.tools.register(createTool(ctx, config)), 'dsh-lark-cli: controlled tool')
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'tool:lark-cli',
    order: 104,
    text: 'Use lark_cli for supported Feishu/Lark auth, docs, drive, wiki, and markdown operations. Pass exact argv as an array, never shell syntax. Ordinary document creation, updates, imports, and uploads run directly; destructive, rollback, logout, and access-removal operations ask the user once. Uploads may read only existing files inside the current workspace; directory sync is unavailable. The tool cannot modify workspace files and cannot run raw API, config, profile, update, skills, background, or terminal commands.',
  }), 'dsh-lark-cli: guidance')
}

export default { inject, apply }
