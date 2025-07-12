// OAuth Configuration
const AGENT_SWARM_API = 'https://50c21f73c5ca.ngrok-free.app/api/v1';
const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/calendar',
];

/**
 * Authentication Module
 * Handles OAuth authentication with Google
 */
class AuthModule extends EventTarget {
  constructor() {
    super();
    this.isOAuthInProgress = false;
    this.tokenData = null;
  }

  // Public API Methods

  /**
   * Bootstrap authentication - check for existing token or handle OAuth callback
   * @returns {Promise<boolean>} - True if authenticated
   */
  async bootstrap() {
    try {
      // Check for existing token
      const existingToken = this.getStoredToken();
      console.log(
        '🔍 Checking for existing token:',
        existingToken ? 'Found' : 'Not found'
      );

      if (existingToken) {
        console.log('📋 Token data:', {
          hasAccessToken: !!existingToken.access_token,
          hasTimestamp: !!existingToken.timestamp,
          hasExpiresIn: !!existingToken.expires_in,
        });

        // Check if token is expired
        if (this.isTokenExpired()) {
          console.log('⏰ Token is expired');
          this.emit('message', {
            message: 'Authentication token expired',
            type: 'system',
          });
          this.clearToken();
          return false;
        }

        console.log('✅ Token is valid, storing in memory');
        this.tokenData = existingToken;
        this.emit('authenticated', { tokenData: existingToken });
        this.emit('message', {
          message: 'Already authenticated',
          type: 'system',
        });
        this.emit('message', {
          message: `Bearer token: ${existingToken.access_token.substring(0, 20)}...`,
          type: 'system',
        });
        return true;
      }

      // Handle OAuth callback if present
      const handled = await this.handleOAuthCallback();
      return handled;
    } catch (error) {
      console.error('Auth bootstrap failed:', error);
      this.emit('authenticationFailed', error);
      return false;
    }
  }

  /**
   * Initiate Google OAuth login
   */
  async loginWithGoogle() {
    // Prevent multiple OAuth flows
    if (this.isOAuthInProgress) {
      console.log('OAuth flow already in progress, ignoring duplicate request');
      this.emit('message', {
        message: 'Authentication already in progress...',
        type: 'system',
      });
      return;
    }

    try {
      this.isOAuthInProgress = true;
      this.setOAuthTimeout();

      // Emit OAuth start event
      this.emit('authStart');

      // Clear any existing state first
      sessionStorage.removeItem('oauth_state');

      const state = this.generateOAuthState();
      const redirectUri = `${window.location.origin}${window.location.pathname}`;

      const initiateResponse = await fetch(
        `${AGENT_SWARM_API}/auth/oauth/initiate`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            redirect_uri: redirectUri,
            state: state,
            scopes: OAUTH_SCOPES,
          }),
        }
      );

      if (!initiateResponse.ok) {
        throw new Error(`OAuth initiate failed: ${initiateResponse.status}`);
      }

      const initiateData = await initiateResponse.json();

      if (!initiateData.auth_url) {
        throw new Error('No auth URL received from server');
      }

      this.emit('message', {
        message: 'Redirecting to Google for authentication...',
        type: 'system',
      });

      window.location.href = initiateData.auth_url;
    } catch (error) {
      console.error('OAuth initiation failed:', error);
      this.isOAuthInProgress = false;
      this.emit('authenticationFailed', error);
    }
  }

  /**
   * Get the current authentication token
   * @returns {string|null} - The access token or null
   */
  getToken() {
    // Try to get token from memory first
    if (this.tokenData && !this.isTokenExpired()) {
      return this.tokenData.access_token;
    }

    // If not in memory, try to load from storage
    const storedToken = this.getStoredToken();
    if (storedToken && !this.isTokenExpired()) {
      // Store it in memory for future use
      this.tokenData = storedToken;
      return storedToken.access_token;
    }

    return null;
  }

  /**
   * Clear the authentication token and emit logout
   */
  clearToken() {
    try {
      localStorage.removeItem('oauth_token');
      sessionStorage.removeItem('oauth_state');
      this.isOAuthInProgress = false;
      this.tokenData = null;

      // Emit logout event
      this.emit('logout');

      console.log('Authentication token cleared successfully');
    } catch (error) {
      console.error('Failed to clear token:', error);
      this.emit('error', error);
    }
  }

  /**
   * Check if user is authenticated
   * @returns {boolean} - True if authenticated
   */
  isAuthenticated() {
    const token = this.getToken();
    return token !== null;
  }

  // Private Methods

  /**
   * Handle OAuth callback
   * @returns {Promise<boolean>} - True if successfully handled
   */
  async handleOAuthCallback() {
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const code = urlParams.get('code');
      const state = urlParams.get('state');
      const error = urlParams.get('error');

      if (error) {
        throw new Error(`OAuth error: ${error}`);
      }

      if (!code) {
        return false; // Not an OAuth callback
      }

      // Validate OAuth state
      this.validateOAuthState(state);

      const redirectUri = `${window.location.origin}${window.location.pathname}`;

      const tokenResponse = await fetch(`${AGENT_SWARM_API}/auth/oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          code: code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
          state: state,
        }),
      });

      if (!tokenResponse.ok) {
        throw new Error(`Token exchange failed: ${tokenResponse.status}`);
      }

      const tokenData = await tokenResponse.json();

      if (!tokenData.access_token) {
        throw new Error('No access token received');
      }

      // Add timestamp for expiration checking
      tokenData.timestamp = Date.now();

      this.storeToken(tokenData);

      // Clean up URL parameters
      const cleanUrl = window.location.origin + window.location.pathname;
      window.history.replaceState({}, document.title, cleanUrl);

      // Reset OAuth progress flag on success
      this.isOAuthInProgress = false;
      console.log('OAuth flow completed successfully');

      this.emit('message', {
        message: `Bearer token: ${tokenData.access_token}`,
        type: 'system',
      });

      return true;
    } catch (error) {
      console.error('OAuth callback handling failed:', error);

      // Clean up URL parameters even on error
      const cleanUrl = window.location.origin + window.location.pathname;
      window.history.replaceState({}, document.title, cleanUrl);

      // Reset OAuth progress flag on error
      this.isOAuthInProgress = false;

      // Clear potentially corrupted state
      sessionStorage.removeItem('oauth_state');

      this.emit('authenticationFailed', error);
      return false;
    }
  }

  /**
   * Store token in localStorage
   * @param {Object} tokenData - Token data from OAuth
   */
  storeToken(tokenData) {
    try {
      this.tokenData = tokenData;
      localStorage.setItem('oauth_token', JSON.stringify(tokenData));

      // Emit authentication success event
      this.emit('authenticated', { tokenData });

      console.log('Authentication token stored successfully');
    } catch (error) {
      console.error('Failed to store token:', error);
      this.emit('error', error);
    }
  }

  /**
   * Get stored token from localStorage
   * @returns {Object|null} - Token data or null
   */
  getStoredToken() {
    try {
      const tokenData = localStorage.getItem('oauth_token');
      return tokenData ? JSON.parse(tokenData) : null;
    } catch (error) {
      console.error('Failed to retrieve token:', error);
      return null;
    }
  }

  /**
   * Check if token is expired
   * @returns {boolean} - True if expired
   */
  isTokenExpired() {
    try {
      const tokenData = this.tokenData || this.getStoredToken();
      if (!tokenData || !tokenData.expires_in) {
        console.log('🕐 No expiration info, assuming token is valid');
        return false; // No expiration info, assume valid
      }

      const tokenTimestamp = tokenData.timestamp || 0;
      const expiresInMs = tokenData.expires_in * 1000;
      const currentTime = Date.now();
      const ageMs = currentTime - tokenTimestamp;
      const isExpired = ageMs >= expiresInMs;

      console.log('🕐 Token expiration check:', {
        tokenAge: Math.floor(ageMs / 1000) + 's',
        expiresIn: tokenData.expires_in + 's',
        isExpired,
      });

      return isExpired;
    } catch (error) {
      console.error('Failed to check token expiration:', error);
      return true; // Assume expired on error
    }
  }

  /**
   * Generate OAuth state for CSRF protection
   * @returns {string} - Generated state
   */
  generateOAuthState() {
    const state = crypto.randomUUID();
    const timestamp = Date.now();

    const stateData = {
      state: state,
      timestamp: timestamp,
    };

    sessionStorage.setItem('oauth_state', JSON.stringify(stateData));
    console.log('Generated and stored OAuth state:', state);

    return state;
  }

  /**
   * Validate OAuth state
   * @param {string} receivedState - State received from OAuth callback
   * @returns {boolean} - True if valid
   */
  validateOAuthState(receivedState) {
    const storedStateStr = sessionStorage.getItem('oauth_state');
    if (!storedStateStr) {
      throw new Error('No stored OAuth state found - possible session timeout');
    }

    let storedStateData;
    try {
      storedStateData = JSON.parse(storedStateStr);
    } catch (parseError) {
      console.error('Failed to parse stored state:', parseError);
      throw new Error('Invalid stored OAuth state format');
    }

    const storedState = storedStateData.state;
    const stateTimestamp = storedStateData.timestamp;

    // Validate state match
    if (!storedState || storedState !== receivedState) {
      throw new Error(
        'Invalid OAuth state - possible CSRF attack or expired session'
      );
    }

    // Check if state is too old (older than 10 minutes)
    const stateAgeMinutes = (Date.now() - stateTimestamp) / 60000;
    if (stateAgeMinutes > 10) {
      throw new Error('OAuth state expired - please try authenticating again');
    }

    // Clear state after successful validation
    sessionStorage.removeItem('oauth_state');
    return true;
  }

  /**
   * Set OAuth timeout
   */
  setOAuthTimeout() {
    setTimeout(
      () => {
        if (this.isOAuthInProgress) {
          console.warn('OAuth flow timeout - resetting flag');
          this.isOAuthInProgress = false;
          this.emit('authTimeout');
        }
      },
      5 * 60 * 1000
    ); // 5 minutes
  }

  /**
   * Custom event emitter
   * @param {string} type - Event type
   * @param {Object} detail - Event detail
   */
  emit(type, detail = {}) {
    const event = new CustomEvent(type, { detail });
    this.dispatchEvent(event);
  }

  /**
   * Add event listener
   * @param {string} type - Event type
   * @param {Function} listener - Event listener
   * @param {Object} options - Event options
   */
  on(type, listener, options = {}) {
    this.addEventListener(type, listener, options);
  }

  /**
   * Remove event listener
   * @param {string} type - Event type
   * @param {Function} listener - Event listener
   */
  off(type, listener) {
    this.removeEventListener(type, listener);
  }
}

// Create and export singleton instance
const authModule = new AuthModule();

export default authModule;

// Also export the class for testing or multiple instances
export { AuthModule };
