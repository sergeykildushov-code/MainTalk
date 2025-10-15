// custom/autoOAuth.js
const crypto = require('crypto');

class AutoOAuthManager {
  constructor(oauthConfig) {
    this.config = oauthConfig;
  }

  /**
   * Test OAuth client configuration
   */
  async testClientOAuth(serverUrl) {
    try {
      console.log('=== TESTING OAUTH SUPPORT ===');
      
      // Test if OAuth endpoint is accessible
      const discoveryUrl = `${serverUrl}/index.php/apps/oauth2/api/v1/configuration`;
      
      console.log('Testing OAuth configuration endpoint:', discoveryUrl);
      
      const response = await fetch(discoveryUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        }
      });
      
      if (response.ok) {
        const config = await response.json();
        console.log('✅ OAuth configuration endpoint accessible');
        console.log('Nextcloud OAuth2 supports: Authorization Code Flow with PKCE');
        console.log('Client Credentials Flow: NOT SUPPORTED');
        
        return {
          success: true,
          supportsAuthorizationCode: true,
          supportsClientCredentials: false,
          configuration: config
        };
      } else {
        console.log('❌ OAuth configuration endpoint not accessible:', response.status);
        return {
          success: false,
          error: `OAuth endpoint returned ${response.status}`,
          supportsAuthorizationCode: false,
          supportsClientCredentials: false
        };
      }
      
    } catch (error) {
      console.error('OAuth test failed:', error);
      return {
        success: false,
        error: error.message,
        supportsAuthorizationCode: false,
        supportsClientCredentials: false
      };
    }
  }

  /**
   * Authorization Code Flow with PKCE
   */
  async performAuthorizationCodeFlow(serverUrl) {
    try {
      console.log('=== STARTING OAUTH AUTHORIZATION CODE FLOW ===');

      // Generate PKCE parameters
      const codeVerifier = this.generateCodeVerifier();
      const codeChallenge = this.generateCodeChallenge(codeVerifier);
      const state = this.generateRandomString(32);

      console.log('PKCE parameters generated');
      console.log('- Using redirect_uri: nc://login');

      return {
        success: true,
        method: 'authorization_code_pkce',
        codeVerifier: codeVerifier,
        codeChallenge: codeChallenge,
        state: state,
        redirectUri: 'nc://login'
      };

    } catch (error) {
      console.error('OAuth Authorization Code Flow failed:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Generate PKCE code verifier
   */
  generateCodeVerifier() {
    return this.generateRandomString(128);
  }

  /**
   * Generate PKCE code challenge from verifier
   */
  generateCodeChallenge(codeVerifier) {
    const hash = crypto.createHash('sha256').update(codeVerifier).digest('base64');
    return hash.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  /**
   * Generate random string
   */
  generateRandomString(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  /**
   * Проверяет валидность OAuth конфигурации
   */
  validateConfig() {
    const hasRealCredentials = this.config.client_id && 
                              this.config.client_secret;
    
    if (hasRealCredentials) {
      console.log('✅ OAuth config: VALID');
    } else {
      console.log('❌ OAuth config: INVALID');
    }
    
    return hasRealCredentials;
  }

  // Устаревшие методы для обратной совместимости
  async performClientCredentialsFlow() {
    console.log('Client Credentials Flow: NOT SUPPORTED by Nextcloud OAuth2');
    return {
      success: false,
      error: 'Client Credentials Grant not supported. Use Authorization Code Flow.'
    };
  }
}

module.exports = AutoOAuthManager;