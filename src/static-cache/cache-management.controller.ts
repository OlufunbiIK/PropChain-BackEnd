import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  Res,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery, ApiBearerAuth, ApiBody } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RbacGuard } from '../auth/guards/rbac.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { StaticContentCacheService } from './static-content-cache.service';
import { CacheInvalidationService } from './cache-invalidation.service';
import { CacheAnalyticsService } from './cache-analytics.service';
import { CacheWarmingService } from './cache-warming.service';
import {
  CacheSearchCriteria,
  CacheContentType,
  CacheInvalidationRule,
  CacheWarmingJob,
  CacheWarmingStrategy,
} from './models/static-cache.entity';

@ApiTags('Static Cache Management')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacGuard)
@Controller('cache')
export class CacheManagementController {
  constructor(
    private readonly cacheService: StaticContentCacheService,
    private readonly invalidationService: CacheInvalidationService,
    private readonly analyticsService: CacheAnalyticsService,
    private readonly warmingService: CacheWarmingService,
  ) {}

  // Cache Entry Management
  @Get('entries')
  @Roles('cache', 'read')
  @ApiOperation({ summary: 'Search cache entries' })
  @ApiResponse({ status: 200, description: 'Cache entries retrieved successfully' })
  @ApiQuery({ name: 'contentType', required: false, description: 'Filter by content type' })
  @ApiQuery({ name: 'tags', required: false, description: 'Filter by tags (comma separated)' })
  @ApiQuery({ name: 'minSize', required: false, description: 'Minimum size in bytes' })
  @ApiQuery({ name: 'maxSize', required: false, description: 'Maximum size in bytes' })
  @ApiQuery({ name: 'pattern', required: false, description: 'Search pattern' })
  async searchEntries(@Query() query: any) {
    const criteria: CacheSearchCriteria = {
      contentType: query.contentType ? CacheContentType[query.contentType.toUpperCase()] : undefined,
      tags: query.tags ? query.tags.split(',').map((t: string) => t.trim()) : undefined,
      minSize: query.minSize ? parseInt(query.minSize) : undefined,
      maxSize: query.maxSize ? parseInt(query.maxSize) : undefined,
      pattern: query.pattern,
    };

    return await this.cacheService.search(criteria);
  }

  @Get('entries/:key')
  @Roles('cache', 'read')
  @ApiOperation({ summary: 'Get specific cache entry' })
  @ApiResponse({ status: 200, description: 'Cache entry retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Cache entry not found' })
  @ApiParam({ name: 'key', description: 'Cache entry key' })
  async getEntry(@Param('key') key: string) {
    const entry = await this.cacheService.get(key);
    if (!entry) {
      throw new Error('Cache entry not found');
    }
    return entry;
  }

  @Delete('entries/:key')
  @Roles('cache', 'delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete specific cache entry' })
  @ApiResponse({ status: 204, description: 'Cache entry deleted successfully' })
  @ApiResponse({ status: 404, description: 'Cache entry not found' })
  @ApiParam({ name: 'key', description: 'Cache entry key' })
  async deleteEntry(@Param('key') key: string) {
    const deleted = await this.cacheService.delete(key);
    if (!deleted) {
      throw new Error('Cache entry not found');
    }
  }

  @Delete('entries')
  @Roles('cache', 'delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Clear all cache entries' })
  @ApiResponse({ status: 204, description: 'All cache entries cleared' })
  async clearCache() {
    await this.cacheService.clear();
  }

  // Cache Invalidation
  @Post('invalidate/tags')
  @Roles('cache', 'write')
  @ApiOperation({ summary: 'Invalidate cache entries by tags' })
  @ApiResponse({ status: 200, description: 'Cache entries invalidated successfully' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } },
    },
  })
  async invalidateByTags(@Body() body: { tags: string[]; reason?: string }) {
    const { tags, reason } = body;
    const affectedKeys = await this.invalidationService.invalidateByTags(tags, reason);
    return { affectedKeys, message: `Invalidated ${affectedKeys} cache entries` };
  }

  @Post('invalidate/pattern')
  @Roles('cache', 'write')
  @ApiOperation({ summary: 'Invalidate cache entries by pattern' })
  @ApiResponse({ status: 200, description: 'Cache entries invalidated successfully' })
  @ApiBody({ schema: { type: 'object', properties: { pattern: { type: 'string' }, reason: { type: 'string' } } } })
  async invalidateByPattern(@Body() body: { pattern: string; reason?: string }) {
    const { pattern, reason } = body;
    const affectedKeys = await this.invalidationService.invalidateByPattern(pattern, reason);
    return { affectedKeys, message: `Invalidated ${affectedKeys} cache entries` };
  }

  @Post('invalidate/expired')
  @Roles('cache', 'write')
  @ApiOperation({ summary: 'Invalidate expired cache entries' })
  @ApiResponse({ status: 200, description: 'Expired entries invalidated successfully' })
  async invalidateExpired() {
    const deletedCount = await this.invalidationService.invalidateExpired();
    return { deletedCount, message: `Invalidated ${deletedCount} expired entries` };
  }

  @Post('invalidate/age')
  @Roles('cache', 'write')
  @ApiOperation({ summary: 'Invalidate cache entries by age' })
  @ApiResponse({ status: 200, description: 'Entries invalidated by age successfully' })
  @ApiBody({ schema: { type: 'object', properties: { maxAge: { type: 'number' }, reason: { type: 'string' } } } })
  async invalidateByAge(@Body() body: { maxAge: number; reason?: string }) {
    const { maxAge, reason } = body;
    const deletedCount = await this.invalidationService.invalidateByAge(maxAge, reason);
    return { deletedCount, message: `Invalidated ${deletedCount} entries older than ${maxAge} seconds` };
  }

  // Invalidation Rules Management
  @Get('invalidation-rules')
  @Roles('cache', 'read')
  @ApiOperation({ summary: 'Get all invalidation rules' })
  @ApiResponse({ status: 200, description: 'Invalidation rules retrieved successfully' })
  async getInvalidationRules() {
    return await this.invalidationService.getRules();
  }

  @Post('invalidation-rules')
  @Roles('cache', 'write')
  @ApiOperation({ summary: 'Create invalidation rule' })
  @ApiResponse({ status: 201, description: 'Invalidation rule created successfully' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        type: { type: 'string' },
        conditions: { type: 'object' },
        isActive: { type: 'boolean' },
      },
    },
  })
  async createInvalidationRule(@Body() rule: Omit<CacheInvalidationRule, 'id' | 'createdAt' | 'triggerCount'>) {
    return await this.invalidationService.createRule(rule);
  }

  @Put('invalidation-rules/:id')
  @Roles('cache', 'write')
  @ApiOperation({ summary: 'Update invalidation rule' })
  @ApiResponse({ status: 200, description: 'Invalidation rule updated successfully' })
  @ApiResponse({ status: 404, description: 'Invalidation rule not found' })
  @ApiParam({ name: 'id', description: 'Invalidation rule ID' })
  async updateInvalidationRule(@Param('id') id: string, @Body() updates: Partial<CacheInvalidationRule>) {
    const updated = await this.invalidationService.updateRule(id, updates);
    if (!updated) {
      throw new Error('Invalidation rule not found');
    }
    return updated;
  }

  @Delete('invalidation-rules/:id')
  @Roles('cache', 'delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete invalidation rule' })
  @ApiResponse({ status: 204, description: 'Invalidation rule deleted successfully' })
  @ApiResponse({ status: 404, description: 'Invalidation rule not found' })
  @ApiParam({ name: 'id', description: 'Invalidation rule ID' })
  async deleteInvalidationRule(@Param('id') id: string) {
    const deleted = await this.invalidationService.deleteRule(id);
    if (!deleted) {
      throw new Error('Invalidation rule not found');
    }
  }

  @Post('invalidation-rules/:id/execute')
  @Roles('cache', 'write')
  @ApiOperation({ summary: 'Execute invalidation rule' })
  @ApiResponse({ status: 200, description: 'Invalidation rule executed successfully' })
  @ApiResponse({ status: 404, description: 'Invalidation rule not found' })
  @ApiParam({ name: 'id', description: 'Invalidation rule ID' })
  async executeInvalidationRule(@Param('id') id: string, @Body() body: { reason?: string } = {}) {
    const result = await this.invalidationService.executeRule(id, body.reason);
    return result;
  }

  // Cache Analytics
  @Get('analytics')
  @Roles('cache', 'read')
  @ApiOperation({ summary: 'Get cache analytics' })
  @ApiResponse({ status: 200, description: 'Cache analytics retrieved successfully' })
  async getAnalytics() {
    return await this.cacheService.getAnalytics();
  }

  @Get('analytics/real-time')
  @Roles('cache', 'read')
  @ApiOperation({ summary: 'Get real-time cache metrics' })
  @ApiResponse({ status: 200, description: 'Real-time metrics retrieved successfully' })
  async getRealTimeMetrics() {
    return await this.analyticsService.getRealTimeMetrics();
  }

  @Get('analytics/history')
  @Roles('cache', 'read')
  @ApiOperation({ summary: 'Get metrics history' })
  @ApiResponse({ status: 200, description: 'Metrics history retrieved successfully' })
  @ApiQuery({ name: 'hours', required: false, description: 'Number of hours of history to retrieve' })
  async getMetricsHistory(@Query('hours') hours: number = 24) {
    return await this.analyticsService.getMetricsHistory(hours);
  }

  @Get('analytics/health')
  @Roles('cache', 'read')
  @ApiOperation({ summary: 'Get cache health status' })
  @ApiResponse({ status: 200, description: 'Health status retrieved successfully' })
  async getHealthStatus() {
    return await this.analyticsService.getHealthStatus();
  }

  @Get('analytics/reports')
  @Roles('cache', 'read')
  @ApiOperation({ summary: 'Generate cache performance report' })
  @ApiResponse({ status: 200, description: 'Report generated successfully' })
  @ApiQuery({ name: 'period', required: false, description: 'Report period (hourly, daily, weekly, monthly)' })
  async generateReport(@Query('period') period: 'hourly' | 'daily' | 'weekly' | 'monthly' = 'daily') {
    return await this.analyticsService.generateReport(period);
  }

  @Get('analytics/alerts')
  @Roles('cache', 'read')
  @ApiOperation({ summary: 'Get cache alerts' })
  @ApiResponse({ status: 200, description: 'Cache alerts retrieved successfully' })
  @ApiQuery({ name: 'resolved', required: false, description: 'Filter by resolved status' })
  async getAlerts(@Query('resolved') resolved: boolean = false) {
    return await this.analyticsService.getAlerts(resolved);
  }

  @Post('analytics/alerts/:id/acknowledge')
  @Roles('cache', 'write')
  @ApiOperation({ summary: 'Acknowledge cache alert' })
  @ApiResponse({ status: 200, description: 'Alert acknowledged successfully' })
  @ApiResponse({ status: 404, description: 'Alert not found' })
  @ApiParam({ name: 'id', description: 'Alert ID' })
  async acknowledgeAlert(@Param('id') id: string) {
    const acknowledged = await this.analyticsService.acknowledgeAlert(id);
    if (!acknowledged) {
      throw new Error('Alert not found');
    }
    return { message: 'Alert acknowledged successfully' };
  }

  @Get('analytics/export')
  @Roles('cache', 'read')
  @ApiOperation({ summary: 'Export cache analytics data' })
  @ApiResponse({ status: 200, description: 'Analytics data exported successfully' })
  @ApiQuery({ name: 'format', required: false, description: 'Export format (json, csv)' })
  async exportAnalytics(@Query('format') format: 'json' | 'csv' = 'json', @Res() res: Response) {
    const data = await this.analyticsService.exportAnalytics(format);

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="cache-analytics-${Date.now()}.csv"`);
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="cache-analytics-${Date.now()}.json"`);
    }

    res.send(data);
  }

  // Cache Warming
  @Get('warming/jobs')
  @Roles('cache', 'read')
  @ApiOperation({ summary: 'Get cache warming jobs' })
  @ApiResponse({ status: 200, description: 'Warming jobs retrieved successfully' })
  async getWarmingJobs() {
    return await this.warmingService.getJobs();
  }

  @Post('warming/jobs')
  @Roles('cache', 'write')
  @ApiOperation({ summary: 'Create cache warming job' })
  @ApiResponse({ status: 201, description: 'Warming job created successfully' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        urls: { type: 'array', items: { type: 'string' } },
        priority: { type: 'number' },
        interval: { type: 'number' },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
  })
  async createWarmingJob(
    @Body() job: Omit<CacheWarmingJob, 'id' | 'successCount' | 'failureCount' | 'averageDuration'>,
  ) {
    return await this.warmingService.createJob(job);
  }

  @Put('warming/jobs/:id')
  @Roles('cache', 'write')
  @ApiOperation({ summary: 'Update cache warming job' })
  @ApiResponse({ status: 200, description: 'Warming job updated successfully' })
  @ApiResponse({ status: 404, description: 'Warming job not found' })
  @ApiParam({ name: 'id', description: 'Warming job ID' })
  async updateWarmingJob(@Param('id') id: string, @Body() updates: Partial<CacheWarmingJob>) {
    const updated = await this.warmingService.updateJob(id, updates);
    if (!updated) {
      throw new Error('Warming job not found');
    }
    return updated;
  }

  @Delete('warming/jobs/:id')
  @Roles('cache', 'delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete cache warming job' })
  @ApiResponse({ status: 204, description: 'Warming job deleted successfully' })
  @ApiResponse({ status: 404, description: 'Warming job not found' })
  @ApiParam({ name: 'id', description: 'Warming job ID' })
  async deleteWarmingJob(@Param('id') id: string) {
    const deleted = await this.warmingService.deleteJob(id);
    if (!deleted) {
      throw new Error('Warming job not found');
    }
  }

  @Post('warming/jobs/:id/execute')
  @Roles('cache', 'write')
  @ApiOperation({ summary: 'Execute cache warming job' })
  @ApiResponse({ status: 200, description: 'Warming job executed successfully' })
  @ApiResponse({ status: 404, description: 'Warming job not found' })
  @ApiParam({ name: 'id', description: 'Warming job ID' })
  async executeWarmingJob(@Param('id') id: string) {
    return await this.warmingService.executeJob(id);
  }

  @Post('warming/popular')
  @Roles('cache', 'write')
  @ApiOperation({ summary: 'Warm popular content' })
  @ApiResponse({ status: 200, description: 'Popular content warmed successfully' })
  @ApiQuery({ name: 'limit', required: false, description: 'Number of popular items to warm' })
  async warmPopularContent(@Query('limit') limit: number = 50) {
    return await this.warmingService.warmPopularContent(limit);
  }

  @Post('warming/user-based')
  @Roles('cache', 'write')
  @ApiOperation({ summary: 'Warm user-based content' })
  @ApiResponse({ status: 200, description: 'User-based content warmed successfully' })
  @ApiBody({
    schema: { type: 'object', properties: { userId: { type: 'string' }, userPreferences: { type: 'object' } } },
  })
  async warmUserBasedContent(@Body() body: { userId: string; userPreferences?: Record<string, unknown> }) {
    return await this.warmingService.warmUserBasedContent(body.userId, body.userPreferences);
  }

  @Post('warming/time-based')
  @Roles('cache', 'write')
  @ApiOperation({ summary: 'Warm time-based content' })
  @ApiResponse({ status: 200, description: 'Time-based content warmed successfully' })
  async warmTimeBasedContent() {
    return await this.warmingService.warmTimeBasedContent();
  }

  @Get('warming/history')
  @Roles('cache', 'read')
  @ApiOperation({ summary: 'Get cache warming history' })
  @ApiResponse({ status: 200, description: 'Warming history retrieved successfully' })
  @ApiQuery({ name: 'limit', required: false, description: 'Number of records to retrieve' })
  async getWarmingHistory(@Query('limit') limit: number = 50) {
    return await this.warmingService.getWarmingHistory(limit);
  }

  @Get('warming/stats')
  @Roles('cache', 'read')
  @ApiOperation({ summary: 'Get cache warming statistics' })
  @ApiResponse({ status: 200, description: 'Warming statistics retrieved successfully' })
  @ApiQuery({ name: 'days', required: false, description: 'Number of days to analyze' })
  async getWarmingStats(@Query('days') days: number = 7) {
    return await this.warmingService.getWarmingStats(days);
  }

  // Cache Utilities
  @Get('stats')
  @Roles('cache', 'read')
  @ApiOperation({ summary: 'Get cache statistics' })
  @ApiResponse({ status: 200, description: 'Cache statistics retrieved successfully' })
  async getStats() {
    return await this.cacheService.getStats();
  }

  @Post('reset-stats')
  @Roles('cache', 'write')
  @ApiOperation({ summary: 'Reset cache statistics' })
  @ApiResponse({ status: 200, description: 'Cache statistics reset successfully' })
  async resetStats() {
    await this.cacheService.resetStats();
    await this.analyticsService.resetStats();
    return { message: 'Cache statistics reset successfully' };
  }

  @Post('warm-cache')
  @Roles('cache', 'write')
  @ApiOperation({ summary: 'Warm cache with URLs' })
  @ApiResponse({ status: 200, description: 'Cache warmed successfully' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        urls: { type: 'array', items: { type: 'string' } },
        priority: { type: 'number' },
        ttl: { type: 'number' },
      },
    },
  })
  async warmCache(@Body() body: { urls: string[]; priority?: number; ttl?: number }) {
    await this.cacheService.warmCache(body.urls, {
      priority: body.priority,
      ttl: body.ttl,
    });
    return { message: `Cache warming initiated for ${body.urls.length} URLs` };
  }

  @Get('export')
  @Roles('cache', 'read')
  @ApiOperation({ summary: 'Export cache data' })
  @ApiResponse({ status: 200, description: 'Cache data exported successfully' })
  async exportCache(@Res() res: Response) {
    const data = await this.cacheService.export();

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="cache-export-${Date.now()}.json"`);
    res.send(data);
  }

  @Post('import')
  @Roles('cache', 'write')
  @ApiOperation({ summary: 'Import cache data' })
  @ApiResponse({ status: 200, description: 'Cache data imported successfully' })
  @ApiBody({ schema: { type: 'object', properties: { data: { type: 'object' } } } })
  async importCache(@Body() body: { data: any }) {
    const result = await this.cacheService.import(body.data);
    return {
      message: 'Cache import completed',
      imported: result.imported,
      skipped: result.skipped,
      errors: result.errors.length,
    };
  }
}

@ApiTags('Public Cache')
@Controller('public/cache')
export class PublicCacheController {
  constructor(private readonly cacheService: StaticContentCacheService) {}

  @Get(':key')
  @ApiOperation({ summary: 'Get cached content (public endpoint)' })
  @ApiResponse({ status: 200, description: 'Cached content retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Content not found in cache' })
  @ApiParam({ name: 'key', description: 'Cache key' })
  async getCachedContent(@Param('key') key: string) {
    const entry = await this.cacheService.get(key);
    if (!entry) {
      throw new Error('Content not found in cache');
    }
    return entry;
  }

  @Get(':key/exists')
  @ApiOperation({ summary: 'Check if content exists in cache' })
  @ApiResponse({ status: 200, description: 'Cache check completed successfully' })
  @ApiParam({ name: 'key', description: 'Cache key' })
  async checkCacheExists(@Param('key') key: string) {
    const entry = await this.cacheService.get(key);
    return {
      exists: !!entry,
      entry: entry ? { contentType: entry.contentType, size: entry.size, lastAccessed: entry.lastAccessed } : null,
    };
  }
}
