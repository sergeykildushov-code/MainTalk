// custom/oauth.config.js
module.exports = {
  // === РЕАЛЬНЫЕ ДАННЫЕ ИЗ ВАШЕЙ АДМИНКИ ===
  client_id: 'yqKrXUKAaN1UYMU5SoNvKeLA7F4SfVzRbTJjiOz2bQAegHzw3cijM0xhD53CgGUv',
  client_secret: 'IYfilZl3VL7Dn7X1uYOkQZMpWH7nMlEOkkwiWDN06QulC4nqnHAoydFUi9h0CaVW',
  
  scope: 'openid profile email talk',
  
  getConfig(BUILD_CONFIG) {
    const config = {
      client_id: BUILD_CONFIG?.oauth?.client_id || this.client_id,
      client_secret: BUILD_CONFIG?.oauth?.client_secret || this.client_secret,
      scope: BUILD_CONFIG?.oauth?.scope || this.scope,
      token_endpoint: '/index.php/apps/oauth2/api/v1/token'
    };
    
    console.log('🔧 OAuth Config loaded:', {
      client_id: config.client_id ? '***' + config.client_id.slice(-8) : 'missing',
      client_secret: config.client_secret ? '***' + config.client_secret.slice(-8) : 'missing',
      scope: config.scope
    });
    
    return config;
  },
  
  validateConfig(config) {
    const hasRealCredentials = config.client_id && 
                              config.client_secret &&
                              config.client_id.length > 10 &&
                              config.client_secret.length > 10;
    
    if (hasRealCredentials) {
      console.log('✅ OAuth config: VALID (using real credentials)');
      return true;
    } else {
      console.warn('❌ OAuth config: INVALID (using default values)');
      console.warn('   Please update client_id and client_secret in custom/oauth.config.js');
      return false;
    }
  }
};