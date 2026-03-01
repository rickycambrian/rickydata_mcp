/**
 * Wallet Token Verification
 *
 * Stateless verification of mcpwt_ tokens via ecrecover.
 * Token format: mcpwt_<base64url(JSON)>
 * Compatible with tokens from https://mcpmarketplace.rickydata.org/auth/cli
 */

import { ethers } from 'ethers';

export const WALLET_TOKEN_PREFIX = 'mcpwt_';

const TOKEN_MESSAGE_REGEX =
  /^(MCP (?:Gateway|Platform) Auth)\nWallet: (0x[a-fA-F0-9]{40})\nExpires: (.+)$/;

const PLATFORM_TOKEN_MESSAGE_PREFIX = 'MCP Platform Auth';
const LEGACY_TOKEN_MESSAGE_PREFIX = 'MCP Gateway Auth';

interface WalletTokenPayload {
  v: number;
  wallet: string;
  exp: number;
  msg: string;
  sig: string;
}

function buildTokenMessageWithPrefix(prefix: string, walletAddress: string, expiresAt: string): string {
  const checksummed = ethers.getAddress(walletAddress);
  const normalizedPrefix = prefix === LEGACY_TOKEN_MESSAGE_PREFIX ? LEGACY_TOKEN_MESSAGE_PREFIX : PLATFORM_TOKEN_MESSAGE_PREFIX;
  return `${normalizedPrefix}\nWallet: ${checksummed}\nExpires: ${expiresAt}`;
}

export function verifyWalletToken(token: string): { walletAddress: string } | null {
  if (!token.startsWith(WALLET_TOKEN_PREFIX)) return null;

  try {
    const json = Buffer.from(token.slice(WALLET_TOKEN_PREFIX.length), 'base64url').toString();
    const payload: WalletTokenPayload = JSON.parse(json);

    if (
      typeof payload.v !== 'number' ||
      typeof payload.wallet !== 'string' ||
      typeof payload.exp !== 'number' ||
      typeof payload.msg !== 'string' ||
      typeof payload.sig !== 'string'
    ) {
      return null;
    }

    if (payload.v !== 1) return null;

    const match = payload.msg.match(TOKEN_MESSAGE_REGEX);
    if (!match) return null;

    const signedPrefix = match[1];
    const signedWallet = ethers.getAddress(match[2]);
    const signedExpiry = Math.floor(new Date(match[3]).getTime() / 1000);
    if (!Number.isFinite(signedExpiry)) return null;

    const recovered = ethers.verifyMessage(payload.msg, payload.sig);
    const checksummedRecovered = ethers.getAddress(recovered);
    const checksummedClaimed = ethers.getAddress(payload.wallet);
    if (checksummedClaimed !== signedWallet) return null;
    if (checksummedRecovered !== checksummedClaimed) return null;
    if (payload.exp !== signedExpiry) return null;
    if (payload.exp < Date.now() / 1000) return null;
    if (payload.msg !== buildTokenMessageWithPrefix(signedPrefix, checksummedClaimed, match[3])) return null;

    return { walletAddress: checksummedClaimed.toLowerCase() };
  } catch {
    return null;
  }
}
