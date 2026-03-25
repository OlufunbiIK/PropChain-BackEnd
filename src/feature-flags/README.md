# Feature Flag System

A comprehensive feature flag system for gradual rollouts, A/B testing, and controlled feature releases.

## Overview

The feature flag system allows you to:
- Enable/disable features without deploying code
- Gradually roll out features to users
- Target specific users or user segments
- Monitor feature usage and performance
- Implement A/B testing
- Control experimental and beta features

## Architecture

### Components

1. **Feature Flag Service** - Core service for flag evaluation and management
2. **Analytics Service** - Tracks flag usage and provides insights
3. **Helper Service** - Simplifies flag usage throughout the application
4. **Middleware** - Automatically evaluates flags for requests
5. **Controllers** - REST API for flag management
6. **Redis Cache** - High-performance flag storage and evaluation

### Flag Types

1. **Boolean** - Simple on/off flags
2. **Percentage** - Gradual rollout based on user percentage
3. **Whitelist** - Enable for specific users
4. **Blacklist** - Disable for specific users
5. **Conditional** - Complex rule-based evaluation

## API Endpoints

### Management API (Protected)

#### Feature Flags
- `GET /feature-flags` - List all flags with filtering
- `POST /feature-flags` - Create new flag
- `GET /feature-flags/:id` - Get flag by ID
- `GET /feature-flags/key/:key` - Get flag by key
- `PATCH /feature-flags/:id` - Update flag
- `DELETE /feature-flags/:id` - Delete flag

#### Evaluation
- `POST /feature-flags/evaluate` - Evaluate single flag
- `POST /feature-flags/evaluate-bulk` - Evaluate multiple flags

#### Analytics
- `GET /feature-flags/:key/analytics` - Get flag analytics

### Public API (Open)

- `POST /public/feature-flags/evaluate` - Evaluate flags (public)
- `POST /public/feature-flags/:key/evaluate` - Evaluate single flag (public)

## Usage Examples

### Basic Flag Check

```typescript
import { FeatureFlagHelperService } from './feature-flags/feature-flag-helper.service';

constructor(private readonly featureFlagHelper: FeatureFlagHelperService) {}

async someMethod() {
  // Check if feature is enabled
  const isEnabled = await this.featureFlagHelper.isEnabled('new-dashboard-ui');
  
  if (isEnabled) {
    // Show new dashboard
  } else {
    // Show old dashboard
  }
}
```

### With User Context

```typescript
async getUserFeatures(userId: string) {
  const context = {
    userId,
    email: 'user@example.com',
    role: 'premium',
    customAttributes: {
      plan: 'premium',
      region: 'us-east'
    }
  };
  
  const flags = await this.featureFlagHelper.areEnabled([
    'advanced-analytics',
    'beta-features',
    'experimental-api'
  ], context);
  
  return flags;
}
```

### Conditional Execution

```typescript
async processData(data: any) {
  return await this.featureFlagHelper.executeIfEnabled(
    'new-processing-algorithm',
    async () => {
      // New algorithm
      return this.processWithNewAlgorithm(data);
    },
    async () => {
      // Fallback algorithm
      return this.processWithOldAlgorithm(data);
    }
  );
}
```

### Controller Decorator

```typescript
import { FeatureFlag } from './feature-flags/middleware/feature-flag.middleware';

@FeatureFlag('experimental-endpoint')
@Get('/experimental/data')
async getExperimentalData() {
  // This endpoint only works if 'experimental-endpoint' flag is enabled
}
```

### Middleware Usage

```typescript
// In app.module.ts
configure(consumer: MiddlewareConsumer) {
  consumer
    .apply(FeatureFlagMiddleware)
    .forRoutes('*');
}

// In controllers
@Get()
async getData(@Req() req: FeatureFlagRequest) {
  if (req.featureFlags?.['new-dashboard-ui']) {
    // Use new dashboard logic
  }
}
```

## Flag Configuration Examples

### Boolean Flag
```json
{
  "key": "maintenance-mode",
  "name": "Maintenance Mode",
  "type": "BOOLEAN",
  "booleanValue": false,
  "status": "ACTIVE"
}
```

### Percentage Rollout
```json
{
  "key": "new-checkout-flow",
  "name": "New Checkout Flow",
  "type": "PERCENTAGE",
  "percentageValue": 25,
  "status": "ACTIVE"
}
```

### Whitelist
```json
{
  "key": "beta-access",
  "name": "Beta Access",
  "type": "WHITELIST",
  "whitelistValue": ["user_123", "user_456"],
  "status": "ACTIVE"
}
```

### Conditional Flag
```json
{
  "key": "premium-features",
  "name": "Premium Features",
  "type": "CONDITIONAL",
  "conditions": [
    {
      "field": "user.plan",
      "operator": "eq",
      "value": "premium"
    }
  ],
  "status": "ACTIVE"
}
```

## Analytics and Monitoring

### Flag Analytics
- Total evaluations
- Enabled/disabled counts
- Unique users
- Daily/weekly trends
- Usage patterns

### Available Analytics
```typescript
// Get flag analytics
const analytics = await this.featureFlagService.getAnalytics('new-dashboard-ui', 30);

// Get all flags analytics
const allAnalytics = await this.analyticsService.getAllFlagsAnalytics(30);

// Get top performing flags
const topFlags = await this.analyticsService.getTopFlags(30, 10);

// Get user interactions
const userInteractions = await this.analyticsService.getUserFlagInteractions('user_123', 30);
```

## Best Practices

### Flag Naming
- Use kebab-case: `new-dashboard-ui`, `experimental-api`
- Be descriptive: `enable-v2-checkout`, `beta-search-algorithm`
- Group related flags: `search-experimental`, `search-beta`

### Gradual Rollouts
1. Start with small percentage (1-5%)
2. Monitor performance and errors
3. Gradually increase percentage
4. Monitor user feedback
5. Full rollout when confident

### Flag Lifecycle
1. **Development** - Create flag, test internally
2. **Beta** - Enable for beta users
3. **Gradual Rollout** - Percentage-based rollout
4. **Full Release** - Enable for all users
5. **Cleanup** - Remove flag and code references

### Performance Considerations
- Use bulk evaluation for multiple flags
- Leverage Redis caching
- Evaluate flags early in request lifecycle
- Cache evaluation results when possible

## Security

### Access Control
- Management API requires authentication
- Role-based access control
- Audit logging for all changes

### Data Protection
- User data in evaluation context is optional
- Analytics data retention policies
- GDPR compliance considerations

## Monitoring and Alerting

### Metrics to Track
- Flag evaluation latency
- Cache hit rates
- Error rates
- Feature adoption rates

### Alerting
- High error rates in flag evaluation
- Cache performance degradation
- Unexpected flag behavior

## Troubleshooting

### Common Issues
1. **Flag not evaluating** - Check flag status and cache
2. **Wrong user targeting** - Verify context data
3. **Performance issues** - Check Redis connectivity
4. **Analytics not updating** - Check evaluation logging

### Debug Tools
- Enable debug logging
- Check Redis cache keys
- Verify evaluation context
- Monitor flag analytics

## Migration Guide

### Adding New Flags
1. Define flag key and type
2. Create flag via API or admin interface
3. Implement conditional logic in code
4. Test with different user contexts
5. Monitor analytics

### Removing Flags
1. Gradually disable flag
2. Remove conditional code
3. Delete flag from system
4. Clean up analytics data

## Integration Examples

### Frontend Integration
```typescript
// API endpoint to get user flags
@Get('/user/flags')
async getUserFlags(@Req() req: Request) {
  const context = this.featureFlagHelper.createContextFromRequest(req);
  const flags = await this.featureFlagHelper.getEnabledFlags(context);
  return { flags };
}
```

### Third-Party Services
```typescript
// Check flag before calling external service
async callExternalAPI(data: any) {
  const canUseNewAPI = await this.featureFlagHelper.isEnabled('new-external-api');
  
  if (canUseNewAPI) {
    return this.newExternalService.call(data);
  } else {
    return this.legacyExternalService.call(data);
  }
}
```

This feature flag system provides a robust foundation for managing feature releases, A/B testing, and gradual rollouts in your application.
