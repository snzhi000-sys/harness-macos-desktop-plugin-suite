const manifest = require('./package.json')

const channel = process.env.DSH_DESKTOP_CHANNEL
if (channel !== 'dev' && channel !== 'stable') {
  throw new Error('DSH_DESKTOP_CHANNEL must be either dev or stable')
}

const dev = channel === 'dev'

module.exports = {
  ...manifest.build,
  appId: dev ? 'ai.deepseek.harness.desktop.dev' : 'ai.deepseek.harness.desktop',
  productName: dev ? 'DeepSeek Harness Dev' : 'DeepSeek Harness',
  extraMetadata: {
    dshDesktopChannel: channel,
  },
  directories: {
    ...manifest.build.directories,
    // electron-builder otherwise walks up to the pnpm workspace root and
    // applies extraMetadata to the source package.json there.
    app: __dirname,
    output: `dist/${channel}`,
  },
}
