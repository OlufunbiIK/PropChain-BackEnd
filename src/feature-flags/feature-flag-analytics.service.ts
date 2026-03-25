import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../common/services/redis.service';
import { FlagAnalytics, FlagEvaluationRecord } from './models/feature-flag.entity';

@Injectable()
export class FeatureFlagAnalyticsService {
  private readonly logger = new Logger(FeatureFlagAnalyticsService.name);
  private readonly analyticsPrefix = 'flag-analytics:';
  private readonly historyPrefix = 'flag-history:';

  constructor(
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
  ) {}

  async getFlagAnalytics(flagKey: string, days: number = 30): Promise<FlagAnalytics> {
    const cacheKey = `${this.analyticsPrefix}${flagKey}:${days}d`;
    const cached = await this.redisService.get(cacheKey);

    if (cached) {
      return JSON.parse(cached);
    }

    const analytics = await this.generateAnalytics(flagKey, days);

    // Cache for 5 minutes
    await this.redisService.setex(cacheKey, 300, JSON.stringify(analytics));

    return analytics;
  }

  async getAllFlagsAnalytics(days: number = 30): Promise<FlagAnalytics[]> {
    const flagKeys = await this.getAllFlagKeys();
    const analyticsPromises = flagKeys.map(key => this.getFlagAnalytics(key, days));
    return Promise.all(analyticsPromises);
  }

  async getFlagEvaluationHistory(flagKey: string, limit: number = 100): Promise<FlagEvaluationRecord[]> {
    const historyKey = `${this.historyPrefix}${flagKey}`;
    const historyData = await this.redisService.lrange(historyKey, 0, limit - 1);

    return historyData.map(record => JSON.parse(record));
  }

  async getFlagTrends(flagKey: string, days: number = 30): Promise<any> {
    const analytics = await this.getFlagAnalytics(flagKey, days);
    const dailyStats = analytics.dailyStats;

    const trends = {
      flagKey,
      period: `${days} days`,
      dailyStats,
      weeklyStats: this.aggregateWeeklyStats(dailyStats),
      trends: this.calculateTrends(dailyStats),
      summary: {
        totalEvaluations: analytics.totalEvaluations,
        enabledRate: analytics.totalEvaluations > 0 ? (analytics.enabledCount / analytics.totalEvaluations) * 100 : 0,
        uniqueUsers: analytics.uniqueUsers,
        averageDailyEvaluations: analytics.totalEvaluations / days,
      },
    };

    return trends;
  }

  async getTopFlags(days: number = 30, limit: number = 10): Promise<any[]> {
    const allAnalytics = await this.getAllFlagsAnalytics(days);

    return allAnalytics
      .sort((a, b) => b.totalEvaluations - a.totalEvaluations)
      .slice(0, limit)
      .map(analytics => ({
        flagKey: analytics.flagKey,
        totalEvaluations: analytics.totalEvaluations,
        enabledRate: analytics.totalEvaluations > 0 ? (analytics.enabledCount / analytics.totalEvaluations) * 100 : 0,
        uniqueUsers: analytics.uniqueUsers,
        lastEvaluated: analytics.lastEvaluated,
      }));
  }

  async getUserFlagInteractions(userId: string, days: number = 30): Promise<any> {
    const flagKeys = await this.getAllFlagKeys();
    const userInteractions = [];

    for (const flagKey of flagKeys) {
      const history = await this.getFlagEvaluationHistory(flagKey, 1000);
      const userHistory = history.filter(record => record.userId === userId);

      if (userHistory.length > 0) {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);

        const recentHistory = userHistory.filter(record => new Date(record.timestamp) >= cutoffDate);

        if (recentHistory.length > 0) {
          userInteractions.push({
            flagKey,
            totalEvaluations: recentHistory.length,
            enabledEvaluations: recentHistory.filter(r => r.result).length,
            lastEvaluation: recentHistory[recentHistory.length - 1].timestamp,
            enabledRate: (recentHistory.filter(r => r.result).length / recentHistory.length) * 100,
          });
        }
      }
    }

    return userInteractions.sort((a, b) => b.totalEvaluations - a.totalEvaluations);
  }

  async exportFlagAnalytics(flagKey: string, days: number = 30, format: 'json' | 'csv' = 'json'): Promise<any> {
    const analytics = await this.getFlagAnalytics(flagKey, days);
    const history = await this.getFlagEvaluationHistory(flagKey, 1000);

    if (format === 'csv') {
      return this.convertToCSV(analytics, history);
    }

    return {
      analytics,
      history,
      exportDate: new Date(),
      period: `${days} days`,
    };
  }

  async recordEvaluation(flagKey: string, record: FlagEvaluationRecord): Promise<void> {
    const historyKey = `${this.historyPrefix}${flagKey}`;

    // Add to history
    await this.redisService.lpush(historyKey, JSON.stringify(record));

    // Keep only last 10000 records per flag
    await this.redisService.ltrim(historyKey, 0, 9999);

    // Invalidate analytics cache
    await this.invalidateAnalyticsCache(flagKey);
  }

  async cleanupOldData(days: number = 90): Promise<void> {
    const flagKeys = await this.getAllFlagKeys();
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    let totalDeleted = 0;

    for (const flagKey of flagKeys) {
      const historyKey = `${this.historyPrefix}${flagKey}`;
      const historyData = await this.redisService.lrange(historyKey, 0, -1);

      const validRecords = historyData.filter(record => {
        const evaluation = JSON.parse(record);
        return new Date(evaluation.timestamp) >= cutoffDate;
      });

      if (validRecords.length < historyData.length) {
        // Remove old records
        await this.redisService.del(historyKey);

        if (validRecords.length > 0) {
          await this.redisService.lpush(historyKey, ...validRecords);
        }

        totalDeleted += historyData.length - validRecords.length;
      }
    }

    this.logger.log(`Cleaned up ${totalDeleted} old evaluation records older than ${days} days`);
  }

  private async generateAnalytics(flagKey: string, days: number): Promise<FlagAnalytics> {
    const historyKey = `${this.historyPrefix}${flagKey}`;
    const historyData = await this.redisService.lrange(historyKey, 0, -1);

    const uniqueUsersSet = new Set<string>();
    const dailyStats: Record<string, { enabled: number; disabled: number }> = {};
    let lastEvaluated: Date | null = null;
    let totalEvaluations = 0;
    let enabledCount = 0;
    let disabledCount = 0;
    const evaluationHistory: FlagEvaluationRecord[] = [];

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    for (const recordData of historyData) {
      const record = JSON.parse(recordData) as FlagEvaluationRecord;
      const evalDate = new Date(record.timestamp);

      if (evalDate >= cutoffDate) {
        totalEvaluations++;

        if (record.result) {
          enabledCount++;
        } else {
          disabledCount++;
        }

        if (record.userId) {
          uniqueUsersSet.add(record.userId);
        }

        if (!lastEvaluated || evalDate > lastEvaluated) {
          lastEvaluated = evalDate;
        }

        evaluationHistory.push(record);
      }
    }

    return {
      flagKey,
      totalEvaluations,
      enabledCount,
      disabledCount,
      uniqueUsers: uniqueUsersSet.size,
      lastEvaluated,
      evaluationHistory,
      dailyStats,
    };
  }

  private async getAllFlagKeys(): Promise<string[]> {
    const keys = await this.redisService.keys(`${this.historyPrefix}*`);
    return keys.map(key => key.replace(this.historyPrefix, ''));
  }

  private aggregateWeeklyStats(
    dailyStats: Record<string, { enabled: number; disabled: number }>,
  ): Record<string, { enabled: number; disabled: number }> {
    const weeklyStats: Record<string, { enabled: number; disabled: number }> = {};

    for (const [date, stats] of Object.entries(dailyStats)) {
      const dateObj = new Date(date);
      const weekStart = new Date(dateObj);
      weekStart.setDate(dateObj.getDate() - dateObj.getDay());
      const weekKey = weekStart.toISOString().split('T')[0];

      if (!weeklyStats[weekKey]) {
        weeklyStats[weekKey] = { enabled: 0, disabled: 0 };
      }

      weeklyStats[weekKey].enabled += stats.enabled;
      weeklyStats[weekKey].disabled += stats.disabled;
    }

    return weeklyStats;
  }

  private calculateTrends(dailyStats: Record<string, { enabled: number; disabled: number }>): any {
    const dates = Object.keys(dailyStats).sort();

    if (dates.length < 2) {
      return { trend: 'insufficient_data', change: 0 };
    }

    const firstWeek = dates.slice(0, 7);
    const lastWeek = dates.slice(-7);

    const firstWeekTotal = firstWeek.reduce(
      (sum, date) => sum + dailyStats[date].enabled + dailyStats[date].disabled,
      0,
    );
    const lastWeekTotal = lastWeek.reduce((sum, date) => sum + dailyStats[date].enabled + dailyStats[date].disabled, 0);

    const change = lastWeekTotal - firstWeekTotal;
    const trend = change > 0 ? 'increasing' : change < 0 ? 'decreasing' : 'stable';

    return { trend, change, percentage: firstWeekTotal > 0 ? (change / firstWeekTotal) * 100 : 0 };
  }

  private convertToCSV(analytics: FlagAnalytics, history: FlagEvaluationRecord[]): string {
    const headers = ['Flag Key', 'Timestamp', 'User ID', 'Result', 'Value', 'Reason'];
    const rows = history.map(record => [
      analytics.flagKey,
      record.timestamp,
      record.userId || '',
      record.result,
      record.value,
      record.reason,
    ]);

    const csvContent = [headers.join(','), ...rows.map(row => row.map(cell => `"${cell}"`).join(','))].join('\n');

    return csvContent;
  }

  private async invalidateAnalyticsCache(flagKey: string): Promise<void> {
    const patterns = [`${this.analyticsPrefix}${flagKey}:*`];

    for (const pattern of patterns) {
      const keys = await this.redisService.keys(pattern);
      if (keys.length > 0) {
        await this.redisService.del(...keys);
      }
    }
  }
}
