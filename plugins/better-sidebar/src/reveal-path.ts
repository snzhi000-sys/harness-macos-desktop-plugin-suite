/** Reveal one workspace entry in the host operating system's file manager. */
import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { isWithin, messageOf, requireAbsolute } from './fs-tree.ts'
import { SidebarError } from './wire.ts'

type RevealLauncher = (executable: string, args: readonly string[]) => Promise<void>

const launch: RevealLauncher = (executable, args) => new Promise((resolve, reject) => {
  execFile(executable, [...args], { windowsHide: true }, (error) => {
    if (error === null) resolve()
    else reject(error)
  })
})

async function validateWorkspaceEntry(
  workspaceRaw: string,
  targetRaw: string,
  platform?: NodeJS.Platform,
): Promise<{ target: string; platform: NodeJS.Platform }> {
  const workspace = requireAbsolute(workspaceRaw)
  const target = requireAbsolute(targetRaw)
  if (!isWithin(workspace, target, platform)) {
    throw new SidebarError('forbidden', 'only workspace entries can be opened', 403)
  }
  try {
    await lstat(target)
    const [workspaceReal, targetReal] = await Promise.all([realpath(workspace), realpath(target)])
    if (!isWithin(workspaceReal, targetReal, platform)) {
      throw new SidebarError('forbidden', 'only workspace entries can be opened', 403)
    }
  } catch (error) {
    if (error instanceof SidebarError) throw error
    throw new SidebarError('fs-error', `cannot open "${target}": ${messageOf(error)}`, 400)
  }
  return { target, platform: platform ?? process.platform }
}

/**
 * Validate and reveal one existing workspace entry in the platform file manager.
 * @param workspaceRaw - Authoritative absolute workspace root.
 * @param targetRaw - Absolute file or folder selected in Explorer.
 * @param options - Injectable platform and launcher used by deterministic tests.
 * @returns After the platform reveal command exits successfully.
 */
export async function revealPathInFileManager(
  workspaceRaw: string,
  targetRaw: string,
  options: { platform?: NodeJS.Platform; launch?: RevealLauncher } = {},
): Promise<void> {
  const { target, platform } = await validateWorkspaceEntry(workspaceRaw, targetRaw, options.platform)
  if (platform !== 'darwin') {
    throw new SidebarError('unsupported-platform', 'revealing files is currently available on macOS only', 501)
  }

  try {
    await (options.launch ?? launch)('/usr/bin/open', ['-R', target])
  } catch (error) {
    throw new SidebarError('fs-error', `cannot reveal "${target}": ${messageOf(error)}`, 500)
  }
}

/** Open one existing workspace file with the operating system's default app. */
export async function openPathWithSystemApp(
  workspaceRaw: string,
  targetRaw: string,
  options: { platform?: NodeJS.Platform; launch?: RevealLauncher } = {},
): Promise<void> {
  const { target, platform } = await validateWorkspaceEntry(workspaceRaw, targetRaw, options.platform)
  if (platform !== 'darwin') {
    throw new SidebarError('unsupported-platform', 'opening files is currently available on macOS only', 501)
  }
  try {
    await (options.launch ?? launch)('/usr/bin/open', [target])
  } catch (error) {
    throw new SidebarError('fs-error', `cannot open "${target}": ${messageOf(error)}`, 500)
  }
}
