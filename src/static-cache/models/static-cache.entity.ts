export enum CacheStrategy {
  TTL = 'TTL',
  LRU = 'LRU',
  WRITE_THROUGH = 'WRITE_THROUGH',
  WRITE_BEHIND = 'WRITE_BEHIND',
  REFRESH_AHEAD = 'REFRESH_AHEAD',
}

export enum CacheContentType {
  JSON = 'JSON',
  HTML = 'HTML',
  CSS = 'CSS',
  JS = 'JS',
  IMAGE = 'IMAGE',
  TEXT = 'TEXT',
  BINARY = 'BINARY',
}

export interface CacheEntry {
  key: string;
  content: string | Buffer;
  contentType: CacheContentType;
  size: number;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: Date;
  lastAccessed: Date;
  accessCount: number;
  ttl?: number;
  etag?: string;
  lastModified?: Date;
  compressed: boolean;
  version: number;
}

export interface CacheConfig {
  defaultTtl: number;
  maxSize: number;
  compressionThreshold: number;
  enableCompression: boolean;
  enableAnalytics: boolean;
  strategy: CacheStrategy;
  cleanupInterval: number;
  maxEntries: number;
}

export interface CacheInvalidationRule {
  id: string;
  name: string;
  description: string;
  type: 'TTL' | 'MANUAL' | 'TAG_BASED' | 'PATTERN_BASED';
  conditions: {
    tags?: string[];
    pattern?: string;
    ttl?: number;
    maxAge?: number;
  };
  isActive: boolean;
  createdAt: Date;
  lastTriggered?: Date;
  triggerCount: number;
}

export interface CacheAnalytics {
  totalEntries: number;
  totalSize: number;
  hitRate: number;
  missRate: number;
  averageResponseTime: number;
  topAccessedEntries: CacheEntry[];
  entriesByContentType: Record<CacheContentType, number>;
  entriesByTag: Record<string, number>;
  evictionRate: number;
  compressionRatio: number;
  generatedAt: Date;
}

export interface CacheStats {
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  evictions: number;
  compressions: number;
  decompressions: number;
  totalResponseTime: number;
  lastReset: Date;
}

export interface CacheWarmerJob {
  id: string;
  name: string;
  urls: string[];
  priority: number;
  interval: number;
  isActive: boolean;
  lastRun?: Date;
  nextRun?: Date;
  successCount: number;
  failureCount: number;
  metadata: Record<string, unknown>;
}

export interface CacheEntryMetadata {
  originalUrl?: string;
  statusCode?: number;
  headers?: Record<string, string>;
  source?: string;
  buildVersion?: string;
  environment?: string;
  dependencies?: string[];
  jobId?: string;
  warmedAt?: Date;
}

export interface CacheSearchCriteria {
  contentType?: CacheContentType;
  tags?: string[];
  minSize?: number;
  maxSize?: number;
  minAccessCount?: number;
  createdAfter?: Date;
  createdBefore?: Date;
  lastAccessedAfter?: Date;
  lastAccessedBefore?: Date;
  pattern?: string;
}

export interface CacheExportData {
  entries: CacheEntry[];
  analytics: CacheAnalytics;
  stats: CacheStats;
  config: CacheConfig;
  exportedAt: Date;
  version: string;
}

export interface CacheImportResult {
  importedCount: number;
  skippedCount: number;
  errorCount: number;
  errors: string[];
  importedAt: Date;
}

export interface CacheWarmingJob {
  id: string;
  name: string;
  description: string;
  urls: string[];
  priority: number;
  interval: number; // in minutes
  isActive: boolean;
  lastRun?: Date;
  nextRun?: Date;
  successCount: number;
  failureCount: number;
  averageDuration: number;
  metadata: Record<string, unknown>;
  tags: string[];
  ttl?: number;
  headers?: Record<string, string>;
}

export interface CacheWarmingStrategy {
  id: string;
  name: string;
  description: string;
  type: 'POPULAR_CONTENT' | 'USER_BASED' | 'TIME_BASED' | 'CUSTOM';
  config: Record<string, unknown>;
  isActive: boolean;
  lastExecuted?: Date;
  results: CacheWarmingResult[];
}

export interface CacheWarmingResult {
  jobId: string;
  jobName: string;
  startTime: Date;
  endTime: Date;
  duration: number;
  totalUrls: number;
  successCount: number;
  failureCount: number;
  errors: Array<{ url: string; error: string; timestamp: Date }>;
  warmedEntries: Array<{
    url: string;
    key: string;
    size: number;
    contentType: CacheContentType;
    duration: number;
  }>;
}
