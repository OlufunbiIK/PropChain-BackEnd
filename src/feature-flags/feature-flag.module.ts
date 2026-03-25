import { Module } from '@nestjs/common';
import { FeatureFlagService } from './feature-flag.service';
import { FeatureFlagAnalyticsService } from './feature-flag-analytics.service';
import { FeatureFlagHelperService } from './feature-flag-helper.service';
import { FeatureFlagController, PublicFeatureFlagController } from './feature-flag.controller';
import { RedisService } from '../common/services/redis.service';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [ConfigModule],
  controllers: [FeatureFlagController, PublicFeatureFlagController],
  providers: [FeatureFlagService, FeatureFlagAnalyticsService, FeatureFlagHelperService, RedisService],
  exports: [FeatureFlagService, FeatureFlagAnalyticsService, FeatureFlagHelperService],
})
export class FeatureFlagModule {}
