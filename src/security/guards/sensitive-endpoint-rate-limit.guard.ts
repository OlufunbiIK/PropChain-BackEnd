import { Injectable, CanActivate, ExecutionContext, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimitingService } from '../services/rate-limiting.service';
import { IpBlockingService } from '../services/ip-blocking.service';

export interface SensitiveRateLimitOptions {
  windowMs?: number;
  maxRequests?: number;
  keyPrefix?: string;
  enableProgressiveDelay?: boolean;
  blockOnExceed?: boolean;
  blockDurationMs?: number;
}

@Injectable()
export class SensitiveEndpointRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(SensitiveEndpointRateLimitGuard.name);

  constructor(
    private readonly rateLimitingService: RateLimitingService,
    private readonly ipBlockingService: IpBlockingService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      const request = context.switchToHttp().getRequest();
      const response = context.switchToHttp().getResponse();

      const options =
        this.reflector.get<SensitiveRateLimitOptions>('sensitiveRateLimitOptions', context.getHandler()) ||
        this.getDefaultOptions();

      const ip = this.getClientIp(request);

      if (await this.ipBlockingService.isIpBlocked(ip)) {
        this.logger.warn(`Blocked request from IP: ${ip}`);
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: 'Your IP has been temporarily blocked due to suspicious activity',
            error: 'Too Many Requests',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      if (await this.ipBlockingService.isIpWhitelisted(ip)) {
        return true;
      }

      const key = this.generateKey(request, context);
      const config = {
        windowMs: options.windowMs || 60000,
        maxRequests: options.maxRequests || 5,
        keyPrefix: options.keyPrefix || 'sensitive',
      };

      const { allowed, info } = await this.rateLimitingService.checkRateLimit(key, config);

      this.setRateLimitHeaders(response, info);

      if (!allowed) {
        this.logger.warn(`Rate limit exceeded for sensitive endpoint. Key: ${key}, IP: ${ip}`);

        if (options.enableProgressiveDelay) {
          await this.applyProgressiveDelay(key, config);
        }

        if (options.blockOnExceed) {
          const blockDuration = options.blockDurationMs || 3600000;
          await this.ipBlockingService.blockIp(
            ip,
            `Rate limit exceeded on sensitive endpoint: ${request.path}`,
            blockDuration,
          );
          await this.ipBlockingService.recordFailedAttempt(ip, `Rate limit exceeded: ${request.path}`);
        }

        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: 'Too many requests. Please try again later.',
            error: 'Too Many Requests',
            retryAfter: Math.ceil(info.resetTime / 1000),
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      return true;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error('Sensitive rate limit check failed:', error);
      return true;
    }
  }

  private async applyProgressiveDelay(key: string, config: any): Promise<void> {
    const attempts = await this.getExcessAttempts(key, config);
    if (attempts > 0) {
      const delayMs = Math.min(attempts * 1000, 10000);
      this.logger.debug(`Applying progressive delay of ${delayMs}ms for key: ${key}`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  private async getExcessAttempts(key: string, config: any): Promise<number> {
    const info = await this.rateLimitingService.getRateLimitInfo(key, config);
    if (!info) {
      return 1;
    }
    return Math.max(0, config.maxRequests - info.remaining);
  }

  private generateKey(request: any, context: ExecutionContext): string {
    if (request.user?.id) {
      return `user:${request.user.id}`;
    }

    const email = request.body?.email;
    if (email) {
      return `email:${email}`;
    }

    const ip = this.getClientIp(request);
    return `ip:${ip}`;
  }

  private getClientIp(request: any): string {
    return (
      request.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      request.headers['x-real-ip'] ||
      request.connection?.remoteAddress ||
      request.socket?.remoteAddress ||
      (request.connection?.socket ? request.connection.socket.remoteAddress : null) ||
      'unknown'
    );
  }

  private setRateLimitHeaders(response: any, info: any): void {
    if (response && response.setHeader && info) {
      response.setHeader('X-RateLimit-Limit', info.limit);
      response.setHeader('X-RateLimit-Remaining', info.remaining);
      response.setHeader('X-RateLimit-Reset', Math.floor(info.resetTime / 1000));
      response.setHeader('Retry-After', Math.ceil((info.resetTime - Date.now()) / 1000));
    }
  }

  private getDefaultOptions(): SensitiveRateLimitOptions {
    return {
      windowMs: 60000,
      maxRequests: 5,
      keyPrefix: 'sensitive',
      enableProgressiveDelay: true,
      blockOnExceed: false,
      blockDurationMs: 3600000,
    };
  }
}
