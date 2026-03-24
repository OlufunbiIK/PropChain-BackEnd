import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import * as xss from 'xss';

export const XSS_PATTERNS = [
  /<script[\s>]/i,
  /<iframe[\s>]/i,
  /<object[\s>]/i,
  /<embed[\s>]/i,
  /<form[\s>].*?javascript:/i,
  /javascript:/i,
  /vbscript:/i,
  /data:text\/html/i,
  /onload\s*=|onerror\s*=|onclick\s*=|onmouseover\s*=|onfocus\s*=|onblur\s*=/i,
];

/**
 * Custom validator constraint for XSS protection
 */
@ValidatorConstraint({ async: false })
export class XssValidatorConstraint implements ValidatorConstraintInterface {
  validate(value: any) {
    if (typeof value !== 'string') {
      return true; // Only validate strings
    }

    for (const pattern of XSS_PATTERNS) {
      if (pattern.test(value)) {
        return false;
      }
    }

    return true;
  }

  defaultMessage() {
    return 'The input contains potentially malicious content (XSS)';
  }
}

/**
 * Decorator to validate and sanitize input against XSS attacks
 */
export function IsXssSafe(validationOptions?: ValidationOptions) {
  return function (object: Record<string, any>, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: XssValidatorConstraint,
    });
  };
}

/**
 * Function to sanitize input against XSS
 */
export function sanitizeXss(input: string): string {
  if (typeof input !== 'string') {
    return input;
  }

  if (typeof input !== 'string') {
    return input;
  }

  // For sanitization, we'll use the xss library with a configuration
  // that removes all HTML tags but preserves plain text
  const options = {
    whiteList: {}, // Allow no HTML tags for maximum security
  };

  return xss.filterXSS(input, options);
}

/**
 * Function to sanitize an object against XSS
 */
export function sanitizeObjectXss(obj: any): any {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    return sanitizeXss(obj);
  }

  if (typeof obj === 'object') {
    const sanitized: any = Array.isArray(obj) ? [] : {};

    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        sanitized[key] = sanitizeObjectXss(obj[key]);
      }
    }

    return sanitized;
  }

  return obj;
}
