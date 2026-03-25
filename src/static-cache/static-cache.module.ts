import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { StaticContentCacheService } from './static-content-cache.service';
import { CacheInvalidationService } from './cache-invalidation.service';
import { CacheAnalyticsService } from './cache-analytics.service';
import { CacheWarmingService } from './cache-warming.service';
import { CacheManagementController, PublicCacheController } from './cache-management.controller';
import { StaticCacheMiddleware } from './middleware/static-cache.middleware';
import { RedisService } from '../common/services/redis.service';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [ConfigModule, ScheduleModule.forRoot()],
  controllers: [CacheManagementController, PublicCacheController],
  providers: [
    StaticContentCacheService,
    CacheInvalidationService,
    CacheAnalyticsService,
    CacheWarmingService,
    StaticCacheMiddleware,
    RedisService,
  ],
  exports: [
    StaticContentCacheService,
    CacheInvalidationService,
    CacheAnalyticsService,
    CacheWarmingService,
    StaticCacheMiddleware,
  ],
})
export class StaticCacheModule {}
