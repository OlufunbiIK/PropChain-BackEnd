import * as winston from 'winston';
import 'winston-daily-rotate-file';

/**
 * Logging configuration with structured JSON format, log rotation, and sensitive data filtering
 */

const SENSITIVE_KEYS = [
  'password',
  'privatekey',
  'private_key',
  'token',
  'secret',
  'mnemonic',
  'seed',
  'apikey',
  'api_key',
  'authorization',
  'auth',
  'creditcard',
  'ssn',
  'pin',
  'database_url',
  'db_url',
  'connection_string',
];

/**
 * Filter sensitive data from log objects
 */
export const filterSensitiveData = (obj: any): any => {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => filterSensitiveData(item));
  }

  const newObj = { ...obj };

  for (const key in newObj) {
    const lowerKey = key.toLowerCase();

    if (SENSITIVE_KEYS.some(sensitiveKey => lowerKey.includes(sensitiveKey))) {
      newObj[key] = '[REDACTED]';
    } else if (typeof newObj[key] === 'object') {
      newObj[key] = filterSensitiveData(newObj[key]);
    }
  }

  return newObj;
};

/**
 * Custom format for sensitive data redaction
 */
const redactFormat = () => {
  return winston.format(info => {
    // Redact common sensitive fields
    const redactedInfo = { ...info };

    // Mask database credentials in string messages
    if (typeof redactedInfo.message === 'string') {
      redactedInfo.message = redactedInfo.message.replace(/(postgres(?:ql)?|mysql):\/\/[^:]+:[^@]+@/g, '$1://***:***@');
    }

    // Redact nested data in 'meta' or 'data' fields
    if (redactedInfo.meta) {
      redactedInfo.meta = filterSensitiveData(redactedInfo.meta);
    }
    if (redactedInfo.data) {
      redactedInfo.data = filterSensitiveData(redactedInfo.data);
    }
    if (redactedInfo.body) {
      redactedInfo.body = filterSensitiveData(redactedInfo.body);
    }

    // Redact direct properties
    for (const key in redactedInfo) {
      const lowerKey = key.toLowerCase();
      if (SENSITIVE_KEYS.some(sensitiveKey => lowerKey.includes(sensitiveKey))) {
        redactedInfo[key] = '[REDACTED]';
      }
    }

    return redactedInfo;
  });
};

/**
 * Create Winston logger with structured JSON format
 */
export const createWinstonLogger = (environment: string): winston.Logger => {
  const isProduction = environment === 'production';
  const errorRetention = process.env.LOG_ERROR_RETENTION_DAYS || '30d';
  const appRetention = process.env.LOG_APP_RETENTION_DAYS || '14d';

  return winston.createLogger({
    level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
    format: winston.format.combine(
      winston.format.timestamp({
        format: 'YYYY-MM-DD HH:mm:ss.SSS',
      }),
      redactFormat()(),
      winston.format.json(),
    ),
    defaultMeta: { service: 'propchain-api', environment },
    transports: [
      // Console transport (always enabled)
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.printf(({ timestamp, level, message, ...meta }) => {
            const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
            return `[${timestamp}] ${level.toUpperCase()}: ${message} ${metaStr}`;
          }),
        ),
      }),

      // Error logs (separate file)
      new winston.transports.DailyRotateFile({
        filename: 'logs/error-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        level: 'error',
        maxFiles: errorRetention,
        maxSize: '20m',
        zippedArchive: true,
      }),

      // Combined logs (all levels)
      new winston.transports.DailyRotateFile({
        filename: 'logs/application-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        maxFiles: appRetention,
        maxSize: '20m',
        zippedArchive: true,
      }),
    ],
  });
};

/**
 * Log levels configuration
 */
export const LOG_LEVELS = {
  ERROR: 'error',
  WARN: 'warn',
  INFO: 'info',
  DEBUG: 'debug',
  VERBOSE: 'verbose',
};

/**
 * Log categories for consistent tagging
 */
export const LOG_CATEGORIES = {
  HTTP: 'HTTP',
  AUTH: 'AUTH',
  DATABASE: 'DATABASE',
  BLOCKCHAIN: 'BLOCKCHAIN',
  TRANSACTION: 'TRANSACTION',
  PROPERTY: 'PROPERTY',
  USER: 'USER',
  VALIDATION: 'VALIDATION',
  ERROR: 'ERROR',
  CACHE: 'CACHE',
  EXTERNAL_API: 'EXTERNAL_API',
};
