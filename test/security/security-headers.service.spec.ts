import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SecurityHeadersService } from '../../src/security/services/security-headers.service';

describe('SecurityHeadersService', () => {
  let service: SecurityHeadersService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SecurityHeadersService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<SecurityHeadersService>(SecurityHeadersService);
  });

  it('returns the XSS-focused security header set', () => {
    const headers = service.getSecurityHeaders();

    expect(headers['Content-Security-Policy']).toContain("default-src 'self'");
    expect(headers['X-XSS-Protection']).toBe('1; mode=block');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Cross-Origin-Opener-Policy']).toBe('same-origin');
    expect(headers['Cross-Origin-Resource-Policy']).toBe('same-origin');
    expect(headers['Origin-Agent-Cluster']).toBe('?1');
  });

  it('returns the relaxed development profile when requested', () => {
    const headers = service.getSecurityHeaders(service.getDevelopmentConfig());

    expect(headers['X-Frame-Options']).toBe('SAMEORIGIN');
    expect(headers['Cross-Origin-Opener-Policy']).toBe('same-origin-allow-popups');
    expect(headers['Cross-Origin-Resource-Policy']).toBe('cross-origin');
  });
});
