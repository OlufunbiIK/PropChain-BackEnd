// PrismaService manages the PrismaClient lifecycle and database connection pooling.
// Connection pooling is configured via the DATABASE_URL environment variable.
// Example: postgresql://user:pass@host:5432/db?connection_limit=10&pool_timeout=30
// See docs/DATABASE_SCHEMA.md for recommended settings.
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { StructuredLoggerService } from '../../common/logging/logger.service';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  /**
   * PrismaService constructor
   * - Configures PrismaClient with connection pooling via DATABASE_URL
   * - See docs/DATABASE_SCHEMA.md for recommended pooling settings
   * - Logs queries, errors, and warnings
   */
  constructor(
    private readonly configService: ConfigService,
    private readonly logger: StructuredLoggerService,
  ) {
    // Get the database URL from environment/config
    let databaseUrl = configService.get<string>('DATABASE_URL');

    if (databaseUrl) {
      // Enforce database connection encryption (SSL)
      if (!databaseUrl.includes('sslmode=')) {
        const separator = databaseUrl.includes('?') ? '&' : '?';
        databaseUrl += `${separator}sslmode=require`;
      }

      // Enforce connection pooling security
      if (!databaseUrl.includes('connection_limit=')) {
        const separator = databaseUrl.includes('?') ? '&' : '?';
        databaseUrl += `${separator}connection_limit=5`;
      }

      if (!databaseUrl.includes('pool_timeout=')) {
        const separator = databaseUrl.includes('?') ? '&' : '?';
        databaseUrl += `${separator}pool_timeout=10`;
      }
    }

    // Prisma uses the connection URL to configure pooling
    // Example: postgresql://user:pass@host:5432/db?connection_limit=10&pool_timeout=30
    super({
      datasources: {
        db: {
          url: databaseUrl,
        },
      },
      log: [
        { level: 'query', emit: 'event' },
        { level: 'error', emit: 'stdout' },
        { level: 'warn', emit: 'stdout' },
      ],
    });

    this.logger.setContext('PrismaService');
  }

  /**
   * Initialize Prisma connection and enable query performance monitoring.
   * Logs query durations and parameters for performance analysis.
   */
  async onModuleInit() {
    this.logger.log('Connecting to database...');

    // Enable query performance monitoring in all environments
    (this as any).$on('query', (e: any) => {
      // Log query duration, SQL, and parameters
      this.logger.logDatabase('query', e.duration, {
        query: e.query,
        params: e.params,
      });
    });

    await this.$connect();
    this.logger.log('Database connection established');
  }

  async onModuleDestroy() {
    this.logger.log('Disconnecting from database...');
    await this.$disconnect();
    this.logger.log('Database connection closed');
  }

  /**
   * Clean database for testing purposes
   * WARNING: This will delete all data from the database
   */
  async cleanDatabase() {
    if (this.configService.get<string>('NODE_ENV') === 'production') {
      throw new Error('Cannot clean database in production environment');
    }

    const models = Reflect.ownKeys(this).filter(
      key => typeof key === 'string' && !key.startsWith('_') && !key.startsWith('$'),
    );

    return Promise.all(
      models.map(modelKey => {
        const model = this[modelKey as string];
        if (model && typeof model.deleteMany === 'function') {
          return model.deleteMany();
        }
        return Promise.resolve();
      }),
    );
  }

  /**
   * Health check for database connection
   */
  async isHealthy(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      const err = error as Error;
      this.logger.error('Database health check failed', err.stack, {
        message: err.message,
      });
      return false;
    }
  }

  /**
   * Execute a transaction with automatic retry logic
   */
  async executeTransaction<T>(
    fn: (prisma: Prisma.TransactionClient) => Promise<T>,
    options?: {
      maxRetries?: number;
      timeout?: number;
    },
  ): Promise<T> {
    const maxRetries = options?.maxRetries ?? 3;
    const timeout = options?.timeout ?? 5000;

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.$transaction(fn, {
          timeout,
          maxWait: timeout,
        });
      } catch (error) {
        lastError = error as Error;
        this.logger.warn(`Transaction attempt ${attempt}/${maxRetries} failed: ${lastError.message}`);

        if (attempt < maxRetries) {
          // Exponential backoff
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 100));
        }
      }
    }

    throw lastError;
  }
}
