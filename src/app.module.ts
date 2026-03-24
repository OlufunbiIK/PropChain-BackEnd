import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { TerminusModule } from '@nestjs/terminus';
import { BullModule } from '@nestjs/bull';
import { APP_INTERCEPTOR, APP_FILTER } from '@nestjs/core';

// Core & Database
import { PrismaModule } from './database/prisma/prisma.module';
import { HealthModule } from './health/health.module';
import { ConfigurationModule } from './config/configuration.module';
import configuration from './config/configuration';
import valuationConfig from './config/valuation.config';

// Caching
import { CacheModule } from './common/cache/cache.module';

// Logging
import { LoggingModule } from './common/logging/logging.module';
import { LoggingInterceptor } from './common/logging/logging.interceptor';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { AllExceptionsFilter } from './common/errors/error.filter';

// I18n
import { I18nModule, AcceptLanguageResolver, QueryResolver, HeaderResolver } from 'nestjs-i18n';
import * as path from 'path';

// Redis
import { RedisModule } from './common/services/redis.module';
import { createRedisConfig } from './common/services/redis.config';

// Business Modules
import { PropertiesModule } from './properties/properties.module';
import { UsersModule } from './users/users.module';
import { TransactionsModule } from './transactions/transactions.module';
import { BlockchainModule } from './blockchain/blockchain.module';
import { AuthModule } from './auth/auth.module';
import { FilesModule } from './files/files.module';
import { ValuationModule } from './valuation/valuation.module';
import { ApiKeysModule } from './api-keys/api-keys.module';
import { DocumentsModule } from './documents/documents.module';
import { SecurityModule } from './security/security.module';

// Compliance & Security Modules
import { AuditModule } from './common/audit/audit.module';
import { RbacModule } from './rbac/rbac.module';
import { AuditController } from './common/controllers/audit.controller';

// Middleware
import { AuthRateLimitMiddleware } from './auth/middleware/auth.middleware';
import { HeaderValidationMiddleware } from './security/middleware/header-validation.middleware';
import { ObservabilityModule } from './observability/observability.module';

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration, valuationConfig],
      envFilePath: ['.env.local', '.env.development', '.env'],
      cache: true, // Enable configuration caching
      expandVariables: true, // Allow environment variable expansion
    }),
    ConfigurationModule,

    // I18n
    I18nModule.forRootAsync({
      useFactory: (configService: ConfigService) => ({
        fallbackLanguage: configService.getOrThrow('FALLBACK_LANGUAGE', 'en'),
        loaderOptions: {
          path: path.join(__dirname, '/i18n/'),
          watch: true,
        },
      }),
      resolvers: [{ use: QueryResolver, options: ['lang'] }, AcceptLanguageResolver, new HeaderResolver(['x-lang'])],
      inject: [ConfigService],
    }),

    // Caching
    CacheModule,

    // Core
    LoggingModule,
    PrismaModule,
    HealthModule,
    RedisModule,

    // Security & rate limiting
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => [
        {
          ttl: configService.get<number>('THROTTLE_TTL', 60),
          limit: configService.get<number>('THROTTLE_LIMIT', 10),
        },
      ],
    }),

    // Background jobs
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: createRedisConfig,
    }),

    // Scheduling & health
    ScheduleModule.forRoot(),
    TerminusModule,

    // Business
    AuthModule,
    ApiKeysModule,
    UsersModule,
    PropertiesModule,
    TransactionsModule,
    BlockchainModule,
    FilesModule,
    ValuationModule,
    DocumentsModule,
    SecurityModule, // Add security module

    // Compliance & Security
    AuditModule,
    RbacModule,
    ObservabilityModule,
  ],
  controllers: [
    AuditController, // Add the audit controller
  ],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: ResponseInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      // Header validation for security
      .apply(HeaderValidationMiddleware)
      .forRoutes('*')
      // Auth rate limiting
      .apply(AuthRateLimitMiddleware)
      .forRoutes('/auth*');
  }
}
