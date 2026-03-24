import { BadRequestException } from '@nestjs/common';
import { InputSanitizationService } from '../../src/security/services/input-sanitization.service';

describe('InputSanitizationService', () => {
  let service: InputSanitizationService;

  beforeEach(() => {
    service = new InputSanitizationService();
  });

  it('sanitizes nested request payloads recursively', () => {
    const sanitized = service.sanitizeRequestPayload({
      name: '  <script>alert("xss")</script>Jane  ',
      profile: {
        bio: '<img src=x onerror=alert(1)>Investor',
      },
      tags: [' <b>prime</b> ', 'clean'],
    });

    expect(sanitized).toEqual({
      name: '&lt;script&gt;alert("xss")&lt;/script&gt;Jane',
      profile: {
        bio: '&lt;img src=x onerror=alert(1)&gt;Investor',
      },
      tags: ['&lt;b&gt;prime&lt;/b&gt;', 'clean'],
    });
  });

  it('rejects SQL injection payloads in any request branch', () => {
    expect(() =>
      service.assertSafeRequestPayload(
        {
          filters: {
            search: "' OR 1=1 --",
          },
        },
        'request.body',
      ),
    ).toThrow(BadRequestException);
  });

  it('sanitizes obvious XSS payloads instead of persisting raw markup', () => {
    const sanitized = service.sanitizeRequestPayload({
      query: '<script>alert(1)</script>',
    });

    expect(sanitized).toEqual({
      query: '&lt;script&gt;alert(1)&lt;/script&gt;',
    });
  });

  it('rejects control characters in string input', () => {
    expect(() => service.assertSafeRequestPayload({ name: 'bad\x00value' }, 'request.body')).toThrow(
      'Invalid control characters detected in request.body.name',
    );
  });
});
