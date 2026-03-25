import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { FeatureFlagService } from '../feature-flag.service';
import { FlagEvaluationContext } from '../models/feature-flag.entity';

export interface FeatureFlagRequest extends Request {
  featureFlags?: Record<string, boolean>;
  user?: any;
}

@Injectable()
export class FeatureFlagMiddleware implements NestMiddleware {
  private readonly logger = new Logger(FeatureFlagMiddleware.name);

  constructor(private readonly featureFlagService: FeatureFlagService) {}

  async use(req: FeatureFlagRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      // Get common flag keys that should be evaluated for every request
      const commonFlagKeys = this.getCommonFlagKeys(req);

      if (commonFlagKeys.length === 0) {
        next();
        return;
      }

      // Build evaluation context from request
      const context = this.buildEvaluationContext(req);

      // Evaluate flags in bulk for performance
      const results = await this.featureFlagService.bulkEvaluate(commonFlagKeys, context);

      // Store results in request for later use
      req.featureFlags = results.reduce(
        (acc, result) => {
          acc[result.flagKey] = result.enabled;
          return acc;
        },
        {} as Record<string, boolean>,
      );

      // Log flag evaluations for debugging
      this.logFlagEvaluations(req, results);

      next();
    } catch (error) {
      this.logger.error('Error in feature flag middleware', error);
      // Continue without feature flags if there's an error
      next();
    }
  }

  private getCommonFlagKeys(req: Request): string[] {
    const flagKeys: string[] = [];

    // Route-specific flags
    const route = req.route?.path || req.path;

    if (route.includes('/api/v2')) {
      flagKeys.push('api-v2-enabled');
    }

    if (route.includes('/experimental')) {
      flagKeys.push('experimental-features');
    }

    if (route.includes('/beta')) {
      flagKeys.push('beta-features');
    }

    // Global flags that should always be evaluated
    flagKeys.push('new-dashboard-ui');
    flagKeys.push('enhanced-security');
    flagKeys.push('advanced-analytics');

    // User-specific flags
    if (req.user) {
      flagKeys.push('user-personalization');
      flagKeys.push('premium-features');
    }

    return [...new Set(flagKeys)]; // Remove duplicates
  }

  private buildEvaluationContext(req: FeatureFlagRequest): FlagEvaluationContext {
    const context: FlagEvaluationContext = {
      userAgent: req.get('User-Agent'),
      ip: req.ip || req.connection.remoteAddress,
      customAttributes: {},
    };

    // Add user information if available
    if (req.user) {
      context.userId = req.user.id;
      context.email = req.user.email;
      context.role = req.user.role;

      if (req.user.plan) {
        context.customAttributes!.plan = req.user.plan;
      }

      if (req.user.region) {
        context.customAttributes!.region = req.user.region;
      }

      if (req.user.createdAt) {
        context.customAttributes!.userAge =
          Date.now() - new Date(req.user.createdAt).getTime();
      }
    }

    // Add request-specific attributes
    if (req.get('X-Country')) {
      context.customAttributes!.country = req.get('X-Country');
    }

    if (req.get('X-Device-Type')) {
      context.customAttributes!.deviceType = req.get('X-Device-Type');
    }

    if (req.get('X-App-Version')) {
      context.customAttributes!.appVersion = req.get('X-App-Version');
    }

    return context;
  }

  private logFlagEvaluations(req: FeatureFlagRequest, results: any[]): void {
    const enabledFlags = results.filter((r) => r.enabled).map((r) => r.flagKey);
    const disabledFlags = results.filter((r) => !r.enabled).map((r) => r.flagKey);

    if (enabledFlags.length > 0 || disabledFlags.length > 0) {
      this.logger.debug(
        `Feature flags evaluated for ${req.method} ${req.path} - ` +
          `Enabled: [${enabledFlags.join(', ')}] ` +
          `Disabled: [${disabledFlags.join(', ')}]`,
        {
          userId: req.user?.id,
          path: req.path,
          method: req.method,
          enabledFlags,
          disabledFlags,
        },
      );
    }
  }
}

// Decorator for checking feature flags in controllers
export const FeatureFlag = (flagKey: string) => {
  return (target: any, propertyKey: string, descriptor: PropertyDescriptor) => {
    const originalMethod = descriptor.value;

    descriptor.value = function (...args: any[]) {
      const req = args[0] as FeatureFlagRequest;

      if (!req.featureFlags || req.featureFlags[flagKey] !== true) {
        throw new Error(`Feature flag '${flagKey}' is not enabled`);
      }

      return originalMethod.apply(this, args);
    };

    return descriptor;
  };
};

// Helper function to check if a feature flag is enabled
export const isFeatureEnabled = (req: FeatureFlagRequest, flagKey: string): boolean => {
  return req.featureFlags?.[flagKey] === true;
};

// Helper function to get feature flag value
export const getFeatureFlagValue = (req: FeatureFlagRequest, flagKey: string): boolean => {
  return req.featureFlags?.[flagKey] || false;
};