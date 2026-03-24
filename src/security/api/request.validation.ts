import { Injectable, NestInterceptor, ExecutionContext, CallHandler, BadRequestException } from '@nestjs/common';
import { Observable } from 'rxjs';
import { InputSanitizationService } from '../services/input-sanitization.service';

/**
 * Request Validation and Sanitization Interceptor
 *
 * Validates and sanitizes incoming requests to prevent injection attacks
 */
@Injectable()
export class RequestValidationInterceptor implements NestInterceptor {
  constructor(private readonly inputSanitizationService: InputSanitizationService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();

    // Validate and sanitize request
    this.validateAndSanitizeRequest(request);

    return next.handle();
  }

  /**
   * Validate and sanitize request data
   */
  private validateAndSanitizeRequest(request: any): void {
    // Validate request size
    this.validateRequestSize(request);

    if (request.query) {
      this.inputSanitizationService.assertSafeRequestPayload(request.query, 'request.query');
      request.query = this.inputSanitizationService.sanitizeRequestPayload(request.query);
    }

    if (request.body) {
      this.inputSanitizationService.assertSafeRequestPayload(request.body, 'request.body');
      request.body = this.inputSanitizationService.sanitizeRequestPayload(request.body);
    }

    if (request.params) {
      this.inputSanitizationService.assertSafeRequestPayload(request.params, 'request.params');
      request.params = this.inputSanitizationService.sanitizeRequestPayload(request.params);
    }
  }

  /**
   * Validate request size
   */
  private validateRequestSize(request: any): void {
    const maxSize = 10 * 1024 * 1024; // 10MB
    const payload = {
      body: request.body,
      params: request.params,
      query: request.query,
    };
    const size = Buffer.byteLength(JSON.stringify(payload ?? {}), 'utf8');

    if (size > maxSize) {
      throw new BadRequestException('Request size exceeds maximum allowed size');
    }
  }
}
