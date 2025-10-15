/**
 * SPDX-FileCopyrightText: 2022 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * @typedef Credentials
 * @property {string} server - Server URL
 * @property {string} user - User's Login (user@example.com, not userid)
 * @property {string} password - App password or access token
 * @property {string} [code] - OAuth authorization code (if present)
 * @property {string} [state] - OAuth state parameter (if present)
 * @property {Object} [tokenData] - Full OAuth token data (if available)
 */

/**
 * Parse redirect URL according to Nextcloud Login Flow specification
 * Official format: nc://login/server:URL&user:USER&password:PASSWORD
 *
 * @param {string} url - Redirect URL in format: nc://login/server:URL&user:USER&password:PASSWORD
 * @return {Credentials} - Credentials data
 * @throws {Error} - Parsing error
 */
function parseLoginRedirectUrl(url) {
    console.log('🔗 Parsing login redirect URL:', url)
    
    // Basic validation
    if (!url || typeof url !== 'string') {
        throw new Error('Invalid URL: URL must be a non-empty string')
    }
    
    // Validate protocol
    if (!url.startsWith('nc://')) {
        throw new Error(`Invalid protocol. Expected "nc://", got "${url.split('://')[0]}://"`)
    }
    
    // Remove protocol for easier parsing
    const withoutProtocol = url.substring(5) // Remove "nc://"
    
    if (!withoutProtocol) {
        throw new Error('Invalid URL: Missing endpoint after protocol')
    }
    
    // Check if it's the login endpoint
    if (!withoutProtocol.startsWith('login/')) {
        throw new Error(`Invalid endpoint. Expected "login/", got "${withoutProtocol.split('/')[0]}/"`)
    }
    
    // Extract the parameters part
    const paramsString = withoutProtocol.substring(6) // Remove "login/"
    
    if (!paramsString) {
        throw new Error('Invalid URL: Missing parameters after login/')
    }
    
    // Parse parameters - format: server:URL&user:USER&password:PASSWORD
    const params = {}
    const pairs = paramsString.split('&')
    
    for (const pair of pairs) {
        if (!pair) continue
        
        const firstColonIndex = pair.indexOf(':')
        if (firstColonIndex === -1) {
            console.warn('⚠️ Skipping invalid parameter pair (no colon):', pair)
            continue
        }
        
        const key = pair.substring(0, firstColonIndex)
        const value = pair.substring(firstColonIndex + 1)
        
        if (!key || !value) {
            console.warn('⚠️ Skipping invalid parameter pair (empty key or value):', pair)
            continue
        }
        
        // Handle different parameter types
        if (key === 'server') {
            // Server URL should be preserved as-is for proper URL parsing
            params[key] = value
        } else if (key === 'code' || key === 'state') {
            // OAuth parameters - decode but preserve exact values
            try {
                params[key] = decodeURIComponent(value)
            } catch (e) {
                params[key] = value // Fallback to raw value
            }
        } else {
            // User and password - decode and handle spaces
            try {
                params[key] = decodeURIComponent(value.replaceAll('+', ' '))
            } catch (e) {
                params[key] = value.replaceAll('+', ' ') // Fallback with space replacement
            }
        }
    }
    
    // Validate required parameters
    if (!params.server) {
        throw new Error('Missing required parameter: server')
    }
    
    if (!params.user) {
        throw new Error('Missing required parameter: user')
    }
    
    if (!params.password) {
        throw new Error('Missing required parameter: password')
    }
    
    // Validate server URL format
    try {
        const serverUrl = new URL(params.server)
        if (!serverUrl.protocol.startsWith('http')) {
            throw new Error('Server URL must use HTTP or HTTPS protocol')
        }
    } catch (e) {
        throw new Error(`Invalid server URL: ${params.server} - ${e.message}`)
    }
    
    console.log('✅ Successfully parsed login URL:', {
        server: params.server,
        user: params.user,
        hasPassword: !!params.password,
        passwordLength: params.password ? params.password.length : 0,
        hasCode: !!params.code,
        hasState: !!params.state
    })
    
    // Build credentials object
    const credentials = {
        server: params.server,
        user: params.user,
        password: params.password,
    }
    
    // Add optional OAuth parameters
    if (params.code) credentials.code = params.code
    if (params.state) credentials.state = params.state
    
    return credentials
}

/**
 * Build login redirect URL according to Nextcloud Login Flow specification
 * 
 * @param {Credentials} credentials - Credentials data
 * @return {string} - Formatted redirect URL
 * @throws {Error} - If required parameters are missing
 */
function buildLoginRedirectUrl(credentials) {
    if (!credentials || typeof credentials !== 'object') {
        throw new Error('Credentials must be a non-null object')
    }
    
    const { server, user, password, code, state } = credentials
    
    // Validate required parameters
    if (!server) {
        throw new Error('Missing required parameter: server')
    }
    
    if (!user) {
        throw new Error('Missing required parameter: user')
    }
    
    if (!password) {
        throw new Error('Missing required parameter: password')
    }
    
    // Validate server URL
    try {
        new URL(server)
    } catch (e) {
        throw new Error(`Invalid server URL: ${server}`)
    }
    
    // Encode values (spaces become +)
    const encodedServer = encodeURIComponent(server).replace(/%20/g, '+')
    const encodedUser = encodeURIComponent(user).replace(/%20/g, '+')
    const encodedPassword = encodeURIComponent(password).replace(/%20/g, '+')
    
    // Build base URL
    let url = `nc://login/server:${encodedServer}&user:${encodedUser}&password:${encodedPassword}`
    
    // Add OAuth parameters if present
    if (code) {
        const encodedCode = encodeURIComponent(code).replace(/%20/g, '+')
        url += `&code:${encodedCode}`
    }
    
    if (state) {
        const encodedState = encodeURIComponent(state).replace(/%20/g, '+')
        url += `&state:${encodedState}`
    }
    
    console.log('🔗 Built login redirect URL:', {
        server: server,
        user: user,
        hasPassword: true,
        hasCode: !!code,
        hasState: !!state,
        finalUrl: url
    })
    
    return url
}

/**
 * Validate if URL matches Nextcloud Login Flow pattern
 * 
 * @param {string} url - URL to validate
 * @return {boolean} - True if valid login flow URL
 */
function isValidLoginFlowUrl(url) {
    if (!url || typeof url !== 'string') {
        return false
    }
    
    try {
        parseLoginRedirectUrl(url)
        return true
    } catch (error) {
        console.log('❌ Invalid login flow URL:', error.message)
        return false
    }
}

/**
 * Extract OAuth parameters from login flow URL
 * 
 * @param {string} url - Login flow URL
 * @return {Object} - OAuth parameters { code, state } or empty object
 */
function extractOAuthParams(url) {
    if (!isValidLoginFlowUrl(url)) {
        return {}
    }
    
    try {
        const credentials = parseLoginRedirectUrl(url)
        const result = {}
        
        if (credentials.code) result.code = credentials.code
        if (credentials.state) result.state = credentials.state
        
        return result
    } catch (error) {
        console.error('Error extracting OAuth params:', error)
        return {}
    }
}

/**
 * Create credentials for OAuth token flow
 * 
 * @param {string} serverUrl - Server URL
 * @param {string} accessToken - OAuth access token
 * @param {string} userId - User ID
 * @param {Object} tokenData - Full token data
 * @return {Credentials} - Formatted credentials
 */
function createOAuthCredentials(serverUrl, accessToken, userId, tokenData = {}) {
    if (!serverUrl || !accessToken) {
        throw new Error('serverUrl and accessToken are required')
    }
    
    const credentials = {
        server: serverUrl,
        user: userId || 'oauth_user',
        password: accessToken,
    }
    
    // Include full token data if provided
    if (tokenData && Object.keys(tokenData).length > 0) {
        credentials.tokenData = tokenData
    }
    
    return credentials
}

/**
 * Create credentials from OAuth authorization code flow
 * 
 * @param {string} serverUrl - Server URL
 * @param {string} authCode - OAuth authorization code
 * @param {string} state - OAuth state parameter
 * @param {string} userId - User ID (optional)
 * @return {Credentials} - Formatted credentials with code
 */
function createOAuthCodeCredentials(serverUrl, authCode, state, userId = 'oauth_user') {
    if (!serverUrl || !authCode) {
        throw new Error('serverUrl and authCode are required')
    }
    
    return {
        server: serverUrl,
        user: userId,
        password: 'oauth_code_flow', // Placeholder, real token will be exchanged
        code: authCode,
        state: state
    }
}

/**
 * Check if credentials contain OAuth authorization code
 * 
 * @param {Credentials} credentials - Credentials to check
 * @return {boolean} - True if credentials contain OAuth code
 */
function hasOAuthCode(credentials) {
    return !!(credentials && credentials.code)
}

/**
 * Check if credentials contain OAuth access token
 * 
 * @param {Credentials} credentials - Credentials to check
 * @return {boolean} - True if credentials contain OAuth token (not a code)
 */
function hasOAuthToken(credentials) {
    return !!(credentials && 
              credentials.password && 
              credentials.password !== 'oauth_code_flow' &&
              !credentials.code)
}

/**
 * Convert OAuth token response to credentials format
 * 
 * @param {string} serverUrl - Server URL
 * @param {Object} tokenResponse - OAuth token response
 * @param {string} userId - User ID
 * @return {Credentials} - Formatted credentials
 */
function tokenResponseToCredentials(serverUrl, tokenResponse, userId) {
    if (!tokenResponse || !tokenResponse.access_token) {
        throw new Error('Invalid token response: access_token is required')
    }
    
    return createOAuthCredentials(
        serverUrl,
        tokenResponse.access_token,
        userId || tokenResponse.user_id,
        tokenResponse
    )
}

/**
 * Test function to verify URL parsing and building
 * 
 * @param {string} testUrl - URL to test
 */
function testLoginFlowUrl(testUrl) {
    console.log('🧪 Testing login flow URL:', testUrl)
    
    try {
        const credentials = parseLoginRedirectUrl(testUrl)
        console.log('✅ Parse successful:', credentials)
        
        const rebuiltUrl = buildLoginRedirectUrl(credentials)
        console.log('✅ Rebuild successful:', rebuiltUrl)
        
        const isValid = isValidLoginFlowUrl(testUrl)
        console.log('✅ Validation:', isValid)
        
        const oauthParams = extractOAuthParams(testUrl)
        console.log('✅ OAuth params:', oauthParams)
        
        return {
            success: true,
            credentials,
            rebuiltUrl,
            isValid,
            oauthParams
        }
    } catch (error) {
        console.error('❌ Test failed:', error.message)
        return {
            success: false,
            error: error.message
        }
    }
}

// Export all functions
module.exports = {
    parseLoginRedirectUrl,
    buildLoginRedirectUrl,
    isValidLoginFlowUrl,
    extractOAuthParams,
    createOAuthCredentials,
    createOAuthCodeCredentials,
    hasOAuthCode,
    hasOAuthToken,
    tokenResponseToCredentials,
    testLoginFlowUrl,
}