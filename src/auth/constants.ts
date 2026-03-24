export const jwtConstants = {
  secret: process.env.JWT_SECRET || 'default_secret_for_development',
};

/** Access vs refresh JWT claim; prevents using an access JWT on the refresh endpoint. */
export const JWT_TOKEN_USE = {
  ACCESS: 'access',
  REFRESH: 'refresh',
} as const;

/**
 * Redis keys for token revocation: access-token denylist (by jti) and refresh rotation (by session id).
 */
export const tokenRevocationRedisKeys = {
  accessRevoked: (jti: string) => `blacklisted_token:${jti}`,
  refreshSession: (refreshSessionId: string) => `refresh_session:${refreshSessionId}`,
  userRefreshSession: (userId: string) => `user_refresh_rid:${userId}`,
} as const;
