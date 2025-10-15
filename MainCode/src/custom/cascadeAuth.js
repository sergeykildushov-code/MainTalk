// custom/cascadeAuth.js
class CascadeAuth {
  constructor(app, BUILD_CONFIG) {
    this.app = app
    this.BUILD_CONFIG = BUILD_CONFIG
    this.domainAuth = require('./domainAuth.js')
    this.oauthConfig = require('./oauth.config.js')
  }

  async performCascadeAuth() {
    console.log('Starting simplified cascade auth...')
    
    // 1. Определяем стратегию через ВАШ domainAuth
    const authStrategy = await this.domainAuth.determineAuthStrategy(this.app, this.BUILD_CONFIG)
    console.log('Auth strategy:', authStrategy.type)
    
    // 2. Автоматический вход если есть credentials
    if (authStrategy.type === 'file' && this.domainAuth.validateCredentials(authStrategy.creds)) {
      console.log('Attempting auto-login with file credentials...')
      
      // Пробуем OAuth авто-логин
      const oauthResult = await this.tryOAuthAuto(authStrategy.creds)
      if (oauthResult.success) {
        return oauthResult
      }
      
      // Fallback к basic auth
      return this.tryFileCredentials(authStrategy.creds)
    }
    
    // 3. Manual fallback
    return { 
      success: false, 
      type: 'manual',
      reason: 'no_auto_credentials'
    }
  }

  /**
   * OAuth авто-логин
   */
  async tryOAuthAuto(creds) {
    try {
      const { serverUrl, credentials } = creds
      const oauthCfg = this.oauthConfig.getConfig(this.BUILD_CONFIG)
      
      // Проверяем валидность OAuth конфига
      if (!this.oauthConfig.validateConfig(oauthCfg)) {
        console.log('OAuth config invalid, skipping OAuth auto-login')
        return { success: false, reason: 'invalid_oauth_config' }
      }

      console.log('Attempting OAuth auto-login...')
      const tokenData = await this.domainAuth.getOAuthToken(serverUrl, credentials, oauthCfg)
      
      if (tokenData) {
        console.log('✅ OAuth auto-login successful!')
        const oauthCredentials = this.domainAuth.convertOAuthToCredentials(tokenData, credentials.username)
        
        return {
          success: true,
          type: 'oauth_auto',
          serverUrl: serverUrl,
          credentials: oauthCredentials
        }
      }
      
      return { success: false, reason: 'oauth_token_failed' }
    } catch (error) {
      console.error('OAuth auto-login failed:', error)
      return { success: false, reason: error.message }
    }
  }

  /**
   * Basic auth через файл credentials
   */
  async tryFileCredentials(creds) {
    try {
      const { serverUrl, credentials } = creds
      
      console.log('Using file credentials for basic auth')
      
      return {
        success: true,
        type: 'file_credentials',
        serverUrl: serverUrl,
        credentials: credentials
      }
    } catch (error) {
      console.error('File credentials login failed:', error)
      return { success: false, reason: error.message }
    }
  }
}

module.exports = CascadeAuth