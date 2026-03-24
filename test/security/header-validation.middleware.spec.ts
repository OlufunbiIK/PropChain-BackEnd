import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { HeaderValidationMiddleware } from '../../src/security/middleware/header-validation.middleware';

describe('HeaderValidationMiddleware', () => {
  let middleware: HeaderValidationMiddleware;

  const mockRequest = (headers: Record<string, string> = {}, method = 'GET') =>
    ({
      headers,
      method,
    }) as any;

  const mockResponse = () => ({} as any);

  const mockNext = jest.fn();

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [HeaderValidationMiddleware],
    }).compile();

    middleware = module.get<HeaderValidationMiddleware>(HeaderValidationMiddleware);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(middleware).toBeDefined();
  });

  describe('use', () => {
    it('should pass valid headers', () => {
      const req = mockRequest({
        'content-type': 'application/json',
        authorization: 'Bearer token',
      });
      const res = mockResponse();

      middleware.use(req, res, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(req.sanitizedHeaders).toBeDefined();
    });

    it('should throw BadRequestException for blocked headers', () => {
      const req = mockRequest({
        'x-forwarded-host': 'malicious.com',
      });
      const res = mockResponse();

      expect(() => middleware.use(req, res, mockNext)).toThrow(BadRequestException);
    });

    it('should throw BadRequestException for XSS patterns', () => {
      const req = mockRequest({
        'x-custom-header': '<script>alert("xss")</script>',
      });
      const res = mockResponse();

      expect(() => middleware.use(req, res, mockNext)).toThrow(BadRequestException);
    });

    it('should throw BadRequestException for SQL injection patterns', () => {
      const req = mockRequest({
        'x-custom-header': "'; DROP TABLE users; --",
      });
      const res = mockResponse();

      expect(() => middleware.use(req, res, mockNext)).toThrow(BadRequestException);
    });

    it('should throw BadRequestException for null bytes', () => {
      const req = mockRequest({
        'x-custom-header': 'value\x00injection',
      });
      const res = mockResponse();

      expect(() => middleware.use(req, res, mockNext)).toThrow(BadRequestException);
    });

    it('should pass headers with authorization', () => {
      const req = mockRequest({
        authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test',
      });
      const res = mockResponse();

      middleware.use(req, res, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should pass headers with API key', () => {
      const req = mockRequest({
        'x-api-key': 'propchain_live_abc123xyz',
      });
      const res = mockResponse();

      middleware.use(req, res, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('validateHeaders', () => {
    it('should return valid for empty headers', () => {
      const req = mockRequest({});
      const result = middleware.validateHeaders(req);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should return invalid for oversized header', () => {
      const longValue = 'a'.repeat(10000);
      const req = mockRequest({ 'x-long-header': longValue });
      const result = middleware.validateHeaders(req);

      expect(result.isValid).toBe(false);
      expect(result.errors[0]).toContain('exceeds maximum size');
    });

    it('should return invalid for too many headers', () => {
      const headers: Record<string, string> = {};
      for (let i = 0; i < 60; i++) {
        headers[`x-header-${i}`] = `value-${i}`;
      }
      const req = mockRequest(headers);
      const result = middleware.validateHeaders(req);

      expect(result.isValid).toBe(false);
      expect(result.errors[0]).toContain('Too many headers');
    });

    it('should return warning for control characters', () => {
      const req = mockRequest({ 'x-custom': 'value\x01test' });
      const result = middleware.validateHeaders(req);

      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('should return warning for missing Content-Type on POST', () => {
      const req = mockRequest({}, 'POST');
      const result = middleware.validateHeaders(req);

      expect(result.warnings).toContain('Missing Content-Type header for request with body');
    });

    it('should return invalid for invalid Content-Type', () => {
      const req = mockRequest({ 'content-type': 'invalid/type' }, 'POST');
      const result = middleware.validateHeaders(req);

      expect(result.isValid).toBe(false);
      expect(result.errors[0]).toContain('Invalid Content-Type');
    });

    it('should sanitize headers', () => {
      const req = mockRequest({ 'x-custom': '  value  ' });
      const result = middleware.validateHeaders(req);

      expect(result.sanitizedHeaders['x-custom']).toBe('value');
    });
  });

  describe('validateHeader', () => {
    it('should return valid for normal header', () => {
      const result = middleware.validateHeader('x-custom', 'value');

      expect(result.isValid).toBe(true);
    });

    it('should return invalid for blocked header', () => {
      const result = middleware.validateHeader('x-forwarded-host', 'malicious.com');

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('blocked');
    });

    it('should return invalid for oversized header', () => {
      const longValue = 'a'.repeat(10000);
      const result = middleware.validateHeader('x-custom', longValue);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('exceeds maximum size');
    });

    it('should return invalid for path traversal', () => {
      const result = middleware.validateHeader('x-custom', '../../../etc/passwd');

      expect(result.isValid).toBe(false);
    });
  });

  describe('getSecurityReport', () => {
    it('should return high score for complete security headers', () => {
      const headers = {
        'content-security-policy': "default-src 'self'",
        'strict-transport-security': 'max-age=31536000; includeSubDomains; preload',
        'x-frame-options': 'DENY',
        'x-content-type-options': 'nosniff',
        'x-xss-protection': '1; mode=block',
        'referrer-policy': 'strict-origin-when-cross-origin',
        'permissions-policy': 'geolocation=()',
      };

      const report = middleware.getSecurityReport(headers);

      expect(report.score).toBe(100);
      expect(report.issues).toHaveLength(0);
    });

    it('should return low score for missing security headers', () => {
      const headers = {
        server: 'Apache/2.4.41 (Ubuntu) PHP/7.4.3',
        'x-powered-by': 'Express',
      };

      const report = middleware.getSecurityReport(headers);

      expect(report.score).toBeLessThan(50);
      expect(report.issues.length).toBeGreaterThan(0);
      expect(report.recommendations.length).toBeGreaterThan(0);
    });

    it('should detect information disclosure', () => {
      const headers = {
        server: 'Apache/2.4.41 (Ubuntu) with detailed version info',
        'x-powered-by': 'Express',
      };

      const report = middleware.getSecurityReport(headers);

      expect(report.issues).toContain('Server header reveals detailed information');
      expect(report.issues).toContain('X-Powered-By header exposes technology stack');
    });

    it('should recommend HSTS improvements', () => {
      const headers = {
        'strict-transport-security': 'max-age=31536000',
      };

      const report = middleware.getSecurityReport(headers);

      expect(report.recommendations).toContain('Add includeSubDomains to HSTS header');
      expect(report.recommendations).toContain('Consider adding preload to HSTS header');
    });
  });

  describe('detectSuspiciousPatterns', () => {
    it('should detect XSS patterns', () => {
      const result = (middleware as any).detectSuspiciousPatterns(
        'x-custom',
        '<script>alert(1)</script>',
      );

      expect(result.detected).toBe(true);
    });

    it('should detect javascript: protocol', () => {
      const result = (middleware as any).detectSuspiciousPatterns(
        'x-custom',
        'javascript:alert(1)',
      );

      expect(result.detected).toBe(true);
    });

    it('should detect SQL injection patterns', () => {
      const result = (middleware as any).detectSuspiciousPatterns(
        'x-custom',
        "' OR 1=1 --",
      );

      expect(result.detected).toBe(true);
    });

    it('should skip validation for authorization header', () => {
      const result = (middleware as any).detectSuspiciousPatterns(
        'authorization',
        'Bearer <script>alert(1)</script>',
      );

      expect(result.detected).toBe(false);
    });

    it('should skip validation for cookie header', () => {
      const result = (middleware as any).detectSuspiciousPatterns(
        'cookie',
        'session=<script>alert(1)</script>',
      );

      expect(result.detected).toBe(false);
    });
  });

  describe('isValidContentType', () => {
    it('should return true for application/json', () => {
      const result = (middleware as any).isValidContentType('application/json');

      expect(result).toBe(true);
    });

    it('should return true for multipart/form-data', () => {
      const result = (middleware as any).isValidContentType('multipart/form-data; boundary=----');

      expect(result).toBe(true);
    });

    it('should return false for invalid content type', () => {
      const result = (middleware as any).isValidContentType('invalid/type');

      expect(result).toBe(false);
    });
  });
});
