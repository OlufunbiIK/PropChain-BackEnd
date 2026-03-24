import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

export const SQL_INJECTION_PATTERNS = [
  /\b(?:UNION)(?:\s+ALL)?\s+SELECT\b/i,
  /(?:'|"|`)\s*(?:OR|AND)\s*(?:'[^']*'|"[^"]*"|`[^`]*`|\d+)\s*=\s*(?:'[^']*'|"[^"]*"|`[^`]*`|\d+)/i,
  /\b(?:OR|AND)\b\s+\d+\s*=\s*\d+/i,
  /;\s*(?:DROP|DELETE|INSERT|UPDATE|ALTER|CREATE|TRUNCATE|EXEC(?:UTE)?)\b/i,
  /--\s*$/i,
  /\/\*[\s\S]*\*\//i,
  /\b(?:xp_cmdshell|information_schema|pg_sleep|sleep)\b/i,
];

/**
 * Custom validator constraint for SQL injection prevention
 */
@ValidatorConstraint({ async: false })
export class SqlInjectionValidatorConstraint implements ValidatorConstraintInterface {
  validate(value: any) {
    if (typeof value !== 'string') {
      return true; // Only validate strings
    }

    // Check against known SQL injection patterns
    for (const pattern of SQL_INJECTION_PATTERNS) {
      if (pattern.test(value)) {
        return false;
      }
    }

    return true;
  }

  defaultMessage() {
    return 'The input contains potentially malicious SQL injection content';
  }
}

/**
 * Decorator to validate input against SQL injection
 */
export function IsNotSqlInjection(validationOptions?: ValidationOptions) {
  return function (object: Record<string, any>, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: SqlInjectionValidatorConstraint,
    });
  };
}

/**
 * Function to check if a string contains potential SQL injection patterns
 */
export function containsSqlInjection(input: string): boolean {
  if (typeof input !== 'string') {
    return false;
  }

  for (const pattern of SQL_INJECTION_PATTERNS) {
    if (pattern.test(input)) {
      return true;
    }
  }

  return false;
}

/**
 * Function to sanitize input against SQL injection
 */
export function sanitizeSqlInjection(input: string): string {
  if (typeof input !== 'string') {
    return input;
  }

  let sanitized = input;

  // Remove potentially dangerous SQL keywords and characters
  sanitized = sanitized.replace(/(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|UNION|SCRIPT)\b)/gi, '');
  sanitized = sanitized.replace(/(;|\-\-|\#|\/\*|\*\/)/g, '');
  sanitized = sanitized.replace(/(\b(OR|AND)\b\s*\d+\s*[=<>]\s*\d+)/gi, '');
  sanitized = sanitized.replace(/('|--|#|\/\*|\*\/)/g, '');

  return sanitized.trim();
}

/**
 * Function to sanitize an object against SQL injection
 */
export function sanitizeObjectSqlInjection(obj: any): any {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    return sanitizeSqlInjection(obj);
  }

  if (typeof obj === 'object') {
    const sanitized: any = Array.isArray(obj) ? [] : {};

    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        sanitized[key] = sanitizeObjectSqlInjection(obj[key]);
      }
    }

    return sanitized;
  }

  return obj;
}
