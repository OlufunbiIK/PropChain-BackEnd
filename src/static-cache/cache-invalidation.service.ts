import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../common/services/redis.service';
import { Cron, CronExpression } from '@nestjs/schedule';
import { v4 as uuidv4 } from 'uuid';
import { CacheInvalidationRule, CacheAnalytics, CacheEntry } from './models/static-cache.entity';
import { StaticContentCacheService } from './static-content-cache.service';

@Injectable()
export class CacheInvalidationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheInvalidationService.name);
  private readonly rulesPrefix = 'cache-invalidation-rules:';
  private readonly historyPrefix = 'cache-invalidation-history:';
  private readonly schedulesPrefix = 'cache-invalidation-schedules:';

  private rules: Map<string, CacheInvalidationRule> = new Map();
  private invalidationHistory: Array<{
    id: string;
    ruleId?: string;
    type: string;
    reason: string;
    affectedKeys: number;
    timestamp: Date;
    duration: number;
  }> = [];

  constructor(
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
    private readonly cacheService: StaticContentCacheService,
  ) {}

  async onModuleInit() {
    await this.loadRules();
    this.logger.log('Cache invalidation service initialized');
  }

  async onModuleDestroy() {
    await this.saveRules();
    this.logger.log('Cache invalidation service destroyed');
  }

  async createRule(
    rule: Omit<CacheInvalidationRule, 'id' | 'createdAt' | 'triggerCount'>,
  ): Promise<CacheInvalidationRule> {
    const newRule: CacheInvalidationRule = {
      ...rule,
      id: uuidv4(),
      createdAt: new Date(),
      triggerCount: 0,
    };

    this.rules.set(newRule.id, newRule);
    await this.saveRule(newRule);

    this.logger.log(`Created invalidation rule: ${newRule.name}`);
    return newRule;
  }

  async updateRule(id: string, updates: Partial<CacheInvalidationRule>): Promise<CacheInvalidationRule | null> {
    const rule = this.rules.get(id);
    if (!rule) {
      return null;
    }

    const updatedRule = { ...rule, ...updates };
    this.rules.set(id, updatedRule);
    await this.saveRule(updatedRule);

    this.logger.log(`Updated invalidation rule: ${updatedRule.name}`);
    return updatedRule;
  }

  async deleteRule(id: string): Promise<boolean> {
    const rule = this.rules.get(id);
    if (!rule) {
      return false;
    }

    this.rules.delete(id);
    await this.redisService.del(`${this.rulesPrefix}${id}`);

    this.logger.log(`Deleted invalidation rule: ${rule.name}`);
    return true;
  }

  async getRules(): Promise<CacheInvalidationRule[]> {
    return Array.from(this.rules.values());
  }

  async getRule(id: string): Promise<CacheInvalidationRule | null> {
    return this.rules.get(id) || null;
  }

  async executeRule(
    id: string,
    reason?: string,
  ): Promise<{ success: boolean; affectedKeys: number; duration: number }> {
    const rule = this.rules.get(id);
    if (!rule) {
      throw new Error(`Rule not found: ${id}`);
    }

    if (!rule.isActive) {
      return { success: false, affectedKeys: 0, duration: 0 };
    }

    const startTime = Date.now();
    let affectedKeys = 0;

    try {
      switch (rule.type) {
        case 'TTL':
          affectedKeys = await this.executeTtlInvalidation(rule);
          break;
        case 'MANUAL':
          affectedKeys = await this.executeManualInvalidation(rule);
          break;
        case 'TAG_BASED':
          affectedKeys = await this.executeTagBasedInvalidation(rule);
          break;
        case 'PATTERN_BASED':
          affectedKeys = await this.executePatternBasedInvalidation(rule);
          break;
        default:
          throw new Error(`Unknown rule type: ${rule.type}`);
      }

      // Update rule statistics
      rule.triggerCount++;
      rule.lastTriggered = new Date();
      await this.saveRule(rule);

      const duration = Date.now() - startTime;

      // Record in history
      await this.recordInvalidation({
        id: uuidv4(),
        ruleId: id,
        type: rule.type,
        reason: reason || `Rule execution: ${rule.name}`,
        affectedKeys,
        timestamp: new Date(),
        duration,
      });

      this.logger.log(`Executed invalidation rule: ${rule.name} (${affectedKeys} keys, ${duration}ms)`);

      return { success: true, affectedKeys, duration };
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(`Error executing invalidation rule: ${rule.name}`, error);

      await this.recordInvalidation({
        id: uuidv4(),
        ruleId: id,
        type: rule.type,
        reason: `Rule execution failed: ${rule.name}`,
        affectedKeys: 0,
        timestamp: new Date(),
        duration,
      });

      return { success: false, affectedKeys: 0, duration };
    }
  }

  async invalidateByTags(tags: string[], reason: string = 'Manual tag invalidation'): Promise<number> {
    const startTime = Date.now();
    const affectedKeys = await this.cacheService.invalidateByTags(tags);
    const duration = Date.now() - startTime;

    await this.recordInvalidation({
      id: uuidv4(),
      type: 'TAG_BASED',
      reason,
      affectedKeys,
      timestamp: new Date(),
      duration,
    });

    this.logger.log(`Manual tag invalidation: ${tags.join(', ')} (${affectedKeys} keys, ${duration}ms)`);
    return affectedKeys;
  }

  async invalidateByPattern(pattern: string, reason: string = 'Manual pattern invalidation'): Promise<number> {
    const startTime = Date.now();
    const affectedKeys = await this.cacheService.invalidateByPattern(pattern);
    const duration = Date.now() - startTime;

    await this.recordInvalidation({
      id: uuidv4(),
      type: 'PATTERN_BASED',
      reason,
      affectedKeys,
      timestamp: new Date(),
      duration,
    });

    this.logger.log(`Manual pattern invalidation: ${pattern} (${affectedKeys} keys, ${duration}ms)`);
    return affectedKeys;
  }

  async invalidateExpired(reason: string = 'Expired entries cleanup'): Promise<number> {
    const startTime = Date.now();

    // Get all entries and check for expiration
    const entries = await this.cacheService.search({});
    const expiredKeys: string[] = [];

    for (const entry of entries) {
      if (entry.ttl && Date.now() - entry.createdAt.getTime() > entry.ttl * 1000) {
        expiredKeys.push(entry.key);
      }
    }

    // Delete expired entries
    let deletedCount = 0;
    for (const key of expiredKeys) {
      if (await this.cacheService.delete(key)) {
        deletedCount++;
      }
    }

    const duration = Date.now() - startTime;

    await this.recordInvalidation({
      id: uuidv4(),
      type: 'TTL',
      reason,
      affectedKeys: deletedCount,
      timestamp: new Date(),
      duration,
    });

    this.logger.log(`Expired entries cleanup: ${deletedCount} entries (${duration}ms)`);
    return deletedCount;
  }

  async invalidateByAge(maxAge: number, reason: string = 'Age-based invalidation'): Promise<number> {
    const startTime = Date.now();
    const cutoffDate = new Date(Date.now() - maxAge * 1000);

    const entries = await this.cacheService.search({
      createdBefore: cutoffDate,
    });

    let deletedCount = 0;
    for (const entry of entries) {
      if (await this.cacheService.delete(entry.key)) {
        deletedCount++;
      }
    }

    const duration = Date.now() - startTime;

    await this.recordInvalidation({
      id: uuidv4(),
      type: 'MANUAL',
      reason,
      affectedKeys: deletedCount,
      timestamp: new Date(),
      duration,
    });

    this.logger.log(`Age-based invalidation: ${deletedCount} entries older than ${maxAge}s (${duration}ms)`);
    return deletedCount;
  }

  async invalidateByAccessCount(minAccessCount: number, reason: string = 'Access count invalidation'): Promise<number> {
    const startTime = Date.now();

    const entries = await this.cacheService.search({
      minAccessCount,
    });

    let deletedCount = 0;
    for (const entry of entries) {
      if (await this.cacheService.delete(entry.key)) {
        deletedCount++;
      }
    }

    const duration = Date.now() - startTime;

    await this.recordInvalidation({
      id: uuidv4(),
      type: 'MANUAL',
      reason,
      affectedKeys: deletedCount,
      timestamp: new Date(),
      duration,
    });

    this.logger.log(
      `Access count invalidation: ${deletedCount} entries with < ${minAccessCount} accesses (${duration}ms)`,
    );
    return deletedCount;
  }

  async getInvalidationHistory(limit: number = 100): Promise<any[]> {
    const historyKey = `${this.historyPrefix}recent`;
    const history = await this.redisService.lrange(historyKey, 0, limit - 1);

    return history.map(record => JSON.parse(record));
  }

  async getInvalidationStats(days: number = 30): Promise<any> {
    const history = await this.getInvalidationHistory(1000);
    const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const recentHistory = history.filter(record => new Date(record.timestamp) >= cutoffDate);

    const stats = {
      totalInvalidations: recentHistory.length,
      byType: {} as Record<string, number>,
      averageDuration: 0,
      totalAffectedKeys: 0,
      topRules: {} as Record<string, number>,
      dailyStats: {} as Record<string, number>,
    };

    let totalDuration = 0;

    for (const record of recentHistory) {
      stats.byType[record.type] = (stats.byType[record.type] || 0) + 1;
      stats.totalAffectedKeys += record.affectedKeys;
      totalDuration += record.duration;

      if (record.ruleId) {
        stats.topRules[record.ruleId] = (stats.topRules[record.ruleId] || 0) + 1;
      }

      const day = record.timestamp.split('T')[0];
      stats.dailyStats[day] = (stats.dailyStats[day] || 0) + 1;
    }

    stats.averageDuration = recentHistory.length > 0 ? totalDuration / recentHistory.length : 0;

    return stats;
  }

  @Cron(CronExpression.EVERY_HOUR)
  async scheduledInvalidation(): Promise<void> {
    this.logger.debug('Running scheduled invalidation checks');

    for (const rule of this.rules.values()) {
      if (rule.isActive && this.shouldExecuteScheduledRule(rule)) {
        try {
          await this.executeRule(rule.id, 'Scheduled execution');
        } catch (error) {
          this.logger.error(`Scheduled invalidation failed for rule: ${rule.name}`, error);
        }
      }
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async cleanupInvalidationHistory(): Promise<void> {
    const historyKey = `${this.historyPrefix}recent`;
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Keep only last 30 days of history
    const history = await this.redisService.lrange(historyKey, 0, -1);
    const recentHistory = history.filter(record => {
      const parsed = JSON.parse(record);
      return new Date(parsed.timestamp) >= thirtyDaysAgo;
    });

    await this.redisService.del(historyKey);
    if (recentHistory.length > 0) {
      await this.redisService.lpush(historyKey, ...recentHistory);
    }

    this.logger.log(`Cleaned up invalidation history, kept ${recentHistory.length} records`);
  }

  private async executeTtlInvalidation(rule: CacheInvalidationRule): Promise<number> {
    const maxAge = rule.conditions.maxAge || rule.conditions.ttl || 3600;
    return await this.invalidateByAge(maxAge, `TTL rule: ${rule.name}`);
  }

  private async executeManualInvalidation(rule: CacheInvalidationRule): Promise<number> {
    // Manual rules might have custom conditions
    let deletedCount = 0;

    if (rule.conditions.maxAge) {
      deletedCount += await this.invalidateByAge(rule.conditions.maxAge, `Manual rule: ${rule.name}`);
    }

    if (rule.conditions.tags && rule.conditions.tags.length > 0) {
      deletedCount += await this.invalidateByTags(rule.conditions.tags, `Manual rule: ${rule.name}`);
    }

    if (rule.conditions.pattern) {
      deletedCount += await this.invalidateByPattern(rule.conditions.pattern, `Manual rule: ${rule.name}`);
    }

    return deletedCount;
  }

  private async executeTagBasedInvalidation(rule: CacheInvalidationRule): Promise<number> {
    if (!rule.conditions.tags || rule.conditions.tags.length === 0) {
      throw new Error('Tag-based rule must specify tags');
    }

    return await this.invalidateByTags(rule.conditions.tags, `Tag-based rule: ${rule.name}`);
  }

  private async executePatternBasedInvalidation(rule: CacheInvalidationRule): Promise<number> {
    if (!rule.conditions.pattern) {
      throw new Error('Pattern-based rule must specify pattern');
    }

    return await this.invalidateByPattern(rule.conditions.pattern, `Pattern-based rule: ${rule.name}`);
  }

  private shouldExecuteScheduledRule(rule: CacheInvalidationRule): boolean {
    // This is a simplified check - in a real implementation, you'd have
    // more sophisticated scheduling logic
    if (!rule.lastTriggered) {
      return true;
    }

    const hoursSinceLastExecution = (Date.now() - rule.lastTriggered.getTime()) / (1000 * 60 * 60);
    return hoursSinceLastExecution >= 24; // Execute once per day
  }

  private async loadRules(): Promise<void> {
    const keys = await this.redisService.keys(`${this.rulesPrefix}*`);

    for (const key of keys) {
      const ruleData = await this.redisService.get(key);
      if (ruleData) {
        const rule: CacheInvalidationRule = JSON.parse(ruleData);
        this.rules.set(rule.id, rule);
      }
    }

    this.logger.log(`Loaded ${this.rules.size} invalidation rules`);
  }

  private async saveRules(): Promise<void> {
    for (const rule of this.rules.values()) {
      await this.saveRule(rule);
    }
  }

  private async saveRule(rule: CacheInvalidationRule): Promise<void> {
    const ruleKey = `${this.rulesPrefix}${rule.id}`;
    await this.redisService.setex(ruleKey, 86400, JSON.stringify(rule)); // 24 hours TTL
  }

  private async recordInvalidation(record: any): Promise<void> {
    const historyKey = `${this.historyPrefix}recent`;
    await this.redisService.lpush(historyKey, JSON.stringify(record));
    await this.redisService.ltrim(historyKey, 0, 999); // Keep last 1000 records
    await this.redisService.expire(historyKey, 86400 * 30); // 30 days TTL
  }
}
