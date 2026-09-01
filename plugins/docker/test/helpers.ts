/**
 * Shared test harness: a minimal cordis context with the real tool registry,
 * the docker tools, the two-layer policy, a scriptable fake shell, and a
 * mock approval gate. No daemon required.
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CallId } from '@deepseek-ai/dsh-llm'
import type { ShellExecRequest, ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { ShellExecutor } from '@deepseek-ai/dsh-shell'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { DockerRunner } from '../src/runner.ts'
import { applyPolicy } from '../src/policy.ts'
import { applyContainerTools } from '../src/tools/containers.ts'
import { applyLogsTool } from '../src/tools/logs.ts'
import { applyInspectTool } from '../src/tools/inspect.ts'
import { applyExecTool } from '../src/tools/exec.ts'
import { applyImageTools } from '../src/tools/images.ts'
import { applyPruneTool } from '../src/tools/prune.ts'
import { applyComposeTools } from '../src/tools/compose.ts'
import { resolveConfig, type Config, type ResolvedConfig } from '../src/types.ts'

/** One scripted shell response, matched by substring against the command. */
export interface ShellResponse {
  match: string
  exitCode?: number | null
  stdout?: string
  stderr?: string
}

/** A scriptable fake `ctx.shell` executor. */
export class FakeShell {
  calls: string[] = []
  private readonly responses: ShellResponse[]

  constructor(responses: ShellResponse[]) {
    this.responses = responses
  }

  resolve(req: ShellExecRequest): ShellExecSpec {
    return {
      command: req.command,
      workdir: req.workdir ?? process.cwd(),
      timeoutMs: 30_000,
      stdoutMaxBytes: req.stdoutMaxBytes ?? 1_048_576,
      signal: req.signal,
      stdin: req.stdin,
      env: req.env,
      dshEnv: req.dshEnv,
      sandboxPolicy: undefined,
    }
  }

  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    this.calls.push(spec.command)
    for (const r of this.responses) {
      if (spec.command.includes(r.match)) {
        return {
          exitCode: r.exitCode ?? 0,
          signal: null,
          timedOut: false,
          aborted: false,
          timeoutMs: spec.timeoutMs,
          stdout: { text: r.stdout ?? '', truncated: false },
          stderr: { text: r.stderr ?? '', truncated: false },
        }
      }
    }
    throw new Error(`FakeShell: unexpected command: ${spec.command}`)
  }
}

/** A mock approval gate recording every request. */
export function mockApproval(outcome: ApprovalOutcome) {
  const requests: Array<{ toolName: string; reason: string }> = []
  return {
    requests,
    request: async (req: { toolName: string; reason?: string }): Promise<ApprovalOutcome> => {
      requests.push({ toolName: req.toolName, reason: req.reason ?? '' })
      return outcome
    },
  }
}

/** A minimal agent carrying a session cwd for project detection. */
export function fakeAgent(cwd = process.cwd()): Agent {
  return { session: { header: { cwd } } } as unknown as Agent
}

/** One docker tool call executed through the real pipeline. */
export async function executeTool(
  ctx: Context,
  name: string,
  args: Record<string, unknown>,
  cwd = process.cwd(),
): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    callId: `call-${name}-${Math.random().toString(36).slice(2)}` as unknown as CallId,
    name,
    arguments: args,
    agent: fakeAgent(cwd),
    signal: new AbortController().signal,
  })
}

export interface BuildOptions {
  shell: FakeShell
  /** Approval outcome the mock gate returns; omit to leave no gate composed. */
  approval?: ReturnType<typeof mockApproval>
  config?: Partial<Config>
  cwd?: string
  /** Runs before the policy is installed (e.g. a rogue pre-execute listener). */
  beforePolicy?: (ctx: Context) => void
}

/** Build a test context with the tools and policy installed. */
export async function buildContext(options: BuildOptions): Promise<{ ctx: Context; config: ResolvedConfig }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const config = resolveConfig(options.config)
  const getConfig = () => config
  const runner = new DockerRunner(ctx, getConfig)
  applyContainerTools(ctx, runner, getConfig)
  applyLogsTool(ctx, runner, getConfig)
  applyInspectTool(ctx, runner, getConfig)
  applyExecTool(ctx, runner, getConfig)
  applyImageTools(ctx, runner, getConfig)
  applyPruneTool(ctx, runner, getConfig)
  applyComposeTools(ctx, runner, getConfig)
  if (options.beforePolicy !== undefined) options.beforePolicy(ctx)
  applyPolicy(ctx, runner, getConfig)
  ctx.provide('shell', options.shell as unknown as ShellExecutor)
  if (options.approval !== undefined) {
    ctx.provide('approval', options.approval as never)
  }
  return { ctx, config }
}

/** A docker ps row for the fake shell, in `--format json` NDJSON. */
export function psRow(partial: Record<string, unknown>): string {
  return JSON.stringify({
    ID: 'aabbccddeeff',
    Names: 'box',
    Image: 'alpine',
    State: 'running',
    Status: 'Up 1 hour',
    Ports: '',
    Labels: 'com.docker.compose.project=probe,com.docker.compose.service=box',
    ...partial,
  })
}

/** An images row for the fake shell, in `--format json` NDJSON. */
export function imageRow(partial: Record<string, unknown>): string {
  return JSON.stringify({
    ID: 'img1234567890',
    Repository: 'alpine',
    Tag: 'latest',
    Size: '5MB',
    ...partial,
  })
}
