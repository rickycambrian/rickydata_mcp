/**
 * OAuth 2.0 Provider for Claude.ai Connectors
 *
 * Bridges the MCP SDK's OAuthServerProvider interface to our existing wallet token
 * (mcpwt_) authentication system. Wallet tokens ARE the OAuth access tokens —
 * no token format changes needed.
 *
 * Flow:
 *   Claude.ai → 401 → discovers OAuth endpoints → DCR → redirects user to /authorize
 *   → MCP server redirects to marketplace Privy login → user authenticates →
 *   marketplace creates wallet token + POSTs to /oauth/complete → MCP server issues
 *   auth code → redirects to Claude.ai callback → Claude.ai exchanges code for wallet
 *   token → uses wallet token as Bearer on /mcp
 */

import { randomUUID, randomBytes } from "node:crypto";
import type { Response, RequestHandler } from "express";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { verifyWalletToken, WALLET_TOKEN_PREFIX } from "./wallet-token.js";

/**
 * Extract expiry (seconds since epoch) from a wallet token payload.
 * Token format: mcpwt_<base64url(JSON)> where JSON has { exp: number }.
 */
function getTokenExpiry(token: string): number | undefined {
  try {
    const json = Buffer.from(token.slice(WALLET_TOKEN_PREFIX.length), "base64url").toString();
    const payload = JSON.parse(json);
    return typeof payload.exp === "number" ? payload.exp : undefined;
  } catch {
    return undefined;
  }
}

// ============================================================================
// Configuration
// ============================================================================

const MARKETPLACE_URL =
  process.env.MARKETPLACE_URL || "https://mcpmarketplace.rickydata.org";
const SERVER_BASE_URL =
  process.env.SERVER_BASE_URL || "https://rickydata-mcp-server-2dbp4scmrq-uc.a.run.app";

// TTLs
const CLIENT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const PENDING_SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes
const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

// ============================================================================
// In-memory stores (all with TTL cleanup)
// ============================================================================

interface RegisteredClient {
  info: OAuthClientInformationFull;
  createdAt: number;
}

interface PendingSession {
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  scopes?: string[];
  token?: string; // filled in by /oauth/complete
  createdAt: number;
}

interface AuthCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  token: string; // the wallet token
  createdAt: number;
}

interface RefreshTokenEntry {
  clientId: string;
  walletToken: string;
  createdAt: number;
}

const clients = new Map<string, RegisteredClient>();
const pendingSessions = new Map<string, PendingSession>();
const authCodes = new Map<string, AuthCode>();
const refreshTokens = new Map<string, RefreshTokenEntry>();

// ============================================================================
// TTL cleanup (called from session cleanup interval in index.ts)
// ============================================================================

export function pruneOAuthStores(now: number): void {
  for (const [id, entry] of clients) {
    if (now - entry.createdAt > CLIENT_TTL_MS) clients.delete(id);
  }
  for (const [id, entry] of pendingSessions) {
    if (now - entry.createdAt > PENDING_SESSION_TTL_MS) pendingSessions.delete(id);
  }
  for (const [id, entry] of authCodes) {
    if (now - entry.createdAt > AUTH_CODE_TTL_MS) authCodes.delete(id);
  }
  for (const [id, entry] of refreshTokens) {
    if (now - entry.createdAt > REFRESH_TOKEN_TTL_MS) refreshTokens.delete(id);
  }
}

// ============================================================================
// Clients store
// ============================================================================

class RickydataClientsStore implements OAuthRegisteredClientsStore {
  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const entry = clients.get(clientId);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > CLIENT_TTL_MS) {
      clients.delete(clientId);
      return undefined;
    }
    return entry.info;
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">
  ): OAuthClientInformationFull {
    const clientId = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const info: OAuthClientInformationFull = {
      ...client,
      client_id: clientId,
      client_id_issued_at: now,
    };
    clients.set(clientId, { info, createdAt: Date.now() });
    return info;
  }
}

// ============================================================================
// OAuth Server Provider
// ============================================================================

export class RickydataOAuthProvider implements OAuthServerProvider {
  private _clientsStore = new RickydataClientsStore();

  get clientsStore(): OAuthRegisteredClientsStore {
    return this._clientsStore;
  }

  /**
   * Begins authorization: stores pending session and redirects to marketplace login.
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    const sessionId = randomUUID();

    pendingSessions.set(sessionId, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      state: params.state,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes,
      createdAt: Date.now(),
    });

    // Redirect to marketplace OAuth login page
    const callbackUrl = `${SERVER_BASE_URL}/oauth/callback`;
    const marketplaceUrl = new URL(`${MARKETPLACE_URL}/auth/oauth`);
    marketplaceUrl.searchParams.set("session", sessionId);
    marketplaceUrl.searchParams.set("callback", callbackUrl);
    marketplaceUrl.searchParams.set("server", SERVER_BASE_URL);

    res.redirect(marketplaceUrl.toString());
  }

  /**
   * Returns the code_challenge for PKCE validation.
   */
  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const entry = authCodes.get(authorizationCode);
    if (!entry) throw new Error("Invalid authorization code");
    return entry.codeChallenge;
  }

  /**
   * Exchanges an authorization code for tokens.
   * Returns the wallet token as the access_token.
   */
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    _resource?: URL
  ): Promise<OAuthTokens> {
    const entry = authCodes.get(authorizationCode);
    if (!entry) throw new Error("Invalid or expired authorization code");

    // Validate client and redirect_uri
    if (entry.clientId !== client.client_id) {
      throw new Error("Authorization code was issued to a different client");
    }
    if (redirectUri && entry.redirectUri !== redirectUri) {
      throw new Error("redirect_uri mismatch");
    }

    // Single-use: delete immediately
    authCodes.delete(authorizationCode);

    // Check TTL
    if (Date.now() - entry.createdAt > AUTH_CODE_TTL_MS) {
      throw new Error("Authorization code expired");
    }

    // Create refresh token
    const refreshToken = randomBytes(32).toString("hex");
    refreshTokens.set(refreshToken, {
      clientId: client.client_id,
      walletToken: entry.token,
      createdAt: Date.now(),
    });

    // Verify wallet token to get expiry
    const verified = verifyWalletToken(entry.token);
    const expiresIn = verified ? 30 * 24 * 60 * 60 : 86400; // 30 days or 1 day fallback

    return {
      access_token: entry.token,
      token_type: "Bearer",
      expires_in: expiresIn,
      refresh_token: refreshToken,
    };
  }

  /**
   * Exchanges a refresh token for a new access token.
   * Returns the same wallet token if still valid.
   */
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    _resource?: URL
  ): Promise<OAuthTokens> {
    const entry = refreshTokens.get(refreshToken);
    if (!entry) throw new Error("Invalid refresh token");

    if (entry.clientId !== client.client_id) {
      throw new Error("Refresh token was issued to a different client");
    }

    if (Date.now() - entry.createdAt > REFRESH_TOKEN_TTL_MS) {
      refreshTokens.delete(refreshToken);
      throw new Error("Refresh token expired");
    }

    // Verify the wallet token is still valid
    const verified = verifyWalletToken(entry.walletToken);
    if (!verified) {
      refreshTokens.delete(refreshToken);
      throw new Error("Wallet token expired — user must re-authorize");
    }

    return {
      access_token: entry.walletToken,
      token_type: "Bearer",
      expires_in: 30 * 24 * 60 * 60,
      refresh_token: refreshToken,
    };
  }

  /**
   * Verifies an access token (wallet token) and returns AuthInfo.
   * This is called by requireBearerAuth middleware on every /mcp request.
   */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const result = verifyWalletToken(token);
    if (!result) {
      throw new Error("Invalid or expired wallet token");
    }

    // requireBearerAuth requires expiresAt — extract from token payload
    const expiresAt = getTokenExpiry(token);

    return {
      token,
      clientId: "wallet",
      scopes: [],
      expiresAt,
      extra: { walletAddress: result.walletAddress },
    };
  }

  /**
   * Revokes a token.
   */
  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    // If it's a refresh token, remove it
    if (refreshTokens.has(request.token)) {
      refreshTokens.delete(request.token);
    }
    // Wallet tokens are stateless — can't be revoked server-side
  }
}

// ============================================================================
// Custom endpoints (not handled by SDK router)
// ============================================================================

/**
 * POST /oauth/complete
 * Called by marketplace JS after user creates wallet token.
 * Body: { session: string, token: string }
 */
export function oauthCompleteHandler(): RequestHandler {
  return (req, res) => {
    // CORS: only allow marketplace origin
    const origin = req.headers.origin;
    if (origin === MARKETPLACE_URL) {
      res.setHeader("Access-Control-Allow-Origin", MARKETPLACE_URL);
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    const { session, token } = req.body || {};
    if (!session || !token) {
      res.status(400).json({ error: "Missing session or token" });
      return;
    }

    const pending = pendingSessions.get(session);
    if (!pending) {
      res.status(404).json({ error: "Session not found or expired" });
      return;
    }

    // Verify the token is valid before storing
    const verified = verifyWalletToken(token);
    if (!verified) {
      res.status(400).json({ error: "Invalid wallet token" });
      return;
    }

    // Store token on pending session
    pending.token = token;

    res.json({ ok: true });
  };
}

/**
 * GET /oauth/callback
 * Browser redirect from marketplace after login.
 * Looks up pending session, creates auth code, redirects to Claude's callback URL.
 */
export function oauthCallbackHandler(): RequestHandler {
  return (req, res) => {
    const sessionId = req.query.session as string | undefined;
    if (!sessionId) {
      res.status(400).json({ error: "Missing session parameter" });
      return;
    }

    const pending = pendingSessions.get(sessionId);
    if (!pending) {
      res.status(404).json({ error: "Session not found or expired" });
      return;
    }

    if (!pending.token) {
      res.status(400).json({ error: "Authorization not yet completed — token not received" });
      return;
    }

    // Create single-use auth code
    const code = randomBytes(32).toString("hex");
    authCodes.set(code, {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      token: pending.token,
      createdAt: Date.now(),
    });

    // Clean up pending session
    pendingSessions.delete(sessionId);

    // Redirect to Claude's callback URL with code and state
    const redirectUrl = new URL(pending.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (pending.state) {
      redirectUrl.searchParams.set("state", pending.state);
    }

    res.redirect(redirectUrl.toString());
  };
}
