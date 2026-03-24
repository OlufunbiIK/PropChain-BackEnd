import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface SecurityHeadersConfig {
  // Content Security Policy
  csp?: {
    defaultSrc?: string[];
    scriptSrc?: string[];
    styleSrc?: string[];
    imgSrc?: string[];
    connectSrc?: string[];
    fontSrc?: string[];
    objectSrc?: string[];
    mediaSrc?: string[];
    frameSrc?: string[];
    childSrc?: string[];
    frameAncestors?: string[];
    formAction?: string[];
    baseUri?: string[];
    reportUri?: string;
  };

  // HTTP Strict Transport Security
  hsts?: {
    maxAge?: number;
    includeSubDomains?: boolean;
    preload?: boolean;
  };

  // X-Content-Type-Options
  contentTypeOptions?: boolean;

  // X-Frame-Options
  frameOptions?: 'DENY' | 'SAMEORIGIN';

  // X-XSS-Protection
  xssProtection?: boolean;

  // Referrer Policy
  referrerPolicy?: string;

  // Permissions Policy
  permissionsPolicy?: {
    [key: string]: string[];
  };

  // Feature Policy (deprecated but still used)
  featurePolicy?: {
    [key: string]: string[];
  };

  crossOriginOpenerPolicy?: string;
  crossOriginResourcePolicy?: string;
  originAgentCluster?: boolean;
}

@Injectable()
export class SecurityHeadersService {
  private readonly logger = new Logger(SecurityHeadersService.name);
  private readonly defaultConfig: SecurityHeadersConfig;

  constructor(private readonly configService: ConfigService) {
    this.defaultConfig = this.getDefaultConfig();
  }

  /**
   * Get security headers for HTTP response
   */
  getSecurityHeaders(customConfig?: SecurityHeadersConfig): Record<string, string> {
    try {
      const config = customConfig || this.defaultConfig;
      const headers: Record<string, string> = {};

      // Content Security Policy
      if (config.csp) {
        headers['Content-Security-Policy'] = this.buildCSP(config.csp);
      }

      // HTTP Strict Transport Security
      if (config.hsts) {
        headers['Strict-Transport-Security'] = this.buildHSTS(config.hsts);
      }

      // X-Content-Type-Options
      if (config.contentTypeOptions !== false) {
        headers['X-Content-Type-Options'] = 'nosniff';
      }

      // X-Frame-Options
      if (config.frameOptions) {
        headers['X-Frame-Options'] = config.frameOptions;
      }

      // X-XSS-Protection
      if (config.xssProtection !== false) {
        headers['X-XSS-Protection'] = '1; mode=block';
      }

      // Referrer Policy
      if (config.referrerPolicy) {
        headers['Referrer-Policy'] = config.referrerPolicy;
      } else {
        headers['Referrer-Policy'] = 'strict-origin-when-cross-origin';
      }

      // Permissions Policy
      if (config.permissionsPolicy) {
        headers['Permissions-Policy'] = this.buildPermissionsPolicy(config.permissionsPolicy);
      }

      // Feature Policy (deprecated but still supported)
      if (config.featurePolicy) {
        headers['Feature-Policy'] = this.buildFeaturePolicy(config.featurePolicy);
      }

      // Additional security headers
      headers['X-Download-Options'] = 'noopen';
      headers['X-Permitted-Cross-Domain-Policies'] = 'none';
      headers['X-DNS-Prefetch-Control'] = 'off';
      headers['Cross-Origin-Opener-Policy'] = config.crossOriginOpenerPolicy || 'same-origin';
      headers['Cross-Origin-Resource-Policy'] = config.crossOriginResourcePolicy || 'same-origin';

      if (config.originAgentCluster !== false) {
        headers['Origin-Agent-Cluster'] = '?1';
      }

      return headers;
    } catch (error) {
      this.logger.error('Failed to generate security headers:', error);
      return this.getMinimalSecurityHeaders();
    }
  }

  /**
   * Build Content Security Policy string
   */
  private buildCSP(csp: NonNullable<SecurityHeadersConfig['csp']>): string {
    const directives: string[] = [];

    const directiveMap: Record<string, string[] | undefined> = {
      'default-src': csp.defaultSrc,
      'script-src': csp.scriptSrc,
      'style-src': csp.styleSrc,
      'img-src': csp.imgSrc,
      'connect-src': csp.connectSrc,
      'font-src': csp.fontSrc,
      'object-src': csp.objectSrc,
      'media-src': csp.mediaSrc,
      'frame-src': csp.frameSrc,
      'child-src': csp.childSrc,
      'frame-ancestors': csp.frameAncestors,
      'form-action': csp.formAction,
      'base-uri': csp.baseUri,
    };

    for (const [directive, sources] of Object.entries(directiveMap)) {
      if (sources && sources.length > 0) {
        directives.push(`${directive} ${sources.join(' ')}`);
      }
    }

    if (csp.reportUri) {
      directives.push(`report-uri ${csp.reportUri}`);
    }

    return directives.join('; ');
  }

  /**
   * Build HSTS header string
   */
  private buildHSTS(hsts: NonNullable<SecurityHeadersConfig['hsts']>): string {
    const parts = [`max-age=${hsts.maxAge || 31536000}`];

    if (hsts.includeSubDomains) {
      parts.push('includeSubDomains');
    }

    if (hsts.preload) {
      parts.push('preload');
    }

    return parts.join('; ');
  }

  /**
   * Build Permissions Policy string
   */
  private buildPermissionsPolicy(permissions: Record<string, string[]>): string {
    const directives: string[] = [];

    for (const [feature, allowList] of Object.entries(permissions)) {
      if (allowList.length === 0) {
        directives.push(`${feature}=()`);
      } else {
        directives.push(`${feature}=(${allowList.join(' ')})`);
      }
    }

    return directives.join(', ');
  }

  /**
   * Build Feature Policy string (deprecated)
   */
  private buildFeaturePolicy(features: Record<string, string[]>): string {
    const directives: string[] = [];

    for (const [feature, allowList] of Object.entries(features)) {
      if (allowList.length === 0) {
        directives.push(`${feature} 'none'`);
      } else {
        directives.push(`${feature} ${allowList.join(' ')}`);
      }
    }

    return directives.join('; ');
  }

  /**
   * Get default security configuration
   */
  private getDefaultConfig(): SecurityHeadersConfig {
    return {
      csp: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"], // Adjust based on your needs
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
        childSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        baseUri: ["'self'"],
      },
      hsts: {
        maxAge: 31536000, // 1 year
        includeSubDomains: true,
        preload: true,
      },
      contentTypeOptions: true,
      frameOptions: 'DENY',
      xssProtection: true,
      referrerPolicy: 'strict-origin-when-cross-origin',
      permissionsPolicy: {
        geolocation: [],
        midi: [],
        notifications: [],
        push: [],
        syncXhr: [],
        microphone: [],
        camera: [],
        magnetometer: [],
        gyroscope: [],
        fullscreen: ["'self'"],
        payment: [],
      },
      crossOriginOpenerPolicy: 'same-origin',
      crossOriginResourcePolicy: 'same-origin',
      originAgentCluster: true,
    };
  }

  /**
   * Get minimal security headers for fallback
   */
  private getMinimalSecurityHeaders(): Record<string, string> {
    return {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-XSS-Protection': '1; mode=block',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Download-Options': 'noopen',
      'X-Permitted-Cross-Domain-Policies': 'none',
      'X-DNS-Prefetch-Control': 'off',
    };
  }

  /**
   * Get relaxed configuration for development
   */
  getDevelopmentConfig(): SecurityHeadersConfig {
    return {
      csp: {
        defaultSrc: ["'self'", "'unsafe-eval'", "'unsafe-inline'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:', 'http:'],
        connectSrc: ["'self'", 'http://localhost:*', 'ws://localhost:*'],
      },
      frameOptions: 'SAMEORIGIN',
      contentTypeOptions: true,
      xssProtection: true,
      referrerPolicy: 'strict-origin-when-cross-origin',
      crossOriginOpenerPolicy: 'same-origin-allow-popups',
      crossOriginResourcePolicy: 'cross-origin',
      originAgentCluster: true,
    };
  }

  /**
   * Validate security configuration
   */
  validateConfig(config: SecurityHeadersConfig): string[] {
    const errors: string[] = [];

    if (config.csp) {
      // Check for overly permissive CSP
      if (config.csp.defaultSrc?.includes("'unsafe-inline'")) {
        this.logger.warn('CSP includes unsafe-inline in default-src');
      }
      if (config.csp.scriptSrc?.includes("'unsafe-eval'")) {
        this.logger.warn('CSP includes unsafe-eval in script-src');
      }
    }

    if (config.hsts && config.hsts.maxAge && config.hsts.maxAge < 15552000) {
      errors.push('HSTS max-age should be at least 180 days (15552000 seconds)');
    }

    return errors;
  }
}
