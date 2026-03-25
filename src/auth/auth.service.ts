import { Injectable } from '@nestjs/common';
import {
  UnauthorizedException,
  InvalidCredentialsException,
  TokenExpiredException,
  InvalidInputException,
  UserNotFoundException,
} from '../common/errors/custom.exceptions';
import { UserService } from '../users/user.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { CreateUserDto } from '../users/dto/create-user.dto';
import * as bcrypt from 'bcrypt';
import { RedisService } from '../common/services/redis.service';
import { v4 as uuidv4 } from 'uuid';
import { StructuredLoggerService } from '../common/logging/logger.service';
import { JwtPayload, SessionInfo } from './auth.types';
import { JWT_TOKEN_USE, tokenRevocationRedisKeys } from './constants';
import { createHash } from 'crypto';

/**
 * Auth Service
 *
 * Handles all authentication operations including:
 * - User registration and email verification
 * - Email/Password and Web3 wallet login
 * - JWT Token generation and rotation
 * - Session management and invalidation
 *
 * @class AuthService
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
    private readonly logger: StructuredLoggerService,
  ) {
    this.logger.setContext('AuthService');
  }

  /**
   * Register a new user and send verification email
   *
   * @param {CreateUserDto} createUserDto - The user registration data
   * @returns {Promise<{message: string}>} Success message
   *
   * @example
   * ```typescript
   * const result = await authService.register({
   *   email: 'dev@propchain.com',
   *   password: 'Password123!',
   *   firstName: 'Prop',
   *   lastName: 'Chain'
   * });
   * ```
   */
  async register(createUserDto: CreateUserDto) {
    try {
      const user = await this.userService.create(createUserDto);
      await this.sendVerificationEmail(user.id, user.email);
      this.logger.logAuth('User registration successful', { userId: user.id });
      return {
        message: 'User registered successfully. Please check your email for verification.',
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      this.logger.error('User registration failed', errorMessage, {
        email: createUserDto.email,
      });
      throw error;
    }
  }

  /**
   * Authenticate a user and generate JWT tokens
   *
   * Supports both email/password and Web3 wallet address/signature.
   * Implements login attempt tracking for brute-force protection.
   *
   * @param {Object} credentials - The credentials to authenticate
   * @param {Object} [requestMeta] - Request metadata for session fingerprinting
   * @returns {Promise<AuthResponse>} The generated tokens and user info
   *
   * @example
   * ```typescript
   * // Email login
   * const auth = await authService.login({
   *   email: 'dev@propchain.com',
   *   password: 'Password123!'
   * });
   *
   * // Web3 login
   * const auth = await authService.login({
   *   walletAddress: '0x123...',
   *   signature: '0xabc...'
   * });
   * ```
   */
  async login(
    credentials: { email?: string; password?: string; walletAddress?: string; signature?: string },
    requestMeta?: { ip?: string; userAgent?: string },
  ) {
    let user: any;

    // brute force protection
    const identifier = credentials.email || credentials.walletAddress;
    const maxAttempts = this.configService.get<number>('MAX_LOGIN_ATTEMPTS', 5);
    const attemptWindow = this.configService.get<number>('LOGIN_ATTEMPT_WINDOW', 600); // seconds
    const attemptsKey = identifier ? `login_attempts:${identifier}` : null;

    if (attemptsKey) {
      const existing = await this.redisService.get(attemptsKey);
      const attempts = parseInt(existing || '0', 10);
      if (attempts >= maxAttempts) {
        this.logger.warn('Too many login attempts', { identifier });
        throw new UnauthorizedException('Too many login attempts. Please try again later.');
      }
    }

    try {
      if (credentials.email && credentials.password) {
        user = await this.validateUserByEmail(credentials.email, credentials.password);
      } else if (credentials.walletAddress) {
        user = await this.validateUserByWallet(credentials.walletAddress, credentials.signature);
      } else {
        throw new InvalidInputException(undefined, 'Email/password or wallet address/signature required');
      }

      if (!user) {
        this.logger.warn('Invalid login attempt', { email: credentials.email });
        // increment attempt count only for email-based logins
        if (attemptsKey) {
          const existing = await this.redisService.get(attemptsKey);
          const attempts = parseInt(existing || '0', 10) + 1;
          await this.redisService.setex(attemptsKey, attemptWindow, attempts.toString());
        }
        throw new InvalidCredentialsException();
      }

      // successful login, clear attempts
      if (attemptsKey) {
        await this.redisService.del(attemptsKey);
      }

      this.logger.logAuth('User login successful', { userId: user.id });
      return this.generateTokens(user, requestMeta);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      this.logger.error('User login failed', errorMessage, {
        email: credentials.email,
      });
      throw error;
    }
  }

  async validateUserByEmail(email: string, password: string): Promise<any> {
    const user = await this.userService.findByEmail(email);

    if (!user || !user.password) {
      this.logger.warn('Email validation failed: User not found', { email });
      throw new InvalidCredentialsException();
    }

    const isPasswordValid = await bcrypt.compare(password, user.password as string);
    if (!isPasswordValid) {
      this.logger.warn('Email validation failed: Invalid password', { email });
      throw new InvalidCredentialsException();
    }

    const { password: _, ...result } = user as any;
    return result;
  }

  async validateUserByWallet(walletAddress: string, signature?: string): Promise<any> {
    let user = await this.userService.findByWalletAddress(walletAddress);

    if (!user) {
      user = await this.userService.create({
        email: `${walletAddress}@wallet.auth`,
        password: Math.random().toString(36).slice(-10),
        walletAddress,
        firstName: 'Web3',
        lastName: 'User',
      });
      this.logger.logAuth('New Web3 user created', { walletAddress });
    }

    const { password: _, ...result } = user as any;
    return result;
  }

  async refreshToken(refreshToken: string, requestMeta?: { ip?: string; userAgent?: string }) {
    try {
      const payload = (await this.jwtService.verifyAsync(refreshToken, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      })) as JwtPayload;

      if (payload.tokenUse !== JWT_TOKEN_USE.REFRESH || !payload.rid) {
        this.logger.warn('Refresh token validation failed: wrong token type', { userId: payload.sub });
        throw new TokenExpiredException('Invalid refresh token');
      }

      const user = (await this.userService.findById(payload.sub)) as { id: string; email: string; [key: string]: any };
      if (!user) {
        this.logger.warn('Refresh token validation failed: User not found', {
          userId: payload.sub,
        });
        throw new UserNotFoundException(payload.sub);
      }

      const refreshSessionData = await this.redisService.get(tokenRevocationRedisKeys.refreshSession(payload.rid));
      if (!refreshSessionData) {
        this.logger.warn('Refresh token validation failed: missing refresh session', { userId: payload.sub });
        throw new TokenExpiredException('Invalid refresh token');
      }

      const refreshSession = JSON.parse(refreshSessionData) as {
        userId: string;
        sessionId: string;
        fingerprint: string;
      };
      const currentRid = await this.redisService.get(tokenRevocationRedisKeys.userRefreshSession(payload.sub));

      if (refreshSession.userId !== payload.sub || currentRid !== payload.rid) {
        this.logger.warn('Refresh token validation failed: revoked or rotated', { userId: payload.sub });
        throw new TokenExpiredException('Invalid refresh token');
      }

      const existingSession = await this.getSessionById(payload.sub, refreshSession.sessionId);
      if (!existingSession) {
        this.logger.warn('Refresh token validation failed: session missing', { userId: payload.sub });
        throw new TokenExpiredException('Invalid refresh token');
      }

      this.assertFingerprintMatches(existingSession, requestMeta);
      await this.invalidateSession(payload.sub, refreshSession.sessionId);

      this.logger.logAuth('Token refreshed successfully', { userId: user.id });
      return this.generateTokens(user, requestMeta);
    } catch (error) {
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error('Token refresh failed', stack);
      throw new TokenExpiredException('Invalid refresh token');
    }
  }

  async logout(userId: string, accessToken?: string) {
    // Blacklist the current access token
    if (accessToken) {
      const tokenPayload = await this.jwtService.decode(accessToken);
      if (tokenPayload && typeof tokenPayload === 'object' && 'jti' in tokenPayload) {
        const jti = tokenPayload.jti;
        const expiry = tokenPayload.exp;
        if (jti && expiry) {
          const ttl = expiry - Math.floor(Date.now() / 1000);
          if (ttl > 0) {
            await this.redisService.setex(tokenRevocationRedisKeys.accessRevoked(jti), ttl, userId);
            this.logger.logAuth('Access token blacklisted', { userId, jti });
          }
        }
      }
    }

    // === REFRESH TOKEN REVOCATION ===
    // Prevents token refresh even if JWT signature is still valid

    if (accessToken) {
      const tokenPayload = this.jwtService.decode(accessToken) as JwtPayload | null;
      if (tokenPayload?.sid) {
        await this.invalidateSession(userId, tokenPayload.sid);
      }
    } else {
      await this.clearRefreshSessionForUser(userId);
    }
    this.logger.logAuth('User logged out successfully', { userId });
    return { message: 'Logged out successfully' };
  }

  async forgotPassword(email: string) {
    const user = (await this.userService.findByEmail(email)) as {
      id: string;
      email: string;
      [key: string]: any;
    } | null;
    if (!user) {
      this.logger.log('Forgot password request for non-existent user', { email });
      return { message: 'If email exists, a reset link has been sent' };
    }

    const resetToken = uuidv4();
    const resetTokenExpiry = Date.now() + 3600000; // 1 hour

    // Save reset token and expiry in Redis
    await this.redisService.set(
      `password_reset:${resetToken}`,
      JSON.stringify({ userId: user.id, expiry: resetTokenExpiry }),
    );

    await this.sendPasswordResetEmail(user.email, resetToken);
    this.logger.log('Password reset email sent', { email });
    return { message: 'If email exists, a reset link has been sent' };
  }

  async resetPassword(resetToken: string, newPassword: string) {
    const resetData = await this.redisService.get(`password_reset:${resetToken}`);

    if (!resetData) {
      this.logger.warn('Invalid or expired password reset token received');
      throw new InvalidInputException(undefined, 'Invalid or expired reset token');
    }

    const { userId, expiry } = JSON.parse(resetData);

    if (Date.now() > expiry) {
      await this.redisService.del(`password_reset:${resetToken}`);
      this.logger.warn('Expired password reset token used', { userId });
      throw new InvalidInputException(undefined, 'Reset token has expired');
    }

    await this.userService.updatePassword(userId, newPassword);
    await this.redisService.del(`password_reset:${resetToken}`);
    await this.invalidateAllSessions(userId);

    this.logger.log('Password reset successfully', { userId });
    return { message: 'Password reset successfully' };
  }

  async verifyEmail(token: string) {
    const verificationData = await this.redisService.get(`email_verification:${token}`);

    if (!verificationData) {
      this.logger.warn('Invalid or expired email verification token');
      throw new InvalidInputException(undefined, 'Invalid or expired verification token');
    }

    const { userId } = JSON.parse(verificationData);
    await this.userService.verifyUser(userId);
    await this.redisService.del(`email_verification:${token}`);

    this.logger.log('Email verified successfully', { userId });
    return { message: 'Email verified successfully' };
  }

  /**
   * Access-token revocation list (Redis). Entries use TTL so the key expires with the JWT.
   */
  async isTokenBlacklisted(jti: string): Promise<boolean> {
    const blacklisted = await this.redisService.get(tokenRevocationRedisKeys.accessRevoked(jti));
    return blacklisted !== null;
  }

  async getActiveSessions(userId: string): Promise<any[]> {
    const sessionKeys = await this.redisService.keys(`active_session:${userId}:*`);
    const sessions = [];

    for (const key of sessionKeys) {
      const sessionData = await this.redisService.get(key);
      if (sessionData) {
        sessions.push(JSON.parse(sessionData));
      }
    }

    return sessions;
  }

  async getSessionById(userId: string, sessionId: string): Promise<SessionInfo | null> {
    const sessionData = await this.redisService.get(tokenRevocationRedisKeys.activeSession(userId, sessionId));
    return sessionData ? JSON.parse(sessionData) : null;
  }

  async getAllUserSessions(userId: string): Promise<any[]> {
    const sessions = await this.getActiveSessions(userId);
    return sessions.map(session => ({
      ...session,
      isActive: true,
      expiresIn: this.getSessionExpiry(session.lastActivity || session.createdAt),
    }));
  }

  async invalidateAllSessions(userId: string): Promise<void> {
    const sessionKeys = await this.redisService.keys(`active_session:${userId}:*`);
    for (const key of sessionKeys) {
      const sessionData = await this.redisService.get(key);
      if (sessionData) {
        const session = JSON.parse(sessionData) as SessionInfo;
        await this.redisService.del(tokenRevocationRedisKeys.accessSession(session.jti));
        await this.redisService.del(tokenRevocationRedisKeys.refreshSession(session.refreshSessionId));
      }
      await this.redisService.del(key);
    }
    await this.clearRefreshSessionForUser(userId);
    this.logger.logAuth('All sessions invalidated', { userId });
  }

  async getConcurrentSessions(userId: string): Promise<number> {
    const sessions = await this.getActiveSessions(userId);
    return sessions.length;
  }

  private getSessionExpiry(createdAt: string): number {
    const created = new Date(createdAt);
    const sessionTimeout = this.configService.get<number>('SESSION_TIMEOUT', 3600) * 1000;
    const expiry = created.getTime() + sessionTimeout;
    return Math.max(0, expiry - Date.now());
  }

  async invalidateSession(userId: string, sessionId: string): Promise<void> {
    const session = await this.getSessionById(userId, sessionId);
    if (session) {
      await this.redisService.del(tokenRevocationRedisKeys.accessSession(session.jti));
      await this.redisService.del(tokenRevocationRedisKeys.refreshSession(session.refreshSessionId));
      const currentRid = await this.redisService.get(tokenRevocationRedisKeys.userRefreshSession(userId));
      if (currentRid === session.refreshSessionId) {
        await this.redisService.del(tokenRevocationRedisKeys.userRefreshSession(userId));
      }
      const ttl = this.getSessionExpiry(session.lastActivity || session.createdAt);
      if (ttl > 0) {
        await this.redisService.setex(
          tokenRevocationRedisKeys.accessRevoked(session.jti),
          Math.ceil(ttl / 1000),
          userId,
        );
      }
    }
    await this.redisService.del(tokenRevocationRedisKeys.activeSession(userId, sessionId));
    this.logger.logAuth('Session invalidated', { userId, sessionId });
  }

  async validateActiveSession(
    userId: string,
    jti: string,
    sessionId: string,
    requestMeta?: { ip?: string; userAgent?: string },
  ): Promise<SessionInfo> {
    const mappedSessionId = await this.redisService.get(tokenRevocationRedisKeys.accessSession(jti));
    if (!mappedSessionId || mappedSessionId !== sessionId) {
      throw new UnauthorizedException('Session is no longer active');
    }

    const session = await this.getSessionById(userId, sessionId);
    if (!session || session.jti !== jti) {
      throw new UnauthorizedException('Session is no longer active');
    }

    const absoluteExpiry = session.absoluteExpiresAt ? new Date(session.absoluteExpiresAt).getTime() : 0;
    if (absoluteExpiry && absoluteExpiry <= Date.now()) {
      await this.invalidateSession(userId, sessionId);
      throw new UnauthorizedException('Session has expired');
    }

    this.assertFingerprintMatches(session, requestMeta);

    const idleTimeoutSeconds = this.configService.get<number>('SESSION_TIMEOUT', 3600);
    const lastActivity = new Date(session.lastActivity || session.createdAt).getTime();
    if (Date.now() - lastActivity > idleTimeoutSeconds * 1000) {
      await this.invalidateSession(userId, sessionId);
      throw new UnauthorizedException('Session has expired');
    }

    const updatedSession: SessionInfo = {
      ...session,
      lastActivity: new Date().toISOString(),
      ip: requestMeta?.ip || session.ip,
      userAgent: requestMeta?.userAgent || session.userAgent,
    };

    await this.persistSession(updatedSession);
    return updatedSession;
  }

  private async clearRefreshSessionForUser(userId: string): Promise<void> {
    const rid = await this.redisService.get(tokenRevocationRedisKeys.userRefreshSession(userId));
    if (rid) {
      await this.redisService.del(tokenRevocationRedisKeys.refreshSession(rid));
    }
    await this.redisService.del(tokenRevocationRedisKeys.userRefreshSession(userId));
  }

  private refreshSessionTtlSeconds(refreshToken: string): number {
    const decoded = this.jwtService.decode(refreshToken) as { exp?: number } | null;
    if (!decoded?.exp) {
      return 0;
    }
    return Math.max(0, decoded.exp - Math.floor(Date.now() / 1000));
  }

  private async generateTokens(user: any, requestMeta?: { ip?: string; userAgent?: string }) {
    await this.clearRefreshSessionForUser(user.id);

    const jti = uuidv4();
    const sessionId = uuidv4();
    const refreshSessionId = uuidv4();

    const accessPayload: JwtPayload = {
      sub: user.id,
      email: user.email,
      jti,
      sid: sessionId,
      tokenUse: JWT_TOKEN_USE.ACCESS,
    };

    const refreshPayload: JwtPayload = {
      sub: user.id,
      email: user.email,
      sid: sessionId,
      rid: refreshSessionId,
      tokenUse: JWT_TOKEN_USE.REFRESH,
    };

    const accessToken = this.jwtService.sign(accessPayload, {
      secret: this.configService.get<string>('JWT_SECRET'),
      expiresIn: this.configService.get<string>('JWT_EXPIRES_IN', '15m') as any,
    });

    const refreshToken = this.jwtService.sign(refreshPayload, {
      secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      expiresIn: this.configService.get<string>('JWT_REFRESH_EXPIRES_IN', '7d') as any,
    });

    let refreshTtl = this.refreshSessionTtlSeconds(refreshToken);
    if (refreshTtl <= 0) {
      refreshTtl = 7 * 24 * 60 * 60;
    }
    const sessionMeta = this.buildSessionInfo(user.id, sessionId, jti, refreshSessionId, requestMeta);
    await this.redisService.setex(
      tokenRevocationRedisKeys.refreshSession(refreshSessionId),
      refreshTtl,
      JSON.stringify({
        userId: user.id,
        sessionId,
        fingerprint: sessionMeta.fingerprint,
      }),
    );
    await this.redisService.setex(tokenRevocationRedisKeys.userRefreshSession(user.id), refreshTtl, refreshSessionId);

    const sessionExpiry = this.configService.get<number>('SESSION_TIMEOUT', 3600);
    await this.redisService.setex(tokenRevocationRedisKeys.accessSession(jti), sessionExpiry, sessionId);
    await this.persistSession(sessionMeta);

    this.logger.debug('Generated new tokens for user', { userId: user.id, jti, refreshSessionId, sessionId });

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      user: {
        id: user.id,
        email: user.email,
        walletAddress: user.walletAddress,
        isVerified: user.isVerified,
      },
    };
  }

  private async sendVerificationEmail(userId: string, email: string) {
    const verificationToken = uuidv4();

    // Save token in Redis
    const expiry = Date.now() + 3600000; // 1 hour
    await this.redisService.set(`email_verification:${verificationToken}`, JSON.stringify({ userId, expiry }));

    // Import EmailService and send actual email
    const { EmailService } = await import('../communication/email/email.service');
    const emailService = new EmailService(this.configService, null, null, null);

    await emailService.sendTemplatedEmail(email, 'email-verification', {
      firstName: email.split('@')[0], // Extract name from email for personalization
      verificationUrl: `${this.configService.get<string>('BASE_URL')}/auth/verify-email/${verificationToken}`,
    });

    this.logger.log(`Verification email sent to ${email}`, { userId });
    this.logger.debug(`Verification token generated for ${email}`, { userId });
  }

  private async sendPasswordResetEmail(email: string, resetToken: string) {
    // Import EmailService and send actual email
    const { EmailService } = await import('../communication/email/email.service');
    const emailService = new EmailService(this.configService, null, null, null);

    await emailService.sendTemplatedEmail(email, 'password-reset', {
      firstName: email.split('@')[0], // Extract name from email for personalization
      resetUrl: `${this.configService.get<string>('BASE_URL')}/auth/reset-password/${resetToken}`,
    });

    this.logger.log(`Password reset email sent to ${email}`);
    this.logger.debug(`Password reset token generated for ${email}`);
  }

  private buildSessionInfo(
    userId: string,
    sessionId: string,
    jti: string,
    refreshSessionId: string,
    requestMeta?: { ip?: string; userAgent?: string },
  ): SessionInfo {
    const now = new Date();
    const absoluteLifetimeSeconds = this.configService.get<number>('SESSION_ABSOLUTE_TIMEOUT', 86400);

    return {
      sessionId,
      userId,
      jti,
      refreshSessionId,
      createdAt: now.toISOString(),
      lastActivity: now.toISOString(),
      userAgent: requestMeta?.userAgent || 'unknown',
      ip: requestMeta?.ip || 'unknown',
      absoluteExpiresAt: new Date(now.getTime() + absoluteLifetimeSeconds * 1000).toISOString(),
      fingerprint: this.buildFingerprint(requestMeta),
    };
  }

  private async persistSession(session: SessionInfo): Promise<void> {
    const sessionExpiry = this.configService.get<number>('SESSION_TIMEOUT', 3600);
    await this.redisService.setex(
      tokenRevocationRedisKeys.activeSession(session.userId, session.sessionId),
      sessionExpiry,
      JSON.stringify(session),
    );
    await this.redisService.setex(
      tokenRevocationRedisKeys.accessSession(session.jti),
      sessionExpiry,
      session.sessionId,
    );
  }

  private buildFingerprint(requestMeta?: { ip?: string; userAgent?: string }): string {
    const source = `${requestMeta?.ip || 'unknown'}|${requestMeta?.userAgent || 'unknown'}`;
    return createHash('sha256').update(source).digest('hex');
  }

  private assertFingerprintMatches(session: SessionInfo, requestMeta?: { ip?: string; userAgent?: string }): void {
    if (!session.fingerprint) {
      return;
    }

    const requestFingerprint = this.buildFingerprint(requestMeta);
    if (requestFingerprint !== session.fingerprint) {
      throw new UnauthorizedException('Session validation failed');
    }
  }
}
