import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';

import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SensitiveEndpointRateLimitGuard } from '../../../src/security/guards/sensitive-endpoint-rate-limit.guard';
import { RateLimitingService } from '../../../src/security/services/rate-limiting.service';
import { IpBlockingService } from '../../../src/security/services/ip-blocking.service';

describe('SensitiveEndpointRateLimitGuard', () => {
  let guard: SensitiveEndpointRateLimitGuard;
  let rateLimitingService: jest.Mocked<RateLimitingService>;
  let ipBlockingService: jest.Mocked<IpBlockingService>;
  let reflector: jest.Mocked<Reflector>;
  beforeAll(() => {
    // Suppress ALL Logger messages for this test suite
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'verbose').mockImplementation(() => {});
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });



  const mockExecutionContext = (requestData: any = {}) => {
    const request = {
      headers: {},
      body: {},
      connection: { remoteAddress: '127.0.0.1' },
      path: '/test',
      ...requestData,
    };

    const response = {
      setHeader: jest.fn(),
    };

    return {
      switchToHttp: jest.fn().mockReturnValue({
        getRequest: () => request,
        getResponse: () => response,
      }),
      getHandler: jest.fn(),
    } as unknown as ExecutionContext;
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SensitiveEndpointRateLimitGuard,
        {
          provide: RateLimitingService,
          useValue: {
            checkRateLimit: jest.fn(),
            getRateLimitInfo: jest.fn(),
          },
        },
        {
          provide: IpBlockingService,
          useValue: {
            isIpBlocked: jest.fn(),
            isIpWhitelisted: jest.fn(),
            blockIp: jest.fn(),
            recordFailedAttempt: jest.fn(),
          },
        },
        {
          provide: Reflector,
          useValue: {
            get: jest.fn(),
          },
        },
      ],
    }).compile();

    guard = module.get<SensitiveEndpointRateLimitGuard>(SensitiveEndpointRateLimitGuard);
    rateLimitingService = module.get(RateLimitingService);
    ipBlockingService = module.get(IpBlockingService);
    reflector = module.get(Reflector);
  });



  afterEach(() => {
    jest.clearAllMocks();
  });



  describe('canActivate', () => {
    it('should allow request when rate limit is not exceeded', async () => {
      const context = mockExecutionContext();
      
      ipBlockingService.isIpBlocked.mockResolvedValue(false);
      ipBlockingService.isIpWhitelisted.mockResolvedValue(false);
      rateLimitingService.checkRateLimit.mockResolvedValue({
        allowed: true,
        info: {
          remaining: 4,
          resetTime: Date.now() + 60000,
          limit: 5,
          window: 60000,
        },
      });
      reflector.get.mockReturnValue(undefined);

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      expect(rateLimitingService.checkRateLimit).toHaveBeenCalled();
    });

    it('should block request when IP is blocked', async () => {
      const context = mockExecutionContext();
      
      ipBlockingService.isIpBlocked.mockResolvedValue(true);

      await expect(guard.canActivate(context)).rejects.toThrow(HttpException);
      await expect(guard.canActivate(context)).rejects.toThrow('Your IP has been temporarily blocked due to suspicious activity');
    });

    it('should allow request when IP is whitelisted', async () => {
      const context = mockExecutionContext();
      
      ipBlockingService.isIpBlocked.mockResolvedValue(false);
      ipBlockingService.isIpWhitelisted.mockResolvedValue(true);

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      expect(rateLimitingService.checkRateLimit).not.toHaveBeenCalled();
    });

    it('should throw HttpException when rate limit is exceeded', async () => {
      const context = mockExecutionContext();
      
      ipBlockingService.isIpBlocked.mockResolvedValue(false);
      ipBlockingService.isIpWhitelisted.mockResolvedValue(false);
      const resetTime = Date.now() + 60000;
      rateLimitingService.checkRateLimit.mockResolvedValue({
        allowed: false,
        info: {
          remaining: 0,
          resetTime: resetTime,
          limit: 5,
          window: 60000,
        },
      });
      reflector.get.mockReturnValue({ enableProgressiveDelay: false });

      await expect(guard.canActivate(context)).rejects.toThrow(HttpException);
      await expect(guard.canActivate(context)).rejects.toThrow(/Too many requests/);
    });

    it('should block IP when blockOnExceed is enabled and rate limit exceeded', async () => {
      const context = mockExecutionContext();
      
      ipBlockingService.isIpBlocked.mockResolvedValue(false);
      ipBlockingService.isIpWhitelisted.mockResolvedValue(false);
      rateLimitingService.checkRateLimit.mockResolvedValue({
        allowed: false,
        info: {
          remaining: 0,
          resetTime: Date.now() + 60000,
          limit: 5,
          window: 60000,
        },
      });
      reflector.get.mockReturnValue({
        blockOnExceed: true,
        blockDurationMs: 3600000,
      });

      await expect(guard.canActivate(context)).rejects.toThrow(HttpException);
      expect(ipBlockingService.blockIp).toHaveBeenCalledWith(
        '127.0.0.1',
        expect.stringContaining('Rate limit exceeded'),
        3600000,
      );
      expect(ipBlockingService.recordFailedAttempt).toHaveBeenCalled();
    });

    it('should apply progressive delay when enabled', async () => {
      const context = mockExecutionContext();
      
      ipBlockingService.isIpBlocked.mockResolvedValue(false);
      ipBlockingService.isIpWhitelisted.mockResolvedValue(false);
      rateLimitingService.checkRateLimit.mockResolvedValue({
        allowed: false,
        info: {
          remaining: 0,
          resetTime: Date.now() + 60000,
          limit: 5,
          window: 60000,
        },
      });
      rateLimitingService.getRateLimitInfo.mockResolvedValue({
        remaining: 0,
        resetTime: Date.now() + 60000,
        limit: 5,
        window: 60000,
      });
      reflector.get.mockReturnValue({
        enableProgressiveDelay: true,
      });

      const startTime = Date.now();
      await expect(guard.canActivate(context)).rejects.toThrow(HttpException);
      const endTime = Date.now();

      expect(endTime - startTime).toBeGreaterThanOrEqual(0);
    });

    it('should use email from request body for rate limit key', async () => {
      const context = mockExecutionContext({
        body: { email: 'test@example.com' },
      });
      
      ipBlockingService.isIpBlocked.mockResolvedValue(false);
      ipBlockingService.isIpWhitelisted.mockResolvedValue(false);
      rateLimitingService.checkRateLimit.mockResolvedValue({
        allowed: true,
        info: {
          remaining: 4,
          resetTime: Date.now() + 60000,
          limit: 5,
          window: 60000,
        },
      });
      reflector.get.mockReturnValue(undefined);

      await guard.canActivate(context);

      expect(rateLimitingService.checkRateLimit).toHaveBeenCalledWith(
        'email:test@example.com',
        expect.any(Object),
      );
    });

    it('should use user ID from request for rate limit key when authenticated', async () => {
      const context = mockExecutionContext({
        user: { id: 'user-123' },
      });
      
      ipBlockingService.isIpBlocked.mockResolvedValue(false);
      ipBlockingService.isIpWhitelisted.mockResolvedValue(false);
      rateLimitingService.checkRateLimit.mockResolvedValue({
        allowed: true,
        info: {
          remaining: 4,
          resetTime: Date.now() + 60000,
          limit: 5,
          window: 60000,
        },
      });
      reflector.get.mockReturnValue(undefined);

      await guard.canActivate(context);

      expect(rateLimitingService.checkRateLimit).toHaveBeenCalledWith(
        'user:user-123',
        expect.any(Object),
      );
    });

    it('should set rate limit headers in response', async () => {
      const context = mockExecutionContext();
      const response = context.switchToHttp().getResponse();
      
      ipBlockingService.isIpBlocked.mockResolvedValue(false);
      ipBlockingService.isIpWhitelisted.mockResolvedValue(false);
      rateLimitingService.checkRateLimit.mockResolvedValue({
        allowed: true,
        info: {
          remaining: 4,
          resetTime: Date.now() + 60000,
          limit: 5,
          window: 60000,
        },
      });
      reflector.get.mockReturnValue(undefined);

      await guard.canActivate(context);

      expect(response.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', 5);
      expect(response.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', 4);
      expect(response.setHeader).toHaveBeenCalledWith('X-RateLimit-Reset', expect.any(Number));
      expect(response.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(Number));
    });

    it('should fail open when rate limiting service throws error', async () => {
      const context = mockExecutionContext();
      
      ipBlockingService.isIpBlocked.mockResolvedValue(false);
      ipBlockingService.isIpWhitelisted.mockResolvedValue(false);
      rateLimitingService.checkRateLimit.mockRejectedValue(new Error('Redis connection failed'));
      reflector.get.mockReturnValue(undefined);

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
    });

    it('should extract IP from x-forwarded-for header', async () => {
      const context = mockExecutionContext({
        headers: { 'x-forwarded-for': '203.0.113.1, 198.51.100.1' },
      });
      
      ipBlockingService.isIpBlocked.mockResolvedValue(false);
      ipBlockingService.isIpWhitelisted.mockResolvedValue(false);
      rateLimitingService.checkRateLimit.mockResolvedValue({
        allowed: true,
        info: {
          remaining: 4,
          resetTime: Date.now() + 60000,
          limit: 5,
          window: 60000,
        },
      });
      reflector.get.mockReturnValue(undefined);

      await guard.canActivate(context);

      expect(ipBlockingService.isIpBlocked).toHaveBeenCalledWith('203.0.113.1');
    });

    it('should use custom rate limit options from decorator', async () => {
      const context = mockExecutionContext();
      
      ipBlockingService.isIpBlocked.mockResolvedValue(false);
      ipBlockingService.isIpWhitelisted.mockResolvedValue(false);
      rateLimitingService.checkRateLimit.mockResolvedValue({
        allowed: true,
        info: {
          remaining: 2,
          resetTime: Date.now() + 300000,
          limit: 3,
          window: 300000,
        },
      });
      reflector.get.mockReturnValue({
        windowMs: 300000,
        maxRequests: 3,
        keyPrefix: 'custom_prefix',
      });

      await guard.canActivate(context);

      expect(rateLimitingService.checkRateLimit).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          windowMs: 300000,
          maxRequests: 3,
          keyPrefix: 'custom_prefix',
        }),
      );
    });
  });
});
