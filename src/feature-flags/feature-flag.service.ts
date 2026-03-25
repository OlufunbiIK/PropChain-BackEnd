import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../common/services/redis.service';
import {
  FeatureFlag,
  FeatureFlagType,
  FeatureFlagStatus,
  FlagEvaluationContext,
  FlagEvaluationResult,
  FlagCondition,
} from './models/feature-flag.entity';
import { CreateFeatureFlagDto, UpdateFeatureFlagDto, FlagQueryDto } from './dto/feature-flag.dto';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';

@Injectable()
export class FeatureFlagService {
  private readonly logger = new Logger(FeatureFlagService.name);
  private readonly cachePrefix = 'feature-flag:';
  private readonly evaluationCachePrefix = 'flag-eval:';
  private readonly analyticsPrefix = 'flag-analytics:';
  private readonly cacheTtl = 300; // 5 minutes
  private readonly evaluationCacheTtl = 60; // 1 minute

  constructor(
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
  ) {}

  async create(createFlagDto: CreateFeatureFlagDto, createdBy: string): Promise<FeatureFlag> {
    const flag: FeatureFlag = {
      id: uuidv4(),
      key: createFlagDto.key,
      name: createFlagDto.name,
      description: createFlagDto.description,
      type: createFlagDto.type,
      status: createFlagDto.status,
      value: this.getValueFromDto(createFlagDto) as boolean | number | string[],
      conditions: createFlagDto.conditions,
      tags: createFlagDto.tags || [],
      metadata: createFlagDto.metadata || {},
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy,
      updatedBy: createdBy,
    };

    // Check if flag key already exists
    const existingFlag = await this.getByKey(flag.key);
    if (existingFlag) {
      throw new Error(`Feature flag with key '${flag.key}' already exists`);
    }

    await this.save(flag);
    await this.invalidateCache(flag.key);

    this.logger.log(`Created feature flag: ${flag.key} by ${createdBy}`);
    return flag;
  }

  async findAll(query?: FlagQueryDto): Promise<{ flags: FeatureFlag[]; total: number }> {
    const { page = 1, limit = 20 } = query || {};

    const cacheKey = `flags:list:${this.serializeQuery(query)}`;
    const cached = await this.redisService.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    // Get all flags from Redis
    const flagKeys = await this.redisService.keys(`${this.cachePrefix}*`);
    const flags: FeatureFlag[] = [];

    for (const key of flagKeys) {
      const flagData = await this.redisService.get(key);
      if (flagData) {
        const flag = JSON.parse(flagData) as FeatureFlag;

        // Apply filters
        if (this.matchesFilters(flag, query)) {
          flags.push(flag);
        }
      }
    }

    // Sort by updatedAt descending
    flags.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    const total = flags.length;
    const startIndex = (page - 1) * limit;
    const paginatedFlags = flags.slice(startIndex, startIndex + limit);

    const result = { flags: paginatedFlags, total };

    // Cache the result
    await this.redisService.setex(cacheKey, this.cacheTtl, JSON.stringify(result));

    return result;
  }

  async findOne(id: string): Promise<FeatureFlag | null> {
    const cacheKey = `${this.cachePrefix}${id}`;
    const cached = await this.redisService.get(cacheKey);

    if (cached) {
      return JSON.parse(cached);
    }

    const flag = await this.getById(id);
    if (flag) {
      await this.redisService.setex(cacheKey, this.cacheTtl, JSON.stringify(flag));
    }

    return flag;
  }

  async getByKey(key: string): Promise<FeatureFlag | null> {
    const cacheKey = `${this.cachePrefix}key:${key}`;
    const cached = await this.redisService.get(cacheKey);

    if (cached) {
      return JSON.parse(cached);
    }

    // Search by key
    const flagKeys = await this.redisService.keys(`${this.cachePrefix}*`);
    for (const flagKey of flagKeys) {
      const flagData = await this.redisService.get(flagKey);
      if (flagData) {
        const flag = JSON.parse(flagData) as FeatureFlag;
        if (flag.key === key) {
          await this.redisService.setex(cacheKey, this.cacheTtl, JSON.stringify(flag));
          return flag;
        }
      }
    }

    return null;
  }

  async update(
    id: string,
    updateFlagDto: UpdateFeatureFlagDto,
    updatedBy: string,
  ): Promise<FeatureFlag> {
    const existingFlag = await this.getById(id);
    if (!existingFlag) {
      throw new Error(`Feature flag with id '${id}' not found`);
    }

    const updatedFlag: FeatureFlag = {
      ...existingFlag,
      name: updateFlagDto.name ?? existingFlag.name,
      description: updateFlagDto.description ?? existingFlag.description,
      status: updateFlagDto.status ?? existingFlag.status,
      type: updateFlagDto.type ?? existingFlag.type,
      value: updateFlagDto.type
        ? (this.getValueFromDto(updateFlagDto) as boolean | number | string[])
        : existingFlag.value,
      conditions: updateFlagDto.conditions ?? existingFlag.conditions,
      tags: updateFlagDto.tags ?? existingFlag.tags,
      metadata: updateFlagDto.metadata ?? existingFlag.metadata,
      updatedAt: new Date(),
      updatedBy,
    };

    await this.save(updatedFlag);
    await this.invalidateCache(updatedFlag.key);

    this.logger.log(`Updated feature flag: ${updatedFlag.key} by ${updatedBy}`);
    return updatedFlag;
  }

  async remove(id: string): Promise<void> {
    const flag = await this.getById(id);
    if (!flag) {
      throw new Error(`Feature flag with id '${id}' not found`);
    }

    await this.redisService.del(`${this.cachePrefix}${id}`);
    await this.redisService.del(`${this.cachePrefix}key:${flag.key}`);
    await this.invalidateCache(flag.key);

    this.logger.log(`Deleted feature flag: ${flag.key}`);
  }

  async evaluate(
    flagKey: string,
    context: FlagEvaluationContext = {},
  ): Promise<FlagEvaluationResult> {
    const flag = await this.getByKey(flagKey);
    if (!flag) {
      return {
        flagKey,
        enabled: false,
        value: false,
        reason: 'Flag not found',
        timestamp: new Date(),
      };
    }

    if (flag.status !== FeatureFlagStatus.ACTIVE) {
      return {
        flagKey,
        enabled: false,
        value: false,
        reason: 'Flag is not active',
        timestamp: new Date(),
      };
    }

    // Check evaluation cache
    const cacheKey = `${this.evaluationCachePrefix}${flagKey}:${this.getContextHash(context)}`;
    const cached = await this.redisService.get(cacheKey);
    if (cached) {
      const result = JSON.parse(cached) as FlagEvaluationResult;
      result.timestamp = new Date(); // Update timestamp
      return result;
    }

    const result = this.evaluateFlag(flag, context);

    // Cache the evaluation result
    await this.redisService.setex(cacheKey, this.evaluationCacheTtl, JSON.stringify(result));

    // Record analytics
    await this.recordEvaluation(flagKey, result, context);

    return result;
  }

  async bulkEvaluate(
    flagKeys: string[],
    context: FlagEvaluationContext = {},
  ): Promise<FlagEvaluationResult[]> {
    const results: FlagEvaluationResult[] = [];

    for (const flagKey of flagKeys) {
      const result = await this.evaluate(flagKey, context);
      results.push(result);
    }

    return results;
  }

  async getAnalytics(flagKey: string, days: number = 30): Promise<any> {
    const analyticsKey = `${this.analyticsPrefix}${flagKey}`;
    const cached = await this.redisService.get(analyticsKey);

    if (cached) {
      return JSON.parse(cached);
    }

    // Generate analytics from evaluation history
    const historyKey = `${this.analyticsPrefix}${flagKey}:history`;
    const historyData = await this.redisService.lrange(historyKey, 0, -1);

    const uniqueUsersSet = new Set<string>();
    const dailyStats: Record<string, { enabled: number; disabled: number }> = {};
    let lastEvaluated: Date | null = null;
    let enabledCount = 0;
    let disabledCount = 0;

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    for (const record of historyData) {
      const evaluation = JSON.parse(record);
      const evalDate = new Date(evaluation.timestamp);

      if (evalDate >= cutoffDate) {
        if (evaluation.result) {
          enabledCount++;
        } else {
          disabledCount++;
        }

        if (evaluation.userId) {
          uniqueUsersSet.add(evaluation.userId);
        }

        if (!lastEvaluated || evalDate > lastEvaluated) {
          lastEvaluated = evalDate;
        }

        const dayKey = evalDate.toISOString().split('T')[0];
        if (!dailyStats[dayKey]) {
          dailyStats[dayKey] = { enabled: 0, disabled: 0 };
        }

        if (evaluation.result) {
          dailyStats[dayKey].enabled++;
        } else {
          dailyStats[dayKey].disabled++;
        }
      }
    }

    const analytics = {
      flagKey,
      totalEvaluations: historyData.length,
      enabledCount,
      disabledCount,
      uniqueUsers: uniqueUsersSet.size,
      lastEvaluated,
      dailyStats,
    };

    // Cache analytics for 5 minutes
    await this.redisService.setex(analyticsKey, 300, JSON.stringify(analytics));

    return analytics;
  }

  private async save(flag: FeatureFlag): Promise<void> {
    await this.redisService.set(`${this.cachePrefix}${flag.id}`, JSON.stringify(flag));
    await this.redisService.set(`${this.cachePrefix}key:${flag.key}`, JSON.stringify(flag));
  }

  private async getById(id: string): Promise<FeatureFlag | null> {
    const flagData = await this.redisService.get(`${this.cachePrefix}${id}`);
    return flagData ? JSON.parse(flagData) : null;
  }

  private getValueFromDto(dto: CreateFeatureFlagDto | UpdateFeatureFlagDto): unknown {
    switch (dto.type) {
      case FeatureFlagType.BOOLEAN:
        return dto.booleanValue ?? false;
      case FeatureFlagType.PERCENTAGE:
        return dto.percentageValue ?? 0;
      case FeatureFlagType.WHITELIST:
        return dto.whitelistValue ?? [];
      case FeatureFlagType.BLACKLIST:
        return dto.blacklistValue ?? [];
      default:
        return false;
    }
  }

  private evaluateFlag(flag: FeatureFlag, context: FlagEvaluationContext): FlagEvaluationResult {
    switch (flag.type) {
      case FeatureFlagType.BOOLEAN:
        return {
          flagKey: flag.key,
          enabled: flag.value as boolean,
          value: flag.value,
          reason: 'Boolean flag',
          timestamp: new Date(),
        };

      case FeatureFlagType.PERCENTAGE: {
        const percentage = flag.value as number;
        const hash = this.getStickyHash(context.userId || context.email || 'anonymous');
        const userPercentage = (hash % 100) + 1;
        const enabled = userPercentage <= percentage;
        return {
          flagKey: flag.key,
          enabled,
          value: flag.value,
          reason: `Percentage rollout: ${userPercentage}% <= ${percentage}%`,
          timestamp: new Date(),
        };
      }

      case FeatureFlagType.WHITELIST: {
        const whitelist = flag.value as string[];
        const userId = context.userId || context.email;
        const whitelisted = userId ? whitelist.includes(userId) : false;
        return {
          flagKey: flag.key,
          enabled: whitelisted,
          value: flag.value,
          reason: whitelisted ? 'User whitelisted' : 'User not in whitelist',
          timestamp: new Date(),
        };
      }

      case FeatureFlagType.BLACKLIST: {
        const blacklist = flag.value as string[];
        const blacklistedUserId = context.userId || context.email;
        const blacklisted = blacklistedUserId ? blacklist.includes(blacklistedUserId) : false;
        return {
          flagKey: flag.key,
          enabled: !blacklisted,
          value: flag.value,
          reason: blacklisted ? 'User blacklisted' : 'User not in blacklist',
          timestamp: new Date(),
        };
      }

      case FeatureFlagType.CONDITIONAL: {
        const conditionMet = this.evaluateConditions(flag.conditions || [], context);
        return {
          flagKey: flag.key,
          enabled: conditionMet,
          value: conditionMet,
          reason: conditionMet ? 'Conditions met' : 'Conditions not met',
          timestamp: new Date(),
        };
      }

      default:
        return {
          flagKey: flag.key,
          enabled: false,
          value: false,
          reason: 'Unknown flag type',
          timestamp: new Date(),
        };
    }
  }

  private evaluateConditions(
    conditions: FlagCondition[],
    context: FlagEvaluationContext,
  ): boolean {
    if (conditions.length === 0) return false;

    return conditions.every((condition) => {
      const fieldValue = this.getFieldValue(condition.field, context);
      return this.compareValues(fieldValue, condition.operator, condition.value);
    });
  }

  private getFieldValue(field: string, context: FlagEvaluationContext): unknown {
    const parts = field.split('.');
    let value: unknown = context;

    for (const part of parts) {
      if (value && typeof value === 'object' && part in value) {
        value = (value as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }

    return value;
  }

  private compareValues(actual: unknown, operator: string, expected: unknown): boolean {
    switch (operator) {
      case 'eq':
        return actual === expected;
      case 'ne':
        return actual !== expected;
      case 'gt':
        return Number(actual) > Number(expected);
      case 'gte':
        return Number(actual) >= Number(expected);
      case 'lt':
        return Number(actual) < Number(expected);
      case 'lte':
        return Number(actual) <= Number(expected);
      case 'in':
        return Array.isArray(expected) && expected.includes(actual);
      case 'nin':
        return Array.isArray(expected) && !expected.includes(actual);
      case 'contains':
        return (
          typeof actual === 'string' &&
          typeof expected === 'string' &&
          actual.includes(expected)
        );
      default:
        return false;
    }
  }

  private getStickyHash(identifier: string): number {
    const hash = createHash('md5').update(identifier).digest('hex');
    return parseInt(hash.substring(0, 8), 16);
  }

  private getContextHash(context: FlagEvaluationContext): string {
    const contextString = JSON.stringify({
      userId: context.userId,
      email: context.email,
      role: context.role,
      customAttributes: context.customAttributes,
    });
    return createHash('md5').update(contextString).digest('hex').substring(0, 8);
  }

  private async invalidateCache(flagKey: string): Promise<void> {
    const patterns = [`flags:list:*`, `${this.evaluationCachePrefix}${flagKey}:*`];

    for (const pattern of patterns) {
      const keys = await this.redisService.keys(pattern);
      if (keys.length > 0) {
        await this.redisService.del(...keys);
      }
    }
  }

  private async recordEvaluation(
    flagKey: string,
    result: FlagEvaluationResult,
    context: FlagEvaluationContext,
  ): Promise<void> {
    const historyKey = `${this.analyticsPrefix}${flagKey}:history`;
    const record = {
      userId: context.userId,
      result: result.enabled,
      value: result.value,
      context: {
        role: context.role,
        customAttributes: context.customAttributes,
      },
      timestamp: result.timestamp,
      reason: result.reason,
    };

    // Add to history (keep last 10000 records)
    await this.redisService.lpush(historyKey, JSON.stringify(record));
    await this.redisService.ltrim(historyKey, 0, 9999);

    // Invalidate analytics cache
    await this.redisService.del(`${this.analyticsPrefix}${flagKey}`);
  }

  private matchesFilters(flag: FeatureFlag, query?: FlagQueryDto): boolean {
    if (!query) return true;

    const { keys, status, type, tags, search } = query;

    if (keys) {
      const keyList = keys.split(',').map((k) => k.trim());
      if (!keyList.includes(flag.key)) return false;
    }

    if (status && flag.status !== status) return false;
    if (type && flag.type !== type) return false;

    if (tags) {
      const tagList = tags.split(',').map((t) => t.trim());
      const hasMatchingTag = tagList.some((tag) => flag.tags.includes(tag));
      if (!hasMatchingTag) return false;
    }

    if (search) {
      const searchLower = search.toLowerCase();
      const nameMatch = flag.name.toLowerCase().includes(searchLower);
      const descMatch = flag.description.toLowerCase().includes(searchLower);
      const keyMatch = flag.key.toLowerCase().includes(searchLower);
      if (!nameMatch && !descMatch && !keyMatch) return false;
    }

    return true;
  }

  private serializeQuery(query?: FlagQueryDto): string {
    if (!query) return '';

    const filtered = Object.entries(query)
      .filter(([_key, value]) => value !== undefined && value !== null)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('|');

    return filtered;
  }
}