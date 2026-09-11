const manifest = require('./package.json')
const { desktopPetEnabled } = require('./product-channel.cjs')

const channel = process.env.DSH_DESKTOP_CHANNEL
if (channel !== 'dev' && channel !== 'stable') {
  throw new Error('DSH_DESKTOP_CHANNEL must be either dev or stable')
}

const dev = channel === 'dev'
const desktopPet = desktopPetEnabled(channel)

module.exports = {
  ...manifest.build,
  mac: { ...manifest.build.mac, ...(desktopPet ? { entitlements: 'build/entitlements.pet-dev.plist', entitlementsInherit: 'build/entitlements.pet-dev.plist' } : {}), extendInfo: { ...manifest.build.mac?.extendInfo, ...(desktopPet ? { NSMicrophoneUsageDescription: '桌面伙伴在你点击录音时使用麦克风，将语音转换成可编辑的聊天文字。' } : {}) } },
  files: [...manifest.build.files, ...(!desktopPet ? ['!src/pet-window.mjs', '!src/pet-preload.cjs'] : [])],
  appId: dev ? 'ai.deepseek.harness.desktop.dev' : 'ai.deepseek.harness.desktop',
  productName: dev ? 'DeepSeek Harness Dev' : 'DeepSeek Harness',
  extraMetadata: {
    dshDesktopChannel: channel,
    dshDesktopPet: desktopPet,
  },
  directories: {
    ...manifest.build.directories,
    // electron-builder otherwise walks up to the pnpm workspace root and
    // applies extraMetadata to the source package.json there.
    app: __dirname,
    output: `dist/${channel}`,
  },
}
