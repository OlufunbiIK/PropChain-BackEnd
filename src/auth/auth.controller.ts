import { Controller, Post, Body, Req, Get, UseGuards, HttpCode, HttpStatus, Put, Param, Delete } from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { LoginAttemptsGuard } from './guards/login-attempts.guard';
import { CreateUserDto } from '../users/dto/create-user.dto';
import {
  LoginDto,
  LoginWeb3Dto,
  RefreshTokenDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  VerifyEmailParamsDto,
} from './dto';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { Request } from 'express';
import { ErrorResponseDto } from '../common/errors/error.dto';
import { ApiStandardErrorResponse } from '../common/errors/api-standard-error-response.decorator';
import { SensitiveEndpointRateLimitGuard } from '../security/guards/sensitive-endpoint-rate-limit.guard';
import { SensitiveRateLimit } from '../security/decorators/sensitive-rate-limit.decorator';

/**
 * AuthController
 *
 * Handles all authentication endpoints including user registration, login (traditional and Web3),
 * token management, password reset, email verification, and session management.
 *
 * All endpoints that require authentication are protected with JwtAuthGuard.
 * Login attempts are rate-limited to prevent brute-force attacks.
 */
@ApiTags('authentication')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  /**
   * Register a new user account
   *
   * Creates a new user with email and password credentials. Validates password strength
   * and checks for duplicate email addresses. Sends verification email upon success.
   *
   * @param {CreateUserDto} createUserDto - User registration data
   * @returns {Promise<{message: string}>} Success message with verification instructions
   *
   * @example
   * ```json
   * {
   *   "email": "user@example.com",
   *   "password": "SecurePass123!",
   *   "firstName": "John",
   *   "lastName": "Doe"
   * }
   * ```
   */
  @Post('register')
  @ApiOperation({
    summary: 'Register a new user account',
    description:
      'Creates a new user account with email/password. Sends verification email. Password must be at least 8 characters with uppercase, lowercase, number, and special character.',
  })
  @ApiResponse({
    status: 201,
    description: 'User registered successfully. Verification email sent.',
    schema: {
      properties: {
        message: { type: 'string', example: 'User registered successfully. Please check your email for verification.' },
      },
    },
  })
  @ApiStandardErrorResponse([400, 409])
  async register(@Body() createUserDto: CreateUserDto) {
    return this.authService.register(createUserDto);
  }

  /**
   * Authenticate user with email and password
   *
   * Traditional email/password authentication. Enforces rate limiting after failed attempts.
   * Returns JWT access token (short-lived) and refresh token (long-lived).
   *
   * @param {LoginDto} loginDto - Email and password credentials
   * @param {Request} req - Express request object
   * @returns {Promise<{access_token: string, refresh_token: string, user: object}>} Auth tokens
   */
  @Post('login')
  @UseGuards(LoginAttemptsGuard)
  @ApiOperation({
    summary: 'Login with email and password',
    description:
      'Authenticates user with email and password. Returns access token (valid 15m) and refresh token (valid 7d). Rate limit: 5 attempts per 10 minutes.',
  })
  @ApiResponse({
    status: 200,
    description: 'Login successful.',
    schema: {
      properties: {
        access_token: { type: 'string', description: 'JWT access token for API requests' },
        refresh_token: { type: 'string', description: 'JWT refresh token for obtaining new access tokens' },
        user: { type: 'object', description: 'User information' },
      },
    },
  })
  @ApiStandardErrorResponse([400, 401])
  @HttpCode(HttpStatus.OK)
  async login(@Body() loginDto: LoginDto, @Req() req: Request) {
    return this.authService.login({
      email: loginDto.email,
      password: loginDto.password,
    });
  }

  /**
   * Web3 wallet authentication
   *
   * Authenticates user via blockchain wallet address and signature.
   * Automatically creates account for new wallet addresses (JIT provisioning).
   *
   * @param {LoginWeb3Dto} loginDto - Wallet address and signature
   * @returns {Promise<{access_token: string, refresh_token: string, user: object}>} Auth tokens
   */
  @Post('web3-login')
  @ApiOperation({
    summary: 'Web3 wallet login',
    description:
      'Authenticates user via blockchain wallet signature. Creates account automatically if wallet not registered. Supports Ethereum-based networks.',
  })
  @ApiResponse({
    status: 200,
    description: 'Web3 login successful.',
    schema: {
      properties: {
        access_token: { type: 'string' },
        refresh_token: { type: 'string' },
        user: { type: 'object' },
      },
    },
  })
  @ApiStandardErrorResponse([401])
  @HttpCode(HttpStatus.OK)
  async web3Login(@Body() loginDto: LoginWeb3Dto) {
    return this.authService.login({
      walletAddress: loginDto.walletAddress,
      signature: loginDto.signature,
    });
  }

  /**
   * Refresh access token
   *
   * Exchanges an expired or expiring access token for a new one using a refresh token.
   * Implements token rotation for enhanced security.
   *
   * @param {RefreshTokenDto} refreshTokenDto - Refresh token
   * @returns {Promise<{access_token: string, refresh_token: string}>} New token pair
   */
  @Post('refresh-token')
  @UseGuards(SensitiveEndpointRateLimitGuard)
  @SensitiveRateLimit({
    windowMs: 60000,
    maxRequests: 10,
    keyPrefix: 'token_refresh',
    enableProgressiveDelay: false,
    blockOnExceed: false,
  })
  @ApiOperation({
    summary: 'Refresh access token',
    description:
      'Exchanges refresh token for new access token. Implements token rotation. Rate limit: 10 requests per minute.',
  })
  @ApiResponse({
    status: 200,
    description: 'Token refreshed successfully.',
    schema: {
      properties: {
        access_token: { type: 'string' },
        refresh_token: { type: 'string' },
        user: { type: 'object' },
      },
    },
  })
  @ApiStandardErrorResponse([401])
  @HttpCode(HttpStatus.OK)
  async refreshToken(@Body() refreshTokenDto: RefreshTokenDto) {
    return this.authService.refreshToken(refreshTokenDto.refreshToken);
  }

  /**
   * Logout user
   *
   * Invalidates current session by blacklisting access token and revoking refresh token.
   * Requires authentication with valid JWT token.
   *
   * @param {Request} req - Express request with user context
   * @returns {Promise<{message: string}>} Logout confirmation
   */
  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Logout current user',
    description: 'Invalidates current session by blacklisting tokens. Requires valid access token.',
  })
  @ApiResponse({
    status: 200,
    description: 'Logged out successfully.',
    schema: {
      properties: {
        message: { type: 'string', example: 'Logged out successfully' },
      },
    },
  })
  @ApiStandardErrorResponse([401])
  @HttpCode(HttpStatus.OK)
  async logout(@Req() req: Request) {
    const user = req['user'] as any;
    const authHeader = req.headers['authorization'];
    const accessToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : undefined;
    return this.authService.logout(user.id, accessToken);
  }

  /**
   * Request password reset
   *
   * Initiates password reset flow by sending reset link to user email.
   * Returns generic message regardless of email existence to prevent enumeration.
   *
   * @param {ForgotPasswordDto} forgotPasswordDto - User email address
   * @returns {Promise<{message: string}>} Generic success message
   */
  @Post('forgot-password')
  @UseGuards(SensitiveEndpointRateLimitGuard)
  @SensitiveRateLimit({
    windowMs: 900000,
    maxRequests: 3,
    keyPrefix: 'password_reset',
    enableProgressiveDelay: true,
    blockOnExceed: true,
    blockDurationMs: 1800000,
  })
  @ApiOperation({
    summary: 'Request password reset email',
    description:
      'Sends password reset link to user email. Returns generic message for security. Rate limit: 3 requests per 15 minutes.',
  })
  @ApiResponse({
    status: 200,
    description: 'Password reset email sent (if email exists).',
    schema: {
      properties: {
        message: { type: 'string', example: 'If email exists, a reset link has been sent' },
      },
    },
  })
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() forgotPasswordDto: ForgotPasswordDto) {
    return this.authService.forgotPassword(forgotPasswordDto.email);
  }

  /**
   * Reset password with token
   *
   * Completes password reset using token from email. Validates token hasn't expired.
   * New password must meet strength requirements.
   *
   * @param {ResetPasswordDto} resetPasswordDto - Reset token and new password
   * @returns {Promise<{message: string}>} Success message
   */
  @Put('reset-password')
  @UseGuards(SensitiveEndpointRateLimitGuard)
  @SensitiveRateLimit({
    windowMs: 900000,
    maxRequests: 5,
    keyPrefix: 'password_reset_confirm',
    enableProgressiveDelay: true,
    blockOnExceed: true,
    blockDurationMs: 3600000,
  })
  @ApiOperation({
    summary: 'Reset password using reset token',
    description:
      'Sets new password using token from password reset email. Token valid for 1 hour. Rate limit: 5 requests per 15 minutes.',
  })
  @ApiResponse({
    status: 200,
    description: 'Password reset successfully.',
    schema: {
      properties: {
        message: { type: 'string', example: 'Password reset successfully' },
      },
    },
  })
  @ApiStandardErrorResponse([400])
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() resetPasswordDto: ResetPasswordDto) {
    return this.authService.resetPassword(resetPasswordDto.token, resetPasswordDto.newPassword);
  }

  /**
   * Verify email address
   *
   * Marks user email as verified using token from verification email.
   * Token expires after 1 hour.
   *
   * @param {VerifyEmailParamsDto} params - Email verification token
   * @returns {Promise<{message: string}>} Verification success message
   */
  @Get('verify-email/:token')
  @ApiOperation({
    summary: 'Verify email address',
    description: 'Confirms email ownership using token from verification email. Token valid for 1 hour.',
  })
  @ApiResponse({
    status: 200,
    description: 'Email verified successfully.',
    schema: {
      properties: {
        message: { type: 'string', example: 'Email verified successfully' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid, expired, or already-used verification token.',
    type: ErrorResponseDto,
  })
  @ApiStandardErrorResponse([400])
  async verifyEmail(@Param() params: VerifyEmailParamsDto) {
    return this.authService.verifyEmail(params.token);
  }

  /**
   * Get all active sessions
   *
   * Returns list of all active sessions for authenticated user.
   * Requires valid JWT access token.
   *
   * @param {Request} req - Express request with user context
   * @returns {Promise<Array>} List of active sessions with metadata
   */
  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get all active sessions for current user',
    description: 'Lists all active sessions with IP, user agent, and expiration time.',
  })
  @ApiResponse({
    status: 200,
    description: 'Sessions retrieved successfully.',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          userId: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
          userAgent: { type: 'string' },
          ip: { type: 'string' },
          expiresIn: { type: 'number' },
        },
      },
    },
  })
  @ApiStandardErrorResponse([401])
  @HttpCode(HttpStatus.OK)
  async getSessions(@Req() req: Request) {
    const user = req['user'] as any;
    return this.authService.getAllUserSessions(user.id);
  }

  /**
   * Invalidate specific session
   *
   * Logs out a specific session by session ID. Useful for remote logout
   * of specific devices without affecting other sessions.
   *
   * @param {Request} req - Express request with user context
   * @param {string} sessionId - ID of session to invalidate
   * @returns {Promise<{message: string}>} Success confirmation
   */
  @Delete('sessions/:sessionId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Invalidate a specific session',
    description: 'Logs out a specific device/session without affecting other user sessions.',
  })
  @ApiResponse({
    status: 200,
    description: 'Session invalidated successfully.',
    schema: {
      properties: {
        message: { type: 'string', example: 'Session invalidated successfully' },
      },
    },
  })
  @ApiStandardErrorResponse([401])
  @HttpCode(HttpStatus.OK)
  async invalidateSession(@Req() req: Request, @Param('sessionId') sessionId: string) {
    const user = req['user'] as any;
    await this.authService.invalidateSession(user.id, sessionId);
    return { message: 'Session invalidated successfully' };
  }

  /**
   * Invalidate all sessions
   *
   * Logs out all sessions for the authenticated user.
   * Useful for account security after password change or suspected breach.
   *
   * @param {Request} req - Express request with user context
   * @returns {Promise<{message: string}>} Success confirmation
   */
  @Delete('sessions')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Invalidate all sessions for current user',
    description: 'Logs out all devices/sessions. Useful after password change or security incident.',
  })
  @ApiResponse({
    status: 200,
    description: 'All sessions invalidated successfully.',
    schema: {
      properties: {
        message: { type: 'string', example: 'All sessions invalidated successfully' },
      },
    },
  })
  @ApiStandardErrorResponse([401])
  @HttpCode(HttpStatus.OK)
  async invalidateAllSessions(@Req() req: Request) {
    const user = req['user'] as any;
    await this.authService.invalidateAllSessions(user.id);
    return { message: 'All sessions invalidated successfully' };
  }
}
