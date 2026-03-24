import { Injectable, NestMiddleware, Logger, BadRequestException } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

export interface HeaderValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  sanitizedHeaders: Record<string, string>;
}

export interface HeaderValidationConfig {
  maxHeaderSize: number;
  maxHeaderCount: number;
  blockSuspiciousPatterns: boolean;
  allowedHeaders?: string[];
  blockedHeaders?: string[];
}

@Injectable()
export class HeaderValidationMiddleware implements NestMiddleware {
  private readonly logger = new Logger(HeaderValidationMiddleware.name);
  private readonly config: HeaderValidationConfig;

  // Patterns that indicate potential attacks
  private readonly suspiciousPatterns = [
    /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, // XSS scripts
    /javascript:/gi,
    /on\w+\s*=/gi, // Event handlers like onclick=
    /data:\s*text\/html/gi,
    /vbscript:/gi,
    /expression\s*\(/gi,
    /union\s+select/gi, // SQL injection
    /or\s+1\s*=\s*1/gi,
    /;\s*drop\s+table/gi,
    /;\s*delete\s+from/gi,
    /;\s*insert\s+into/gi,
    /\.\.\//g, // Path traversal
    /%2e%2e%2f/gi, // Encoded path traversal
    /%252e%252e%252f/gi, // Double encoded path traversal
  ];

  // Headers that should be blocked for security reasons
  private readonly defaultBlockedHeaders = [
    'x-forwarded-host', // Can be spoofed
    'x-original-url', // Can be used for SSRF
    'x-rewrite-url', // Can be used for SSRF
  ];

  // Headers that are required for certain operations
  private readonly requiredHeadersForApi = ['content-type'];

  constructor() {
    this.config = {
      maxHeaderSize: 8192, // 8KB max per header
      maxHeaderCount: 50,
      blockSuspiciousPatterns: true,
      blockedHeaders: this.defaultBlockedHeaders,
    };
  }

  use(req: Request, res: Response, next: NextFunction): void {
    const result = this.validateHeaders(req);

    if (!result.isValid) {
      this.logger.warn(`Header validation failed: ${result.errors.join(', ')}`);
      throw new BadRequestException({
        statusCode: 400,
        message: 'Invalid request headers',
        errors: result.errors,
      });
    }

    if (result.warnings.length > 0) {
      this.logger.debug(`Header validation warnings: ${result.warnings.join(', ')}`);
    }

    // Attach sanitized headers to request
    (req as any).sanitizedHeaders = result.sanitizedHeaders;

    next();
  }

  /**
   * Validate all request headers
   */
  validateHeaders(req: Request): HeaderValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const sanitizedHeaders: Record<string, string> = {};

    const headers = req.headers;

    // Check header count
    const headerCount = Object.keys(headers).length;
    if (headerCount > this.config.maxHeaderCount) {
      errors.push(`Too many headers: ${headerCount} (max: ${this.config.maxHeaderCount})`);
    }

    // Validate each header
    for (const [name, value] of Object.entries(headers)) {
      const headerName = name.toLowerCase();

      // Skip undefined values
      if (value === undefined) {
        continue;
      }

      // Convert array values to string for validation
      const headerValue = Array.isArray(value) ? value.join(', ') : String(value);

      // Check header size
      if (headerValue.length > this.config.maxHeaderSize) {
        errors.push(`Header '${headerName}' exceeds maximum size`);
        continue;
      }

      // Check for blocked headers
      if (this.config.blockedHeaders?.includes(headerName)) {
        errors.push(`Blocked header detected: '${headerName}'`);
        continue;
      }

      // Check for suspicious patterns
      if (this.config.blockSuspiciousPatterns) {
        const suspiciousCheck = this.detectSuspiciousPatterns(headerName, headerValue);
        if (suspiciousCheck.detected) {
          errors.push(`Suspicious pattern in header '${headerName}': ${suspiciousCheck.pattern}`);
          continue;
        }
      }

      // Check for null bytes
      if (headerValue.includes('\0') || headerName.includes('\0')) {
        errors.push(`Null byte detected in header '${headerName}'`);
        continue;
      }

      // Check for control characters (except common ones)
      if (this.containsControlCharacters(headerValue)) {
        warnings.push(`Control characters detected in header '${headerName}'`);
      }

      // Sanitize and store
      sanitizedHeaders[headerName] = this.sanitizeHeaderValue(headerValue);
    }

    // Validate Content-Type for POST/PUT/PATCH requests
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      const contentType = headers['content-type'];
      if (!contentType) {
        warnings.push('Missing Content-Type header for request with body');
      } else if (!this.isValidContentType(contentType)) {
        errors.push(`Invalid Content-Type: ${contentType}`);
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      sanitizedHeaders,
    };
  }

  /**
   * Detect suspicious patterns in header value
   */
  private detectSuspiciousPatterns(headerName: string, headerValue: string): { detected: boolean; pattern?: string } {
    // Skip validation for certain headers that may contain legitimate complex values
    const skipPatternCheck = ['authorization', 'cookie', 'x-api-key'];
    if (skipPatternCheck.includes(headerName)) {
      return { detected: false };
    }

    for (const pattern of this.suspiciousPatterns) {
      if (pattern.test(headerValue)) {
        return { detected: true, pattern: pattern.source };
      }
    }

    return { detected: false };
  }

  /**
   * Check if value contains control characters
   */
  private containsControlCharacters(value: string): boolean {
    // Check for control characters except tab, newline, carriage return
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
        return true;
      }
    }
    return false;
  }

  /**
   * Sanitize header value by removing dangerous characters
   */
  private sanitizeHeaderValue(value: string): string {
    return value
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Remove control characters
      .replace(/\r\n/g, ' ') // Replace CRLF with space (header injection prevention)
      .trim();
  }

  /**
   * Validate Content-Type header
   */
  private isValidContentType(contentType: string): boolean {
    const validContentTypes = [
      'application/json',
      'application/x-www-form-urlencoded',
      'multipart/form-data',
      'text/plain',
      'text/html',
      'application/xml',
      'text/xml',
    ];

    const baseContentType = contentType.split(';')[0].trim().toLowerCase();
    return validContentTypes.includes(baseContentType) || baseContentType.startsWith('application/');
  }

  /**
   * Validate specific header by name
   */
  validateHeader(name: string, value: string): { isValid: boolean; error?: string } {
    const headerName = name.toLowerCase();

    if (this.config.blockedHeaders?.includes(headerName)) {
      return { isValid: false, error: `Header '${name}' is blocked` };
    }

    if (value.length > this.config.maxHeaderSize) {
      return { isValid: false, error: `Header '${name}' exceeds maximum size` };
    }

    const suspiciousCheck = this.detectSuspiciousPatterns(headerName, value);
    if (suspiciousCheck.detected) {
      return { isValid: false, error: `Suspicious pattern detected: ${suspiciousCheck.pattern}` };
    }

    return { isValid: true };
  }

  /**
   * Get security report for headers
   */
  getSecurityReport(headers: Record<string, string>): {
    score: number;
    issues: string[];
    recommendations: string[];
  } {
    const issues: string[] = [];
    const recommendations: string[] = [];
    let score = 100;

    // Check for missing security headers in response
    const securityHeaders = {
      'content-security-policy': 20,
      'strict-transport-security': 15,
      'x-frame-options': 10,
      'x-content-type-options': 10,
      'x-xss-protection': 10,
      'referrer-policy': 5,
      'permissions-policy': 5,
    };

    for (const [header, points] of Object.entries(securityHeaders)) {
      if (!headers[header]) {
        issues.push(`Missing security header: ${header}`);
        score -= points;
      }
    }

    // Check for information disclosure
    if (headers['server'] && headers['server'].length > 20) {
      issues.push('Server header reveals detailed information');
      recommendations.push('Configure server header to hide version information');
      score -= 5;
    }

    if (headers['x-powered-by']) {
      issues.push('X-Powered-By header exposes technology stack');
      recommendations.push('Remove X-Powered-By header');
      score -= 5;
    }

    // Check HSTS configuration
    if (headers['strict-transport-security']) {
      const hsts = headers['strict-transport-security'];
      if (!hsts.includes('includeSubDomains')) {
        recommendations.push('Add includeSubDomains to HSTS header');
      }
      if (!hsts.includes('preload')) {
        recommendations.push('Consider adding preload to HSTS header');
      }
    }

    return {
      score: Math.max(0, score),
      issues,
      recommendations,
    };
  }
}
