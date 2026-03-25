import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../common/services/redis.service';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CacheAnalytics, CacheStats, CacheEntry, CacheContentType } from './models/static-cache.entity';
import { StaticContentCacheService } from './static-content-cache.service';

export interface CacheMetrics {
  timestamp: Date;
  hitRate: number;
  missRate: number;
  totalSize: number;
  totalEntries: number;
  averageResponseTime: number;
  memoryUsage: number;
  compressionRatio: number;
  evictionRate: number;
  topContentTypes: Array<{ type: CacheContentType; count: number; percentage: number }>;
  topTags: Array<{ tag: string; count: number; percentage: number }>;
  performanceScore: number;
}

export interface CacheAlert {
  id: string;
  type: 'WARNING' | 'ERROR' | 'INFO';
  message: string;
  metric: string;
  value: number;
  threshold: number;
  timestamp: Date;
  resolved: boolean;
  resolvedAt?: Date;
}

export interface CachePerformanceReport {
  period: string;
  generatedAt: Date;
  summary: {
    totalRequests: number;
    averageHitRate: number;
    averageResponseTime: number;
    totalDataServed: number;
    cacheEfficiency: number;
  };
  trends: {
    hitRateTrend: 'improving' | 'declining' | 'stable';
    responseTimeTrend: 'improving' | 'declining' | 'stable';
    sizeTrend: 'growing' | 'shrinking' | 'stable';
  };
  recommendations: string[];
  alerts: CacheAlert[];
}

@Injectable()
export class CacheAnalyticsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheAnalyticsService.name);
  private readonly metricsPrefix = 'cache-metrics:';
  private readonly alertsPrefix = 'cache-alerts:';
  private readonly reportsPrefix = 'cache-reports:';

  private metricsHistory: CacheMetrics[] = [];
  private alerts: CacheAlert[] = [];
  private monitoringInterval: NodeJS.Timeout;
  private stats: CacheStats = {
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

  private readonly thresholds = {
    hitRate: { warning: 0.8, error: 0.7 },
    responseTime: { warning: 100, error: 500 }, // ms
    memoryUsage: { warning: 0.8, error: 0.9 }, // percentage
    evictionRate: { warning: 0.1, error: 0.2 }, // percentage
    compressionRatio: { warning: 0.5, error: 0.3 }, // percentage
  };

  constructor(
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
    private readonly cacheService: StaticContentCacheService,
  ) {}

  async onModuleInit() {
    await this.loadMetrics();
    await this.loadAlerts();
    this.startMonitoring();
    this.logger.log('Cache analytics service initialized');
  }

  async onModuleDestroy() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }
    await this.saveMetrics();
    await this.saveAlerts();
    this.logger.log('Cache analytics service destroyed');
  }

  async collectMetrics(): Promise<CacheMetrics> {
    const analytics = await this.cacheService.getAnalytics();
    const stats = await this.cacheService.getStats();
    const memoryInfo = await this.getMemoryInfo();

    const metrics: CacheMetrics = {
      timestamp: new Date(),
      hitRate: analytics.hitRate,
      missRate: analytics.missRate,
      totalSize: analytics.totalSize,
      totalEntries: analytics.totalEntries,
      averageResponseTime: analytics.averageResponseTime,
      memoryUsage: memoryInfo.usagePercentage,
      compressionRatio: analytics.compressionRatio,
      evictionRate: analytics.evictionRate,
      topContentTypes: this.getTopContentTypes(analytics.entriesByContentType),
      topTags: this.getTopTags(analytics.entriesByTag),
      performanceScore: this.calculatePerformanceScore(analytics, stats),
    };

    // Store metrics history
    this.metricsHistory.push(metrics);

    // Keep only last 24 hours of metrics (assuming 5-minute intervals)
    if (this.metricsHistory.length > 288) {
      this.metricsHistory = this.metricsHistory.slice(-288);
    }

    // Check for alerts
    await this.checkAlerts(metrics);

    return metrics;
  }

  async getMetricsHistory(hours: number = 24): Promise<CacheMetrics[]> {
    const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);
    return this.metricsHistory.filter(m => m.timestamp >= cutoffTime);
  }

  async getRealTimeMetrics(): Promise<CacheMetrics> {
    return await this.collectMetrics();
  }

  async generateReport(period: 'hourly' | 'daily' | 'weekly' | 'monthly'): Promise<CachePerformanceReport> {
    const now = new Date();
    let periodStart: Date;
    const periodEnd = now;
    let summaryPeriod: string;

    switch (period) {
      case 'hourly':
        periodStart = new Date(now.getTime() - 60 * 60 * 1000);
        summaryPeriod = 'Last Hour';
        break;
      case 'daily':
        periodStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        summaryPeriod = 'Last 24 Hours';
        break;
      case 'weekly':
        periodStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        summaryPeriod = 'Last 7 Days';
        break;
      case 'monthly':
        periodStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        summaryPeriod = 'Last 30 Days';
        break;
    }

    const periodMetrics = this.metricsHistory.filter(m => m.timestamp >= periodStart);

    if (periodMetrics.length === 0) {
      throw new Error(`No metrics available for period: ${period}`);
    }

    const totalRequests = periodMetrics.reduce((sum, m) => sum + (m.hitRate * 100 + m.missRate * 100), 0);
    const averageHitRate = periodMetrics.reduce((sum, m) => sum + m.hitRate, 0) / periodMetrics.length;
    const averageResponseTime = periodMetrics.reduce((sum, m) => sum + m.averageResponseTime, 0) / periodMetrics.length;
    const totalDataServed = periodMetrics.reduce((sum, m) => sum + m.totalSize, 0);
    const cacheEfficiency = averageHitRate * (1 - averageResponseTime / 1000); // Simplified efficiency score

    const trends = this.calculateTrends(periodMetrics);
    const recommendations = this.generateRecommendations(periodMetrics, trends);
    const recentAlerts = this.alerts.filter(a => a.timestamp >= periodStart && !a.resolved);

    const report: CachePerformanceReport = {
      period: summaryPeriod,
      generatedAt: now,
      summary: {
        totalRequests,
        averageHitRate,
        averageResponseTime,
        totalDataServed,
        cacheEfficiency,
      },
      trends,
      recommendations,
      alerts: recentAlerts,
    };

    // Save report
    const reportKey = `${this.reportsPrefix}${period}_${now.toISOString().split('T')[0]}`;
    await this.redisService.setex(reportKey, 86400 * 7, JSON.stringify(report)); // Keep for 7 days

    return report;
  }

  async getAlerts(resolved: boolean = false): Promise<CacheAlert[]> {
    return this.alerts.filter(alert => alert.resolved === resolved);
  }

  async acknowledgeAlert(alertId: string): Promise<boolean> {
    const alert = this.alerts.find(a => a.id === alertId);
    if (!alert) {
      return false;
    }

    alert.resolved = true;
    alert.resolvedAt = new Date();
    await this.saveAlerts();

    this.logger.log(`Alert acknowledged: ${alertId}`);
    return true;
  }

  async createAlert(alert: Omit<CacheAlert, 'id' | 'timestamp' | 'resolved'>): Promise<CacheAlert> {
    const newAlert: CacheAlert = {
      ...alert,
      id: `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date(),
      resolved: false,
    };

    this.alerts.push(newAlert);
    await this.saveAlerts();

    this.logger.warn(`Cache alert created: ${newAlert.message}`);
    return newAlert;
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

  async getHealthStatus(): Promise<{
    status: 'healthy' | 'warning' | 'critical';
    score: number;
    issues: string[];
    metrics: CacheMetrics;
  }> {
    const metrics = await this.collectMetrics();
    const issues: string[] = [];
    let score = 100;

    // Check hit rate
    if (metrics.hitRate < this.thresholds.hitRate.error) {
      issues.push('Cache hit rate is critically low');
      score -= 30;
    } else if (metrics.hitRate < this.thresholds.hitRate.warning) {
      issues.push('Cache hit rate is below optimal');
      score -= 15;
    }

    // Check response time
    if (metrics.averageResponseTime > this.thresholds.responseTime.error) {
      issues.push('Cache response time is critically high');
      score -= 25;
    } else if (metrics.averageResponseTime > this.thresholds.responseTime.warning) {
      issues.push('Cache response time is elevated');
      score -= 10;
    }

    // Check memory usage
    if (metrics.memoryUsage > this.thresholds.memoryUsage.error) {
      issues.push('Cache memory usage is critically high');
      score -= 20;
    } else if (metrics.memoryUsage > this.thresholds.memoryUsage.warning) {
      issues.push('Cache memory usage is high');
      score -= 10;
    }

    // Check eviction rate
    if (metrics.evictionRate > this.thresholds.evictionRate.error) {
      issues.push('Cache eviction rate is critically high');
      score -= 15;
    } else if (metrics.evictionRate > this.thresholds.evictionRate.warning) {
      issues.push('Cache eviction rate is elevated');
      score -= 5;
    }

    let status: 'healthy' | 'warning' | 'critical' = 'healthy';
    if (score < 70) {
      status = 'critical';
    } else if (score < 85) {
      status = 'warning';
    }

    return {
      status,
      score: Math.max(0, score),
      issues,
      metrics,
    };
  }

  async exportAnalytics(format: 'json' | 'csv' = 'json'): Promise<any> {
    const metrics = await this.getMetricsHistory(24 * 7); // Last week
    const alerts = await this.getAlerts();
    const reports = await this.generateReport('daily');

    if (format === 'csv') {
      return this.convertMetricsToCSV(metrics);
    }

    return {
      metrics,
      alerts,
      reports,
      exportedAt: new Date(),
      format: 'json',
    };
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async scheduledMetricsCollection(): Promise<void> {
    try {
      await this.collectMetrics();
    } catch (error) {
      this.logger.error('Error during scheduled metrics collection', error);
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
  async scheduledReportGeneration(): Promise<void> {
    try {
      await this.generateReport('hourly');
    } catch (error) {
      this.logger.error('Error during scheduled report generation', error);
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async scheduledDailyReport(): Promise<void> {
    try {
      await this.generateReport('daily');
      await this.cleanupOldData();
    } catch (error) {
      this.logger.error('Error during scheduled daily operations', error);
    }
  }

  private async getMemoryInfo(): Promise<{ used: number; total: number; usagePercentage: number }> {
    try {
      const redis = this.redisService.getRedisInstance();
      const info = await redis.info('memory');
      const lines = info.split('\r\n');

      let usedMemory = 0;
      let maxMemory = 0;

      for (const line of lines) {
        if (line.startsWith('used_memory:')) {
          usedMemory = parseInt(line.split(':')[1]);
        } else if (line.startsWith('maxmemory:')) {
          maxMemory = parseInt(line.split(':')[1]);
        }
      }

      const total = maxMemory > 0 ? maxMemory : usedMemory * 2; // Estimate if max not set
      const usagePercentage = total > 0 ? usedMemory / total : 0;

      return {
        used: usedMemory,
        total,
        usagePercentage,
      };
    } catch (error) {
      this.logger.warn('Error getting memory info', error);
      return { used: 0, total: 0, usagePercentage: 0 };
    }
  }

  private getTopContentTypes(
    entriesByContentType: Record<CacheContentType, number>,
  ): Array<{ type: CacheContentType; count: number; percentage: number }> {
    const total = Object.values(entriesByContentType).reduce((sum, count) => sum + count, 0);

    return Object.entries(entriesByContentType)
      .map(([type, count]) => ({
        type: type as CacheContentType,
        count,
        percentage: total > 0 ? (count / total) * 100 : 0,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  }

  private getTopTags(entriesByTag: Record<string, number>): Array<{ tag: string; count: number; percentage: number }> {
    const total = Object.values(entriesByTag).reduce((sum, count) => sum + count, 0);

    return Object.entries(entriesByTag)
      .map(([tag, count]) => ({
        tag,
        count,
        percentage: total > 0 ? (count / total) * 100 : 0,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }

  private calculatePerformanceScore(analytics: CacheAnalytics, stats: CacheStats): number {
    let score = 0;

    // Hit rate contribution (40%)
    score += analytics.hitRate * 40;

    // Response time contribution (30%)
    const responseTimeScore = Math.max(0, 1 - analytics.averageResponseTime / 1000); // Normalize to 0-1
    score += responseTimeScore * 30;

    // Size efficiency contribution (20%)
    const sizeEfficiency = analytics.totalEntries > 0 ? 1 - analytics.evictionRate : 1;
    score += sizeEfficiency * 20;

    // Compression contribution (10%)
    score += analytics.compressionRatio * 10;

    return Math.round(score);
  }

  private async checkAlerts(metrics: CacheMetrics): Promise<void> {
    const alerts: Omit<CacheAlert, 'id' | 'timestamp' | 'resolved'>[] = [];

    // Hit rate alerts
    if (metrics.hitRate < this.thresholds.hitRate.error) {
      alerts.push({
        type: 'ERROR',
        message: `Cache hit rate is critically low: ${(metrics.hitRate * 100).toFixed(1)}%`,
        metric: 'hitRate',
        value: metrics.hitRate,
        threshold: this.thresholds.hitRate.error,
      });
    } else if (metrics.hitRate < this.thresholds.hitRate.warning) {
      alerts.push({
        type: 'WARNING',
        message: `Cache hit rate is below optimal: ${(metrics.hitRate * 100).toFixed(1)}%`,
        metric: 'hitRate',
        value: metrics.hitRate,
        threshold: this.thresholds.hitRate.warning,
      });
    }

    // Response time alerts
    if (metrics.averageResponseTime > this.thresholds.responseTime.error) {
      alerts.push({
        type: 'ERROR',
        message: `Cache response time is critically high: ${metrics.averageResponseTime.toFixed(1)}ms`,
        metric: 'responseTime',
        value: metrics.averageResponseTime,
        threshold: this.thresholds.responseTime.error,
      });
    } else if (metrics.averageResponseTime > this.thresholds.responseTime.warning) {
      alerts.push({
        type: 'WARNING',
        message: `Cache response time is elevated: ${metrics.averageResponseTime.toFixed(1)}ms`,
        metric: 'responseTime',
        value: metrics.averageResponseTime,
        threshold: this.thresholds.responseTime.warning,
      });
    }

    // Memory usage alerts
    if (metrics.memoryUsage > this.thresholds.memoryUsage.error) {
      alerts.push({
        type: 'ERROR',
        message: `Cache memory usage is critically high: ${(metrics.memoryUsage * 100).toFixed(1)}%`,
        metric: 'memoryUsage',
        value: metrics.memoryUsage,
        threshold: this.thresholds.memoryUsage.error,
      });
    } else if (metrics.memoryUsage > this.thresholds.memoryUsage.warning) {
      alerts.push({
        type: 'WARNING',
        message: `Cache memory usage is high: ${(metrics.memoryUsage * 100).toFixed(1)}%`,
        metric: 'memoryUsage',
        value: metrics.memoryUsage,
        threshold: this.thresholds.memoryUsage.warning,
      });
    }

    // Create alerts
    for (const alert of alerts) {
      await this.createAlert(alert);
    }
  }

  private calculateTrends(metrics: CacheMetrics[]): {
    hitRateTrend: 'improving' | 'declining' | 'stable';
    responseTimeTrend: 'improving' | 'declining' | 'stable';
    sizeTrend: 'growing' | 'shrinking' | 'stable';
  } {
    if (metrics.length < 2) {
      return {
        hitRateTrend: 'stable',
        responseTimeTrend: 'stable',
        sizeTrend: 'stable',
      };
    }

    const recent = metrics.slice(-10); // Last 10 metrics
    const older = metrics.slice(-20, -10); // Previous 10 metrics

    if (older.length === 0) {
      return {
        hitRateTrend: 'stable',
        responseTimeTrend: 'stable',
        sizeTrend: 'stable',
      };
    }

    const recentAvgHitRate = recent.reduce((sum, m) => sum + m.hitRate, 0) / recent.length;
    const olderAvgHitRate = older.reduce((sum, m) => sum + m.hitRate, 0) / older.length;

    const recentAvgResponseTime = recent.reduce((sum, m) => sum + m.averageResponseTime, 0) / recent.length;
    const olderAvgResponseTime = older.reduce((sum, m) => sum + m.averageResponseTime, 0) / older.length;

    const recentAvgSize = recent.reduce((sum, m) => sum + m.totalSize, 0) / recent.length;
    const olderAvgSize = older.reduce((sum, m) => sum + m.totalSize, 0) / older.length;

    const hitRateTrend = this.calculateTrendDirection(recentAvgHitRate, olderAvgHitRate);
    const responseTimeTrend = this.calculateTrendDirection(olderAvgResponseTime, recentAvgResponseTime); // Inverted for response time
    const sizeTrend = this.calculateSizeTrendDirection(recentAvgSize, olderAvgSize);

    return {
      hitRateTrend,
      responseTimeTrend,
      sizeTrend,
    };
  }

  private calculateTrendDirection(recent: number, older: number): 'improving' | 'declining' | 'stable' {
    const change = (recent - older) / older;

    if (Math.abs(change) < 0.05) {
      return 'stable';
    } // Less than 5% change
    return change > 0 ? 'improving' : 'declining';
  }

  private calculateSizeTrendDirection(recent: number, older: number): 'growing' | 'shrinking' | 'stable' {
    const change = (recent - older) / older;

    if (Math.abs(change) < 0.05) {
      return 'stable';
    } // Less than 5% change
    return change > 0 ? 'growing' : 'shrinking';
  }

  private generateRecommendations(metrics: CacheMetrics[], trends: any): string[] {
    const recommendations: string[] = [];
    const latest = metrics[metrics.length - 1];

    if (latest.hitRate < 0.8) {
      recommendations.push('Consider increasing cache TTL or implementing cache warming strategies');
    }

    if (latest.averageResponseTime > 100) {
      recommendations.push('Optimize cache key structure or consider cache partitioning');
    }

    if (latest.memoryUsage > 0.8) {
      recommendations.push('Monitor cache size and implement more aggressive eviction policies');
    }

    if (latest.compressionRatio < 0.5) {
      recommendations.push('Review compression settings and threshold values');
    }

    if (trends.hitRateTrend === 'declining') {
      recommendations.push('Investigate declining hit rate trend - check caching patterns');
    }

    if (trends.responseTimeTrend === 'declining') {
      recommendations.push('Performance is degrading - consider cache optimization');
    }

    return recommendations;
  }

  private convertMetricsToCSV(metrics: CacheMetrics[]): string {
    const headers = [
      'timestamp',
      'hitRate',
      'missRate',
      'totalSize',
      'totalEntries',
      'averageResponseTime',
      'memoryUsage',
      'compressionRatio',
      'evictionRate',
      'performanceScore',
    ];

    const rows = metrics.map(m => [
      m.timestamp.toISOString(),
      m.hitRate.toString(),
      m.missRate.toString(),
      m.totalSize.toString(),
      m.totalEntries.toString(),
      m.averageResponseTime.toString(),
      m.memoryUsage.toString(),
      m.compressionRatio.toString(),
      m.evictionRate.toString(),
      m.performanceScore.toString(),
    ]);

    return [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
  }

  private startMonitoring(): void {
    this.monitoringInterval = setInterval(
      async () => {
        try {
          await this.collectMetrics();
        } catch (error) {
          this.logger.error('Error in monitoring interval', error);
        }
      },
      5 * 60 * 1000,
    ); // Every 5 minutes
  }

  private async loadMetrics(): Promise<void> {
    try {
      const metricsKey = `${this.metricsPrefix}history`;
      const metricsData = await this.redisService.get(metricsKey);

      if (metricsData) {
        this.metricsHistory = JSON.parse(metricsData);
      }
    } catch (error) {
      this.logger.warn('Error loading metrics history', error);
    }
  }

  private async loadAlerts(): Promise<void> {
    try {
      const alertsKey = `${this.alertsPrefix}active`;
      const alertsData = await this.redisService.get(alertsKey);

      if (alertsData) {
        this.alerts = JSON.parse(alertsData);
      }
    } catch (error) {
      this.logger.warn('Error loading alerts', error);
    }
  }

  private async saveMetrics(): Promise<void> {
    try {
      const metricsKey = `${this.metricsPrefix}history`;
      await this.redisService.setex(metricsKey, 86400, JSON.stringify(this.metricsHistory));
    } catch (error) {
      this.logger.warn('Error saving metrics history', error);
    }
  }

  private async saveAlerts(): Promise<void> {
    try {
      const alertsKey = `${this.alertsPrefix}active`;
      await this.redisService.setex(alertsKey, 86400, JSON.stringify(this.alerts));
    } catch (error) {
      this.logger.warn('Error saving alerts', error);
    }
  }

  private async saveStats(): Promise<void> {
    try {
      const statsKey = `${this.metricsPrefix}stats`;
      await this.redisService.setex(statsKey, 86400, JSON.stringify(this.stats));
    } catch (error) {
      this.logger.warn('Error saving stats', error);
    }
  }

  private async cleanupOldData(): Promise<void> {
    // Keep only last 7 days of metrics
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    this.metricsHistory = this.metricsHistory.filter(m => m.timestamp >= sevenDaysAgo);

    // Clean up resolved alerts older than 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    this.alerts = this.alerts.filter(a => !a.resolved || a.timestamp >= thirtyDaysAgo);

    await this.saveMetrics();
    await this.saveAlerts();

    this.logger.log('Cleaned up old analytics data');
  }
}
