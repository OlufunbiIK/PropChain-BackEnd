import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';
import { MultiLevelCacheService, MultiLevelCacheOptions } from './multi-level-cache.service';

export interface WarmupTask {
  key: string;
  factory: () => Promise<any>;
  options?: MultiLevelCacheOptions;
  priority: number; // 1-10, higher = more important
  condition?: () => boolean | Promise<boolean>;
  dependencies?: string[]; // Keys that must be warmed first
}

export interface WarmupStrategy {
  name: string;
  description: string;
  tasks: WarmupTask[];
  schedule?: CronExpression | string;
  enabled: boolean;
}

export interface CacheWarmingStats {
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  skippedTasks: number;
  lastRunTime: Date | null;
  averageExecutionTime: number;
  strategies: Map<string, { success: number; failed: number }>;
}

@Injectable()
export class CacheWarmingService implements OnModuleInit {
  private readonly logger = new Logger(CacheWarmingService.name);
  private strategies: Map<string, WarmupStrategy> = new Map();
  private stats: CacheWarmingStats = {
    totalTasks: 0,
    completedTasks: 0,
    failedTasks: 0,
    skippedTasks: 0,
    lastRunTime: null,
    averageExecutionTime: 0,
    strategies: new Map(),
  };
  private executionTimes: number[] = [];

  constructor(
    private readonly cacheService: MultiLevelCacheService,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Initialize default strategies
    this.initializeDefaultStrategies();
    this.logger.log('Cache warming service initialized');
  }

  /**
   * Initialize default cache warming strategies
   */
  private initializeDefaultStrategies(): void {
    // Strategy: Warm frequently accessed user data
    this.registerStrategy({
      name: 'user-data',
      description: 'Warm cache with frequently accessed user data',
      tasks: [
        {
          key: 'user:active:list',
          factory: async () => {
            // This would typically fetch from database
            return { users: [], timestamp: Date.now() };
          },
          priority: 8,
          options: { l1Ttl: 300, l2Ttl: 1800, tags: ['user', 'active'] },
        },
        {
          key: 'user:permissions:common',
          factory: async () => {
            return { permissions: ['read:property', 'read:valuation'] };
          },
          priority: 9,
          options: { l1Ttl: 600, l2Ttl: 3600, tags: ['user', 'permissions'] },
        },
      ],
      schedule: CronExpression.EVERY_10_MINUTES,
      enabled: true,
    });

    // Strategy: Warm property data
    this.registerStrategy({
      name: 'property-data',
      description: 'Warm cache with popular property data',
      tasks: [
        {
          key: 'property:popular:list',
          factory: async () => {
            return { properties: [], count: 0 };
          },
          priority: 7,
          options: { l1Ttl: 300, l2Ttl: 900, tags: ['property', 'popular'] },
        },
        {
          key: 'property:recent:list',
          factory: async () => {
            return { properties: [], timestamp: Date.now() };
          },
          priority: 6,
          options: { l1Ttl: 180, l2Ttl: 600, tags: ['property', 'recent'] },
        },
      ],
      schedule: CronExpression.EVERY_5_MINUTES,
      enabled: true,
    });

    // Strategy: Warm valuation data
    this.registerStrategy({
      name: 'valuation-data',
      description: 'Warm cache with valuation calculations',
      tasks: [
        {
          key: 'valuation:market:overview',
          factory: async () => {
            return { overview: {}, timestamp: Date.now() };
          },
          priority: 5,
          options: { l1Ttl: 600, l2Ttl: 3600, tags: ['valuation', 'market'] },
        },
      ],
      schedule: CronExpression.EVERY_HOUR,
      enabled: true,
    });
  }

  /**
   * Register a new warming strategy
   */
  registerStrategy(strategy: WarmupStrategy): void {
    this.strategies.set(strategy.name, strategy);
    this.logger.log(`Registered cache warming strategy: ${strategy.name}`);
  }

  /**
   * Unregister a warming strategy
   */
  unregisterStrategy(name: string): boolean {
    const deleted = this.strategies.delete(name);
    if (deleted) {
      this.logger.log(`Unregistered cache warming strategy: ${name}`);
    }
    return deleted;
  }

  /**
   * Enable/disable a strategy
   */
  setStrategyEnabled(name: string, enabled: boolean): boolean {
    const strategy = this.strategies.get(name);
    if (strategy) {
      strategy.enabled = enabled;
      this.logger.log(`Strategy ${name} ${enabled ? 'enabled' : 'disabled'}`);
      return true;
    }
    return false;
  }

  /**
   * Execute a specific warming strategy
   */
  async executeStrategy(strategyName: string): Promise<void> {
    const strategy = this.strategies.get(strategyName);
    if (!strategy) {
      this.logger.warn(`Strategy not found: ${strategyName}`);
      return;
    }

    if (!strategy.enabled) {
      this.logger.log(`Strategy ${strategyName} is disabled, skipping`);
      return;
    }

    const startTime = Date.now();
    this.logger.log(`Executing cache warming strategy: ${strategy.name}`);

    // Sort tasks by priority (highest first) and dependencies
    const sortedTasks = this.sortTasksByPriorityAndDependencies(strategy.tasks);

    let completed = 0;
    let failed = 0;
    let skipped = 0;

    for (const task of sortedTasks) {
      try {
        // Check condition if provided
        if (task.condition) {
          const conditionResult = await task.condition();
          if (!conditionResult) {
            this.logger.debug(`Skipping task ${task.key} - condition not met`);
            skipped++;
            continue;
          }
        }

        // Check if already cached
        const existing = await this.cacheService.get(task.key);
        if (existing !== undefined) {
          this.logger.debug(`Task ${task.key} already cached, skipping`);
          skipped++;
          continue;
        }

        // Execute the factory function
        const value = await task.factory();

        // Store in cache
        await this.cacheService.set(task.key, value, task.options);

        this.logger.debug(`Successfully warmed cache for key: ${task.key}`);
        completed++;
      } catch (error) {
        this.logger.error(`Failed to warm cache for key ${task.key}: ${error.message}`);
        failed++;
      }
    }

    // Update stats
    const executionTime = Date.now() - startTime;
    this.executionTimes.push(executionTime);
    if (this.executionTimes.length > 100) {
      this.executionTimes.shift(); // Keep last 100
    }

    this.stats.totalTasks += sortedTasks.length;
    this.stats.completedTasks += completed;
    this.stats.failedTasks += failed;
    this.stats.skippedTasks += skipped;
    this.stats.lastRunTime = new Date();
    this.stats.averageExecutionTime = this.executionTimes.reduce((a, b) => a + b, 0) / this.executionTimes.length;

    this.stats.strategies.set(strategyName, {
      success: (this.stats.strategies.get(strategyName)?.success || 0) + completed,
      failed: (this.stats.strategies.get(strategyName)?.failed || 0) + failed,
    });

    this.logger.log(
      `Strategy ${strategyName} completed: ${completed} completed, ${failed} failed, ${skipped} skipped (${executionTime}ms)`,
    );
  }

  /**
   * Execute all enabled strategies
   */
  async executeAllStrategies(): Promise<void> {
    this.logger.log('Executing all enabled cache warming strategies');

    for (const [name, strategy] of this.strategies) {
      if (strategy.enabled) {
        await this.executeStrategy(name);
      }
    }
  }

  /**
   * Execute a single warmup task
   */
  async executeTask(task: WarmupTask): Promise<boolean> {
    try {
      // Check condition if provided
      if (task.condition) {
        const conditionResult = await task.condition();
        if (!conditionResult) {
          this.logger.debug(`Skipping task ${task.key} - condition not met`);
          return false;
        }
      }

      // Check if already cached
      const existing = await this.cacheService.get(task.key);
      if (existing !== undefined) {
        this.logger.debug(`Task ${task.key} already cached, skipping`);
        return false;
      }

      // Execute the factory function
      const value = await task.factory();

      // Store in cache
      await this.cacheService.set(task.key, value, task.options);

      this.logger.debug(`Successfully warmed cache for key: ${task.key}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to warm cache for key ${task.key}: ${error.message}`);
      return false;
    }
  }

  /**
   * Warm cache with custom tasks
   */
  async warmCache(tasks: WarmupTask[]): Promise<{ completed: number; failed: number }> {
    let completed = 0;
    let failed = 0;

    // Sort by priority
    const sortedTasks = [...tasks].sort((a, b) => b.priority - a.priority);

    for (const task of sortedTasks) {
      const success = await this.executeTask(task);
      if (success) {
        completed++;
      } else {
        failed++;
      }
    }

    return { completed, failed };
  }

  /**
   * Schedule-based warming for user data
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async scheduledUserDataWarming(): Promise<void> {
    await this.executeStrategy('user-data');
  }

  /**
   * Schedule-based warming for property data
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async scheduledPropertyDataWarming(): Promise<void> {
    await this.executeStrategy('property-data');
  }

  /**
   * Schedule-based warming for valuation data
   */
  @Cron(CronExpression.EVERY_HOUR)
  async scheduledValuationDataWarming(): Promise<void> {
    await this.executeStrategy('valuation-data');
  }

  /**
   * Continuous warming for high-priority items
   */
  @Interval(60000) // Every minute
  async continuousWarming(): Promise<void> {
    // Find high-priority tasks that aren't cached
    const highPriorityTasks: WarmupTask[] = [];

    for (const strategy of this.strategies.values()) {
      if (!strategy.enabled) {
        continue;
      }

      for (const task of strategy.tasks) {
        if (task.priority >= 8) {
          highPriorityTasks.push(task);
        }
      }
    }

    if (highPriorityTasks.length > 0) {
      this.logger.debug(`Running continuous warming for ${highPriorityTasks.length} high-priority tasks`);

      for (const task of highPriorityTasks) {
        const cached = await this.cacheService.get(task.key);
        if (cached === undefined) {
          await this.executeTask(task);
        }
      }
    }
  }

  /**
   * Get warming statistics
   */
  getStats(): CacheWarmingStats {
    return {
      ...this.stats,
      strategies: new Map(this.stats.strategies),
    };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      totalTasks: 0,
      completedTasks: 0,
      failedTasks: 0,
      skippedTasks: 0,
      lastRunTime: null,
      averageExecutionTime: 0,
      strategies: new Map(),
    };
    this.executionTimes = [];
  }

  /**
   * Get all registered strategies
   */
  getStrategies(): WarmupStrategy[] {
    return Array.from(this.strategies.values());
  }

  /**
   * Get a specific strategy
   */
  getStrategy(name: string): WarmupStrategy | undefined {
    return this.strategies.get(name);
  }

  /**
   * Sort tasks by priority and handle dependencies
   */
  private sortTasksByPriorityAndDependencies(tasks: WarmupTask[]): WarmupTask[] {
    const taskMap = new Map(tasks.map(t => [t.key, t]));
    const visited = new Set<string>();
    const result: WarmupTask[] = [];

    const visit = (task: WarmupTask) => {
      if (visited.has(task.key)) {
        return;
      }
      visited.add(task.key);

      // Visit dependencies first
      if (task.dependencies) {
        for (const depKey of task.dependencies) {
          const dep = taskMap.get(depKey);
          if (dep) {
            visit(dep);
          }
        }
      }

      result.push(task);
    };

    // Sort by priority first
    const sortedByPriority = [...tasks].sort((a, b) => b.priority - a.priority);

    for (const task of sortedByPriority) {
      visit(task);
    }

    return result;
  }

  /**
   * Pre-warm cache on startup
   */
  async prewarmOnStartup(): Promise<void> {
    this.logger.log('Starting cache pre-warming on startup');

    // Only execute critical strategies
    const criticalStrategies = ['user-data', 'property-data'];

    for (const name of criticalStrategies) {
      if (this.strategies.has(name)) {
        await this.executeStrategy(name);
      }
    }

    this.logger.log('Cache pre-warming completed');
  }

  /**
   * Warm cache based on access patterns
   */
  async warmBasedOnAccessPatterns(accessPatterns: Array<{ key: string; frequency: number }>): Promise<void> {
    // Sort by frequency
    const sortedPatterns = accessPatterns.sort((a, b) => b.frequency - a.frequency);

    // Warm top accessed items
    const topPatterns = sortedPatterns.slice(0, 20);

    for (const pattern of topPatterns) {
      const cached = await this.cacheService.get(pattern.key);
      if (cached === undefined) {
        this.logger.debug(`Warming frequently accessed key: ${pattern.key}`);
        // Note: This would need the factory function to actually warm
        // In practice, you'd store the factory with the pattern
      }
    }
  }
}
