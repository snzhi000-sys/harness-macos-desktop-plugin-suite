/** Product selection shared by packaging and artifact verification. */
function desktopPetEnabled(channel = process.env.DSH_DESKTOP_CHANNEL ?? 'dev') {
  if (channel !== 'dev' && channel !== 'stable') throw new Error('Invalid desktop channel')
  return true
}

function productProfile(manifest, channel) {
  if (desktopPetEnabled(channel)) return structuredClone(manifest)
  const pet = 'dsh-desktop-pet'
  return {
    ...manifest,
    bundles: manifest.bundles.filter(name => name !== pet),
    packages: manifest.packages.filter(name => name !== pet),
    productPlugins: Object.fromEntries(Object.entries(manifest.productPlugins).filter(([name]) => name !== pet)),
    requiredRuntimePlugins: manifest.requiredRuntimePlugins.filter(plugin => plugin.package !== pet),
  }
}

module.exports = { desktopPetEnabled, productProfile }
