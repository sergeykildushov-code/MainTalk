// src/custom/integratedAuth.js
// CommonJS module — require() в main.js

module.exports.setupAuthIntegration = function (appInstance) {
  try {
    // Берём BUILD_CONFIG так же, как в main.js
    const { BUILD_CONFIG } = require('../shared/build.config.ts')

    if (BUILD_CONFIG && BUILD_CONFIG.domain) {
      const { URL } = require('url')
      const host = new URL(BUILD_CONFIG.domain).hostname
      const hostPattern = `*.${host}`

      // Добавляем Chromium switches для Integrated Auth
      // NB: app.commandLine.appendSwitch можно вызывать до создания окон
      appInstance.commandLine.appendSwitch('auth-server-whitelist', hostPattern)
      appInstance.commandLine.appendSwitch('auth-negotiate-delegate-whitelist', hostPattern)

      console.log('Integrated Auth enabled for:', [hostPattern])
    } else {
      console.log('Integrated Auth skipped: no BUILD_CONFIG.domain')
    }
  } catch (err) {
    console.warn('Failed to enable integrated auth command-line switches', err)
  }
}