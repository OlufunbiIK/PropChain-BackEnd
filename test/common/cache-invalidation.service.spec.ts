import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';

import { ConfigService } from '@nestjs/config';
import { CacheInvalidationService, InvalidationRule } from '../../src/common/cache/cache-invalidation.service';
import { MultiLevelCacheService } from '../../src/common/cache/multi-level-cache.service';
import { RedisService } from '../../src/common/services/redis.service';

describe('CacheInvalidationService', () => {
  let service: CacheInvalidationService;
  let cacheService: jest.Mocked<MultiLevelCacheService>;
  let redisService: jest.Mocked<RedisService>;
  let configService: jest.Mocked<ConfigService>;
  let loggerErrorSpy: jest.SpyInstance;

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


  beforeEach(async () => {

    const mockCacheService = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
      invalidateByPattern: jest.fn(),
      invalidateByTag: jest.fn(),
      invalidateWithCascade: jest.fn(),
    };

    const mockRedisService = {
      get: jest.fn(),
      setex: jest.fn(),
      del: jest.fn(),
      keys: jest.fn(),
      sadd: jest.fn(),
      smembers: jest.fn(),
      ttl: jest.fn(),
    };

    const mockConfigService = {
      get: jest.fn().mockImplementation((key: string, defaultValue?: any) => defaultValue),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CacheInvalidationService,
        { provide: MultiLevelCacheService, useValue: mockCacheService },
        { provide: RedisService, useValue: mockRedisService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<CacheInvalidationService>(CacheInvalidationService);
    cacheService = module.get(MultiLevelCacheService);
    redisService = module.get(RedisService);
    configService = module.get(ConfigService);

    // Suppress expected error logs in console
    jest.spyOn((service as any).logger, 'error').mockImplementation(() => {});
  });


  afterEach(() => {
    jest.clearAllMocks();
  });



  describe('initialization', () => {
    it('should initialize with default rules', () => {
      const rules = service.getRules();
      expect(rules.length).toBeGreaterThan(0);
    });
  });

  describe('registerRule', () => {
    it('should register a new invalidation rule', () => {
      const rule: InvalidationRule = {
        id: 'test-rule',
        name: 'Test Rule',
        description: 'Test description',
        type: 'pattern',
        target: 'test:*',
        action: 'delete',
        priority: 5,
        enabled: true,
        metadata: {
          createdAt: new Date(),
          lastExecuted: null,
          executionCount: 0,
        },
      };

      service.registerRule(rule);

      expect(service.getRule('test-rule')).toEqual(rule);
    });

    it('should update stats when registering a rule', () => {
      const initialStats = service.getStats();
      const initialCount = initialStats.totalRules;

      const rule: InvalidationRule = {
        id: 'stats-rule',
        name: 'Stats Rule',
        description: 'Stats description',
        type: 'pattern',
        target: 'stats:*',
        action: 'delete',
        priority: 5,
        enabled: true,
        metadata: {
          createdAt: new Date(),
          lastExecuted: null,
          executionCount: 0,
        },
      };

      service.registerRule(rule);

      const newStats = service.getStats();
      expect(newStats.totalRules).toBe(initialCount + 1);
    });
  });

  describe('unregisterRule', () => {
    it('should unregister a rule', () => {
      const rule: InvalidationRule = {
        id: 'temp-rule',
        name: 'Temp Rule',
        description: 'Temp description',
        type: 'pattern',
        target: 'temp:*',
        action: 'delete',
        priority: 5,
        enabled: true,
        metadata: {
          createdAt: new Date(),
          lastExecuted: null,
          executionCount: 0,
        },
      };

      service.registerRule(rule);
      const result = service.unregisterRule('temp-rule');

      expect(result).toBe(true);
      expect(service.getRule('temp-rule')).toBeUndefined();
    });

    it('should return false for non-existent rule', () => {
      const result = service.unregisterRule('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('setRuleEnabled', () => {
    it('should enable/disable a rule', () => {
      const rule: InvalidationRule = {
        id: 'toggle-rule',
        name: 'Toggle Rule',
        description: 'Toggle description',
        type: 'pattern',
        target: 'toggle:*',
        action: 'delete',
        priority: 5,
        enabled: true,
        metadata: {
          createdAt: new Date(),
          lastExecuted: null,
          executionCount: 0,
        },
      };

      service.registerRule(rule);

      // Disable
      let result = service.setRuleEnabled('toggle-rule', false);
      expect(result).toBe(true);
      expect(service.getRule('toggle-rule')?.enabled).toBe(false);

      // Enable
      result = service.setRuleEnabled('toggle-rule', true);
      expect(result).toBe(true);
      expect(service.getRule('toggle-rule')?.enabled).toBe(true);
    });

    it('should return false for non-existent rule', () => {
      const result = service.setRuleEnabled('non-existent', false);
      expect(result).toBe(false);
    });
  });

  describe('executeRule', () => {
    it('should execute a pattern rule', async () => {
      cacheService.invalidateByPattern.mockResolvedValue(5);

      const rule: InvalidationRule = {
        id: 'pattern-rule',
        name: 'Pattern Rule',
        description: 'Pattern description',
        type: 'pattern',
        target: 'pattern:*',
        action: 'delete',
        priority: 5,
        enabled: true,
        metadata: {
          createdAt: new Date(),
          lastExecuted: null,
          executionCount: 0,
        },
      };

      service.registerRule(rule);
      const result = await service.executeRule('pattern-rule');

      expect(result).toBe(5);
      expect(cacheService.invalidateByPattern).toHaveBeenCalledWith('pattern:*');
    });

    it('should execute a tag rule', async () => {
      redisService.keys.mockResolvedValue(['tag:user', 'tag:property']);
      cacheService.invalidateByTag.mockResolvedValue(3);

      const rule: InvalidationRule = {
        id: 'tag-rule',
        name: 'Tag Rule',
        description: 'Tag description',
        type: 'tag',
        target: 'tag:*',
        action: 'delete',
        priority: 5,
        enabled: true,
        metadata: {
          createdAt: new Date(),
          lastExecuted: null,
          executionCount: 0,
        },
      };

      service.registerRule(rule);
      const result = await service.executeRule('tag-rule');

      expect(result).toBe(6); // 3 per tag
    });

    it('should skip disabled rules', async () => {
      const rule: InvalidationRule = {
        id: 'disabled-rule',
        name: 'Disabled Rule',
        description: 'Disabled description',
        type: 'pattern',
        target: 'disabled:*',
        action: 'delete',
        priority: 5,
        enabled: false,
        metadata: {
          createdAt: new Date(),
          lastExecuted: null,
          executionCount: 0,
        },
      };

      service.registerRule(rule);
      const result = await service.executeRule('disabled-rule');

      expect(result).toBe(0);
      expect(cacheService.invalidateByPattern).not.toHaveBeenCalled();
    });

    it('should return 0 for non-existent rule', async () => {
      const result = await service.executeRule('non-existent');
      expect(result).toBe(0);
    });

    it('should execute conditional rule', async () => {
      const condition = jest.fn().mockReturnValue(true);
      redisService.keys.mockResolvedValue(['key1', 'key2']);
      redisService.get.mockResolvedValue(JSON.stringify({
        value: 'test',
        timestamp: Date.now(),
      }));
      redisService.ttl.mockResolvedValue(3600);

      const rule: InvalidationRule = {
        id: 'conditional-rule',
        name: 'Conditional Rule',
        description: 'Conditional description',
        type: 'conditional',
        target: 'conditional:*',
        action: 'delete',
        priority: 5,
        enabled: true,
        condition,
        metadata: {
          createdAt: new Date(),
          lastExecuted: null,
          executionCount: 0,
        },
      };

      service.registerRule(rule);
      const result = await service.executeRule('conditional-rule');

      expect(result).toBe(2);
      expect(condition).toHaveBeenCalled();
    });

    it('should execute dependency rule with cascade', async () => {
      redisService.keys.mockResolvedValue(['key1', 'key2']);

      const rule: InvalidationRule = {
        id: 'dependency-rule',
        name: 'Dependency Rule',
        description: 'Dependency description',
        type: 'dependency',
        target: 'dependency:*',
        action: 'cascade',
        priority: 5,
        enabled: true,
        metadata: {
          createdAt: new Date(),
          lastExecuted: null,
          executionCount: 0,
        },
      };

      service.registerRule(rule);
      const result = await service.executeRule('dependency-rule');

      expect(result).toBe(2);
      expect(cacheService.invalidateWithCascade).toHaveBeenCalledTimes(2);
    });

    it('should handle rule execution errors', async () => {
      cacheService.invalidateByPattern.mockRejectedValue(new Error('Execution error'));

      const rule: InvalidationRule = {
        id: 'error-rule',
        name: 'Error Rule',
        description: 'Error description',
        type: 'pattern',
        target: 'error:*',
        action: 'delete',
        priority: 5,
        enabled: true,
        metadata: {
          createdAt: new Date(),
          lastExecuted: null,
          executionCount: 0,
        },
      };

      service.registerRule(rule);
      const result = await service.executeRule('error-rule');

      expect(result).toBe(0);
    });
  });

  describe('executeAllRules', () => {
    it('should execute all enabled rules', async () => {
      cacheService.invalidateByPattern.mockResolvedValue(1);

      const rule1: InvalidationRule = {
        id: 'all-rule-1',
        name: 'All Rule 1',
        description: 'All Rule 1 description',
        type: 'pattern',
        target: 'all1:*',
        action: 'delete',
        priority: 10,
        enabled: true,
        metadata: {
          createdAt: new Date(),
          lastExecuted: null,
          executionCount: 0,
        },
      };

      const rule2: InvalidationRule = {
        id: 'all-rule-2',
        name: 'All Rule 2',
        description: 'All Rule 2 description',
        type: 'pattern',
        target: 'all2:*',
        action: 'delete',
        priority: 5,
        enabled: true,
        metadata: {
          createdAt: new Date(),
          lastExecuted: null,
          executionCount: 0,
        },
      };

      const disabledRule: InvalidationRule = {
        id: 'all-rule-disabled',
        name: 'All Rule Disabled',
        description: 'All Rule Disabled description',
        type: 'pattern',
        target: 'disabled:*',
        action: 'delete',
        priority: 1,
        enabled: false,
        metadata: {
          createdAt: new Date(),
          lastExecuted: null,
          executionCount: 0,
        },
      };

      service.registerRule(rule1);
      service.registerRule(rule2);
      service.registerRule(disabledRule);

      const results = await service.executeAllRules();

      expect(results.get('all-rule-1')).toBe(1);
      expect(results.get('all-rule-2')).toBe(1);
      expect(results.has('all-rule-disabled')).toBe(false);
    });
  });

  describe('smartInvalidate', () => {
    it('should invalidate based on entity type and change type', async () => {
      cacheService.invalidateByPattern.mockResolvedValue(1);

      await service.smartInvalidate('property', '123', 'update');

      expect(cacheService.invalidateByPattern).toHaveBeenCalled();
    });

    it('should handle create change type', async () => {
      cacheService.invalidateByPattern.mockResolvedValue(1);

      await service.smartInvalidate('user', '456', 'create');

      expect(cacheService.invalidateByPattern).toHaveBeenCalledWith('user:*:list');
      expect(cacheService.invalidateByPattern).toHaveBeenCalledWith('user:active:*');
    });

    it('should handle delete change type', async () => {
      cacheService.invalidateByPattern.mockResolvedValue(1);

      await service.smartInvalidate('transaction', '789', 'delete');

      expect(cacheService.invalidateByPattern).toHaveBeenCalledWith('transaction:789');
      expect(cacheService.invalidateByPattern).toHaveBeenCalledWith('transaction:*:list');
      expect(cacheService.invalidateByPattern).toHaveBeenCalledWith('balance:*');
    });
  });

  describe('invalidateByTagsWithPolicy', () => {
    it('should invalidate by tags with cascade', async () => {
      cacheService.invalidateByTag.mockResolvedValue(3);
      cacheService.invalidateByPattern.mockResolvedValue(2);

      const result = await service.invalidateByTagsWithPolicy(['property'], { cascade: true });

      expect(result).toBeGreaterThanOrEqual(3);
      expect(cacheService.invalidateByTag).toHaveBeenCalledWith('property');
    });

    it('should invalidate by tags without cascade', async () => {
      cacheService.invalidateByTag.mockResolvedValue(3);

      const result = await service.invalidateByTagsWithPolicy(['user'], { cascade: false });

      expect(result).toBe(3);
      expect(cacheService.invalidateByPattern).not.toHaveBeenCalled();
    });
  });

  describe('batchInvalidate', () => {
    it('should batch invalidate multiple keys', async () => {
      const keys = ['key1', 'key2', 'key3'];

      const result = await service.batchInvalidate(keys);

      expect(result.success).toBe(3);
      expect(result.failed).toBe(0);
      expect(cacheService.del).toHaveBeenCalledTimes(3);
    });

    it('should handle partial failures', async () => {
      const keys = ['key1', 'key2', 'key3'];
      cacheService.del
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Delete error'))
        .mockResolvedValueOnce(undefined);

      const result = await service.batchInvalidate(keys);

      expect(result.success).toBe(2);
      expect(result.failed).toBe(1);
    });
  });

  describe('invalidateWithCallback', () => {
    it('should invalidate and refresh with callback', async () => {
      const refreshCallback = jest.fn().mockResolvedValue({ data: 'refreshed' });

      await service.invalidateWithCallback('test:key', refreshCallback);

      expect(cacheService.del).toHaveBeenCalledWith('test:key');
      expect(refreshCallback).toHaveBeenCalled();
      expect(cacheService.set).toHaveBeenCalledWith('test:key', { data: 'refreshed' });
    });

    it('should invalidate without callback', async () => {
      await service.invalidateWithCallback('test:key');

      expect(cacheService.del).toHaveBeenCalledWith('test:key');
      expect(cacheService.set).not.toHaveBeenCalled();
    });

    it('should handle refresh callback errors', async () => {
      const refreshCallback = jest.fn().mockRejectedValue(new Error('Refresh error'));

      await service.invalidateWithCallback('test:key', refreshCallback);

      expect(cacheService.del).toHaveBeenCalledWith('test:key');
      expect(refreshCallback).toHaveBeenCalled();
      expect(cacheService.set).not.toHaveBeenCalled();
    });
  });

  describe('getStats', () => {
    it('should return invalidation statistics', () => {
      const stats = service.getStats();

      expect(stats).toHaveProperty('totalRules');
      expect(stats).toHaveProperty('activeRules');
      expect(stats).toHaveProperty('totalExecutions');
      expect(stats).toHaveProperty('successfulInvalidations');
      expect(stats).toHaveProperty('failedInvalidations');
      expect(stats).toHaveProperty('events');
    });
  });

  describe('getRules', () => {
    it('should return all rules', () => {
      const rules = service.getRules();

      expect(Array.isArray(rules)).toBe(true);
      expect(rules.length).toBeGreaterThan(0);
    });
  });

  describe('getRule', () => {
    it('should return a specific rule', () => {
      const rule = service.getRule('rule-user-session-stale');

      expect(rule).toBeDefined();
      expect(rule?.id).toBe('rule-user-session-stale');
    });

    it('should return undefined for non-existent rule', () => {
      const rule = service.getRule('non-existent');

      expect(rule).toBeUndefined();
    });
  });

  describe('scheduledCleanup', () => {
    it('should execute time-based rules', async () => {
      const timeBasedRule: InvalidationRule = {
        id: 'cleanup-rule',
        name: 'Cleanup Rule',
        description: 'Cleanup description',
        type: 'time-based',
        target: 'cleanup:*',
        action: 'delete',
        priority: 5,
        enabled: true,
        condition: () => true,
        metadata: {
          createdAt: new Date(),
          lastExecuted: null,
          executionCount: 0,
        },
      };

      service.registerRule(timeBasedRule);
      redisService.keys.mockResolvedValue(['key1']);
      redisService.get.mockResolvedValue(JSON.stringify({
        value: 'test',
        timestamp: Date.now(),
      }));
      redisService.ttl.mockResolvedValue(3600);

      await service.scheduledCleanup();

      expect(redisService.keys).toHaveBeenCalledWith('cleanup:*');
    });
  });

  describe('scheduledRefresh', () => {
    it('should execute conditional refresh rules', async () => {
      const refreshRule: InvalidationRule = {
        id: 'refresh-rule',
        name: 'Refresh Rule',
        description: 'Refresh description',
        type: 'conditional',
        target: 'refresh:*',
        action: 'refresh',
        priority: 5,
        enabled: true,
        condition: () => true,
        metadata: {
          createdAt: new Date(),
          lastExecuted: null,
          executionCount: 0,
        },
      };

      service.registerRule(refreshRule);
      redisService.keys.mockResolvedValue(['key1']);
      redisService.get.mockResolvedValue(JSON.stringify({
        value: 'test',
        timestamp: Date.now(),
      }));
      redisService.ttl.mockResolvedValue(3600);

      await service.scheduledRefresh();

      expect(redisService.keys).toHaveBeenCalledWith('refresh:*');
    });
  });
});
