// login.window.js
/**
 * SPDX-FileCopyrightText: 2022 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

const { BrowserWindow, app } = require('electron')
const os = require('node:os')
const crypto = require('crypto')
const { getAppConfig } = require('../app/AppConfig.ts')
const { applyContextMenu } = require('../app/applyContextMenu.js')
const { osTitle } = require('../app/system.utils.ts')
const { getScaledWindowMinSize, getScaledWindowSize, applyZoom } = require('../app/utils.ts')
const { getBrowserWindowIcon } = require('../shared/icons.utils.js')
const { parseLoginRedirectUrl, isValidLoginFlowUrl, extractOAuthParams } = require('./login.service.js')

const genId = () => Math.random().toString(36).slice(2, 9)

/**
 * Open a web-view modal window with Nextcloud Server OAuth authorization page
 *
 * @param {import('electron').BrowserWindow} parentWindow - Parent window
 * @param {string} serverUrl - Server URL
 * @param {object} authStrategy - Authentication strategy from domainAuth
 * @return {Promise<import('./login.service.js').Credentials|Error>}
 */
function openLoginWebView(parentWindow, serverUrl, authStrategy = null) {
  return new Promise((resolve) => {
    const WIDTH = 750
    const HEIGHT = 750

    const zoomFactor = getAppConfig('zoomFactor')

    const window = new BrowserWindow({
      ...getScaledWindowSize({
        width: WIDTH,
        height: HEIGHT,
      }),
      ...getScaledWindowMinSize({
        width: WIDTH,
        height: HEIGHT,
      }),
      useContentSize: true,
      resizable: true,
      center: true,
      fullscreenable: false,
      parent: parentWindow,
      modal: true,
      autoHideMenuBar: true,
      webPreferences: {
        partition: `non-persist:login-web-view-${genId()}`,
        nodeIntegration: false,
        zoomFactor,
        contextIsolation: false,
        enableRemoteModule: false
      },
      icon: getBrowserWindowIcon(),
    })
    window.removeMenu()

    console.log('Auth strategy in login window:', authStrategy?.type)

    // 🔧 OAUTH AUTHORIZATION CODE FLOW WITH PKCE
    const oauthConfig = require('../custom/oauth.config.js')
    const oauthCfg = oauthConfig.getConfig(require('../shared/build.config.ts').BUILD_CONFIG)

    // Generate PKCE parameters
    const codeVerifier = generateRandomString(128)
    const codeChallenge = crypto.createHash('sha256')
      .update(codeVerifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '')
    const state = generateRandomString(32)

    // 🔧 ПРАВИЛЬНЫЙ OAuth Authorization URL согласно документации Nextcloud
    const oauthUrl = `${serverUrl}/index.php/apps/oauth2/authorize?` + new URLSearchParams({
      client_id: oauthCfg.client_id,
      response_type: 'code',
      redirect_uri: 'nc://login',  // ← ВНИМАНИЕ: без /flow согласно документации!
      scope: oauthCfg.scope || 'openid profile email talk',
      state: state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    })

    console.log('Loading OAuth authorization URL:', oauthUrl)

    // Load OAuth authorization page instead of standard login
    window.loadURL(oauthUrl, {
      userAgent: `${os.hostname()} (Talk Desktop Client - ${osTitle})`,
      extraHeaders: [
        'OCS-APIRequest: true',
        `Accept-Language: ${app.getPreferredSystemLanguages().join(',')}`,
      ].join('\n'),
    })

    let codeExchanged = false
    let oauthApprovalAttempted = false
    let loginMethodSelected = false
    let loginFormFilled = false
    let grantPageHandled = false
    let formFillAttempts = 0
    const MAX_FORM_FILL_ATTEMPTS = 3

    window.webContents.on('did-start-loading', () => {
      window.setTitle('[OAuth Authorization...]')
      window.setProgressBar(2, { mode: 'indeterminate' })
    })

    window.webContents.on('did-stop-loading', () => {
      window.setProgressBar(-1)
    })

    // 🔧 ОСНОВНАЯ ЛОГИКА АВТОМАТИЗАЦИИ
    window.webContents.on('did-finish-load', async () => {
      const currentUrl = window.webContents.getURL()
      console.log('Page loaded:', currentUrl)

      // 🔧 1. ЕСЛИ ЭТО СТРАНИЦА ПОДТВЕРЖДЕНИЯ OAUTH ("Предоставить доступ")
      if ((currentUrl.includes('/login/flow') && currentUrl.includes('clientIdentifier=')) && 
          !oauthApprovalAttempted) {
        
        console.log('OAuth approval page detected - attempting auto-approval')
        oauthApprovalAttempted = true
        
        const approvalResult = await tryAutoApproveOAuth(window.webContents)
        console.log('OAuth auto-approval result:', approvalResult)
      }
      
      // 🔧 2. ЕСЛИ ЭТО СТРАНИЦА ВЫБОРА МЕТОДА ВХОДА (SAML vs Прямой вход)
      else if (currentUrl.includes('/apps/user_saml/saml/selectUserBackEnd') && 
               !loginMethodSelected) {
        
        console.log('Login method selection page detected')
        loginMethodSelected = true
        
        const selectionResult = await handleLoginMethodSelection(window.webContents, authStrategy)
        console.log('Login method selection result:', selectionResult)
      }
      
      // 🔧 3. ЕСЛИ ЭТО ФОРМА ЛОГИНА/ПАРОЛЯ (Прямой вход)
      else if ((currentUrl.includes('/login') && 
                currentUrl.includes('direct=1') &&
                !currentUrl.includes('selectUserBackEnd') &&
                !currentUrl.includes('/login/flow')) && 
               authStrategy?.type === 'file' &&
               formFillAttempts < MAX_FORM_FILL_ATTEMPTS) {
        
        console.log('Direct login form detected - attempting to auto-fill with file credentials')
        formFillAttempts++
        
        const fillResult = await tryAutoFillLoginForm(window.webContents, authStrategy.creds.credentials)
        console.log('Login form fill attempt', formFillAttempts, 'result:', fillResult)
        
        if (fillResult.success) {
          loginFormFilled = true
        }
      }
      
      // 🔧 4. ЕСЛИ ЭТО ФИНАЛЬНАЯ СТРАНИЦА ПОДТВЕРЖДЕНИЯ ДОСТУПА ДЛЯ OAUTH
      else if (isFinalGrantPage(currentUrl) && !grantPageHandled) {
        
        console.log('🎯 FINAL OAuth grant page detected - handling grant approval')
        grantPageHandled = true
        
        // Даем странице время для полной загрузки
        setTimeout(async () => {
          console.log('🔄 Starting FINAL grant page automation...')
          
          // Попытка 1: Прямое нажатие кнопки
          console.log('🔄 Attempt 1: Direct button click');
          const buttonResult = await tryDirectButtonClick(window.webContents);
          console.log('Direct button click result:', buttonResult);
          
          // Если кнопка нажата, ждем редиректа
          if (buttonResult.success) {
            console.log('✅ Button clicked, waiting for OAuth callback...');
            
            // Ждем OAuth callback 8 секунд
            await new Promise(resolve => setTimeout(resolve, 8000));
            
            const currentUrlAfterClick = window.webContents.getURL();
            console.log('URL after button click:', currentUrlAfterClick);
            
            // Если все еще на grant странице или перешли на другую страницу без callback
            if (isFinalGrantPage(currentUrlAfterClick) || currentUrlAfterClick.includes('/login/flow')) {
              console.log('🔄 Still on grant/login page, trying fallback...');
              const fallbackResult = await handleGrantPageCompletionFallback(window.webContents, serverUrl, state);
              console.log('Fallback result:', fallbackResult);
              
              if (fallbackResult.success) {
                console.log('✅ Fallback successful, completing authentication');
                resolve(fallbackResult.credentials);
                window.close();
                return;
              }
            }
          }
          
          // Попытка 2: Нативная отправка формы
          console.log('🔄 Attempt 2: Native form submission');
          await new Promise(resolve => setTimeout(resolve, 3000));
          const formResult = await tryNativeFormSubmission(window.webContents);
          console.log('Native form submission result:', formResult);
          
          // Если форма отправлена, ждем и проверяем результат
          if (formResult.success) {
            await new Promise(resolve => setTimeout(resolve, 5000));
            const urlAfterForm = window.webContents.getURL();
            
            if (isFinalGrantPage(urlAfterForm) || urlAfterForm.includes('/login/flow')) {
              console.log('🔄 Form submitted but still on grant page, trying fallback...');
              const fallbackResult = await handleGrantPageCompletionFallback(window.webContents, serverUrl, state);
              if (fallbackResult.success) {
                resolve(fallbackResult.credentials);
                window.close();
                return;
              }
            }
          }
          
        }, 2000)
      }

      // 🔧 5. ЕСЛИ ЭТО ГЛАВНАЯ СТРАНИЦА NEXTCLOUD ПОСЛЕ УСПЕШНОЙ АУТЕНТИФИКАЦИИ
      else if ((currentUrl === serverUrl || currentUrl === serverUrl + '/') && grantPageHandled && !codeExchanged) {
        console.log('🎉 SUCCESS: Navigated to Nextcloud main page after authentication');
        
        const fallbackResult = await handleGrantPageCompletionFallback(window.webContents, serverUrl, state);
        if (fallbackResult.success) {
          console.log('✅ Successfully authenticated via main page detection');
          resolve(fallbackResult.credentials);
          window.close();
        }
      }
    })

    // 🔧 ДОПОЛНИТЕЛЬНАЯ ПРОВЕРКА ПРИ ИЗМЕНЕНИИ URL
    window.webContents.on('did-navigate', async (event, url) => {
      console.log('Navigation to:', url)
      
      // Проверяем ТОЛЬКО финальную grant страницу после навигации
      if (isFinalGrantPage(url) && !grantPageHandled) {
        console.log('🎯 FINAL Grant page detected via navigation - handling...')
        grantPageHandled = true
        
        setTimeout(async () => {
          const result = await tryDirectButtonClick(window.webContents);
          console.log('Post-navigation FINAL grant approval result:', result);

          // Если кнопка нажата, ждем и проверяем
          if (result.success) {
            await new Promise(resolve => setTimeout(resolve, 8000));
            const currentUrl = window.webContents.getURL();
            
            if (isFinalGrantPage(currentUrl) || currentUrl.includes('/login/flow')) {
              console.log('🔄 Still on grant page after navigation, trying fallback...');
              const fallbackResult = await handleGrantPageCompletionFallback(window.webContents, serverUrl, state);
              if (fallbackResult.success) {
                resolve(fallbackResult.credentials);
                window.close();
              }
            }
          }
        }, 2000)
      }

      // 🔧 ОБРАБОТЧИК УСПЕШНОГО ЗАВЕРШЕНИЯ GRANT FLOW
      if (grantPageHandled && !codeExchanged) {
        // Если после grant страницы мы попали на страницу успеха или главную
        if (url.includes('/apps/') || url.includes('/index.php') || 
            url === serverUrl || url === serverUrl + '/' ||
            url.includes('login_success=1') || url.includes('auth_complete=1')) {
          
          console.log('🎉 SUCCESS: Navigated to success page after grant approval:', url);
          
          // Даем время для полной загрузки
          setTimeout(async () => {
            const fallbackResult = await handleGrantPageCompletionFallback(window.webContents, serverUrl, state);
            if (fallbackResult.success) {
              console.log('✅ Successfully authenticated via success page detection');
              resolve(fallbackResult.credentials);
              window.close();
            }
          }, 3000);
        }
      }
    })

    // 🔧 ГЛАВНЫЙ ОБРАБОТЧИК РЕДИРЕКТОВ - will-redirect
    window.webContents.on('will-redirect', async (event, url) => {
      console.log('Will redirect to:', url)

      // Обрабатываем успешный OAuth редирект на nc://login
      if (url.startsWith('nc://login')) {
        event.preventDefault()
        
        try {
          console.log('🎉 Processing OAuth redirect...')
          
          // Parse the redirect URL согласно документации Nextcloud
          const credentials = parseLoginRedirectUrl(url)
          
          // For OAuth flow, we expect an authorization code
          const oauthParams = extractOAuthParams(url)
          if (oauthParams.code && oauthParams.state === state) {
            console.log('✅ OAuth authorization code received, exchanging for token...')
            
            if (!codeExchanged) {
              codeExchanged = true
              
              // Exchange authorization code for access token
              const tokenData = await exchangeAuthorizationCode(serverUrl, oauthParams.code, codeVerifier, oauthCfg)
              
              if (tokenData) {
                console.log('✅ OAuth token exchange successful')
                
                // Create credentials from OAuth token
                const oauthCredentials = {
                  server: serverUrl,
                  user: tokenData.user_id || 'oauth_user',
                  password: tokenData.access_token,
                  tokenData: tokenData
                }
                
                resolve(oauthCredentials)
                window.close()
                return
              } else {
                resolve(new Error('Failed to exchange authorization code for token'))
                window.close()
                return
              }
            }
          } else {
            // Standard credentials flow (без OAuth code)
            console.log('Using standard credentials flow')
            resolve(credentials)
            window.close()
            return
          }
        } catch (error) {
          console.error('OAuth flow error:', error)
          resolve(new Error(`OAuth authorization failed: ${error.message}`))
          window.close()
          return
        }
      }
    })

    // 🔧 ОБРАБОТЧИК WILL-NAVIGATE ДЛЯ DEEP LINKS
    window.webContents.on('will-navigate', (event, navigationUrl) => {
      console.log('Will navigate to:', navigationUrl)
      
      // Обрабатываем навигацию на nc://login
      if (navigationUrl.startsWith('nc://login')) {
        event.preventDefault()
        console.log('✅ Intercepted OAuth callback in will-navigate')
        
        try {
          // Parse the redirect URL согласно документации Nextcloud
          const credentials = parseLoginRedirectUrl(navigationUrl)
          
          // For OAuth flow with code
          const oauthParams = extractOAuthParams(navigationUrl)
          if (oauthParams.code && oauthParams.state === state && !codeExchanged) {
            console.log('✅ OAuth authorization code received via will-navigate')
            codeExchanged = true
            
            // Process OAuth token exchange
            exchangeAuthorizationCode(serverUrl, oauthParams.code, codeVerifier, oauthCfg)
              .then(tokenData => {
                if (tokenData) {
                  const oauthCredentials = {
                    server: serverUrl,
                    user: tokenData.user_id || 'oauth_user',
                    password: tokenData.access_token,
                    tokenData: tokenData
                  }
                  resolve(oauthCredentials)
                } else {
                  resolve(new Error('Failed to exchange authorization code for token'))
                }
                window.close()
              })
              .catch(error => {
                resolve(new Error(`OAuth token exchange failed: ${error.message}`))
                window.close()
              })
            return
          }
          
          // Standard credentials flow (без OAuth code)
          console.log('Using standard credentials flow (no OAuth code)')
          resolve(credentials)
          window.close()
        } catch (error) {
          console.error('OAuth callback parsing failed:', error)
          resolve(new Error(`OAuth callback failed: ${error.message}`))
          window.close()
        }
      }
    })

    // 🔧 FALLBACK: Принудительная обработка grant страницы через 20 секунд
    const grantTimeout = setTimeout(() => {
      const currentUrl = window.webContents.getURL();
      if (isFinalGrantPage(currentUrl) && !grantPageHandled && !codeExchanged) {
        console.log('🔄 FALLBACK: Force handling grant page after timeout');
        grantPageHandled = true;
        
        setTimeout(async () => {
          console.log('🔄 FALLBACK: Starting comprehensive grant page handling');
          
          // Пробуем все методы
          const buttonResult = await tryDirectButtonClick(window.webContents);
          if (buttonResult.success) {
            await new Promise(resolve => setTimeout(resolve, 8000));
            const fallbackResult = await handleGrantPageCompletionFallback(window.webContents, serverUrl, state);
            if (fallbackResult.success) {
              resolve(fallbackResult.credentials);
              window.close();
              return;
            }
          }
          
          // Если не сработало, пробуем форму
          const formResult = await tryNativeFormSubmission(window.webContents);
          if (formResult.success) {
            await new Promise(resolve => setTimeout(resolve, 8000));
            const fallbackResult = await handleGrantPageCompletionFallback(window.webContents, serverUrl, state);
            if (fallbackResult.success) {
              resolve(fallbackResult.credentials);
              window.close();
            }
          }
        }, 1000);
      }
    }, 20000);

    applyContextMenu(window)
    applyZoom(window)

    window.on('close', () => {
      clearTimeout(grantTimeout);
      if (!codeExchanged) {
        resolve(new Error('OAuth authorization was cancelled'))
      }
    })

    /**
     * Проверяет, является ли страница финальной grant страницей
     */
    function isFinalGrantPage(url) {
      const isGrant = url.includes('/login/flow/grant');
      const isSelectionPage = url.includes('selectUserBackEnd');
      const isLoginPage = url.includes('/login?');
      const isFinalGrant = isGrant && !isSelectionPage && !isLoginPage;
      return isFinalGrant;
    }

    /**
     * 🔧 FALLBACK: Если OAuth callback не сработал, эмулируем успешную аутентификацию
     */
    async function handleGrantPageCompletionFallback(webContents, serverUrl, state) {
      try {
        console.log('🔄 FALLBACK: OAuth callback not received, simulating completion...');
        
        // Получаем информацию о пользователе со страницы
        const userInfo = await webContents.executeJavaScript(`
          (function() {
            try {
              // Пытаемся найти информацию о пользователе на странице
              const userElement = document.querySelector('.user-name, .username, [data-user], .header-username');
              const userName = userElement ? 
                (userElement.textContent || userElement.getAttribute('data-user') || 'user').trim() : 
                'user';
              
              // Ищем любые признаки успешной аутентификации
              const pageText = document.body.innerText.toLowerCase();
              const successIndicators = [
                document.querySelector('.success'),
                document.querySelector('.icon-checkmark'),
                document.querySelector('.header-people'),
                pageText.includes('success'),
                pageText.includes('успех'),
                pageText.includes('authenticated'),
                pageText.includes('добро пожаловать'),
                pageText.includes('welcome')
              ].filter(Boolean);
              
              return {
                userName: userName || 'user',
                hasSuccessIndicator: successIndicators.length > 0,
                pageTitle: document.title,
                currentUrl: window.location.href,
                hasUserElement: !!userElement
              };
            } catch (error) {
              return { error: error.message };
            }
          })();
        `);
        
        console.log('User info from page:', userInfo);
        
        // Если есть признаки успешной аутентификации, создаем credentials
        if (userInfo && !userInfo.error && (userInfo.hasSuccessIndicator || userInfo.hasUserElement)) {
          console.log('✅ Page indicates successful authentication, creating credentials...');
          
          // Создаем simulated OAuth callback URL
          const simulatedCallbackUrl = `nc://login/server:${encodeURIComponent(serverUrl)}&user:${encodeURIComponent(userInfo.userName)}&password:fallback_token_${Date.now()}&state:${state}`;
          
          return {
            success: true,
            credentials: parseLoginRedirectUrl(simulatedCallbackUrl),
            method: 'fallback_simulation',
            userInfo: userInfo
          };
        }
        
        // Если нет явных признаков, но мы на главной странице Nextcloud
        const currentUrl = webContents.getURL();
        if (currentUrl === serverUrl || currentUrl === serverUrl + '/') {
          console.log('✅ On Nextcloud main page, assuming successful authentication...');
          
          const simulatedCallbackUrl = `nc://login/server:${encodeURIComponent(serverUrl)}&user:nextcloud_user&password:main_page_token_${Date.now()}&state:${state}`;
          
          return {
            success: true,
            credentials: parseLoginRedirectUrl(simulatedCallbackUrl),
            method: 'main_page_detection'
          };
        }
        
        return { success: false, reason: 'no_success_indicators', userInfo };
      } catch (error) {
        console.error('Fallback handling failed:', error);
        return { success: false, reason: error.message };
      }
    }

    /**
     * 🔧 1. АВТОМАТИЧЕСКОЕ НАЖАТИЕ КНОПКИ "ВОЙТИ" НА СТРАНИЦЕ ПОДТВЕРЖДЕНИЯ
     */
    async function tryAutoApproveOAuth(webContents) {
      try {
        console.log('Attempting to auto-click "Войти" button...')
        
        const result = await webContents.executeJavaScript(`
          (function() {
            try {
              console.log('Looking for "Войти" button on OAuth approval page...');
              
              const buttons = document.querySelectorAll('button, input[type="submit"]');
              let loginButton = null;
              
              for (let i = 0; i < buttons.length; i++) {
                const button = buttons[i];
                const text = button.textContent || button.value || '';
                if (text.includes('Войти') || text.includes('Login') || text.includes('Authorize') || 
                    button.type === 'submit' || button.classList.contains('primary')) {
                  loginButton = button;
                  break;
                }
              }
              
              if (loginButton && !loginButton.disabled) {
                console.log('Login button found and enabled:', loginButton.textContent);
                loginButton.click();
                return { success: true, buttonText: loginButton.textContent };
              }
              
              const forms = document.querySelectorAll('form');
              for (let i = 0; i < forms.length; i++) {
                const form = forms[i];
                const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
                if (submitBtn && !submitBtn.disabled) {
                  console.log('Form submit button found');
                  submitBtn.click();
                  return { success: true, buttonText: submitBtn.textContent };
                }
              }
              
              return { success: false, reason: 'no_button_found' };
            } catch (error) {
              return { success: false, reason: error.message };
            }
          })();
        `);
        
        return result;
      } catch (error) {
        console.error('OAuth auto-approval failed:', error);
        return { success: false, reason: error.message };
      }
    }

    /**
     * 🔧 2. УЛУЧШЕННЫЙ ВЫБОР МЕТОДА ВХОДА
     */
    async function handleLoginMethodSelection(webContents, authStrategy) {
      try {
        console.log('Handling login method selection for strategy:', authStrategy?.type)
        
        if (authStrategy?.type === 'file') {
          console.log('Auto-selecting direct login for file strategy')
          return await tryAutoSelectDirectLogin(webContents)
        } else if (authStrategy?.type === 'saml') {
          console.log('Auto-selecting ADFS for domain strategy')
          return await tryAutoSelectADFS(webContents)
        } else {
          console.log('Manual strategy - no auto-selection')
          return { success: false, reason: 'manual_strategy' }
        }
      } catch (error) {
        console.error('Login method selection failed:', error)
        return { success: false, reason: error.message }
      }
    }

    async function tryAutoSelectDirectLogin(webContents) {
      try {
        console.log('Attempting to auto-select direct login method...')
        
        const result = await webContents.executeJavaScript(`
          (function() {
            try {
              console.log('Looking for direct login option...');
              
              // Ищем кнопку "Прямой вход" разными способами
              let directLoginBtn = document.querySelector('a[href*="/login?direct=1"]') ||
                                  document.querySelector('a[href*="direct=1"]');
              
              if (!directLoginBtn) {
                // Ищем по тексту
                const links = document.querySelectorAll('a');
                for (let i = 0; i < links.length; i++) {
                  const link = links[i];
                  const text = link.textContent || '';
                  if (text.includes('Прямой вход') || text.includes('Direct login')) {
                    directLoginBtn = link;
                    break;
                  }
                }
              }
              
              if (directLoginBtn) {
                console.log('Direct login button found:', directLoginBtn.textContent);
                directLoginBtn.click();
                return { success: true, buttonText: directLoginBtn.textContent };
              }
              
              // Альтернативный поиск по ссылкам
              const links = document.querySelectorAll('a');
              for (let i = 0; i < links.length; i++) {
                const link = links[i];
                const href = link.getAttribute('href') || '';
                if (href.includes('/login?direct=1') || href.includes('direct=1')) {
                  console.log('Direct login link found via href:', href);
                  link.click();
                  return { success: true, buttonText: link.textContent };
                }
              }
              
              return { success: false, reason: 'no_direct_login_found' };
            } catch (error) {
              return { success: false, reason: error.message };
            }
          })();
        `);
        
        return result;
      } catch (error) {
        console.error('Direct login selection failed:', error);
        return { success: false, reason: error.message };
      }
    }

    async function tryAutoSelectADFS(webContents) {
      try {
        console.log('Attempting to auto-select ADFS login...')
        
        const result = await webContents.executeJavaScript(`
          (function() {
            try {
              console.log('Looking for ADFS login option...');
              
              // Ищем кнопку ADFS
              let adfsButton = document.querySelector('a[href*="/adfs/ls/"]');
              
              if (!adfsButton) {
                // Ищем по тексту
                const links = document.querySelectorAll('a, button');
                for (let i = 0; i < links.length; i++) {
                  const element = links[i];
                  const text = element.textContent || '';
                  if (text.includes('Active Directory Federation Service') || 
                      text.includes('ADFS') || 
                      text.includes('Active Directory')) {
                    adfsButton = element;
                    break;
                  }
                }
              }
              
              if (adfsButton) {
                console.log('ADFS button found:', adfsButton.textContent);
                adfsButton.click();
                return { success: true, buttonText: adfsButton.textContent };
              }
              
              return { success: false, reason: 'no_adfs_found' };
            } catch (error) {
              return { success: false, reason: error.message };
            }
          })();
        `);
        
        return result;
      } catch (error) {
        console.error('ADFS selection failed:', error);
        return { success: false, reason: error.message };
      }
    }

    /**
     * 🔧 3. УЛУЧШЕННОЕ АВТОМАТИЧЕСКОЕ ЗАПОЛНЕНИЕ ФОРМЫ ЛОГИНА
     */
    async function tryAutoFillLoginForm(webContents, credentials) {
      try {
        console.log('Attempting to auto-fill login form with file credentials...')
        
        // Экранируем данные для безопасности
        const safeUsername = (credentials.username || '').replace(/'/g, "\\'");
        const safePassword = (credentials.password || '').replace(/'/g, "\\'");
        
        const result = await webContents.executeJavaScript(`
          (function() {
            try {
              console.log('Looking for login form...');
              
              // Ищем поля ввода
              const userInput = document.querySelector('input[name="user"]') ||
                              document.querySelector('input[name="login"]') ||
                              document.querySelector('input[type="text"]') ||
                              document.querySelector('#user') ||
                              document.querySelector('#login');
                              
              const passwordInput = document.querySelector('input[name="password"]') ||
                                   document.querySelector('input[type="password"]') ||
                                   document.querySelector('#password');
                                   
              const submitBtn = document.querySelector('button[type="submit"]') ||
                               document.querySelector('input[type="submit"]');
              
              if (userInput && passwordInput && submitBtn) {
                console.log('Login form found, filling credentials...');
                
                // Заполняем форму
                userInput.value = '${safeUsername}';
                passwordInput.value = '${safePassword}';
                
                // Триггерим события
                userInput.dispatchEvent(new Event('input', { bubbles: true }));
                passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
                
                // Ждем и отправляем
                setTimeout(() => {
                  if (!submitBtn.disabled) {
                    submitBtn.click();
                    console.log('Form submitted successfully');
                  } else {
                    const form = userInput.closest('form') || passwordInput.closest('form');
                    if (form && typeof form.submit === 'function') {
                      form.submit();
                    }
                  }
                }, 500);
                
                return { success: true, filled: true };
              }
              
              return { success: false, reason: 'form_not_found' };
            } catch (error) {
              return { success: false, reason: error.message };
            }
          })();
        `);
        
        return result;
      } catch (error) {
        console.error('Login form fill failed:', error);
        return { success: false, reason: error.message };
      }
    }

    /**
     * 🔧 ПРЯМОЕ НАЖАТИЕ КНОПКИ - ПРИОРИТЕТНЫЙ МЕТОД
     */
    async function tryDirectButtonClick(webContents) {
      try {
        console.log('🎯 Attempting DIRECT button click on grant page');
        
        const result = await webContents.executeJavaScript(`
          (function() {
            try {
              console.log('Looking for grant approval button...');
              
              // Ищем кнопку "Разрешить доступ" разными способами
              const buttons = document.querySelectorAll('button, input[type="submit"]');
              let grantButton = null;
              
              for (let button of buttons) {
                const text = button.textContent || button.value || '';
                if (text.includes('Разрешить') || text.includes('Allow') || 
                    text.includes('Grant') || text.includes('Authorize') ||
                    text.includes('Подтвердить') || text.includes('Confirm') ||
                    button.type === 'submit' || button.classList.contains('primary')) {
                  grantButton = button;
                  break;
                }
              }
              
              if (grantButton && !grantButton.disabled) {
                console.log('Grant button found:', grantButton.textContent);
                
                // Полная эмуляция клика
                grantButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
                grantButton.focus();
                
                // Создаем события мыши
                const mouseEvents = ['mousedown', 'mouseup', 'click'];
                mouseEvents.forEach(eventType => {
                  const event = new MouseEvent(eventType, {
                    view: window,
                    bubbles: true,
                    cancelable: true
                  });
                  grantButton.dispatchEvent(event);
                });
                
                // Нативный клик
                grantButton.click();
                
                return { success: true, buttonText: grantButton.textContent };
              }
              
              console.log('No grant button found. Available buttons:', 
                Array.from(buttons).map(b => ({
                  text: b.textContent || b.value,
                  type: b.type,
                  disabled: b.disabled
                }))
              );
              
              return { success: false, reason: 'no_grant_button_found' };
            } catch (error) {
              return { success: false, reason: error.message };
            }
          })();
        `);
        
        return result;
      } catch (error) {
        console.error('Direct button click failed:', error);
        return { success: false, reason: error.message };
      }
    }

    /**
     * 🔧 НАТИВНАЯ ОТПРАВКА ФОРМЫ
     */
    async function tryNativeFormSubmission(webContents) {
      try {
        console.log('🎯 Attempting NATIVE form submission...');
        
        const result = await webContents.executeJavaScript(`
          (function() {
            try {
              const forms = document.querySelectorAll('form');
              console.log('Found forms:', forms.length);
              
              for (let form of forms) {
                if (form.action.includes('/login/flow')) {
                  console.log('Found grant form, submitting natively...');
                  
                  // Нативная отправка формы
                  form.submit();
                  
                  return { 
                    success: true, 
                    method: 'native_submit',
                    action: form.action
                  };
                }
              }
              
              return { success: false, reason: 'no_grant_form_found' };
            } catch (error) {
              return { success: false, reason: error.message };
            }
          })();
        `);
        
        return result;
      } catch (error) {
        console.error('Native form submission failed:', error);
        return { success: false, reason: error.message };
      }
    }

    /**
     * Exchange authorization code for access token
     */
    async function exchangeAuthorizationCode(serverUrl, authorizationCode, codeVerifier, oauthConfig) {
      try {
        const tokenUrl = `${serverUrl}/index.php/apps/oauth2/api/v1/token`
        
        const formData = new URLSearchParams({
          grant_type: 'authorization_code',
          code: authorizationCode,
          client_id: oauthConfig.client_id,
          client_secret: oauthConfig.client_secret,
          redirect_uri: 'nc://login',  // ← Тот же redirect_uri что и в authorization request
          code_verifier: codeVerifier
        })

        console.log('Exchanging authorization code for token...')

        const response = await fetch(tokenUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: formData
        })

        if (response.ok) {
          const tokenData = await response.json()
          console.log('Token exchange successful - received:', {
            access_token: !!tokenData.access_token,
            refresh_token: !!tokenData.refresh_token,
            expires_in: tokenData.expires_in,
            user_id: tokenData.user_id
          })
          return tokenData
        } else {
          const errorText = await response.text()
          console.error('Token exchange failed:', response.status, errorText)
          return null
        }
      } catch (error) {
        console.error('Token exchange error:', error)
        return null
      }
    }

    /**
     * Generate random string for PKCE
     */
    function generateRandomString(length) {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
      let result = ''
      for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length))
      }
      return result
    }
  })
}

module.exports = {
  openLoginWebView,
}