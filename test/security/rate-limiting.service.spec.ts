import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';

import { ConfigService } from '@nestjs/config';
import { RateLimitingService } from '../../src/security/services/rate-limiting.service';
import { RedisService } from '../../src/common/services/redis.service';

describe('RateLimitingService', () => {
  let service: RateLimitingService;
  let redisService: RedisService;
  let configService: ConfigService;
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



  const mockRedisService = {
    zremrangebyscore: jest.fn(),
    zcard: jest.fn(),
    zadd: jest.fn(),
    expire: jest.fn(),
    del: jest.fn(),
    getRedisInstance: jest.fn().mockReturnThis(),
  };

  const mockConfigService = {
    get: jest.fn().mockImplementation((key: string, defaultValue?: any) => {
      const config: Record<string, number> = {
        RATE_LIMIT_API_PER_MINUTE: 100,
        RATE_LIMIT_AUTH_PER_MINUTE: 5,
        RATE_LIMIT_EXPENSIVE_PER_MINUTE: 10,
        RATE_LIMIT_USER_PER_HOUR: 1000,
      };
      return config[key] || defaultValue;
    }),

  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RateLimitingService,
        {
          provide: RedisService,
          useValue: mockRedisService,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<RateLimitingService>(RateLimitingService);
    redisService = module.get<RedisService>(RedisService);
    configService = module.get<ConfigService>(ConfigService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('checkRateLimit', () => {
    it('should allow request when under limit', async () => {
      mockRedisService.zcard.mockResolvedValue(5);

      const result = await service.checkRateLimit('test-key', {
        windowMs: 60000,
        maxRequests: 10,
      });

      expect(result.allowed).toBe(true);
      expect(result.info.remaining).toBe(4); // 10 - 5 - 1 (for current request)
      expect(mockRedisService.zadd).toHaveBeenCalled();
    });

    it('should block request when over limit', async () => {
      mockRedisService.zcard.mockResolvedValue(10);

      const result = await service.checkRateLimit('test-key', {
        windowMs: 60000,
        maxRequests: 10,
      });

      expect(result.allowed).toBe(false);
      expect(result.info.remaining).toBe(0);
      expect(mockRedisService.zadd).not.toHaveBeenCalled();
    });

    it('should handle Redis errors gracefully', async () => {
      mockRedisService.zcard.mockRejectedValue(new Error('Redis error'));

      const result = await service.checkRateLimit('test-key', {
        windowMs: 60000,
        maxRequests: 10,
      });

      // Should fail open
      expect(result.allowed).toBe(true);
    });
  });

  describe('getRateLimitInfo', () => {
    it('should return correct rate limit info', async () => {
      mockRedisService.zcard.mockResolvedValue(3);

      const result = await service.getRateLimitInfo('test-key', {
        windowMs: 60000,
        maxRequests: 10,
      });

      expect(result.remaining).toBe(7); // 10 - 3
      expect(result.limit).toBe(10);
      expect(result.window).toBe(60000);
    });
  });

  describe('getDefaultConfigurations', () => {
    it('should return default configurations', () => {
      const configs = service.getDefaultConfigurations();

      expect(configs).toHaveProperty('api');
      expect(configs).toHaveProperty('auth');
      expect(configs).toHaveProperty('expensive');
      expect(configs).toHaveProperty('user');

      expect(configs.api.maxRequests).toBe(100);
      expect(configs.auth.maxRequests).toBe(5);
    });
  });
});
