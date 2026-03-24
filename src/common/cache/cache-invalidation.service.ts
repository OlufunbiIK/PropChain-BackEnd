import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MultiLevelCacheService } from './multi-level-cache.service';
import { RedisService } from '../services/redis.service';

export interface InvalidationRule {
  id: string;
  name: string;
  description: string;
  type: 'ttl' | 'tag' | 'pattern' | 'conditional' | 'dependency' | 'time-based';
  target: string | string[] | RegExp;
  condition?: (value: any, metadata: CacheEntryMetadata) => boolean;
  action: 'delete' | 'refresh' | 'cascade';
  priority: number; // 1-10, higher = executed first
  enabled: boolean;
  metadata?: {
    createdAt: Date;
    lastExecuted: Date | null;
    executionCount: number;
  };
}

export interface CacheEntryMetadata {
  key: string;
  createdAt: number;
  lastAccessed: number;
  accessCount: number;
  tags: string[];
  ttl: number;
  size: number;
}

export interface InvalidationEvent {
  ruleId: string;
  key: string;
  action: string;
  timestamp: Date;
  success: boolean;
  error?: string;
}

export interface InvalidationStats {
  totalRules: number;
  activeRules: number;
  totalExecutions: number;
  successfulInvalidations: number;
  failedInvalidations: number;
  events: InvalidationEvent[];
  lastCleanup: Date | null;
}

@Injectable()
export class CacheInvalidationService {
  private readonly logger = new Logger(CacheInvalidationService.name);
  private rules: Map<string, InvalidationRule> = new Map();
  private stats: InvalidationStats = {
    totalRules: 0,
    activeRules: 0,
    totalExecutions: 0,
    successfulInvalidations: 0,
    failedInvalidations: 0,
    events: [],
    lastCleanup: null,
  };
  private readonly maxEvents: number;

  constructor(
    private readonly cacheService: MultiLevelCacheService,
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
  ) {
    this.maxEvents = this.configService.get<number>('CACHE_INVALIDATION_MAX_EVENTS', 1000);
    this.initializeDefaultRules();
  }

  /**
   * Initialize default invalidation rules
   */
  private initializeDefaultRules(): void {
    // Rule: Invalidate stale user sessions
    this.registerRule({
      id: 'rule-user-session-stale',
      name: 'Stale User Session Cleanup',
      description: 'Invalidate user sessions older than 24 hours',
      type: 'time-based',
      target: 'user:session:*',
      action: 'delete',
      priority: 5,
      enabled: true,
      condition: (_value, metadata) => {
        const maxAge = 24 * 60 * 60 * 1000; // 24 hours
        return Date.now() - metadata.createdAt > maxAge;
      },
      metadata: {
        createdAt: new Date(),
        lastExecuted: null,
        executionCount: 0,
      },
    });

    // Rule: Cascade property changes
    this.registerRule({
      id: 'rule-property-cascade',
      name: 'Property Change Cascade',
      description: 'Invalidate related caches when property data changes',
      type: 'dependency',
      target: 'property:*',
      action: 'cascade',
      priority: 9,
      enabled: true,
      metadata: {
        createdAt: new Date(),
        lastExecuted: null,
        executionCount: 0,
      },
    });

    // Rule: Refresh frequently accessed items
    this.registerRule({
      id: 'rule-frequent-refresh',
      name: 'Frequent Access Refresh',
      description: 'Refresh cache entries with high access counts before they expire',
      type: 'conditional',
      target: '*',
      action: 'refresh',
      priority: 3,
      enabled: true,
      condition: (_value, metadata) => {
        return metadata.accessCount > 100 && metadata.ttl < 300; // Less than 5 minutes remaining
      },
      metadata: {
        createdAt: new Date(),
        lastExecuted: null,
        executionCount: 0,
      },
    });

    // Rule: Cleanup expired tags
    this.registerRule({
      id: 'rule-expired-tags',
      name: 'Expired Tag Cleanup',
      description: 'Remove tag indexes for deleted entries',
      type: 'tag',
      target: 'tag:*',
      action: 'delete',
      priority: 2,
      enabled: true,
      metadata: {
        createdAt: new Date(),
        lastExecuted: null,
        executionCount: 0,
      },
    });

    // Rule: Large entry cleanup
    this.registerRule({
      id: 'rule-large-entries',
      name: 'Large Entry Cleanup',
      description: 'Remove large cache entries that are rarely accessed',
      type: 'conditional',
      target: '*',
      action: 'delete',
      priority: 4,
      enabled: true,
      condition: (_value, metadata) => {
        return metadata.size > 1024 * 1024 && metadata.accessCount < 5; // > 1MB and < 5 accesses
      },
      metadata: {
        createdAt: new Date(),
        lastExecuted: null,
        executionCount: 0,
      },
    });
  }

  /**
   * Register a new invalidation rule
   */
  registerRule(rule: InvalidationRule): void {
    this.rules.set(rule.id, rule);
    this.updateStats();
    this.logger.log(`Registered invalidation rule: ${rule.name} (${rule.id})`);
  }

  /**
   * Unregister an invalidation rule
   */
  unregisterRule(ruleId: string): boolean {
    const deleted = this.rules.delete(ruleId);
    if (deleted) {
      this.updateStats();
      this.logger.log(`Unregistered invalidation rule: ${ruleId}`);
    }
    return deleted;
  }

  /**
   * Enable/disable a rule
   */
  setRuleEnabled(ruleId: string, enabled: boolean): boolean {
    const rule = this.rules.get(ruleId);
    if (rule) {
      rule.enabled = enabled;
      this.updateStats();
      this.logger.log(`Rule ${ruleId} ${enabled ? 'enabled' : 'disabled'}`);
      return true;
    }
    return false;
  }

  /**
   * Execute a specific rule
   */
  async executeRule(ruleId: string): Promise<number> {
    const rule = this.rules.get(ruleId);
    if (!rule) {
      this.logger.warn(`Rule not found: ${ruleId}`);
      return 0;
    }

    if (!rule.enabled) {
      this.logger.log(`Rule ${ruleId} is disabled, skipping`);
      return 0;
    }

    this.logger.log(`Executing invalidation rule: ${rule.name}`);
    let invalidatedCount = 0;

    try {
      switch (rule.type) {
        case 'pattern':
          invalidatedCount = await this.executePatternRule(rule);
          break;
        case 'tag':
          invalidatedCount = await this.executeTagRule(rule);
          break;
        case 'conditional':
          invalidatedCount = await this.executeConditionalRule(rule);
          break;
        case 'dependency':
          invalidatedCount = await this.executeDependencyRule(rule);
          break;
        case 'time-based':
          invalidatedCount = await this.executeTimeBasedRule(rule);
          break;
        default:
          this.logger.warn(`Unknown rule type: ${rule.type}`);
      }

      // Update rule metadata
      rule.metadata!.lastExecuted = new Date();
      rule.metadata!.executionCount++;

      // Record event
      this.recordEvent({
        ruleId: rule.id,
        key: rule.target as string,
        action: rule.action,
        timestamp: new Date(),
        success: true,
      });

      this.stats.successfulInvalidations += invalidatedCount;
    } catch (error) {
      this.logger.error(`Failed to execute rule ${ruleId}: ${error.message}`);

      this.recordEvent({
        ruleId: rule.id,
        key: rule.target as string,
        action: rule.action,
        timestamp: new Date(),
        success: false,
        error: error.message,
      });

      this.stats.failedInvalidations++;
    }

    this.stats.totalExecutions++;
    return invalidatedCount;
  }

  /**
   * Execute all enabled rules
   */
  async executeAllRules(): Promise<Map<string, number>> {
    const results = new Map<string, number>();

    // Sort rules by priority (highest first)
    const sortedRules = Array.from(this.rules.values())
      .filter(r => r.enabled)
      .sort((a, b) => b.priority - a.priority);

    for (const rule of sortedRules) {
      const count = await this.executeRule(rule.id);
      results.set(rule.id, count);
    }

    return results;
  }

  /**
   * Execute pattern-based rule
   */
  private async executePatternRule(rule: InvalidationRule): Promise<number> {
    const pattern = rule.target as string;
    const keys = await this.cacheService.invalidateByPattern(pattern);
    this.logger.log(`Pattern rule executed: ${keys} keys invalidated matching ${pattern}`);
    return keys;
  }

  /**
   * Execute tag-based rule
   */
  private async executeTagRule(rule: InvalidationRule): Promise<number> {
    const tagPattern = rule.target as string;
    let totalInvalidated = 0;

    // Find all tags matching the pattern
    const tagKeys = await this.redisService.keys(tagPattern);

    for (const tagKey of tagKeys) {
      const tag = tagKey.replace('tag:', '');
      const count = await this.cacheService.invalidateByTag(tag);
      totalInvalidated += count;
    }

    this.logger.log(`Tag rule executed: ${totalInvalidated} keys invalidated`);
    return totalInvalidated;
  }

  /**
   * Execute conditional rule
   */
  private async executeConditionalRule(rule: InvalidationRule): Promise<number> {
    if (!rule.condition) {
      return 0;
    }

    const pattern = rule.target as string;
    const keys = await this.redisService.keys(pattern);
    let invalidatedCount = 0;

    for (const key of keys) {
      try {
        const value = await this.redisService.get(key);
        if (!value) {
          continue;
        }

        const metadata = await this.getEntryMetadata(key, value);

        if (rule.condition(JSON.parse(value), metadata)) {
          await this.cacheService.del(key);
          invalidatedCount++;
        }
      } catch (error) {
        this.logger.error(`Error checking condition for key ${key}: ${error.message}`);
      }
    }

    this.logger.log(`Conditional rule executed: ${invalidatedCount} keys invalidated`);
    return invalidatedCount;
  }

  /**
   * Execute dependency rule (cascade invalidation)
   */
  private async executeDependencyRule(rule: InvalidationRule): Promise<number> {
    const pattern = rule.target as string;
    const keys = await this.redisService.keys(pattern);
    let totalInvalidated = 0;

    for (const key of keys) {
      await this.cacheService.invalidateWithCascade(key);
      totalInvalidated++;
    }

    this.logger.log(`Dependency rule executed: ${totalInvalidated} keys invalidated with cascade`);
    return totalInvalidated;
  }

  /**
   * Execute time-based rule
   */
  private async executeTimeBasedRule(rule: InvalidationRule): Promise<number> {
    if (!rule.condition) {
      return 0;
    }

    const pattern = rule.target as string;
    const keys = await this.redisService.keys(pattern);
    let invalidatedCount = 0;

    for (const key of keys) {
      try {
        const value = await this.redisService.get(key);
        if (!value) {
          continue;
        }

        const metadata = await this.getEntryMetadata(key, value);

        if (rule.condition(null, metadata)) {
          await this.cacheService.del(key);
          invalidatedCount++;
        }
      } catch (error) {
        this.logger.error(`Error checking time condition for key ${key}: ${error.message}`);
      }
    }

    this.logger.log(`Time-based rule executed: ${invalidatedCount} keys invalidated`);
    return invalidatedCount;
  }

  /**
   * Get metadata for a cache entry
   */
  private async getEntryMetadata(key: string, value: string): Promise<CacheEntryMetadata> {
    const parsed = JSON.parse(value);
    const ttl = await this.redisService.ttl(key);

    return {
      key,
      createdAt: parsed.timestamp || Date.now(),
      lastAccessed: parsed.lastAccessed || parsed.timestamp || Date.now(),
      accessCount: parsed.accessCount || 0,
      tags: parsed.tags || [],
      ttl,
      size: value.length,
    };
  }

  /**
   * Invalidate by tags with policy enforcement
   */
  async invalidateByTagsWithPolicy(tags: string[], policy?: { cascade?: boolean; refresh?: boolean }): Promise<number> {
    let totalInvalidated = 0;

    for (const tag of tags) {
      const count = await this.cacheService.invalidateByTag(tag);
      totalInvalidated += count;

      if (policy?.cascade) {
        // Find and invalidate dependent keys
        const dependentPatterns = this.getDependentPatterns(tag);
        for (const pattern of dependentPatterns) {
          const cascadeCount = await this.cacheService.invalidateByPattern(pattern);
          totalInvalidated += cascadeCount;
        }
      }
    }

    this.logger.log(`Invalidated ${totalInvalidated} entries by tags with policy`);
    return totalInvalidated;
  }

  /**
   * Smart invalidation based on entity changes
   */
  async smartInvalidate(
    entityType: string,
    entityId: string,
    changeType: 'create' | 'update' | 'delete',
  ): Promise<void> {
    this.logger.log(`Smart invalidation for ${entityType}:${entityId} (${changeType})`);

    // Define invalidation patterns based on entity type and change type
    const invalidationMap: Record<string, Record<string, string[]>> = {
      property: {
        update: [`property:${entityId}`, `valuation:property:${entityId}:*`, `document:property:${entityId}:*`],
        delete: [`property:${entityId}`, `property:*:list`, `valuation:*`],
        create: ['property:*:list', 'property:recent:*'],
      },
      user: {
        update: [`user:${entityId}`, `user:${entityId}:permissions`, `user:${entityId}:roles`],
        delete: [`user:${entityId}`, `user:*:list`, `session:${entityId}:*`],
        create: ['user:*:list', 'user:active:*'],
      },
      transaction: {
        update: [`transaction:${entityId}`, `transaction:*:list`],
        delete: [`transaction:${entityId}`, `transaction:*:list`, `balance:*`],
        create: ['transaction:*:list', 'transaction:recent:*', 'balance:*'],
      },
    };

    const patterns = invalidationMap[entityType]?.[changeType] || [];

    for (const pattern of patterns) {
      await this.cacheService.invalidateByPattern(pattern);
    }
  }

  /**
   * Scheduled cleanup of expired entries
   */
  @Cron(CronExpression.EVERY_HOUR)
  async scheduledCleanup(): Promise<void> {
    this.logger.log('Running scheduled cache invalidation cleanup');

    // Execute time-based rules
    for (const rule of this.rules.values()) {
      if (rule.enabled && rule.type === 'time-based') {
        await this.executeRule(rule.id);
      }
    }

    // Clean up old events
    this.cleanupOldEvents();

    this.stats.lastCleanup = new Date();
  }

  /**
   * Scheduled refresh of high-priority entries
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async scheduledRefresh(): Promise<void> {
    this.logger.log('Running scheduled cache refresh');

    // Execute conditional rules for refresh
    for (const rule of this.rules.values()) {
      if (rule.enabled && rule.type === 'conditional' && rule.action === 'refresh') {
        await this.executeRule(rule.id);
      }
    }
  }

  /**
   * Get invalidation statistics
   */
  getStats(): InvalidationStats {
    return {
      ...this.stats,
      events: [...this.stats.events],
    };
  }

  /**
   * Get all rules
   */
  getRules(): InvalidationRule[] {
    return Array.from(this.rules.values());
  }

  /**
   * Get a specific rule
   */
  getRule(ruleId: string): InvalidationRule | undefined {
    return this.rules.get(ruleId);
  }

  /**
   * Record an invalidation event
   */
  private recordEvent(event: InvalidationEvent): void {
    this.stats.events.push(event);

    // Keep only recent events
    if (this.stats.events.length > this.maxEvents) {
      this.stats.events.shift();
    }
  }

  /**
   * Clean up old events
   */
  private cleanupOldEvents(): void {
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    const cutoff = Date.now() - maxAge;

    this.stats.events = this.stats.events.filter(e => e.timestamp.getTime() > cutoff);
  }

  /**
   * Update statistics
   */
  private updateStats(): void {
    const allRules = Array.from(this.rules.values());
    this.stats.totalRules = allRules.length;
    this.stats.activeRules = allRules.filter(r => r.enabled).length;
  }

  /**
   * Get dependent patterns for cascade invalidation
   */
  private getDependentPatterns(tag: string): string[] {
    const dependencies: Record<string, string[]> = {
      property: ['valuation:*', 'document:property:*'],
      user: ['permissions:*', 'roles:*', 'session:*'],
      transaction: ['balance:*', 'history:*'],
    };

    return dependencies[tag] || [];
  }

  /**
   * Batch invalidate multiple keys
   */
  async batchInvalidate(keys: string[]): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;

    for (const key of keys) {
      try {
        await this.cacheService.del(key);
        success++;
      } catch (error) {
        this.logger.error(`Failed to invalidate key ${key}: ${error.message}`);
        failed++;
      }
    }

    return { success, failed };
  }

  /**
   * Invalidate with callback for refresh
   */
  async invalidateWithCallback(key: string, refreshCallback?: () => Promise<any>): Promise<void> {
    // Delete the old value
    await this.cacheService.del(key);

    // If refresh callback provided, execute it and cache the result
    if (refreshCallback) {
      try {
        const newValue = await refreshCallback();
        await this.cacheService.set(key, newValue);
        this.logger.log(`Refreshed cache key after invalidation: ${key}`);
      } catch (error) {
        this.logger.error(`Failed to refresh cache key ${key}: ${error.message}`);
      }
    }
  }
}
