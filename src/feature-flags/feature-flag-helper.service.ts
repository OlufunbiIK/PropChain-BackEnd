import { Injectable } from '@nestjs/common';
import { FeatureFlagService } from './feature-flag.service';
import { FlagEvaluationContext, FlagEvaluationResult } from './models/feature-flag.entity';

@Injectable()
export class FeatureFlagHelperService {
  constructor(private readonly featureFlagService: FeatureFlagService) {}

  /**
   * Check if a feature flag is enabled for a given context
   */
  async isEnabled(flagKey: string, context?: FlagEvaluationContext): Promise<boolean> {
    const result = await this.featureFlagService.evaluate(flagKey, context);
    return result.enabled;
  }

  /**
   * Get the evaluation result for a feature flag
   */
  async getResult(flagKey: string, context?: FlagEvaluationContext): Promise<FlagEvaluationResult> {
    return this.featureFlagService.evaluate(flagKey, context);
  }

  /**
   * Check multiple feature flags at once
   */
  async areEnabled(
    flagKeys: string[],
    context?: FlagEvaluationContext,
  ): Promise<Record<string, boolean>> {
    const results = await this.featureFlagService.bulkEvaluate(flagKeys, context);
    return results.reduce((acc, result) => {
      acc[result.flagKey] = result.enabled;
      return acc;
    }, {} as Record<string, boolean>);
  }

  /**
   * Check if any of the provided flags are enabled
   */
  async isAnyEnabled(flagKeys: string[], context?: FlagEvaluationContext): Promise<boolean> {
    const enabledFlags = await this.areEnabled(flagKeys, context);
    return Object.values(enabledFlags).some((enabled) => enabled);
  }

  /**
   * Check if all of the provided flags are enabled
   */
  async areAllEnabled(flagKeys: string[], context?: FlagEvaluationContext): Promise<boolean> {
    const enabledFlags = await this.areEnabled(flagKeys, context);
    return Object.values(enabledFlags).every((enabled) => enabled);
  }

  /**
   * Get flags for a specific user
   */
  async getUserFlags(
    userId: string,
    userEmail?: string,
    userRole?: string,
  ): Promise<Record<string, boolean>> {
    const context: FlagEvaluationContext = {
      userId,
      email: userEmail,
      role: userRole,
    };

    // Get all active flags
    const { flags } = await this.featureFlagService.findAll({ status: 'ACTIVE' as any });
    const flagKeys = flags.map((flag) => flag.key);

    return this.areEnabled(flagKeys, context);
  }

  /**
   * Execute a function only if a feature flag is enabled
   */
  async executeIfEnabled<T>(
    flagKey: string,
    enabledFn: () => Promise<T> | T,
    disabledFn?: () => Promise<T> | T,
    context?: FlagEvaluationContext,
  ): Promise<T> {
    const isEnabled = await this.isEnabled(flagKey, context);

    if (isEnabled) {
      return await enabledFn();
    }

    if (disabledFn) {
      return await disabledFn();
    }

    throw new Error(`Feature flag '${flagKey}' is not enabled`);
  }

  /**
   * Get feature flag with fallback value
   */
  async getValueWithFallback<T>(
    flagKey: string,
    fallback: T,
    context?: FlagEvaluationContext,
  ): Promise<T> {
    try {
      const result = await this.getResult(flagKey, context);
      return result.enabled ? (result.value as T) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  /**
   * Check experimental features for developers
   */
  async isExperimentalFeatureEnabled(
    featureName: string,
    context?: FlagEvaluationContext,
  ): Promise<boolean> {
    const flagKey = `experimental-${featureName}`;
    return this.isEnabled(flagKey, context);
  }

  /**
   * Check beta features for early adopters
   */
  async isBetaFeatureEnabled(
    featureName: string,
    context?: FlagEvaluationContext,
  ): Promise<boolean> {
    const flagKey = `beta-${featureName}`;
    return this.isEnabled(flagKey, context);
  }

  /**
   * Check premium features based on user plan
   */
  async isPremiumFeatureEnabled(
    featureName: string,
    userPlan: string,
    context?: FlagEvaluationContext,
  ): Promise<boolean> {
    const flagKey = `premium-${featureName}`;
    const enhancedContext = {
      ...context,
      customAttributes: {
        ...context?.customAttributes,
        plan: userPlan,
      },
    };

    return this.isEnabled(flagKey, enhancedContext);
  }

  /**
   * Gradual rollout check
   */
  async isGradualRolloutEnabled(
    flagKey: string,
    userId: string,
    context?: FlagEvaluationContext,
  ): Promise<boolean> {
    const enhancedContext = {
      ...context,
      userId,
    };

    return this.isEnabled(flagKey, enhancedContext);
  }

  /**
   * Create context from request object
   */
  createContextFromRequest(req: any): FlagEvaluationContext {
    return {
      userId: req.user?.id,
      email: req.user?.email,
      role: req.user?.role,
      userAgent: req.get?.('User-Agent'),
      ip: req.ip || req.connection?.remoteAddress,
      customAttributes: {
        plan: req.user?.plan,
        region: req.user?.region,
        country: req.get?.('X-Country'),
        deviceType: req.get?.('X-Device-Type'),
        appVersion: req.get?.('X-App-Version'),
      },
    };
  }

  /**
   * Check feature flag with automatic context creation from request
   */
  async isEnabledFromRequest(flagKey: string, req: any): Promise<boolean> {
    const context = this.createContextFromRequest(req);
    return this.isEnabled(flagKey, context);
  }

  /**
   * Get all enabled flags for context
   */
  async getEnabledFlags(context?: FlagEvaluationContext): Promise<string[]> {
    const { flags } = await this.featureFlagService.findAll({ status: 'ACTIVE' as any });
    const flagKeys = flags.map((flag) => flag.key);
    const enabledFlags = await this.areEnabled(flagKeys, context);

    return Object.entries(enabledFlags)
      .filter(([_key, enabled]) => enabled)
      .map(([flagKey]) => flagKey);
  }

  /**
   * Check if user has access to feature based on multiple conditions
   */
  async hasFeatureAccess(
    flagKey: string,
    userId: string,
    conditions: {
      role?: string;
      plan?: string;
      region?: string;
      customAttributes?: Record<string, unknown>;
    },
  ): Promise<boolean> {
    const context: FlagEvaluationContext = {
      userId,
      role: conditions.role,
      customAttributes: {
        plan: conditions.plan,
        region: conditions.region,
        ...conditions.customAttributes,
      },
    };

    return this.isEnabled(flagKey, context);
  }
}