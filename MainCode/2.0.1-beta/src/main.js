// main.js
/**
 * SPDX-FileCopyrightText: 2022 Nextcloud GmbH
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

const { app, ipcMain, desktopCapturer, systemPreferences, shell, session, BrowserWindow } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const { setupMenu } = require('./app/app.menu.js')
const { loadAppConfig, getAppConfig, setAppConfig } = require('./app/AppConfig.ts')
const { appData } = require('./app/AppData.js')
const { registerAppProtocolHandler } = require('./app/appProtocol.ts')
const { verifyCertificate, promptCertificateTrust } = require('./app/certificate.service.ts')
const { openChromeWebRtcInternals } = require('./app/dev.utils.ts')
const { triggerDownloadUrl } = require('./app/downloads.ts')
const { setupReleaseNotificationScheduler } = require('./app/githubReleaseNotification.service.js')
const { initLaunchAtStartupListener } = require('./app/launchAtStartup.config.ts')
const { systemInfo, isLinux, isMac, isWindows, isSameExecution } = require('./app/system.utils.ts')
const { applyTheme } = require('./app/theme.config.ts')
const { buildTitle, getWindowUrl } = require('./app/utils.ts')
const { enableWebRequestInterceptor, disableWebRequestInterceptor } = require('./app/webRequestInterceptor.js')

const { createAuthenticationWindow } = require('./authentication/authentication.window.js')
const { openLoginWebView } = require('./authentication/login.window.js')
const { createCallboxWindow } = require('./callbox/callbox.window.ts')
const { createHelpWindow } = require('./help/help.window.js')
const { installVueDevtools } = require('./install-vue-devtools.js')
const { BUILD_CONFIG } = require('./shared/build.config.ts')
const { createTalkWindow } = require('./talk/talk.window.js')
const { createUpgradeWindow } = require('./upgrade/upgrade.window.ts')
const { createWelcomeWindow } = require('./welcome/welcome.window.js')

// Custom authentication modules
const { setupAuthIntegration } = require('./custom/integratedAuth.js')
const domainAuth = require('./custom/domainAuth.js')
const oauthConfig = require('./custom/oauth.config.js')
const AutoOAuthManager = require('./custom/autoOAuth.js')

/** Parse command line */
const ARGUMENTS = {
  openInBackground: process.argv.includes('--background'),
}

// ========= DEEP LINK HANDLING =========
let mainWindow = null;
let deepLinkUrl = null;
const deeplinkResolvers = [];

// Вспомогательная функция: пытаемся найти nc://... в argv
function findDeepLinkInArgv(argv) {
  if (!argv || !Array.isArray(argv)) return null;
  for (const a of argv) {
    if (typeof a === 'string' && a.startsWith('nc://')) {
      return a;
    }
  }
  return null;
}

function notifyDeepLink(url) {
  console.log('🎉 [main] Deep link received:', url);
  deepLinkUrl = url;

  // отправить в окно (если оно готово)
  if (mainWindow && mainWindow.webContents) {
    try {
      mainWindow.webContents.send('deeplink-received', url);
    } catch (e) {
      console.error('[main] failed to send deeplink to renderer:', e);
    }
  }

  // разрешить всех ожидающих ipc вызовов
  while (deeplinkResolvers.length > 0) {
    const resolve = deeplinkResolvers.shift();
    try { resolve(url); } catch (e) { /* ignore */ }
  }
}

// GTK workaround on Linux
if (isLinux) app.commandLine.appendSwitch('gtk-version', '3')

// Debug flags for development
if (process.env.NODE_ENV === 'development') {
  app.commandLine.appendSwitch('disable-web-security')
  app.commandLine.appendSwitch('ignore-certificate-errors')
}

/** Name & paths */
const APP_NAME = process.env.NODE_ENV !== 'development' ? path.parse(app.getPath('exe')).name : 'Nextcloud Talk (dev)'
app.setName(APP_NAME)
app.setPath('userData', path.join(app.getPath('appData'), app.getName()))
if (isWindows && process.env.NODE_ENV === 'production') {
  const updateExePath = path.join(path.dirname(app.getPath('exe')), '../Update.exe')
  const isSquirrel = fs.existsSync(updateExePath)
  app.setAppUserModelId(
    isSquirrel
      ? `com.squirrel.${BUILD_CONFIG.applicationNameSanitized}.${BUILD_CONFIG.applicationNameSanitized}`
      : BUILD_CONFIG.winAppId
  )
}

/** Squirrel shortcuts */
if (require('electron-squirrel-startup')) app.quit()

/* ------------------ Регистрация протокола ------------------ */
console.log('🔗 Registering NC protocol...');
console.log('- Process defaultApp:', process.defaultApp);
console.log('- Process argv length:', process.argv.length);

try {
  if (process.defaultApp) {
    // Development mode
    if (process.argv.length >= 2) {
      const result = app.setAsDefaultProtocolClient('nc', process.execPath, [path.resolve(process.argv[1])]);
      console.log('- Protocol registered in dev mode:', result);
    } else {
      const result = app.setAsDefaultProtocolClient('nc');
      console.log('- Protocol registered in dev mode (fallback):', result);
    }
  } else {
    // Production mode
    const result = app.setAsDefaultProtocolClient('nc');
    console.log('- Protocol registered in production mode:', result);
  }
  
  // Force check
  const isRegistered = app.isDefaultProtocolClient('nc');
  console.log('✅ Protocol registration check:', isRegistered);
  
  if (!isRegistered) {
    console.warn('⚠️ Protocol registration failed, trying alternative method...');
    // Alternative registration
    app.setAsDefaultProtocolClient('nc', process.execPath);
    console.log('- Alternative registration result:', app.isDefaultProtocolClient('nc'));
  }
} catch (error) {
  console.error('❌ Protocol registration error:', error);
}

// --- Обработка deep link, пришедшего при первом запуске (Windows/Linux) ---
const initialDeepLink = findDeepLinkInArgv(process.argv);
if (initialDeepLink) {
  console.log('[main] initial deep link from argv:', initialDeepLink);
  deepLinkUrl = initialDeepLink;
}

/** Single instance */
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  console.log('Another instance is running, quitting...');
  app.quit();
} else {
  console.log('Single instance lock acquired');
}

/** Github releases (unbranded) */
if (process.env.NODE_ENV === 'production' && !BUILD_CONFIG.isBranded) {
  setupReleaseNotificationScheduler(24 * 60)
}

/* ========= EARLY IPC REGISTRATION ========= */
const _registeredIpc = new Set()
const safeHandle = (ch, fn) => { if (_registeredIpc.has(ch)) return; _registeredIpc.add(ch); ipcMain.handle(ch, fn) }
const safeOn = (ch, fn) => { if (_registeredIpc.has(ch)) return; _registeredIpc.add(ch); ipcMain.on(ch, fn) }

// System IPC
safeOn('app:quit', () => app.quit())
safeHandle('app:getSystemInfo', () => systemInfo)
safeHandle('app:buildTitle', (_e, title) => buildTitle(title))
safeHandle('app:getSystemL10n', () => ({
  locale: app.getLocale().replace('-', '_') ?? 'en',
  language: app.getPreferredSystemLanguages()[0]?.replace('-', '_') ?? 'en_US',
}))
safeHandle('app:enableWebRequestInterceptor', (_e, ...args) => enableWebRequestInterceptor(...args))
safeHandle('app:disableWebRequestInterceptor', (_e, ...args) => disableWebRequestInterceptor(...args))
safeHandle('app:setBadgeCount', (_e, count) => app.setBadgeCount(count))
safeOn('app:relaunch', () => { app.relaunch(); app.exit(0) })
safeHandle('app:config:get', (_e, key) => getAppConfig(key))
safeHandle('app:config:set', (_e, key, value) => setAppConfig(key, value))
safeOn('app:grantUserGesturedPermission', (event, id) =>
  event.sender.executeJavaScript(`document.getElementById('${id}')?.click()`, true)
)
safeOn('app:toggleDevTools', (event) => event.sender.toggleDevTools())
safeHandle('app:anything', () => {})
safeOn('app:openChromeWebRtcInternals', () => openChromeWebRtcInternals())
safeHandle('app:getDesktopCapturerSources', async () => {
  if (isMac && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
    return null
  }
  const thumbnailWidth = 800
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    fetchWindowIcons: true,
    thumbnailSize: { width: thumbnailWidth, height: thumbnailWidth * 9 / 16 },
  })
  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    icon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null,
    thumbnail: source.thumbnail && !source.thumbnail.isEmpty() ? source.thumbnail.toDataURL() : null,
  }))
})

// AppData IPC (must be early to prevent "No handler" errors)
safeHandle('appData:get', () => appData.toJSON())

// ========= AUTHENTICATION IPC HANDLERS =========
safeHandle('auth:getStrategy', async () => {
  return await domainAuth.determineAuthStrategy(app, BUILD_CONFIG)
})

safeHandle('auth:validateCredentials', async (_e, creds) => {
  return domainAuth.validateCredentials(creds)
})

safeHandle('auth:getOAuthConfig', async () => {
  const config = oauthConfig.getConfig(BUILD_CONFIG)
  return {
    config: config,
    isValid: oauthConfig.validateConfig(config)
  }
})

safeHandle('auth:testClientOAuth', async (_e, serverUrl) => {
  try {
    const oauthCfg = oauthConfig.getConfig(BUILD_CONFIG)
    const autoOAuthManager = new AutoOAuthManager(oauthCfg)
    
    // Проверяем что метод существует
    if (typeof autoOAuthManager.testClientOAuth === 'function') {
      const result = await autoOAuthManager.testClientOAuth(serverUrl)
      return result
    } else {
      console.error('AutoOAuthManager.testClientOAuth is not a function')
      return { success: false, error: 'Method not available' }
    }
  } catch (error) {
    console.error('Client OAuth test failed:', error)
    return { success: false, error: error.message }
  }
})

safeHandle('auth:testAuthorizationCodeFlow', async (_e, serverUrl) => {
  try {
    const oauthCfg = oauthConfig.getConfig(BUILD_CONFIG)
    const autoOAuthManager = new AutoOAuthManager(oauthCfg)
    
    if (typeof autoOAuthManager.performAuthorizationCodeFlow === 'function') {
      const result = await autoOAuthManager.performAuthorizationCodeFlow(serverUrl)
      return result
    } else {
      console.error('AutoOAuthManager.performAuthorizationCodeFlow is not a function')
      return { success: false, error: 'Method not available' }
    }
  } catch (error) {
    console.error('Authorization Code Flow test failed:', error)
    return { success: false, error: error.message }
  }
})

safeHandle('auth:autoLogin', async (_e, authStrategy) => {
  try {
    if (authStrategy.type === 'file' && authStrategy.creds) {
      const { serverUrl, credentials } = authStrategy.creds
      
      console.log('=== ATTEMPTING BASIC AUTH AUTO-LOGIN ===')
      
      // Use basic authentication
      console.log('Using basic authentication with file credentials')
      enableWebRequestInterceptor(serverUrl, { credentials })
      appData.fromJSON({ serverUrl, credentials })
      
      return { 
        success: true, 
        type: 'basic',
        serverUrl: serverUrl,
        credentials: credentials
      }
    }
    
    return { success: false, reason: 'no_auto_login_available' }
  } catch (error) {
    console.error('Auto-login failed:', error)
    return { success: false, reason: error.message }
  }
})

/* ------------------ IPC: ожидание deep link из renderer ------------------ */
safeHandle('oauth-wait-code', async (event, timeoutMs = 60000) => {
  console.log(`[main] Waiting for OAuth code, timeout: ${timeoutMs}ms`);
  
  if (deepLinkUrl) {
    const url = deepLinkUrl;
    deepLinkUrl = null; // consume the URL
    console.log('[main] Returning cached deep link:', url);
    return url;
  }

  // вернётся либо url, либо null по таймауту
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // удаляем резолвер если не использован
      const idx = deeplinkResolvers.indexOf(resolver);
      if (idx !== -1) deeplinkResolvers.splice(idx, 1);
      console.log('[main] OAuth code wait timeout');
      resolve(null);
    }, timeoutMs);

    const resolver = (url) => {
      clearTimeout(timer);
      console.log('[main] OAuth code received via resolver:', url);
      resolve(url);
    };

    deeplinkResolvers.push(resolver);
  });
});
/* ========= /EARLY IPC ========= */

/** Relaunch state for window-all-closed */
let isInWindowRelaunch = false

// ========= GLOBAL OAUTH STATE =========
let oauthState = {
  currentStrategy: null,
  pendingCallback: null,
  isProcessing: false,
  serverUrl: null,
  authState: null
}

/* ------------------ Платформенные обработчики ------------------ */

// macOS: event 'open-url' при открытии схемы
app.on('open-url', (event, url) => {
  event.preventDefault();
  console.log('[main] macOS open-url:', url);
  notifyDeepLink(url);
});

// Single instance lock — чтобы поймать ссылки при повторном запуске (Windows/Linux)
app.on('second-instance', (event, argv, workingDir) => {
  console.log('[main] Second instance launched with argv:', argv);
  
  // argv содержит ссылку при клике на протокол (Windows/Linux)
  const url = findDeepLinkInArgv(argv);
  if (url) {
    console.log('[main] second-instance deep link:', url);
    notifyDeepLink(url);
  }

  // активируем окно
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  await loadAppConfig()
  applyTheme()
  initLaunchAtStartupListener()
  registerAppProtocolHandler()

  const openInBackground = ARGUMENTS.openInBackground || app.getLoginItemSettings().wasOpenedAtLogin

  // Install Vue DevTools in development
  if (process.env.NODE_ENV === 'development') {
    try { 
      await installVueDevtools() 
    } catch (error) {
      console.log('Unable to install Vue Devtools') 
      console.error(error)
    }
    
    console.log('\nNextcloud Talk is running via development server')
    console.log('Hint: type "rs" to restart app without restarting the build\n')
  }

  // Enable integrated authentication
  setupAuthIntegration(app)

  // Check OAuth configuration
  const oauthCfg = oauthConfig.getConfig(BUILD_CONFIG)
  const isOAuthConfigured = oauthConfig.validateConfig(oauthCfg)
  console.log('OAuth configured:', isOAuthConfigured)

  // Final protocol check
  console.log('🔗 Final protocol client check:', app.isDefaultProtocolClient('nc'));

  // Initialize OAuth Manager
  const autoOAuthManager = new AutoOAuthManager(oauthCfg)

  // ========= OAUTH SUPPORT TESTING =========
  let oauthTestResult = null
  if (isOAuthConfigured && BUILD_CONFIG?.domain) {
    console.log('=== TESTING OAUTH SUPPORT ON STARTUP ===')
    try {
      // Проверяем что метод существует
      if (typeof autoOAuthManager.testClientOAuth === 'function') {
        oauthTestResult = await autoOAuthManager.testClientOAuth(BUILD_CONFIG.domain)
        
        if (oauthTestResult.success) {
          console.log('🎉 CLIENT OAUTH WORKS! Application can auto-authenticate')
        } else {
          console.log('ℹ️ OAUTH SUPPORT INFO:', oauthTestResult.error)
          console.log('Nextcloud OAuth2 requires Authorization Code Flow with browser interaction')
        }
      } else {
        console.log('⚠️ AutoOAuthManager.testClientOAuth is not a function')
        oauthTestResult = { success: false, error: 'Method not available' }
      }
    } catch (error) {
      console.error('OAuth test failed:', error)
      oauthTestResult = { success: false, error: error.message }
    }
  }

  // Window management
  let createMainWindow

  setupMenu()

  /** Focus helper */
  function focusMainWindow() {
    if (!createMainWindow) return
    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = createMainWindow()
      mainWindow.once('ready-to-show', () => mainWindow.show())
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
  }

  // ========= ПРАВИЛЬНЫЙ АЛГОРИТМ: ОТЛОЖЕННОЕ ПРИМЕНЕНИЕ СТРАТЕГИЙ =========
  
  // 1. Определяем стратегию авторизации (ТОЛЬКО ОПРЕДЕЛЯЕМ, НЕ ПРИМЕНЯЕМ)
  const authStrategy = await domainAuth.determineAuthStrategy(app, BUILD_CONFIG)
  console.log('Auth strategy detected:', authStrategy.type)

  // 2. Сохраняем стратегию для использования в login.window.js
  oauthState.currentStrategy = authStrategy
  oauthState.serverUrl = authStrategy.serverUrl || BUILD_CONFIG?.domain

  // ========= ENHANCED AUTHENTICATION HANDLER =========
  safeHandle('authentication:openLoginWebView', async (_event, serverUrl) => {
    try {
      console.log('=== USING REAL OAUTH AUTHORIZATION CODE FLOW ===')
      
      // Сохраняем serverUrl для обработки callback
      oauthState.serverUrl = serverUrl
      
      // Передаем стратегию в login window для автоматизации
      console.log('Loading OAuth authorization page with auth strategy:', oauthState.currentStrategy?.type)
      
      // Use the new deep link waiting mechanism
      return new Promise(async (resolve) => {
        // Open login window first
        const loginPromise = openLoginWebView(mainWindow, serverUrl, oauthState.currentStrategy);
        
        // Wait for either deep link or login window result
        const timeout = setTimeout(() => {
          console.log('⏰ OAuth flow timeout - using login window result');
          loginPromise.then(resolve).catch(resolve);
        }, 45000);
        
        // Wait for deep link
        try {
          const deepLinkUrl = await new Promise((deepLinkResolve) => {
            const deepLinkTimer = setTimeout(() => {
              deepLinkResolve(null);
            }, 40000);

            const resolver = (url) => {
              clearTimeout(deepLinkTimer);
              deepLinkResolve(url);
            };

            deeplinkResolvers.push(resolver);
          });
          
          if (deepLinkUrl) {
            console.log('🎉 OAuth code received via deep link');
            clearTimeout(timeout);
            
            try {
              const { parseLoginRedirectUrl, extractOAuthParams } = require('./authentication/login.service.js');
              const credentials = parseLoginRedirectUrl(deepLinkUrl);
              
              // Check if we have OAuth code for token exchange
              const oauthParams = extractOAuthParams(deepLinkUrl);
              if (oauthParams.code) {
                console.log('✅ OAuth authorization code received, will exchange for token');
              }
              
              resolve(credentials);
              return;
            } catch (error) {
              console.error('Deep link parsing failed:', error);
              resolve(new Error(`Deep link parsing failed: ${error.message}`));
              return;
            }
          }
        } catch (error) {
          console.error('Deep link wait failed:', error);
        }
        
        // If no deep link, use login window result
        console.log('🔄 No deep link received, using login window result');
        clearTimeout(timeout);
        loginPromise.then(resolve).catch(resolve);
      });
      
    } catch (error) {
      console.error('OAuth flow setup failed:', error);
      return await openLoginWebView(mainWindow, serverUrl, oauthState.currentStrategy);
    }
  });

  // 3. Всегда показываем Welcome окно (не применяем стратегии сразу)
  console.log('Showing welcome window - strategies will be applied later in login flow')
  mainWindow = createWelcomeWindow()
  createMainWindow = createWelcomeWindow
  
  // Если deep link пришёл ДО загрузки, дождёмся загрузки и отправим
  if (deepLinkUrl) {
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.webContents.send('deeplink-received', deepLinkUrl);
    });
  }
  
  // 4. Передаем информацию о доступных стратегиях в welcome окно
  mainWindow.webContents.once('did-finish-load', () => {
    const availableStrategies = {
      type: oauthState.currentStrategy.type,
      hasCredentials: oauthState.currentStrategy.type === 'file',
      hasDomain: oauthState.currentStrategy.type === 'saml',
      serverUrl: oauthState.currentStrategy.serverUrl,
      oauthConfigured: isOAuthConfigured
    }
    mainWindow.webContents.send('welcome:authStrategies', availableStrategies)
  })
  
  mainWindow.once('ready-to-show', () => mainWindow.show())

  // Certificate handling
  session.defaultSession.setCertificateVerifyProc(async (request, callback) => {
    const isAccepted = request.errorCode === 0 || await promptCertificateTrust(mainWindow, request)
    callback(isAccepted ? 0 : -3)
  })
  app.on('certificate-error', async (event, webContents, url, error, certificate, callback) => {
    event.preventDefault()
    const isAccepted = await promptCertificateTrust(mainWindow, {
      hostname: new URL(url).hostname, certificate, verificationResult: error,
    })
    callback(isAccepted)
  })

  // ========= ОБРАБОТЧИКИ ДЛЯ WELCOME ОКНА =========
  
  // Пользователь выбрал использовать сохраненные credentials
  ipcMain.handle('welcome:useSavedCredentials', async () => {
    console.log('User chose to use saved credentials - opening login with file strategy')
    
    // Переходим к аутентификации с применением file стратегии
    mainWindow.close()
    mainWindow = createAuthenticationWindow()
    createMainWindow = createAuthenticationWindow
    
    mainWindow.once('ready-to-show', () => mainWindow.show())
    
    return { success: true }
  })

  // Пользователь выбрал ручной ввод
  ipcMain.handle('welcome:useManualLogin', async () => {
    console.log('User chose manual login - opening login without auto-strategy')
    
    // Создаем manual стратегию для login window
    oauthState.currentStrategy = {
      type: 'manual',
      reason: 'user_selected_manual',
      serverUrl: BUILD_CONFIG?.domain
    }
    
    // Переходим к аутентификации
    mainWindow.close()
    mainWindow = createAuthenticationWindow()
    createMainWindow = createAuthenticationWindow
    
    mainWindow.once('ready-to-show', () => mainWindow.show())
    
    return { success: true }
  })

  // Renderer (welcome) sends appData
  ipcMain.once('appData:receive', async (_event, newAppData) => {
    console.log('Main: Received appData from renderer')
    appData.fromJSON(newAppData)

    const welcomeWindow = mainWindow
    
    // Check if we already have valid credentials
    if (appData.credentials && appData.serverUrl) {
      console.log('Main: Already authenticated, opening Talk window')
      enableWebRequestInterceptor(appData.serverUrl, { credentials: appData.credentials })
      mainWindow = createTalkWindow()
      createMainWindow = createTalkWindow
      
      mainWindow.webContents.on('did-finish-load', () => {
        console.log('Talk window (from welcome): finished loading')
      })
      
      if (process.env.NODE_ENV === 'development') {
        mainWindow.webContents.openDevTools()
      }
    } else {
      console.log('Main: Not authenticated, opening Auth window')
      await welcomeWindow.webContents.session.clearStorageData()
      mainWindow = createAuthenticationWindow()
      createMainWindow = createAuthenticationWindow
    }

    mainWindow.once('ready-to-show', () => {
      const isTalkWindow = createMainWindow === createTalkWindow
      if (!isTalkWindow || !openInBackground) mainWindow.show()
      welcomeWindow.close()
    })
  })

  // ========= TALK WINDOW INTEGRATIONS =========
  let macDockBounceId
  ipcMain.on('talk:flashAppIcon', async (_event, shouldFlash) => {
    if (isMac) {
      if (macDockBounceId) { 
        app.dock.cancelBounce(macDockBounceId) 
        macDockBounceId = undefined 
      }
      if (shouldFlash) macDockBounceId = app.dock.bounce()
    } else {
      mainWindow.flashFrame(shouldFlash)
    }
  })
  
  ipcMain.handle('talk:focus', async () => focusMainWindow())

  // Authentication login handler - saves credentials and switches to Talk
  ipcMain.handle('authentication:login', async (_event, newAppData) => {
    console.log('Main: Processing authentication login')
    
    // Handle OAuth credentials
    if (newAppData.tokenData) {
      console.log('OAuth token authentication received')
      // Store OAuth token data
      appData.fromJSON({
        serverUrl: newAppData.server,
        credentials: {
          type: 'oauth',
          username: newAppData.user,
          password: newAppData.password,
          tokenData: newAppData.tokenData
        }
      })
    } else {
      // Standard user login
      try { 
        await domainAuth.handleAuthenticationLogin(newAppData, app, appData) 
      } catch (error) {
        console.error('Main: Failed to save authentication data:', error)
      }
      
      // Sync runtime appData
      appData.fromJSON(newAppData)
    }

    // Switch to Talk window
    mainWindow.close()
    mainWindow = createTalkWindow()
    createMainWindow = createTalkWindow
    
    mainWindow.webContents.on('did-finish-load', () => {
      console.log('Talk window (from auth): finished loading')
    })
    
    if (process.env.NODE_ENV === 'development') {
      mainWindow.webContents.openDevTools()
    }
    
    mainWindow.once('ready-to-show', () => mainWindow.show())
  })

  // Authentication logout handler - clears credentials and returns to Auth
  ipcMain.handle('authentication:logout', async () => {
    if (createMainWindow === createTalkWindow) {
      console.log('Main: Processing authentication logout')
      
      // Clear saved credentials
      try { 
        domainAuth.handleAuthenticationLogout(app) 
      } catch (error) {
        console.error('Main: Failed to clear authentication data:', error)
      }
      
      // Reset app state
      appData.reset()
      await mainWindow.webContents.session.clearStorageData()
      app.setBadgeCount(0)

      // Reset OAuth state
      oauthState.pendingCallback = null
      oauthState.isProcessing = false

      // Return to authentication window
      const authenticationWindow = createAuthenticationWindow()
      createMainWindow = createAuthenticationWindow
      authenticationWindow.once('ready-to-show', () => authenticationWindow.show())

      mainWindow.destroy()
      mainWindow = authenticationWindow
    }
  })

  // ========= OTHER WINDOWS =========
  ipcMain.on('callbox:show', (_event, callboxParams) => createCallboxWindow(callboxParams))
  ipcMain.handle('help:show', () => { createHelpWindow(mainWindow) })
  ipcMain.handle('upgrade:show', () => {
    const upgradeWindow = createUpgradeWindow()
    createMainWindow = createUpgradeWindow
    mainWindow.destroy()
    mainWindow = upgradeWindow
  })

  // Window relaunch (e.g., theme changes)
  ipcMain.on('app:relaunchWindow', () => {
    isInWindowRelaunch = true
    mainWindow.destroy()
    mainWindow = createMainWindow()
    mainWindow.once('ready-to-show', () => mainWindow.show())
    isInWindowRelaunch = false
  })

  // Additional IPC handlers
  ipcMain.on('app:downloadURL', (_event, url, filename) => triggerDownloadUrl(mainWindow, url, filename))
  ipcMain.handle('certificate:verify', (_event, url) => verifyCertificate(mainWindow, url))

   // macOS dock icon handling
  app.on('activate', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
    } else {
      mainWindow = createMainWindow()
      mainWindow.once('ready-to-show', () => mainWindow.show())
    }
  })
})

app.on('window-all-closed', () => {
  if (isInWindowRelaunch) return
  if (isMac) return
  app.quit()
})

/* ------------------ Дополнительная диагностика ------------------ */
process.on('uncaughtException', (err) => {
  console.error('[main] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[main] Unhandled promise rejection:', reason);
});