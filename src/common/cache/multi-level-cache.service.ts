import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../services/redis.service';

export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  version: number;
  tags: string[];
}

export interface MultiLevelCacheOptions {
  l1Ttl?: number; // In-memory cache TTL (seconds)
  l2Ttl?: number; // Redis cache TTL (seconds)
  ttl?: number; // Generic TTL for backward compatibility
  tags?: string[];
  version?: number;
  staleWhileRevalidate?: boolean;
}

export interface CacheStats {
  l1Hits: number;
  l1Misses: number;
  l2Hits: number;
  l2Misses: number;
  totalRequests: number;
  l1HitRate: number;
  l2HitRate: number;
  overallHitRate: number;
  l1Size: number;
  l2Size: number;
}

export interface InvalidationPolicy {
  type: 'ttl' | 'tag' | 'pattern' | 'conditional';
  value: string | number | ((entry: any) => boolean);
  cascade?: boolean;
}

@Injectable()
export class MultiLevelCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MultiLevelCacheService.name);
  private l1Cache: Map<string, CacheEntry<any>> = new Map();
  private stats: CacheStats = {
    l1Hits: 0,
    l1Misses: 0,
    l2Hits: 0,
    l2Misses: 0,
    totalRequests: 0,
    l1HitRate: 0,
    l2HitRate: 0,
    overallHitRate: 0,
    l1Size: 0,
    l2Size: 0,
  };

  private readonly l1MaxSize: number;
  private readonly l1DefaultTtl: number;
  private readonly l2DefaultTtl: number;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private invalidationPolicies: Map<string, InvalidationPolicy[]> = new Map();

  constructor(
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
  ) {
    this.l1MaxSize = this.configService.get<number>('CACHE_L1_MAX_SIZE', 1000);
    this.l1DefaultTtl = this.configService.get<number>('CACHE_L1_TTL', 300); // 5 minutes
    this.l2DefaultTtl = this.configService.get<number>('CACHE_L2_TTL', 3600); // 1 hour
  }

  async onModuleInit(): Promise<void> {
    // Start cleanup interval for expired L1 entries
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredL1Entries();
    }, 60000); // Run every minute

    // Initialize invalidation policies
    this.initializeInvalidationPolicies();

    this.logger.log('Multi-level cache service initialized');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.l1Cache.clear();
    this.logger.log('Multi-level cache service destroyed');
  }

  /**
   * Initialize default invalidation policies
   */
  private initializeInvalidationPolicies(): void {
    // Property-related cache invalidation
    this.invalidationPolicies.set('property', [
      { type: 'pattern', value: 'property:*', cascade: true },
      { type: 'pattern', value: 'valuation:property:*', cascade: true },
    ]);

    // User-related cache invalidation
    this.invalidationPolicies.set('user', [
      { type: 'pattern', value: 'user:*', cascade: true },
      { type: 'pattern', value: 'permissions:user:*', cascade: true },
    ]);

    // Transaction-related cache invalidation
    this.invalidationPolicies.set('transaction', [
      { type: 'pattern', value: 'transaction:*', cascade: true },
      { type: 'pattern', value: 'balance:*', cascade: true },
    ]);
  }

  /**
   * Get value from multi-level cache
   */
  async get<T>(key: string): Promise<T | undefined> {
    this.stats.totalRequests++;

    // Level 1: In-memory cache
    const l1Entry = this.l1Cache.get(key);
    if (l1Entry && l1Entry.expiresAt > Date.now()) {
      this.stats.l1Hits++;
      this.updateHitRates();
      this.logger.debug(`L1 cache HIT: ${key}`);
      return l1Entry.value as T;
    }

    // Remove expired L1 entry
    if (l1Entry) {
      this.l1Cache.delete(key);
    }

    this.stats.l1Misses++;

    // Level 2: Redis cache
    try {
      const l2Value = await this.redisService.get(key);
      if (l2Value) {
        this.stats.l2Hits++;
        const parsed = JSON.parse(l2Value);

        // Promote to L1 cache
        this.setL1(key, parsed.value, {
          l1Ttl: this.l1DefaultTtl,
          tags: parsed.tags,
          version: parsed.version,
        });

        this.updateHitRates();
        this.logger.debug(`L2 cache HIT: ${key}`);
        return parsed.value as T;
      }
    } catch (error) {
      this.logger.error(`L2 cache GET error for key ${key}: ${error.message}`);
    }

    this.stats.l2Misses++;
    this.updateHitRates();
    this.logger.debug(`Cache MISS: ${key}`);
    return undefined;
  }

  /**
   * Set value in multi-level cache
   */
  async set<T>(key: string, value: T, options?: MultiLevelCacheOptions): Promise<void> {
    const l1Ttl = options?.l1Ttl ?? this.l1DefaultTtl;
    const l2Ttl = options?.l2Ttl ?? this.l2DefaultTtl;

    // Set in L1 cache
    this.setL1(key, value, options);

    // Set in L2 cache (Redis)
    try {
      const entry = {
        value,
        tags: options?.tags || [],
        version: options?.version || 1,
        timestamp: Date.now(),
      };
      await this.redisService.setex(key, l2Ttl, JSON.stringify(entry));
      this.logger.debug(`Cache SET: ${key} (L1: ${l1Ttl}s, L2: ${l2Ttl}s)`);
    } catch (error) {
      this.logger.error(`L2 cache SET error for key ${key}: ${error.message}`);
    }

    // Store tags for invalidation
    if (options?.tags) {
      for (const tag of options.tags) {
        await this.addKeyToTag(tag, key);
      }
    }
  }

  /**
   * Set value in L1 (in-memory) cache only
   */
  private setL1<T>(key: string, value: T, options?: MultiLevelCacheOptions): void {
    // Check if we need to evict entries
    if (this.l1Cache.size >= this.l1MaxSize && !this.l1Cache.has(key)) {
      this.evictL1Entries();
    }

    const ttl = (options?.l1Ttl ?? this.l1DefaultTtl) * 1000; // Convert to ms
    const entry: CacheEntry<T> = {
      value,
      expiresAt: Date.now() + ttl,
      version: options?.version || 1,
      tags: options?.tags || [],
    };

    this.l1Cache.set(key, entry);
    this.stats.l1Size = this.l1Cache.size;
  }

  /**
   * Delete value from multi-level cache
   */
  async del(key: string): Promise<void> {
    // Delete from L1
    this.l1Cache.delete(key);
    this.stats.l1Size = this.l1Cache.size;

    // Delete from L2
    try {
      await this.redisService.del(key);
      this.logger.debug(`Cache DEL: ${key}`);
    } catch (error) {
      this.logger.error(`Cache DEL error for key ${key}: ${error.message}`);
    }
  }

  /**
   * Get with automatic cache population
   */
  async wrap<T>(key: string, factory: () => Promise<T>, options?: MultiLevelCacheOptions): Promise<T> {
    // Try to get from cache
    const cached = await this.get<T>(key);
    if (cached !== undefined) {
      return cached;
    }

    // Generate fresh value
    const fresh = await factory();

    // Store in cache
    await this.set(key, fresh, options);

    return fresh;
  }

  /**
   * Invalidate cache entries by tag
   */
  async invalidateByTag(tag: string): Promise<number> {
    let count = 0;

    // Get all keys with this tag
    const keys = await this.getKeysByTag(tag);

    for (const key of keys) {
      await this.del(key);
      count++;
    }

    // Clear the tag index
    await this.redisService.del(`tag:${tag}`);

    this.logger.log(`Invalidated ${count} cache entries by tag: ${tag}`);
    return count;
  }

  /**
   * Invalidate cache entries by pattern
   */
  async invalidateByPattern(pattern: string): Promise<number> {
    let count = 0;

    // Invalidate in L1
    for (const key of this.l1Cache.keys()) {
      if (this.matchPattern(key, pattern)) {
        this.l1Cache.delete(key);
        count++;
      }
    }

    // Invalidate in L2
    try {
      const keys = await this.redisService.keys(pattern);
      for (const key of keys) {
        await this.redisService.del(key);
        count++;
      }
    } catch (error) {
      this.logger.error(`Pattern invalidation error for ${pattern}: ${error.message}`);
    }

    this.logger.log(`Invalidated ${count} cache entries by pattern: ${pattern}`);
    return count;
  }

  /**
   * Invalidate with cascade based on policies
   */
  async invalidateWithCascade(key: string): Promise<void> {
    const namespace = key.split(':')[0];
    const policies = this.invalidationPolicies.get(namespace) || [];

    // Apply invalidation policies
    for (const policy of policies) {
      if (policy.type === 'pattern' && typeof policy.value === 'string') {
        if (this.matchPattern(key, policy.value)) {
          await this.invalidateByPattern(policy.value);

          if (policy.cascade) {
            // Cascade to dependent keys
            const dependentPatterns = this.getDependentPatterns(namespace);
            for (const depPattern of dependentPatterns) {
              await this.invalidateByPattern(depPattern);
            }
          }
        }
      }
    }

    // Invalidate the original key
    await this.del(key);
  }

  /**
   * Register custom invalidation policy
   */
  registerInvalidationPolicy(namespace: string, policy: InvalidationPolicy): void {
    if (!this.invalidationPolicies.has(namespace)) {
      this.invalidationPolicies.set(namespace, []);
    }
    this.invalidationPolicies.get(namespace)!.push(policy);
    this.logger.log(`Registered invalidation policy for namespace: ${namespace}`);
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    return { ...this.stats };
  }

  /**
   * Reset cache statistics
   */
  resetStats(): void {
    this.stats = {
      l1Hits: 0,
      l1Misses: 0,
      l2Hits: 0,
      l2Misses: 0,
      totalRequests: 0,
      l1HitRate: 0,
      l2HitRate: 0,
      overallHitRate: 0,
      l1Size: this.l1Cache.size,
      l2Size: 0,
    };
  }

  /**
   * Clear all caches
   */
  async clear(): Promise<void> {
    // Clear L1
    this.l1Cache.clear();
    this.stats.l1Size = 0;

    // Clear L2 (Redis)
    try {
      await this.redisService.flushdb();
      this.logger.log('All caches cleared');
    } catch (error) {
      this.logger.error(`Failed to clear L2 cache: ${error.message}`);
    }
  }

  /**
   * Update hit rates
   */
  private updateHitRates(): void {
    const l1Total = this.stats.l1Hits + this.stats.l1Misses;
    const l2Total = this.stats.l2Hits + this.stats.l2Misses;

    this.stats.l1HitRate = l1Total > 0 ? this.stats.l1Hits / l1Total : 0;
    this.stats.l2HitRate = l2Total > 0 ? this.stats.l2Hits / l2Total : 0;
    this.stats.overallHitRate =
      this.stats.totalRequests > 0 ? (this.stats.l1Hits + this.stats.l2Hits) / this.stats.totalRequests : 0;
  }

  /**
   * Evict entries from L1 cache (LRU strategy)
   */
  private evictL1Entries(): void {
    const entriesToEvict = Math.ceil(this.l1MaxSize * 0.1); // Evict 10%
    let evicted = 0;

    // Simple LRU: remove oldest entries first
    const entries = Array.from(this.l1Cache.entries());
    entries.sort((a, b) => a[1].expiresAt - b[1].expiresAt);

    for (const [key] of entries) {
      if (evicted >= entriesToEvict) {
        break;
      }
      this.l1Cache.delete(key);
      evicted++;
    }

    this.stats.l1Size = this.l1Cache.size;
    this.logger.debug(`Evicted ${evicted} entries from L1 cache`);
  }

  /**
   * Cleanup expired L1 entries
   */
  private cleanupExpiredL1Entries(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.l1Cache.entries()) {
      if (entry.expiresAt <= now) {
        this.l1Cache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.stats.l1Size = this.l1Cache.size;
      this.logger.debug(`Cleaned up ${cleaned} expired L1 cache entries`);
    }
  }

  /**
   * Add key to tag index
   */
  private async addKeyToTag(tag: string, key: string): Promise<void> {
    try {
      await this.redisService.sadd(`tag:${tag}`, key);
    } catch (error) {
      this.logger.error(`Failed to add key to tag index: ${error.message}`);
    }
  }

  /**
   * Get keys by tag
   */
  private async getKeysByTag(tag: string): Promise<string[]> {
    try {
      return await this.redisService.smembers(`tag:${tag}`);
    } catch (error) {
      this.logger.error(`Failed to get keys by tag: ${error.message}`);
      return [];
    }
  }

  /**
   * Match key against pattern
   */
  private matchPattern(key: string, pattern: string): boolean {
    const regex = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);
    return regex.test(key);
  }

  /**
   * Get dependent patterns for cascade invalidation
   */
  private getDependentPatterns(namespace: string): string[] {
    const dependencies: Record<string, string[]> = {
      property: ['valuation:property:*', 'document:property:*'],
      user: ['permissions:user:*', 'roles:user:*'],
      transaction: ['balance:*', 'history:*'],
    };
    return dependencies[namespace] || [];
  }

  /**
   * Get all keys in L1 cache
   */
  getL1Keys(): string[] {
    return Array.from(this.l1Cache.keys());
  }

  /**
   * Get L2 (Redis) cache size
   */
  async getL2Size(): Promise<number> {
    try {
      const keys = await this.redisService.keys('*');
      return keys.length;
    } catch (error) {
      this.logger.error(`Failed to get L2 size: ${error.message}`);
      return 0;
    }
  }

  /**
   * Update cache entry version
   */
  async incrementVersion(key: string): Promise<number> {
    const entry = this.l1Cache.get(key);
    if (entry) {
      entry.version++;
    }

    try {
      const l2Entry = await this.redisService.get(key);
      if (l2Entry) {
        const parsed = JSON.parse(l2Entry);
        parsed.version++;
        const ttl = await this.redisService.ttl(key);
        await this.redisService.setex(key, ttl > 0 ? ttl : this.l2DefaultTtl, JSON.stringify(parsed));
        return parsed.version;
      }
    } catch (error) {
      this.logger.error(`Failed to increment version: ${error.message}`);
    }

    return entry?.version || 1;
  }
}
