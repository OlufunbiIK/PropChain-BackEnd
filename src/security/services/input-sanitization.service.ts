import { BadRequestException, Injectable } from '@nestjs/common';
import { SQL_INJECTION_PATTERNS } from '../../common/validators/sql-injection.validator';
import { sanitizeXss } from '../../common/validators/xss.validator';

@Injectable()
export class InputSanitizationService {
  sanitizeRequestPayload<T>(payload: T): T {
    return this.sanitizeValue(payload) as T;
  }

  assertSafeRequestPayload(payload: unknown, path = 'request'): void {
    this.assertNoThreats(payload, path);
  }

  private sanitizeValue(value: unknown): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === 'string') {
      return this.sanitizeString(value);
    }

    if (Array.isArray(value)) {
      return value.map(item => this.sanitizeValue(item));
    }

    if (!this.isPlainObject(value)) {
      return value;
    }

    return Object.entries(value).reduce<Record<string, unknown>>((acc, [key, nestedValue]) => {
      acc[key] = this.sanitizeValue(nestedValue);
      return acc;
    }, {});
  }

  private sanitizeString(value: string): string {
    const withoutControlCharacters = value
      .replace(/\x00/g, '')
      .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
      .trim();

    return sanitizeXss(withoutControlCharacters);
  }

  private assertNoThreats(value: unknown, path: string): void {
    if (value === null || value === undefined) {
      return;
    }

    if (typeof value === 'string') {
      this.assertSafeString(value, path);
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => this.assertNoThreats(item, `${path}[${index}]`));
      return;
    }

    if (!this.isPlainObject(value)) {
      return;
    }

    Object.entries(value).forEach(([key, nestedValue]) => {
      this.assertNoThreats(nestedValue, `${path}.${key}`);
    });
  }

  private assertSafeString(value: string, path: string): void {
    if (this.containsIllegalControlCharacters(value)) {
      throw new BadRequestException(`Invalid control characters detected in ${path}`);
    }

    if (this.matchesPattern(value, SQL_INJECTION_PATTERNS)) {
      throw new BadRequestException(`Potential SQL injection detected in ${path}`);
    }

  }

  private containsIllegalControlCharacters(value: string): boolean {
    return /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value);
  }

  private matchesPattern(value: string, patterns: RegExp[]): boolean {
    return patterns.some(pattern => {
      pattern.lastIndex = 0;
      return pattern.test(value);
    });
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null) {
      return false;
    }

    if (value instanceof Date || Buffer.isBuffer(value)) {
      return false;
    }

    return Object.getPrototypeOf(value) === Object.prototype;
  }
}
