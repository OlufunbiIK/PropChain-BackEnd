import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import * as compression from 'compression';
import { AppModule } from './app.module';
import { StructuredLoggerService } from './common/logging/logger.service';
import { ErrorResponseDto } from './common/errors/error.dto';
import { SecurityHeadersService } from './security/services/security-headers.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  const configService = app.get(ConfigService);
  const logger = await app.resolve(StructuredLoggerService);
  app.useLogger(logger);

  // Security middleware
  app.use(helmet());
  app.use(compression());

  // Enhanced security headers - CSP, HSTS, and other security headers
  const securityHeadersService = app.get(SecurityHeadersService);
  const isProduction = configService.get('NODE_ENV') === 'production';

  // Get environment-specific security headers configuration
  const securityConfig = isProduction
    ? undefined // Use default production config
    : securityHeadersService.getDevelopmentConfig();

  // Validate configuration in production
  if (isProduction) {
    const configErrors = securityHeadersService.validateConfig(securityHeadersService['defaultConfig']);
    if (configErrors.length > 0) {
      logger.warn(`Security configuration warnings: ${configErrors.join(', ')}`);
    }
  }

  // Apply security headers middleware
  const securityHeaders = securityHeadersService.getSecurityHeaders(securityConfig);
  app.use((req: any, res: any, next: () => void) => {
    Object.entries(securityHeaders).forEach(([key, value]) => {
      res.setHeader(key, value);
    });
    next();
  });

  logger.log(`Security headers configured: ${Object.keys(securityHeaders).length} headers applied`);

  // CORS configuration
  app.enableCors({
    origin: configService.get('CORS_ORIGIN', '*'),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-correlation-id'],
  });

  // Global pipes
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // API prefix
  const apiPrefix = configService.get('API_PREFIX', 'api');
  app.setGlobalPrefix(apiPrefix);

  // Swagger documentation
  if (configService.get('SWAGGER_ENABLED', true)) {
    const config = new DocumentBuilder()
      .setTitle('PropChain API')
      .setDescription('Decentralized Real Estate Infrastructure - Backend API')
      .setVersion('1.0.0')
      .addTag('properties')
      .addTag('transactions')
      .addTag('users')
      .addTag('blockchain')
      .addBearerAuth()
      .addApiKey({ type: 'apiKey', name: 'X-API-KEY', in: 'header' }, 'apiKey')
      .build();

    const document = SwaggerModule.createDocument(app, config, {
      extraModels: [ErrorResponseDto],
    });
    SwaggerModule.setup(`${apiPrefix}/docs`, app, document, {
      customSiteTitle: 'PropChain API Documentation',
      customCss: '.swagger-ui .topbar { display: none }',
      customfavIcon: '/favicon.ico',
    });

    logger.log(`Swagger documentation available at /${apiPrefix}/docs`);
  }

  const port = configService.get<number>('PORT', 3000);
  const host = configService.get<string>('HOST', '0.0.0.0');

  await app.listen(port, host);

  logger.log(`🚀 PropChain Backend is running on: http://${host}:${port}/${apiPrefix}`);
  logger.log(`🏠 Environment: ${configService.get('NODE_ENV', 'development')}`);
  logger.log(`📊 Health check: http://${host}:${port}/${apiPrefix}/health`);

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    logger.log('SIGTERM signal received: closing HTTP server');
    await app.close();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    logger.log('SIGINT signal received: closing HTTP server');
    await app.close();
    process.exit(0);
  });
}

bootstrap().catch(async error => {
  // Use a temporary logger since the app hasn't started
  const tempLogger = new (await import('./common/logging/logger.service')).StructuredLoggerService(null);
  tempLogger.setContext('Main');
  tempLogger.error('Failed to start application:', error.stack, {});
  process.exit(1);
});
