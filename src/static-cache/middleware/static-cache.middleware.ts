import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { StaticContentCacheService } from '../static-content-cache.service';
import { CacheContentType } from '../models/static-cache.entity';
import { createHash } from 'crypto';

export interface CacheableRequest extends Request {
  cacheKey?: string;
  cacheTags?: string[];
  cacheTtl?: number;
  skipCache?: boolean;
}

@Injectable()
export class StaticCacheMiddleware implements NestMiddleware {
  private readonly logger = new Logger(StaticCacheMiddleware.name);

  constructor(private readonly cacheService: StaticContentCacheService) {}

  async use(req: CacheableRequest, res: Response, next: NextFunction): Promise<void> {
    // Skip caching for certain requests
    if (this.shouldSkipCache(req)) {
      req.skipCache = true;
      return next();
    }

    // Generate cache key
    req.cacheKey = this.generateCacheKey(req);
    req.cacheTags = this.generateCacheTags(req);
    req.cacheTtl = this.getCacheTtl(req);

    // Try to get from cache
    if (req.method === 'GET') {
      const cachedEntry = await this.cacheService.get(req.cacheKey);

      if (cachedEntry) {
        await this.serveFromCache(req, res, cachedEntry);
        return;
      }
    }

    // Intercept response to cache it
    if (req.method === 'GET') {
      this.interceptResponse(req, res, next);
    } else {
      next();
    }
  }

  private getContentTypeFromUrl(url: string): string | null {
    const extension = url.split('.').pop()?.toLowerCase();

    const contentTypes: Record<string, string> = {
      html: 'text/html',
      css: 'text/css',
      js: 'application/javascript',
      json: 'application/json',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      svg: 'image/svg+xml',
      ico: 'image/x-icon',
      pdf: 'application/pdf',
      xml: 'application/xml',
      txt: 'text/plain',
    };

    return extension ? contentTypes[extension] || null : null;
  }

  private shouldSkipCache(req: CacheableRequest): boolean {
    // Skip cache for non-GET requests
    if (req.method !== 'GET') {
      return true;
    }

    // Skip cache for authenticated requests with sensitive data
    if (req.headers.authorization || req.headers.cookie) {
      const url = req.url.toLowerCase();
      if (url.includes('/api/') && !url.includes('/public/')) {
        return true;
      }
    }

    // Skip cache for requests with cache-control headers
    const cacheControl = req.headers['cache-control']?.toLowerCase();
    if (cacheControl && (cacheControl.includes('no-cache') || cacheControl.includes('no-store'))) {
      return true;
    }

    // Skip cache for dynamic content
    const skipPatterns = [
      '/admin/',
      '/dashboard/',
      '/profile/',
      '/settings/',
      '/auth/',
      '/api/v1/users/',
      '/api/v1/transactions/',
    ];

    return skipPatterns.some(pattern => req.url.toLowerCase().includes(pattern));
  }

  private generateCacheKey(req: CacheableRequest): string {
    const url = req.url;
    const method = req.method;
    const host = req.headers.host || 'localhost';

    // Create a hash of relevant request components
    const components = [
      method,
      host,
      url,
      // Add relevant query parameters (excluding cache-busting ones)
      this.sanitizeQueryParams(req.query as Record<string, string>),
    ].join('|');

    return createHash('md5').update(components).digest('hex');
  }

  private generateCacheTags(req: CacheableRequest): string[] {
    const tags: string[] = [];
    const url = req.url.toLowerCase();

    // Content type tags
    if (url.includes('.css')) {
      tags.push('css');
    }
    if (url.includes('.js')) {
      tags.push('javascript');
    }
    if (url.includes('.png') || url.includes('.jpg') || url.includes('.gif') || url.includes('.svg')) {
      tags.push('image');
    }
    if (url.includes('.html')) {
      tags.push('html');
    }

    // Route-based tags
    if (url.includes('/static/')) {
      tags.push('static');
    }
    if (url.includes('/assets/')) {
      tags.push('assets');
    }
    if (url.includes('/public/')) {
      tags.push('public');
    }
    if (url.includes('/api/')) {
      tags.push('api');
    }

    // Feature-based tags
    if (url.includes('/dashboard')) {
      tags.push('dashboard');
    }
    if (url.includes('/properties')) {
      tags.push('properties');
    }
    if (url.includes('/users')) {
      tags.push('users');
    }

    // Environment tag
    tags.push(process.env.NODE_ENV || 'development');

    return tags;
  }

  private getCacheTtl(req: CacheableRequest): number {
    const url = req.url.toLowerCase();

    // Static assets can be cached longer
    if (url.includes('/static/') || url.includes('/assets/')) {
      if (url.includes('.css') || url.includes('.js')) {
        return 86400; // 24 hours
      }
      if (url.includes('.png') || url.includes('.jpg') || url.includes('.gif') || url.includes('.svg')) {
        return 604800; // 7 days
      }
      return 3600; // 1 hour
    }

    // API responses
    if (url.includes('/api/')) {
      if (url.includes('/public/')) {
        return 300; // 5 minutes
      }
      return 60; // 1 minute for other API endpoints
    }

    // HTML pages
    if (url.includes('.html')) {
      return 1800; // 30 minutes
    }

    // Default
    return 600; // 10 minutes
  }

  private sanitizeQueryParams(query: Record<string, string>): Record<string, string> {
    const sanitized: Record<string, string> = {};
    const skipParams = ['_', 'v', 'version', 'cache', 'timestamp', 't'];

    for (const [key, value] of Object.entries(query)) {
      if (!skipParams.includes(key.toLowerCase()) && value) {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  private async serveFromCache(req: CacheableRequest, res: Response, cachedEntry: any): Promise<void> {
    // Set cache headers
    res.setHeader('X-Cache', 'HIT');
    res.setHeader('X-Cache-Key', req.cacheKey);
    if (cachedEntry.etag) {
      res.setHeader('ETag', cachedEntry.etag);
    }
    if (cachedEntry.lastModified) {
      res.setHeader('Last-Modified', cachedEntry.lastModified.toUTCString());
    }

    // Set content type
    const contentType = this.getContentTypeFromUrl(req.url);
    if (contentType) {
      res.setHeader('Content-Type', contentType);
    }

    // Set cache control
    const maxAge = req.cacheTtl || 600;
    res.setHeader('Cache-Control', `public, max-age=${maxAge}`);

    // Send cached content
    if (typeof cachedEntry.content === 'string') {
      res.send(cachedEntry.content);
    } else {
      res.send(cachedEntry.content);
    }

    this.logger.debug(`Cache HIT: ${req.method} ${req.url} (${cachedEntry.size} bytes)`);
  }

  private interceptResponse(req: CacheableRequest, res: Response, next: NextFunction): void {
    const originalSend = res.send;
    const originalWrite = res.write;
    let responseData: any;
    let isCached = false;

    // Intercept res.send
    res.send = function (data: any) {
      responseData = data;

      // Cache the response if it's cacheable
      if (shouldCacheResponse(res.statusCode) && !req.skipCache && req.cacheKey) {
        cacheResponse(req, res, data);
      }

      return originalSend.call(this, data);
    };

    // Intercept res.write for streaming responses
    res.write = function (chunk: any) {
      if (!isCached && shouldCacheResponse(res.statusCode) && !req.skipCache && req.cacheKey) {
        // For streaming responses, we might want to handle them differently
        // For now, we'll skip caching streaming responses
      }
      return originalWrite.call(this, chunk);
    };

    next();

    function shouldCacheResponse(statusCode: number): boolean {
      // Only cache successful responses
      return statusCode >= 200 && statusCode < 300;
    }

    async function cacheResponse(request: CacheableRequest, response: Response, data: any): Promise<void> {
      try {
        const contentType = getContentTypeFromResponse(response) || getContentTypeFromUrl(request.url);
        const cacheContentType = mapContentType(contentType);

        // Determine if content is binary
        const isBinary = isBinaryContent(contentType, data);
        const content = isBinary ? Buffer.from(data) : data;

        await this.cacheService.set(request.cacheKey, content, cacheContentType, {
          ttl: request.cacheTtl,
          tags: request.cacheTags,
          metadata: {
            originalUrl: request.url,
            statusCode: response.statusCode,
            headers: getCacheableHeaders(response),
            source: 'middleware',
            environment: process.env.NODE_ENV,
          },
          etag: response.get('ETag'),
          lastModified: response.get('Last-Modified') ? new Date(response.get('Last-Modified')) : undefined,
        });

        // Set cache headers for client
        response.setHeader('X-Cache', 'MISS');
        response.setHeader('X-Cache-Key', req.cacheKey);

        const maxAge = req.cacheTtl || 600;
        response.setHeader('Cache-Control', `public, max-age=${maxAge}`);

        isCached = true;
      } catch (error) {
        // Don't let caching errors break the response
        this.logger.error('Error caching response', error);
      }
    }

    function getContentTypeFromResponse(response: Response): string | null {
      return response.get('Content-Type') || null;
    }

    function getContentTypeFromUrl(url: string): string | null {
      const extension = url.split('.').pop()?.toLowerCase();

      const contentTypes: Record<string, string> = {
        html: 'text/html',
        css: 'text/css',
        js: 'application/javascript',
        json: 'application/json',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        svg: 'image/svg+xml',
        ico: 'image/x-icon',
        pdf: 'application/pdf',
        xml: 'application/xml',
        txt: 'text/plain',
      };

      return extension ? contentTypes[extension] || null : null;
    }

    function mapContentType(contentType: string): CacheContentType {
      if (contentType.includes('application/json')) {
        return CacheContentType.JSON;
      }
      if (contentType.includes('text/html')) {
        return CacheContentType.HTML;
      }
      if (contentType.includes('text/css')) {
        return CacheContentType.CSS;
      }
      if (contentType.includes('javascript')) {
        return CacheContentType.JS;
      }
      if (contentType.includes('image/')) {
        return CacheContentType.IMAGE;
      }
      if (contentType.includes('text/')) {
        return CacheContentType.TEXT;
      }
      return CacheContentType.BINARY;
    }

    function isBinaryContent(contentType: string, data: any): boolean {
      if (contentType.includes('image/') || contentType.includes('application/pdf')) {
        return true;
      }

      // Check if data is already a Buffer
      if (Buffer.isBuffer(data)) {
        return true;
      }

      // Heuristic: if the content type suggests binary but data is string, it might be base64
      if (contentType.includes('application/') && typeof data === 'string') {
        try {
          Buffer.from(data, 'base64');
          return true;
        } catch {
          // Not base64, treat as text
        }
      }

      return false;
    }

    function getCacheableHeaders(response: Response): Record<string, string> {
      const headers: Record<string, string> = {};
      const cacheableHeaders = [
        'content-type',
        'content-encoding',
        'content-length',
        'last-modified',
        'etag',
        'cache-control',
        'expires',
      ];

      for (const header of cacheableHeaders) {
        const value = response.get(header);
        if (value) {
          headers[header] = value;
        }
      }

      return headers;
    }
  }
}

// Helper function to create cache middleware with custom options
export function createCacheMiddleware(
  options: {
    skipPatterns?: string[];
    defaultTtl?: number;
    enableCompression?: boolean;
  } = {},
) {
  return (req: CacheableRequest, res: Response, next: NextFunction) => {
    // Apply custom options
    if (options.skipPatterns) {
      const shouldSkip = options.skipPatterns.some(pattern => req.url.toLowerCase().includes(pattern.toLowerCase()));
      if (shouldSkip) {
        req.skipCache = true;
        return next();
      }
    }

    if (options.defaultTtl) {
      req.cacheTtl = options.defaultTtl;
    }

    next();
  };
}

// Decorator for controllers to customize cache behavior
export function CacheOptions(options: { ttl?: number; tags?: string[]; skip?: boolean; key?: string }) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const req = args[0] as CacheableRequest;

      if (options.skip) {
        req.skipCache = true;
      }

      if (options.ttl) {
        req.cacheTtl = options.ttl;
      }

      if (options.tags) {
        req.cacheTags = [...(req.cacheTags || []), ...options.tags];
      }

      if (options.key) {
        req.cacheKey = options.key;
      }

      return originalMethod.apply(this, args);
    };

    return descriptor;
  };
}

// Helper function to manually cache content
export async function cacheContent(
  cacheService: StaticContentCacheService,
  key: string,
  content: string | Buffer,
  contentType: CacheContentType,
  options: {
    ttl?: number;
    tags?: string[];
    metadata?: Record<string, unknown>;
  } = {},
): Promise<void> {
  await cacheService.set(key, content, contentType, {
    ttl: options.ttl,
    tags: options.tags || [],
    metadata: options.metadata || {},
  });
}

// Helper function to invalidate cache by pattern
export async function invalidateCacheByPattern(
  cacheService: StaticContentCacheService,
  pattern: string,
): Promise<number> {
  return await cacheService.invalidateByPattern(pattern);
}

// Helper function to invalidate cache by tags
export async function invalidateCacheByTags(cacheService: StaticContentCacheService, tags: string[]): Promise<number> {
  return await cacheService.invalidateByTags(tags);
}
