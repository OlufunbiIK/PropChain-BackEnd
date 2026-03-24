import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RedisModule } from '../common/services/redis.module';
import { RateLimitingService } from './services/rate-limiting.service';
import { IpBlockingService } from './services/ip-blocking.service';
import { DdosProtectionService } from './services/ddos-protection.service';
import { ApiQuotaService } from './services/api-quota.service';
import { SecurityHeadersService } from './services/security-headers.service';
import { InputSanitizationService } from './services/input-sanitization.service';
import { HeaderValidationMiddleware } from './middleware/header-validation.middleware';
import { SecurityController } from './security.controller';
import { AdvancedRateLimitGuard } from './guards/advanced-rate-limit.guard';
import { SensitiveEndpointRateLimitGuard } from './guards/sensitive-endpoint-rate-limit.guard';

@Module({
  imports: [ConfigModule, RedisModule],
  controllers: [SecurityController],
  providers: [
    RateLimitingService,
    IpBlockingService,
    DdosProtectionService,
    ApiQuotaService,
    SecurityHeadersService,
    InputSanitizationService,
    HeaderValidationMiddleware,
    AdvancedRateLimitGuard,
    SensitiveEndpointRateLimitGuard,
  ],
  exports: [
    RateLimitingService,
    IpBlockingService,
    DdosProtectionService,
    ApiQuotaService,
    SecurityHeadersService,
    InputSanitizationService,
    HeaderValidationMiddleware,
    AdvancedRateLimitGuard,
    SensitiveEndpointRateLimitGuard,
  ],
})
export class SecurityModule {}
