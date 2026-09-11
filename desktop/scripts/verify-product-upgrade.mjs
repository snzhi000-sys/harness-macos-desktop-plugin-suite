import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
const appPath = resolve(process.argv[2])
const resources = join(appPath, 'Contents', 'Resources')
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const temporary = mkdtempSync(join(tmpdir(), 'dsh-packaged-upgrade-'))
try {
  const runtime = join(temporary, 'runtime')
  const profile = join(temporary, 'profile')
  mkdirSync(runtime)
  mkdirSync(profile)
  execFileSync('/usr/bin/tar', ['-xzf', join(resources, 'runtime-bootstrap/runtime.tar.gz'), '-C', runtime])
  execFileSync('/usr/bin/tar', ['-xzf', join(resources, 'profile-bootstrap/profile.tar.gz'), '-C', profile])
  const installer = join(temporary, 'profile-bootstrap.mjs')
  writeFileSync(installer, asar.extractFile(join(resources, 'app.asar'), 'src/profile-bootstrap.mjs'))
  execFileSync(join(runtime, 'bin/node'), ['--test', '--test-name-pattern=migrated Stable profile|cold file browsing|full access', 'plugins/file-edit/tests/host-event-ledger.test.mjs'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, DSH_TEST_APP_RESOURCES: resources, DSH_TEST_RUNTIME_DIR: runtime,
      DSH_TEST_PROFILE_INSTALLER: pathToFileURL(installer).href,
      DSH_TEST_FILE_EDIT_HOST: pathToFileURL(join(profile, 'node_modules/dsh-file-edit/host/index.mjs')).href },
  })
  console.log('Packaged Stable migration, real Bash write/delete, ledger and rejection recovery passed')
} finally {
  rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
