import { Test } from '@nestjs/testing';
import { AuthService } from '../../src/auth/auth.service';
import { UserService } from '../../src/users/user.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../src/common/services/redis.service';
import { StructuredLoggerService } from '../../src/common/logging/logger.service';
import { TokenExpiredException } from '../../src/common/errors/custom.exceptions';

describe('AuthService', () => {
  let authService: AuthService;
  let userService: UserService;
  let jwtService: JwtService;
  let redisMock: any;
  let configMock: any;

  beforeEach(async () => {
    redisMock = {
      set: jest.fn(),
      setex: jest.fn(),
      get: jest.fn(),
      del: jest.fn(),
      keys: jest.fn(),
    };

    configMock = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'MAX_LOGIN_ATTEMPTS') return 5;
        if (key === 'LOGIN_ATTEMPT_WINDOW') return 600;
        if (key === 'JWT_SECRET') return 'test-jwt-secret-that-is-at-least-32-characters';
        if (key === 'JWT_REFRESH_SECRET') return 'test-jwt-refresh-secret-that-is-long-enough';
        if (key === 'JWT_EXPIRES_IN') return '15m';
        if (key === 'JWT_REFRESH_EXPIRES_IN') return '7d';
        if (key === 'SESSION_TIMEOUT') return 3600;
        return null;
      }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: UserService,
          useValue: {
            create: jest.fn(),
            findByEmail: jest.fn(),
            findById: jest.fn(),
            updatePassword: jest.fn(),
            verifyUser: jest.fn(),
          },
        },
        {
          provide: JwtService,
          useValue: {
            sign: jest.fn().mockReturnValue('signed-jwt'),
            verifyAsync: jest.fn(),
            decode: jest.fn().mockReturnValue({
              exp: Math.floor(Date.now() / 1000) + 3600,
            }),
          },
        },
        {
          provide: ConfigService,
          useValue: configMock,
        },
        {
          provide: RedisService,
          useValue: redisMock,
        },
        StructuredLoggerService,
      ],
    }).compile();

    authService = moduleRef.get<AuthService>(AuthService);
    userService = moduleRef.get<UserService>(UserService);
    jwtService = moduleRef.get<JwtService>(JwtService);
  });

  describe('refreshToken', () => {
    it('should reject token without refresh tokenUse', async () => {
      jest.spyOn(jwtService, 'verifyAsync').mockResolvedValue({
        sub: 'u1',
        email: 'a@b.com',
        tokenUse: 'access',
        jti: 'jti-1',
      } as any);

      await expect(authService.refreshToken('tok')).rejects.toBeInstanceOf(TokenExpiredException);
    });

    it('should issue new tokens when refresh session matches', async () => {
      const user = { id: 'u1', email: 'a@b.com', isVerified: true, walletAddress: null };
      jest.spyOn(jwtService, 'verifyAsync').mockResolvedValue({
        sub: 'u1',
        email: 'a@b.com',
        tokenUse: 'refresh',
        rid: 'rid-1',
      } as any);
      jest.spyOn(userService, 'findById').mockResolvedValue(user as any);
      redisMock.get.mockImplementation(async (key: string) => {
        if (key.startsWith('refresh_session:')) {
          return 'u1';
        }
        if (key.startsWith('user_refresh_rid:')) {
          return 'rid-1';
        }
        return null;
      });
      redisMock.del.mockResolvedValue(1);
      redisMock.setex.mockResolvedValue(undefined);

      const result = await authService.refreshToken('valid-refresh');

      expect(result.access_token).toBeDefined();
      expect(result.refresh_token).toBeDefined();
      expect(jwtService.sign).toHaveBeenCalled();
    });
  });

  describe('login brute force protection', () => {
    const creds = { email: 'foo@bar.com', password: 'bad' };

    it('should increment login attempts on invalid credentials', async () => {
      jest.spyOn(authService, 'validateUserByEmail').mockResolvedValue(null);
      redisMock.get.mockResolvedValue('0');

      await expect(authService.login(creds)).rejects.toThrow('The provided credentials are invalid');
      expect(redisMock.setex).toHaveBeenCalledWith('login_attempts:foo@bar.com', 600, '1');
    });

    it('should block when max attempts reached', async () => {
      redisMock.get.mockResolvedValue('5');
      await expect(authService.login(creds)).rejects.toThrow('Too many login attempts');
    });

    it('should clear attempts after successful login', async () => {
      const fakeUser = { id: 'u1', email: 'foo@bar.com' };
      jest.spyOn(authService, 'validateUserByEmail').mockResolvedValue(fakeUser as any);
      redisMock.get.mockResolvedValue('2');
      // jwtService.sign is already a jest.fn(), so generateTokens will run without errors

      await authService.login(creds);
      expect(redisMock.del).toHaveBeenCalledWith('login_attempts:foo@bar.com');
    });
  });
});
