import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../common/services/redis.service';
import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';
import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import {
  CacheEntry,
  CacheConfig,
  CacheStrategy,
  CacheContentType,
  CacheInvalidationRule,
  CacheAnalytics,
  CacheStats,
  CacheSearchCriteria,
  CacheEntryMetadata,
} from './models/static-cache.entity';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

@Injectable()
export class StaticContentCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StaticContentCacheService.name);
  private readonly cachePrefix = 'static-cache:';
  private readonly metadataPrefix = 'cache-metadata:';
  private readonly statsPrefix = 'cache-stats:';
  private readonly analyticsPrefix = 'cache-analytics:';
  private readonly tagsPrefix = 'cache-tags:';
  private readonly invalidationPrefix = 'cache-invalidation:';

  private config: CacheConfig;
  private cleanupInterval: NodeJS.Timeout;
  private stats: CacheStats;

  constructor(
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
  ) {
    this.config = {
      defaultTtl: this.configService.get<number>('STATIC_CACHE_DEFAULT_TTL', 3600),
      maxSize: this.configService.get<number>('STATIC_CACHE_MAX_SIZE', 100 * 1024 * 1024), // 100MB
      compressionThreshold: this.configService.get<number>('STATIC_CACHE_COMPRESSION_THRESHOLD', 1024),
      enableCompression: this.configService.get<boolean>('STATIC_CACHE_ENABLE_COMPRESSION', true),
      enableAnalytics: this.configService.get<boolean>('STATIC_CACHE_ENABLE_ANALYTICS', true),
      strategy: this.configService.get<CacheStrategy>('STATIC_CACHE_STRATEGY', CacheStrategy.TTL),
      cleanupInterval: this.configService.get<number>('STATIC_CACHE_CLEANUP_INTERVAL', 300000), // 5 minutes
      maxEntries: this.configService.get<number>('STATIC_CACHE_MAX_ENTRIES', 10000),
    };

    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      evictions: 0,
      compressions: 0,
      decompressions: 0,
      totalResponseTime: 0,
      lastReset: new Date(),
    };
  }

  async onModuleInit() {
    await this.initializeStats();
    this.startCleanupInterval();
    this.logger.log('Static content cache service initialized');
  }

  async onModuleDestroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    await this.saveStats();
    this.logger.log('Static content cache service destroyed');
  }

  async get(key: string): Promise<CacheEntry | null> {
    const startTime = Date.now();

    try {
      const cacheKey = this.getCacheKey(key);
      const cachedData = await this.redisService.get(cacheKey);

      if (!cachedData) {
        await this.recordMiss();
        return null;
      }

      const entry: CacheEntry = JSON.parse(cachedData);

      // Check TTL
      if (entry.ttl && Date.now() - entry.createdAt.getTime() > entry.ttl * 1000) {
        await this.delete(key);
        await this.recordMiss();
        return null;
      }

      // Update access statistics
      entry.lastAccessed = new Date();
      entry.accessCount++;
      await this.updateEntryAccess(entry);

      // Decompress if needed
      if (entry.compressed && typeof entry.content === 'string') {
        const compressed = Buffer.from(entry.content, 'base64');
        entry.content = (await gunzipAsync(compressed)).toString();
        await this.recordDecompression();
      }

      await this.recordHit(Date.now() - startTime);
      return entry;
    } catch (error) {
      this.logger.error(`Error getting cache entry for key: ${key}`, error);
      await this.recordMiss();
      return null;
    }
  }

  async set(
    key: string,
    content: string | Buffer,
    contentType: CacheContentType,
    options: {
      ttl?: number;
      tags?: string[];
      metadata?: CacheEntryMetadata;
      etag?: string;
      lastModified?: Date;
    } = {},
  ): Promise<void> {
    const startTime = Date.now();

    try {
      const { ttl = this.config.defaultTtl, tags = [], metadata = {}, etag, lastModified } = options;

      let processedContent = content;
      let compressed = false;
      const size = typeof content === 'string' ? content.length : content.length;

      // Compress if enabled and content is large enough
      if (this.config.enableCompression && size > this.config.compressionThreshold) {
        if (typeof content === 'string') {
          processedContent = await gzipAsync(Buffer.from(content));
          processedContent = (processedContent as Buffer).toString('base64');
          compressed = true;
          await this.recordCompression();
        }
      }

      const entry: CacheEntry = {
        key,
        content: processedContent,
        contentType,
        size,
        tags,
        metadata: metadata as Record<string, unknown>,
        createdAt: new Date(),
        lastAccessed: new Date(),
        accessCount: 0,
        ttl,
        etag,
        lastModified,
        compressed,
        version: 1,
      };

      const cacheKey = this.getCacheKey(key);
      await this.redisService.setex(cacheKey, ttl, JSON.stringify(entry));

      // Update tag indexes
      await this.updateTagIndexes(key, tags);

      // Check cache size limits
      await this.enforceSizeLimits();

      await this.recordSet(Date.now() - startTime);
      this.logger.debug(`Cached entry: ${key} (${size} bytes, ${compressed ? 'compressed' : 'uncompressed'})`);
    } catch (error) {
      this.logger.error(`Error setting cache entry for key: ${key}`, error);
      throw error;
    }
  }

  async delete(key: string): Promise<boolean> {
    try {
      const cacheKey = this.getCacheKey(key);
      const result = await this.redisService.del(cacheKey);

      if (result > 0) {
        await this.removeTagIndexes(key);
        await this.recordDelete();
        return true;
      }

      return false;
    } catch (error) {
      this.logger.error(`Error deleting cache entry for key: ${key}`, error);
      return false;
    }
  }

  async clear(): Promise<void> {
    try {
      const keys = await this.redisService.keys(`${this.cachePrefix}*`);
      if (keys.length > 0) {
        await this.redisService.del(...keys);
      }

      // Clear tag indexes
      const tagKeys = await this.redisService.keys(`${this.tagsPrefix}*`);
      if (tagKeys.length > 0) {
        await this.redisService.del(...tagKeys);
      }

      this.logger.log(`Cleared ${keys.length} cache entries`);
    } catch (error) {
      this.logger.error('Error clearing cache', error);
      throw error;
    }
  }

  async invalidateByTags(tags: string[]): Promise<number> {
    let invalidatedCount = 0;

    for (const tag of tags) {
      const tagKey = this.getTagKey(tag);
      const keys = await this.redisService.smembers(tagKey);

      if (keys.length > 0) {
        await this.redisService.del(...keys.map(k => this.getCacheKey(k)));
        await this.redisService.del(tagKey);
        invalidatedCount += keys.length;
      }
    }

    this.logger.log(`Invalidated ${invalidatedCount} entries by tags: ${tags.join(', ')}`);
    return invalidatedCount;
  }

  async invalidateByPattern(pattern: string): Promise<number> {
    const regex = new RegExp(pattern);
    const keys = await this.redisService.keys(`${this.cachePrefix}*`);
    const keysToDelete: string[] = [];

    for (const key of keys) {
      const entryKey = key.replace(this.cachePrefix, '');
      if (regex.test(entryKey)) {
        keysToDelete.push(key);
      }
    }

    if (keysToDelete.length > 0) {
      await this.redisService.del(...keysToDelete);
      await this.removeTagIndexesForKeys(keysToDelete.map(k => k.replace(this.cachePrefix, '')));
    }

    this.logger.log(`Invalidated ${keysToDelete.length} entries by pattern: ${pattern}`);
    return keysToDelete.length;
  }

  async search(criteria: CacheSearchCriteria): Promise<CacheEntry[]> {
    const results: CacheEntry[] = [];
    const keys = await this.redisService.keys(`${this.cachePrefix}*`);

    for (const key of keys) {
      try {
        const data = await this.redisService.get(key);
        if (!data) {
          continue;
        }

        const entry: CacheEntry = JSON.parse(data);

        if (this.matchesCriteria(entry, criteria)) {
          results.push(entry);
        }
      } catch (error) {
        this.logger.warn(`Error reading cache entry: ${key}`, error);
      }
    }

    return results;
  }

  async getAnalytics(): Promise<CacheAnalytics> {
    const cacheKey = `${this.analyticsPrefix}current`;
    const cached = await this.redisService.get(cacheKey);

    if (cached) {
      return JSON.parse(cached);
    }

    return await this.generateAnalytics();
  }

  async getStats(): Promise<CacheStats> {
    return { ...this.stats };
  }

  async resetStats(): Promise<void> {
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      evictions: 0,
      compressions: 0,
      decompressions: 0,
      totalResponseTime: 0,
      lastReset: new Date(),
    };

    await this.saveStats();
  }

  async warmCache(urls: string[], options: { priority?: number; ttl?: number } = {}): Promise<void> {
    this.logger.log(`Starting cache warming for ${urls.length} URLs`);

    // This would typically make HTTP requests to fetch content
    // For now, we'll just create placeholder entries
    for (const url of urls) {
      try {
        // In a real implementation, you'd fetch the content from the URL
        const content = `Cached content for ${url}`;
        await this.set(url, content, CacheContentType.HTML, {
          ttl: options.ttl || this.config.defaultTtl,
          metadata: { originalUrl: url, source: 'cache-warmer' },
          tags: ['warmed', 'auto-generated'],
        });
      } catch (error) {
        this.logger.warn(`Failed to warm cache for URL: ${url}`, error);
      }
    }

    this.logger.log(`Cache warming completed for ${urls.length} URLs`);
  }

  async export(): Promise<any> {
    const entries = await this.search({});
    const analytics = await this.getAnalytics();
    const stats = await this.getStats();

    return {
      entries,
      analytics,
      stats,
      config: this.config,
      exportedAt: new Date(),
      version: '1.0.0',
    };
  }

  async import(data: any): Promise<{ imported: number; skipped: number; errors: string[] }> {
    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];

    try {
      for (const entry of data.entries || []) {
        try {
          await this.set(entry.key, entry.content, entry.contentType, {
            ttl: entry.ttl,
            tags: entry.tags,
            metadata: entry.metadata,
            etag: entry.etag,
            lastModified: entry.lastModified,
          });
          imported++;
        } catch (error) {
          errors.push(`Failed to import entry ${entry.key}: ${error.message}`);
          skipped++;
        }
      }
    } catch (error) {
      errors.push(`Import failed: ${error.message}`);
    }

    this.logger.log(`Import completed: ${imported} imported, ${skipped} skipped, ${errors.length} errors`);
    return { imported, skipped, errors };
  }

  private async initializeStats(): Promise<void> {
    const statsKey = `${this.statsPrefix}current`;
    const cached = await this.redisService.get(statsKey);

    if (cached) {
      this.stats = JSON.parse(cached);
    } else {
      await this.saveStats();
    }
  }

  private async saveStats(): Promise<void> {
    const statsKey = `${this.statsPrefix}current`;
    await this.redisService.setex(statsKey, 3600, JSON.stringify(this.stats));
  }

  private getCacheKey(key: string): string {
    return `${this.cachePrefix}${key}`;
  }

  private getTagKey(tag: string): string {
    return `${this.tagsPrefix}${tag}`;
  }

  private async updateTagIndexes(key: string, tags: string[]): Promise<void> {
    for (const tag of tags) {
      const tagKey = this.getTagKey(tag);
      await this.redisService.sadd(tagKey, key);
      await this.redisService.expire(tagKey, this.config.defaultTtl);
    }
  }

  private async removeTagIndexes(key: string): Promise<void> {
    const entry = await this.get(key);
    if (entry) {
      for (const tag of entry.tags) {
        const tagKey = this.getTagKey(tag);
        await this.redisService.srem(tagKey, key);
      }
    }
  }

  private async removeTagIndexesForKeys(keys: string[]): Promise<void> {
    for (const key of keys) {
      await this.removeTagIndexes(key);
    }
  }

  private async updateEntryAccess(entry: CacheEntry): Promise<void> {
    const cacheKey = this.getCacheKey(entry.key);
    await this.redisService.setex(cacheKey, entry.ttl || this.config.defaultTtl, JSON.stringify(entry));
  }

  private async enforceSizeLimits(): Promise<void> {
    const currentSize = await this.getCurrentCacheSize();

    if (currentSize > this.config.maxSize) {
      await this.evictLeastRecentlyUsed(currentSize - this.config.maxSize);
    }

    const entryCount = await this.getEntryCount();
    if (entryCount > this.config.maxEntries) {
      await this.evictByCount(entryCount - this.config.maxEntries);
    }
  }

  private async getCurrentCacheSize(): Promise<number> {
    const keys = await this.redisService.keys(`${this.cachePrefix}*`);
    let totalSize = 0;

    for (const key of keys) {
      const data = await this.redisService.get(key);
      if (data) {
        const entry: CacheEntry = JSON.parse(data);
        totalSize += entry.size;
      }
    }

    return totalSize;
  }

  private async getEntryCount(): Promise<number> {
    const keys = await this.redisService.keys(`${this.cachePrefix}*`);
    return keys.length;
  }

  private async evictLeastRecentlyUsed(bytesToFree: number): Promise<void> {
    const entries = await this.search({});
    entries.sort((a, b) => a.lastAccessed.getTime() - b.lastAccessed.getTime());

    let freedBytes = 0;
    for (const entry of entries) {
      await this.delete(entry.key);
      freedBytes += entry.size;
      this.stats.evictions++;

      if (freedBytes >= bytesToFree) {
        break;
      }
    }

    this.logger.log(`Evicted LRU entries to free ${freedBytes} bytes`);
  }

  private async evictByCount(count: number): Promise<void> {
    const entries = await this.search({});
    entries.sort((a, b) => a.lastAccessed.getTime() - b.lastAccessed.getTime());

    for (let i = 0; i < Math.min(count, entries.length); i++) {
      await this.delete(entries[i].key);
      this.stats.evictions++;
    }

    this.logger.log(`Evicted ${count} entries by count`);
  }

  private matchesCriteria(entry: CacheEntry, criteria: CacheSearchCriteria): boolean {
    if (criteria.contentType && entry.contentType !== criteria.contentType) {
      return false;
    }
    if (criteria.tags && !criteria.tags.some(tag => entry.tags.includes(tag))) {
      return false;
    }
    if (criteria.minSize && entry.size < criteria.minSize) {
      return false;
    }
    if (criteria.maxSize && entry.size > criteria.maxSize) {
      return false;
    }
    if (criteria.minAccessCount && entry.accessCount < criteria.minAccessCount) {
      return false;
    }
    if (criteria.createdAfter && entry.createdAt < criteria.createdAfter) {
      return false;
    }
    if (criteria.createdBefore && entry.createdAt > criteria.createdBefore) {
      return false;
    }
    if (criteria.lastAccessedAfter && entry.lastAccessed < criteria.lastAccessedAfter) {
      return false;
    }
    if (criteria.lastAccessedBefore && entry.lastAccessed > criteria.lastAccessedBefore) {
      return false;
    }
    if (criteria.pattern && !new RegExp(criteria.pattern).test(entry.key)) {
      return false;
    }

    return true;
  }

  private async generateAnalytics(): Promise<CacheAnalytics> {
    const entries = await this.search({});
    const totalEntries = entries.length;
    const totalSize = entries.reduce((sum, entry) => sum + entry.size, 0);
    const hitRate =
      this.stats.hits + this.stats.misses > 0 ? this.stats.hits / (this.stats.hits + this.stats.misses) : 0;
    const missRate = 1 - hitRate;
    const averageResponseTime =
      this.stats.hits + this.stats.misses > 0
        ? this.stats.totalResponseTime / (this.stats.hits + this.stats.misses)
        : 0;

    const topAccessedEntries = entries.sort((a, b) => b.accessCount - a.accessCount).slice(0, 10);

    const entriesByContentType: Record<CacheContentType, number> = {} as any;
    const entriesByTag: Record<string, number> = {};

    for (const entry of entries) {
      entriesByContentType[entry.contentType] = (entriesByContentType[entry.contentType] || 0) + 1;

      for (const tag of entry.tags) {
        entriesByTag[tag] = (entriesByTag[tag] || 0) + 1;
      }
    }

    const evictionRate = this.stats.sets > 0 ? this.stats.evictions / this.stats.sets : 0;
    const compressionRatio = this.stats.compressions > 0 ? this.stats.decompressions / this.stats.compressions : 0;

    const analytics: CacheAnalytics = {
      totalEntries,
      totalSize,
      hitRate,
      missRate,
      averageResponseTime,
      topAccessedEntries,
      entriesByContentType,
      entriesByTag,
      evictionRate,
      compressionRatio,
      generatedAt: new Date(),
    };

    // Cache analytics for 5 minutes
    const cacheKey = `${this.analyticsPrefix}current`;
    await this.redisService.setex(cacheKey, 300, JSON.stringify(analytics));

    return analytics;
  }

  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(async () => {
      try {
        await this.cleanup();
      } catch (error) {
        this.logger.error('Error during cleanup', error);
      }
    }, this.config.cleanupInterval);
  }

  private async cleanup(): Promise<void> {
    const keys = await this.redisService.keys(`${this.cachePrefix}*`);
    let cleanedCount = 0;

    for (const key of keys) {
      try {
        const data = await this.redisService.get(key);
        if (!data) {
          continue;
        }

        const entry: CacheEntry = JSON.parse(data);

        // Check if entry has expired
        if (entry.ttl && Date.now() - entry.createdAt.getTime() > entry.ttl * 1000) {
          await this.redisService.del(key);
          await this.removeTagIndexes(entry.key);
          cleanedCount++;
        }
      } catch (error) {
        this.logger.warn(`Error during cleanup of key: ${key}`, error);
      }
    }

    if (cleanedCount > 0) {
      this.logger.log(`Cleaned up ${cleanedCount} expired entries`);
    }

    await this.saveStats();
  }

  private async recordHit(responseTime: number): Promise<void> {
    this.stats.hits++;
    this.stats.totalResponseTime += responseTime;
    await this.saveStats();
  }

  private async recordMiss(): Promise<void> {
    this.stats.misses++;
    this.stats.totalResponseTime += 1; // Assume 1ms for cache miss
    await this.saveStats();
  }

  private async recordSet(responseTime: number): Promise<void> {
    this.stats.sets++;
    this.stats.totalResponseTime += responseTime;
    await this.saveStats();
  }

  private async recordDelete(): Promise<void> {
    this.stats.deletes++;
    await this.saveStats();
  }

  private async recordCompression(): Promise<void> {
    this.stats.compressions++;
    await this.saveStats();
  }

  private async recordDecompression(): Promise<void> {
    this.stats.decompressions++;
    await this.saveStats();
  }
}
