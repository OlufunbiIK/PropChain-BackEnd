# Static Content Caching System

A comprehensive static content caching system with Redis backend, featuring intelligent cache invalidation strategies, real-time analytics, and automated cache warming.

## Overview

The static content caching system provides:
- **High-performance caching** with Redis backend
- **Intelligent invalidation** (TTL, manual, tag-based, pattern-based)
- **Real-time analytics** and monitoring
- **Automated cache warming** strategies
- **Middleware integration** for automatic caching
- **Comprehensive management API**

## Architecture

### Core Components

1. **StaticContentCacheService** - Core caching operations
2. **CacheInvalidationService** - Cache invalidation strategies
3. **CacheAnalyticsService** - Analytics and monitoring
4. **CacheWarmingService** - Automated cache warming
5. **StaticCacheMiddleware** - Automatic request caching
6. **CacheManagementController** - Management API endpoints

### Cache Types

- **JSON** - API responses and data
- **HTML** - Rendered pages and templates
- **CSS** - Stylesheets
- **JavaScript** - Client-side scripts
- **Images** - Static image files
- **Text** - Plain text content
- **Binary** - Other binary content

## Configuration

### Environment Variables

```bash
# Cache Configuration
STATIC_CACHE_DEFAULT_TTL=3600          # Default TTL in seconds
STATIC_CACHE_MAX_SIZE=104857600        # Max cache size in bytes (100MB)
STATIC_CACHE_COMPRESSION_THRESHOLD=1024 # Compression threshold in bytes
STATIC_CACHE_ENABLE_COMPRESSION=true    # Enable compression
STATIC_CACHE_ENABLE_ANALYTICS=true     # Enable analytics
STATIC_CACHE_STRATEGY=TTL              # Cache strategy
STATIC_CACHE_CLEANUP_INTERVAL=300000    # Cleanup interval in ms
STATIC_CACHE_MAX_ENTRIES=10000          # Maximum number of entries
```

## Usage Examples

### Basic Cache Operations

```typescript
import { StaticContentCacheService, CacheContentType } from './static-cache/static-content-cache.service';

constructor(private readonly cacheService: StaticContentCacheService) {}

// Cache content
await this.cacheService.set(
  'user:123:profile',
  JSON.stringify(userData),
  CacheContentType.JSON,
  {
    ttl: 3600,
    tags: ['user', 'profile'],
    metadata: { userId: '123' }
  }
);

// Get cached content
const cached = await this.cacheService.get('user:123:profile');
if (cached) {
  const userData = JSON.parse(cached.content as string);
}

// Delete cached content
await this.cacheService.delete('user:123:profile');
```

### Cache Invalidation

```typescript
import { CacheInvalidationService } from './static-cache/cache-invalidation.service';

// Invalidate by tags
await this.invalidationService.invalidateByTags(['user', 'profile']);

// Invalidate by pattern
await this.invalidationService.invalidateByPattern('/api/v1/users/.*');

// Invalidate expired entries
await this.invalidationService.invalidateExpired();

// Create invalidation rule
const rule = await this.invalidationService.createRule({
  name: 'User Profile Cleanup',
  description: 'Clean up user profile cache entries',
  type: 'TAG_BASED',
  conditions: { tags: ['user', 'profile'] },
  isActive: true,
});
```

### Cache Analytics

```typescript
import { CacheAnalyticsService } from './static-cache/cache-analytics.service';

// Get real-time metrics
const metrics = await this.analyticsService.getRealTimeMetrics();

// Get health status
const health = await this.analyticsService.getHealthStatus();

// Generate performance report
const report = await this.analyticsService.generateReport('daily');

// Get alerts
const alerts = await this.analyticsService.getAlerts(false); // Unresolved alerts
```

### Cache Warming

```typescript
import { CacheWarmingService } from './static-cache/cache-warming.service';

// Warm popular content
await this.warmingService.warmPopularContent(50);

// Warm user-based content
await this.warmingService.warmUserBasedContent('user123', {
  favoriteProperties: ['prop1', 'prop2'],
  recentSearches: ['villa', 'apartment']
});

// Create custom warming job
const job = await this.warmingService.createJob({
  name: 'Dashboard Warming',
  description: 'Warm dashboard content',
  urls: ['/dashboard', '/api/v1/dashboard/stats'],
  priority: 1,
  interval: 30,
  isActive: true,
  tags: ['dashboard', 'critical'],
});
```

### Middleware Integration

```typescript
import { CacheOptions } from './static-cache/middleware/static-cache.middleware';

@Controller('api/v1/properties')
export class PropertiesController {
  
  @Get()
  @CacheOptions({
    ttl: 1800, // 30 minutes
    tags: ['properties', 'public'],
  })
  async getProperties() {
    // Automatically cached response
    return await this.propertiesService.findAll();
  }

  @Get(':id')
  @CacheOptions({
    ttl: 3600, // 1 hour
    tags: ['properties', 'details'],
    skip: false,
  })
  async getProperty(@Param('id') id: string) {
    // Automatically cached response
    return await this.propertiesService.findOne(id);
  }
}
```

## API Endpoints

### Cache Management

#### Entries
- `GET /cache/entries` - Search cache entries
- `GET /cache/entries/:key` - Get specific entry
- `DELETE /cache/entries/:key` - Delete entry
- `DELETE /cache/entries` - Clear all entries

#### Invalidation
- `POST /cache/invalidate/tags` - Invalidate by tags
- `POST /cache/invalidate/pattern` - Invalidate by pattern
- `POST /cache/invalidate/expired` - Invalidate expired entries
- `POST /cache/invalidate/age` - Invalidate by age

#### Invalidation Rules
- `GET /cache/invalidation-rules` - List rules
- `POST /cache/invalidation-rules` - Create rule
- `PUT /cache/invalidation-rules/:id` - Update rule
- `DELETE /cache/invalidation-rules/:id` - Delete rule
- `POST /cache/invalidation-rules/:id/execute` - Execute rule

#### Analytics
- `GET /cache/analytics` - Get cache analytics
- `GET /cache/analytics/real-time` - Real-time metrics
- `GET /cache/analytics/history` - Metrics history
- `GET /cache/analytics/health` - Health status
- `GET /cache/analytics/reports` - Generate report
- `GET /cache/analytics/alerts` - Get alerts
- `POST /cache/analytics/alerts/:id/acknowledge` - Acknowledge alert
- `GET /cache/analytics/export` - Export analytics data

#### Cache Warming
- `GET /cache/warming/jobs` - List warming jobs
- `POST /cache/warming/jobs` - Create warming job
- `PUT /cache/warming/jobs/:id` - Update job
- `DELETE /cache/warming/jobs/:id` - Delete job
- `POST /cache/warming/jobs/:id/execute` - Execute job
- `POST /cache/warming/popular` - Warm popular content
- `POST /cache/warming/user-based` - Warm user-based content
- `POST /cache/warming/time-based` - Warm time-based content
- `GET /cache/warming/history` - Warming history
- `GET /cache/warming/stats` - Warming statistics

#### Utilities
- `GET /cache/stats` - Cache statistics
- `POST /cache/reset-stats` - Reset statistics
- `POST /cache/warm-cache` - Warm cache with URLs
- `GET /cache/export` - Export cache data
- `POST /cache/import` - Import cache data

### Public Endpoints

- `GET /public/cache/:key` - Get cached content
- `GET /public/cache/:key/exists` - Check if content exists

## Cache Invalidation Strategies

### TTL (Time-To-Live)
```typescript
// Automatic expiration based on time
await this.cacheService.set('key', content, CacheContentType.JSON, {
  ttl: 3600, // Expires in 1 hour
});
```

### Manual Invalidation
```typescript
// Direct deletion
await this.cacheService.delete('key');

// Batch invalidation
await this.invalidationService.invalidateByTags(['tag1', 'tag2']);
```

### Tag-Based Invalidation
```typescript
// Cache with tags
await this.cacheService.set('key', content, CacheContentType.JSON, {
  tags: ['user', 'profile', 'premium'],
});

// Invalidate by tags
await this.invalidationService.invalidateByTags(['user']); // Invalidates all entries with 'user' tag
```

### Pattern-Based Invalidation
```typescript
// Invalidate using regex patterns
await this.invalidationService.invalidateByPattern('/api/v1/users/.*');
await this.invalidationService.invalidateByPattern('dashboard:.*');
```

## Cache Warming Strategies

### Popular Content
Automatically warms most frequently accessed content based on analytics.

### User-Based Content
Warms content based on user preferences and behavior patterns.

### Time-Based Content
Warms content based on time-of-day usage patterns.

### Custom Jobs
Create custom warming jobs for specific URLs and schedules.

```typescript
const job = await this.warmingService.createJob({
  name: 'Critical API Endpoints',
  urls: [
    '/api/v1/properties/featured',
    '/api/v1/market-trends',
    '/api/v1/dashboard/stats'
  ],
  priority: 1,
  interval: 15, // Every 15 minutes
  tags: ['critical', 'api'],
  ttl: 900, // 15 minutes
});
```

## Analytics and Monitoring

### Key Metrics
- **Hit Rate**: Percentage of cache hits
- **Miss Rate**: Percentage of cache misses
- **Response Time**: Average cache response time
- **Memory Usage**: Cache memory consumption
- **Compression Ratio**: Effectiveness of compression
- **Eviction Rate**: Frequency of cache evictions

### Health Monitoring
```typescript
const health = await this.analyticsService.getHealthStatus();
// Returns: { status: 'healthy' | 'warning' | 'critical', score: number, issues: string[] }
```

### Alerts
The system automatically generates alerts for:
- Low hit rates
- High response times
- Memory pressure
- High eviction rates
- Compression issues

## Performance Optimization

### Compression
Content larger than the compression threshold is automatically compressed using gzip.

### Cache Strategies
- **TTL**: Time-based expiration
- **LRU**: Least Recently Used eviction
- **Write-Through**: Immediate cache updates
- **Write-Behind**: Asynchronous cache updates
- **Refresh-Ahead**: Proactive cache refresh

### Memory Management
- Automatic cleanup of expired entries
- Size-based eviction when limits are exceeded
- Configurable memory limits and thresholds

## Best Practices

### Cache Key Design
```typescript
// Good cache keys
'user:123:profile'
'api:v1:properties:featured'
'dashboard:stats:daily:2023-12-01'

// Avoid
'data' // Too generic
'123' // Not descriptive
```

### Tag Strategy
```typescript
// Use hierarchical tags
['user', 'profile', 'premium']
['api', 'v1', 'properties', 'featured']
['dashboard', 'stats', 'daily']
```

### TTL Configuration
```typescript
// Static assets: 24 hours - 7 days
// API responses: 5 minutes - 1 hour
// User-specific content: 15 minutes - 1 hour
// Real-time data: 1 minute - 5 minutes
```

### Cache Warming
```typescript
// Warm critical paths during off-peak hours
// Use user behavior data for personalized warming
// Implement time-based warming for predictable traffic patterns
```

## Troubleshooting

### Common Issues

1. **Low Hit Rate**
   - Check cache key consistency
   - Verify TTL settings
   - Review cache warming strategy

2. **High Memory Usage**
   - Monitor cache size limits
   - Check compression effectiveness
   - Review eviction policies

3. **Slow Response Times**
   - Check Redis connection
   - Monitor compression overhead
   - Review cache key complexity

### Debug Tools
```typescript
// Check if content is cached
const exists = await this.cacheService.get('key');

// Get cache statistics
const stats = await this.cacheService.getStats();

// Get health status
const health = await this.analyticsService.getHealthStatus();

// View cache analytics
const analytics = await this.cacheService.getAnalytics();
```

## Security Considerations

### Access Control
- Management endpoints require authentication
- Role-based access control for cache operations
- Audit logging for all cache modifications

### Data Protection
- Sensitive data should not be cached
- Use appropriate TTL for user-specific content
- Implement cache invalidation on data changes

### Cache Isolation
- Separate caches for different environments
- Use tags to isolate related content
- Implement cache partitioning for large datasets

## Integration Examples

### Express.js Integration
```typescript
import { StaticCacheMiddleware } from './static-cache/middleware/static-cache.middleware';

app.use(StaticCacheMiddleware);
```

### Custom Cache Decorator
```typescript
export function Cache(ttl: number, tags: string[]) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    
    descriptor.value = async function (...args: any[]) {
      const cacheKey = generateCacheKey(target.constructor.name, propertyKey, args);
      
      // Try cache first
      const cached = await this.cacheService.get(cacheKey);
      if (cached) {
        return JSON.parse(cached.content as string);
      }
      
      // Execute and cache result
      const result = await originalMethod.apply(this, args);
      await this.cacheService.set(
        cacheKey,
        JSON.stringify(result),
        CacheContentType.JSON,
        { ttl, tags }
      );
      
      return result;
    };
  };
}
```

This comprehensive static content caching system provides high-performance caching with intelligent management, real-time monitoring, and automated optimization features.
