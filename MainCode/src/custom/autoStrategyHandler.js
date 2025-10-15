// custom/autoStrategyHandler.js - ЕСЛИ ХОТИТЕ АВТО-ВЫБОР МЕТОДА
class AutoStrategyHandler {
  constructor(app, BUILD_CONFIG) {
    this.app = app
    this.BUILD_CONFIG = BUILD_CONFIG
    this.domainAuth = require('./domainAuth.js')
  }

  /**
   * Автоматически выбирает метод входа на странице логина
   */
  async autoSelectLoginMethod(webContents) {
    const authStrategy = await this.domainAuth.determineAuthStrategy(this.app, this.BUILD_CONFIG)
    
    console.log('Auto-selecting login method for:', authStrategy.type)
    
    if (authStrategy.type === 'saml') {
      return await this.clickADFS(webContents)
    } else if (authStrategy.type === 'file') {
      return await this.fillDirectLogin(webContents, authStrategy.creds.credentials)
    }
    
    return false
  }

  async clickADFS(webContents) {
    return await webContents.executeJavaScript(`
      new Promise((resolve) => {
        const findADFS = () => {
          const adfsBtn = document.querySelector('[data-provider="windows"]');
          if (adfsBtn) {
            console.log('ADFS button found, auto-clicking...');
            adfsBtn.click();
            resolve(true);
          } else {
            setTimeout(findADFS, 200);
          }
        };
        findADFS();
        setTimeout(() => resolve(false), 5000);
      });
    `)
  }

  async fillDirectLogin(webContents, credentials) {
    return await webContents.executeJavaScript(`
      new Promise((resolve) => {
        const findForm = () => {
          const userInput = document.querySelector('input[name="user"]');
          const passInput = document.querySelector('input[name="password"]');
          const submitBtn = document.querySelector('button[type="submit"]');
          
          if (userInput && passInput && submitBtn) {
            console.log('Login form found, auto-filling...');
            userInput.value = '${credentials.username}';
            passInput.value = '${credentials.password}';
            userInput.dispatchEvent(new Event('input', { bubbles: true }));
            passInput.dispatchEvent(new Event('input', { bubbles: true }));
            setTimeout(() => {
              submitBtn.click();
              resolve(true);
            }, 300);
          } else {
            setTimeout(findForm, 200);
          }
        };
        findForm();
        setTimeout(() => resolve(false), 5000);
      });
    `)
  }
}

module.exports = AutoStrategyHandler