import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RedisService } from '../common/services/redis.service';
import { v4 as uuidv4 } from 'uuid';
import { StaticContentCacheService } from './static-content-cache.service';
import {
  CacheContentType,
  CacheWarmingJob,
  CacheWarmingStrategy,
  CacheWarmingResult,
} from './models/static-cache.entity';

@Injectable()
export class CacheWarmingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheWarmingService.name);
  private readonly jobsPrefix = 'cache-warming-jobs:';
  private readonly resultsPrefix = 'cache-warming-results:';
  private readonly strategiesPrefix = 'cache-warming-strategies:';

  private jobs: Map<string, CacheWarmingJob> = new Map();
  private strategies: Map<string, CacheWarmingStrategy> = new Map();
  private warmingInterval: NodeJS.Timeout;
  private isWarming = false;

  constructor(
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
    private readonly cacheService: StaticContentCacheService,
  ) {}

  async onModuleInit() {
    await this.loadJobs();
    await this.loadStrategies();
    await this.initializeDefaultStrategies();
    this.startWarmingScheduler();
    this.logger.log('Cache warming service initialized');
  }

  async onModuleDestroy() {
    if (this.warmingInterval) {
      clearInterval(this.warmingInterval);
    }
    await this.saveJobs();
    await this.saveStrategies();
    this.logger.log('Cache warming service destroyed');
  }

  async createJob(
    job: Omit<CacheWarmingJob, 'id' | 'successCount' | 'failureCount' | 'averageDuration'>,
  ): Promise<CacheWarmingJob> {
    const newJob: CacheWarmingJob = {
      ...job,
      id: uuidv4(),
      successCount: 0,
      failureCount: 0,
      averageDuration: 0,
    };

    this.jobs.set(newJob.id, newJob);
    await this.saveJob(newJob);

    this.logger.log(`Created cache warming job: ${newJob.name}`);
    return newJob;
  }

  async updateJob(id: string, updates: Partial<CacheWarmingJob>): Promise<CacheWarmingJob | null> {
    const job = this.jobs.get(id);
    if (!job) {
      return null;
    }

    const updatedJob = { ...job, ...updates };
    this.jobs.set(id, updatedJob);
    await this.saveJob(updatedJob);

    this.logger.log(`Updated cache warming job: ${updatedJob.name}`);
    return updatedJob;
  }

  async deleteJob(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job) {
      return false;
    }

    this.jobs.delete(id);
    await this.redisService.del(`${this.jobsPrefix}${id}`);

    this.logger.log(`Deleted cache warming job: ${job.name}`);
    return true;
  }

  async getJobs(): Promise<CacheWarmingJob[]> {
    return Array.from(this.jobs.values());
  }

  async getJob(id: string): Promise<CacheWarmingJob | null> {
    return this.jobs.get(id) || null;
  }

  async executeJob(jobId: string): Promise<CacheWarmingResult> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    if (!job.isActive) {
      throw new Error(`Job is not active: ${job.name}`);
    }

    this.logger.log(`Starting cache warming job: ${job.name}`);

    const result: CacheWarmingResult = {
      jobId: job.id,
      jobName: job.name,
      startTime: new Date(),
      endTime: new Date(),
      duration: 0,
      totalUrls: job.urls.length,
      successCount: 0,
      failureCount: 0,
      errors: [],
      warmedEntries: [],
    };

    const startTime = Date.now();

    try {
      // Warm URLs in parallel with concurrency control
      const concurrency = 5; // Process 5 URLs at a time
      const chunks = this.chunkArray(job.urls, concurrency);

      for (const chunk of chunks) {
        const promises = chunk.map(url => this.warmUrl(url, job));
        const results = await Promise.allSettled(promises);

        for (const promiseResult of results) {
          if (promiseResult.status === 'fulfilled') {
            const warmResult = promiseResult.value;
            if (warmResult.success) {
              result.successCount++;
              result.warmedEntries.push(
                warmResult.entry || {
                  url: warmResult.url,
                  key: warmResult.url,
                  size: 0,
                  contentType: 'JSON' as any,
                  duration: 0,
                },
              );
            } else {
              result.failureCount++;
              result.errors.push({
                url: warmResult.url,
                error: warmResult.error || 'Unknown error',
                timestamp: new Date(),
              });
            }
          } else {
            result.failureCount++;
            result.errors.push({
              url: 'unknown',
              error: promiseResult.reason?.message || 'Unknown error',
              timestamp: new Date(),
            });
          }
        }
      }

      // Update job statistics
      const endTime = Date.now();
      const duration = endTime - startTime;

      job.lastRun = new Date(startTime);
      job.successCount += result.successCount;
      job.failureCount += result.failureCount;
      job.averageDuration = (job.averageDuration + duration) / 2;
      job.nextRun = new Date(endTime + job.interval * 60 * 1000);

      await this.saveJob(job);

      result.endTime = new Date(endTime);
      result.duration = duration;

      // Save result
      await this.saveResult(result);

      this.logger.log(
        `Completed cache warming job: ${job.name} (${result.successCount}/${result.totalUrls} successful, ${duration}ms)`,
      );
    } catch (error) {
      result.endTime = new Date();
      result.duration = Date.now() - startTime;
      result.errors.push({
        url: 'job-execution',
        error: error.message,
        timestamp: new Date(),
      });

      this.logger.error(`Error executing cache warming job: ${job.name}`, error);
    }

    return result;
  }

  async warmPopularContent(limit: number = 50): Promise<CacheWarmingResult> {
    // Get analytics to find popular content
    const analytics = await this.cacheService.getAnalytics();
    const popularUrls = analytics.topAccessedEntries.slice(0, limit).map(entry => entry.key);

    const job: CacheWarmingJob = {
      id: uuidv4(),
      name: 'Popular Content Warming',
      description: 'Warm most frequently accessed content',
      urls: popularUrls,
      priority: 1,
      interval: 60,
      isActive: true,
      successCount: 0,
      failureCount: 0,
      averageDuration: 0,
      metadata: { strategy: 'popular', limit },
      tags: ['popular', 'auto-generated'],
      ttl: 3600,
    };

    return await this.executeJob(job.id);
  }

  async warmUserBasedContent(userId: string, userPreferences?: Record<string, unknown>): Promise<CacheWarmingResult> {
    // Generate URLs based on user preferences and behavior
    const urls = this.generateUserBasedUrls(userId, userPreferences);

    const job: CacheWarmingJob = {
      id: uuidv4(),
      name: `User-based Warming: ${userId}`,
      description: `Warm content for user ${userId}`,
      urls,
      priority: 2,
      interval: 30,
      isActive: true,
      successCount: 0,
      failureCount: 0,
      averageDuration: 0,
      metadata: { strategy: 'user-based', userId, userPreferences },
      tags: ['user-based', 'personalized'],
      ttl: 1800,
    };

    return await this.executeJob(job.id);
  }

  async warmTimeBasedContent(): Promise<CacheWarmingResult> {
    // Generate URLs based on time of day and patterns
    const urls = this.generateTimeBasedUrls();

    const job: CacheWarmingJob = {
      id: uuidv4(),
      name: 'Time-based Content Warming',
      description: 'Warm content based on current time patterns',
      urls,
      priority: 3,
      interval: 15,
      isActive: true,
      successCount: 0,
      failureCount: 0,
      averageDuration: 0,
      metadata: { strategy: 'time-based', hour: new Date().getHours() },
      tags: ['time-based', 'scheduled'],
      ttl: 900,
    };

    return await this.executeJob(job.id);
  }

  async createStrategy(strategy: Omit<CacheWarmingStrategy, 'id' | 'results'>): Promise<CacheWarmingStrategy> {
    const newStrategy: CacheWarmingStrategy = {
      ...strategy,
      id: uuidv4(),
      results: [],
    };

    this.strategies.set(newStrategy.id, newStrategy);
    await this.saveStrategy(newStrategy);

    this.logger.log(`Created cache warming strategy: ${newStrategy.name}`);
    return newStrategy;
  }

  async executeStrategy(strategyId: string): Promise<CacheWarmingResult> {
    const strategy = this.strategies.get(strategyId);
    if (!strategy) {
      throw new Error(`Strategy not found: ${strategyId}`);
    }

    if (!strategy.isActive) {
      throw new Error(`Strategy is not active: ${strategy.name}`);
    }

    let result: CacheWarmingResult;

    switch (strategy.type) {
      case 'POPULAR_CONTENT':
        result = await this.warmPopularContent((strategy.config.limit as number) || 50);
        break;
      case 'USER_BASED':
        const userId = strategy.config.userId as string;
        const userPreferences = strategy.config.userPreferences as Record<string, unknown>;
        result = await this.warmUserBasedContent(userId, userPreferences);
        break;
      case 'TIME_BASED':
        result = await this.warmTimeBasedContent();
        break;
      case 'CUSTOM':
        result = await this.executeCustomStrategy(strategy);
        break;
      default:
        throw new Error(`Unknown strategy type: ${strategy.type}`);
    }

    // Update strategy
    strategy.lastExecuted = new Date();
    strategy.results.push(result);

    // Keep only last 10 results
    if (strategy.results.length > 10) {
      strategy.results = strategy.results.slice(-10);
    }

    await this.saveStrategy(strategy);

    return result;
  }

  async getWarmingHistory(limit: number = 50): Promise<CacheWarmingResult[]> {
    const resultsKey = `${this.resultsPrefix}recent`;
    const results = await this.redisService.lrange(resultsKey, 0, limit - 1);

    return results.map(result => JSON.parse(result));
  }

  async getWarmingStats(days: number = 7): Promise<any> {
    const history = await this.getWarmingHistory(1000);
    const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const recentHistory = history.filter(result => new Date(result.startTime) >= cutoffDate);

    const stats = {
      totalJobs: recentHistory.length,
      totalUrls: recentHistory.reduce((sum, result) => sum + result.totalUrls, 0),
      successRate: 0,
      averageDuration: 0,
      topJobs: {} as Record<string, number>,
      errorsByType: {} as Record<string, number>,
      dailyStats: {} as Record<string, number>,
    };

    let totalSuccesses = 0;
    let totalFailures = 0;
    let totalDuration = 0;

    for (const result of recentHistory) {
      totalSuccesses += result.successCount;
      totalFailures += result.failureCount;
      totalDuration += result.duration;

      stats.topJobs[result.jobName] = (stats.topJobs[result.jobName] || 0) + 1;

      for (const error of result.errors) {
        const errorType = error.error.split(':')[0] || 'unknown';
        stats.errorsByType[errorType] = (stats.errorsByType[errorType] || 0) + 1;
      }

      const day = result.startTime.toISOString().split('T')[0];
      stats.dailyStats[day] = (stats.dailyStats[day] || 0) + 1;
    }

    stats.successRate = totalSuccesses + totalFailures > 0 ? totalSuccesses / (totalSuccesses + totalFailures) : 0;
    stats.averageDuration = recentHistory.length > 0 ? totalDuration / recentHistory.length : 0;

    return stats;
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async scheduledWarming(): Promise<void> {
    if (this.isWarming) {
      this.logger.debug('Warming already in progress, skipping scheduled run');
      return;
    }

    this.logger.debug('Running scheduled cache warming');

    const now = new Date();
    const jobsToRun: string[] = [];

    // Find jobs that need to run
    for (const job of this.jobs.values()) {
      if (job.isActive && job.nextRun && job.nextRun <= now) {
        jobsToRun.push(job.id);
      }
    }

    // Execute jobs in priority order
    jobsToRun.sort((a, b) => {
      const jobA = this.jobs.get(a);
      const jobB = this.jobs.get(b);
      if (!jobA || !jobB) {
        return 0;
      }
      return jobA.priority - jobB.priority;
    });

    for (const jobId of jobsToRun) {
      try {
        this.isWarming = true;
        await this.executeJob(jobId);
      } catch (error) {
        this.logger.error(`Scheduled warming failed for job: ${jobId}`, error);
      } finally {
        this.isWarming = false;
      }
    }

    if (jobsToRun.length > 0) {
      this.logger.log(`Scheduled warming completed for ${jobsToRun.length} jobs`);
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
  async automaticPopularWarming(): Promise<void> {
    try {
      await this.warmPopularContent(25);
    } catch (error) {
      this.logger.error('Automatic popular content warming failed', error);
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_6AM)
  async cleanupWarmingHistory(): Promise<void> {
    const resultsKey = `${this.resultsPrefix}recent`;
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Keep only last 30 days of history
    const history = await this.redisService.lrange(resultsKey, 0, -1);
    const recentHistory = history.filter(record => {
      const parsed = JSON.parse(record);
      return new Date(parsed.startTime) >= thirtyDaysAgo;
    });

    await this.redisService.del(resultsKey);
    if (recentHistory.length > 0) {
      await this.redisService.lpush(resultsKey, ...recentHistory);
    }

    this.logger.log(`Cleaned up warming history, kept ${recentHistory.length} records`);
  }

  private async warmUrl(
    url: string,
    job: CacheWarmingJob,
  ): Promise<{
    url: string;
    success: boolean;
    entry?: {
      url: string;
      key: string;
      size: number;
      contentType: CacheContentType;
      duration: number;
    };
    error?: string;
  }> {
    const startTime = Date.now();

    try {
      // In a real implementation, you would make an HTTP request to fetch the content
      // For now, we'll simulate this with placeholder content
      const content = `Cached content for ${url} (warmed at ${new Date().toISOString()})`;
      const contentType = this.getContentTypeFromUrl(url);

      await this.cacheService.set(url, content, contentType, {
        ttl: job.ttl,
        tags: job.tags,
        metadata: {
          originalUrl: url,
          source: 'cache-warmer',
          jobId: job.id,
          warmedAt: new Date(),
        },
      });

      const duration = Date.now() - startTime;

      return {
        url,
        success: true,
        entry: {
          url,
          key: url,
          size: content.length,
          contentType,
          duration,
        },
      };
    } catch (error) {
      return {
        url,
        success: false,
        error: error.message,
      };
    }
  }

  private getContentTypeFromUrl(url: string): CacheContentType {
    const extension = url.split('.').pop()?.toLowerCase();

    if (extension === 'css') {
      return CacheContentType.CSS;
    }
    if (extension === 'js') {
      return CacheContentType.JS;
    }
    if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'ico'].includes(extension || '')) {
      return CacheContentType.IMAGE;
    }
    if (extension === 'html') {
      return CacheContentType.HTML;
    }
    if (extension === 'json') {
      return CacheContentType.JSON;
    }
    if (extension === 'txt') {
      return CacheContentType.TEXT;
    }

    return CacheContentType.HTML; // Default
  }

  private chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  private generateUserBasedUrls(userId: string, preferences?: Record<string, unknown>): string[] {
    const urls: string[] = [];

    // Generate URLs based on user preferences
    if (preferences?.favoriteProperties) {
      const properties = preferences.favoriteProperties as string[];
      for (const propertyId of properties) {
        urls.push(`/api/v1/properties/${propertyId}`);
        urls.push(`/properties/${propertyId}/details`);
      }
    }

    if (preferences?.recentSearches) {
      const searches = preferences.recentSearches as string[];
      for (const search of searches) {
        urls.push(`/api/v1/properties/search?q=${encodeURIComponent(search)}`);
      }
    }

    // Add user-specific URLs
    urls.push(`/api/v1/users/${userId}/profile`);
    urls.push(`/api/v1/users/${userId}/dashboard`);
    urls.push(`/api/v1/users/${userId}/favorites`);

    return urls;
  }

  private generateTimeBasedUrls(): string[] {
    const urls: string[] = [];
    const hour = new Date().getHours();

    // Morning content (6-12)
    if (hour >= 6 && hour < 12) {
      urls.push('/api/v1/properties/featured');
      urls.push('/api/v1/market-trends/morning');
      urls.push('/dashboard/morning-overview');
    }

    // Afternoon content (12-18)
    if (hour >= 12 && hour < 18) {
      urls.push('/api/v1/properties/trending');
      urls.push('/api/v1/market-trends/afternoon');
      urls.push('/dashboard/afternoon-update');
    }

    // Evening content (18-24)
    if (hour >= 18 && hour < 24) {
      urls.push('/api/v1/properties/recent');
      urls.push('/api/v1/market-trends/evening');
      urls.push('/dashboard/evening-summary');
    }

    // Night content (0-6)
    if (hour >= 0 && hour < 6) {
      urls.push('/api/v1/properties/popular');
      urls.push('/api/v1/market-trends/overnight');
      urls.push('/dashboard/night-update');
    }

    return urls;
  }

  private async executeCustomStrategy(strategy: CacheWarmingStrategy): Promise<CacheWarmingResult> {
    const urls = (strategy.config.urls as string[]) || [];

    const job: CacheWarmingJob = {
      id: uuidv4(),
      name: strategy.name,
      description: strategy.description,
      urls,
      priority: (strategy.config.priority as number) || 5,
      interval: (strategy.config.interval as number) || 30,
      isActive: true,
      successCount: 0,
      failureCount: 0,
      averageDuration: 0,
      metadata: strategy.config,
      tags: (strategy.config.tags as string[]) || ['custom'],
      ttl: strategy.config.ttl as number,
      headers: strategy.config.headers as Record<string, string>,
    };

    return await this.executeJob(job.id);
  }

  private async initializeDefaultStrategies(): Promise<void> {
    // Popular content strategy
    if (!this.strategies.has('popular')) {
      await this.createStrategy({
        name: 'Popular Content Strategy',
        description: 'Automatically warms popular content based on analytics',
        type: 'POPULAR_CONTENT',
        config: { limit: 50 },
        isActive: true,
      });
    }

    // Time-based strategy
    if (!this.strategies.has('time-based')) {
      await this.createStrategy({
        name: 'Time-based Strategy',
        description: 'Warms content based on time-of-day patterns',
        type: 'TIME_BASED',
        config: {},
        isActive: true,
      });
    }
  }

  private startWarmingScheduler(): void {
    this.warmingInterval = setInterval(
      async () => {
        try {
          await this.scheduledWarming();
        } catch (error) {
          this.logger.error('Error in warming scheduler', error);
        }
      },
      5 * 60 * 1000,
    ); // Check every 5 minutes
  }

  private async loadJobs(): Promise<void> {
    const keys = await this.redisService.keys(`${this.jobsPrefix}*`);

    for (const key of keys) {
      const jobData = await this.redisService.get(key);
      if (jobData) {
        const job: CacheWarmingJob = JSON.parse(jobData);
        this.jobs.set(job.id, job);
      }
    }

    this.logger.log(`Loaded ${this.jobs.size} cache warming jobs`);
  }

  private async loadStrategies(): Promise<void> {
    const keys = await this.redisService.keys(`${this.strategiesPrefix}*`);

    for (const key of keys) {
      const strategyData = await this.redisService.get(key);
      if (strategyData) {
        const strategy: CacheWarmingStrategy = JSON.parse(strategyData);
        this.strategies.set(strategy.id, strategy);
      }
    }

    this.logger.log(`Loaded ${this.strategies.size} cache warming strategies`);
  }

  private async saveJobs(): Promise<void> {
    for (const job of this.jobs.values()) {
      await this.saveJob(job);
    }
  }

  private async saveStrategies(): Promise<void> {
    for (const strategy of this.strategies.values()) {
      await this.saveStrategy(strategy);
    }
  }

  private async saveJob(job: CacheWarmingJob): Promise<void> {
    const jobKey = `${this.jobsPrefix}${job.id}`;
    await this.redisService.setex(jobKey, 86400, JSON.stringify(job));
  }

  private async saveStrategy(strategy: CacheWarmingStrategy): Promise<void> {
    const strategyKey = `${this.strategiesPrefix}${strategy.id}`;
    await this.redisService.setex(strategyKey, 86400, JSON.stringify(strategy));
  }

  private async saveResult(result: CacheWarmingResult): Promise<void> {
    const resultsKey = `${this.resultsPrefix}recent`;
    await this.redisService.lpush(resultsKey, JSON.stringify(result));
    await this.redisService.ltrim(resultsKey, 0, 999); // Keep last 1000 results
    await this.redisService.expire(resultsKey, 86400 * 30); // 30 days TTL
  }
}
