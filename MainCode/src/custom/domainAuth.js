// custom/domainAuth.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/* ---------- helpers ---------- */
function credsPath(app) {
  return path.join(app.getPath('userData'), 'credentials.json');
}

function readSaved(app) {
  try {
    const p = credsPath(app);
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, 'utf8');
      let creds = JSON.parse(content);
      creds = fixCredentialsFormat(creds);
      console.log('[auth] Loaded credentials from file');
      return creds;
    }
  } catch (error) {
    console.error('[auth] Failed to read credentials file:', error);
  }
  return null;
}

function writeSaved(app, obj) {
  try {
    const p = credsPath(app);
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
    console.log('[auth] Credentials saved to file');
  } catch (error) {
    console.error('[auth] Failed to save credentials:', error);
  }
}

function removeSaved(app) {
  try {
    const p = credsPath(app);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log('[auth] Credentials file removed');
    }
  } catch (error) {
    console.error('[auth] Failed to remove credentials:', error);
  }
}

function fixCredentialsFormat(creds) {
  if (!creds || !creds.credentials) return creds;
  if (creds.credentials.server && creds.credentials.user && creds.credentials.password) {
    console.log('[auth] Fixing credentials format from old to new...');
    return {
      serverUrl: creds.serverUrl || creds.credentials.server,
      credentials: {
        username: creds.credentials.user,
        password: creds.credentials.password
      }
    };
  }
  return creds;
}

function isOnDomain(expectedDomain) {
  if (process.platform !== 'win32') {
    return false;
  }
  try {
    const id = execFileSync('whoami', [], { encoding: 'utf8' }).trim();
    const m = id.match(/^([^\\]+)\\[^\\]+$/);
    if (m) {
      const domain = m[1].toUpperCase();
      const computerName = (process.env.COMPUTERNAME || '').toUpperCase();
      if (domain && computerName && domain !== computerName) {
        if (!expectedDomain) return true;
        return domain === String(expectedDomain).toUpperCase();
      }
    }
  } catch (error) {
    console.error('[auth] Domain check failed:', error);
  }
  return false;
}

/* ---------- Основные API функции ---------- */
async function detectAuthState(app, BUILD_CONFIG) {
  const expectedDomain = (BUILD_CONFIG && (BUILD_CONFIG.adDomain || BUILD_CONFIG?.sso?.realm)) || null;
  const saved = readSaved(app);
  const inDomain = isOnDomain(expectedDomain);
  return { inDomain, hasCreds: !!saved, creds: saved || null, expectedDomain };
}

async function determineAuthStrategy(app, BUILD_CONFIG) {
  const state = await detectAuthState(app, BUILD_CONFIG);
  let strategy;
  if (state.inDomain) {
    strategy = { type: 'saml', reason: 'domain_joined', serverUrl: BUILD_CONFIG?.domain || state.creds?.serverUrl };
  } else if (state.hasCreds) {
    strategy = { type: 'file', reason: 'credentials_file_found', creds: state.creds, serverUrl: state.creds.serverUrl };
  } else {
    strategy = { type: 'manual', reason: 'no_auto_auth_available', serverUrl: BUILD_CONFIG?.domain };
  }
  console.log('[auth] Auth strategy:', strategy);
  return strategy;
}

async function handleAuthenticationLogin(newAppData, app, appData) {
  try {
    if (newAppData?.serverUrl) appData.serverUrl = newAppData.serverUrl;
    if (newAppData?.credentials) appData.credentials = newAppData.credentials;
    writeSaved(app, { serverUrl: appData.serverUrl, credentials: appData.credentials || { type: 'manual' }, timestamp: Date.now() });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function handleAuthenticationLogout(app) {
  removeSaved(app);
}

function validateCredentials(creds) {
  if (!creds || !creds.serverUrl || !creds.credentials) return false;
  try { new URL(creds.serverUrl); } catch { return false; }
  const auth = creds.credentials;
  if (auth.username && auth.password) return true;
  if (auth.type === 'oauth') return !!(auth.token && auth.username);
  return false;
}

async function performAutoLogin(authStrategy, enableWebRequestInterceptor) {
  try {
    if (authStrategy.type === 'file' && authStrategy.creds) {
      const { serverUrl, credentials } = authStrategy.creds;
      enableWebRequestInterceptor(serverUrl, { credentials });
      return { success: true, type: 'basic', serverUrl, credentials };
    }
    return { success: false, reason: 'no_auto_login_available' };
  } catch (error) {
    return { success: false, reason: error.message };
  }
}

module.exports = {
  detectAuthState,
  handleAuthenticationLogin,
  handleAuthenticationLogout,
  determineAuthStrategy,
  validateCredentials,
  performAutoLogin,
  _helpers: { credsPath, readSaved, writeSaved, removeSaved, isOnDomain, fixCredentialsFormat }
};