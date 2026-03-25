export enum FeatureFlagType {
  BOOLEAN = 'BOOLEAN',
  PERCENTAGE = 'PERCENTAGE',
  WHITELIST = 'WHITELIST',
  BLACKLIST = 'BLACKLIST',
  CONDITIONAL = 'CONDITIONAL',
}

export enum FeatureFlagStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  ARCHIVED = 'ARCHIVED',
}

export interface FeatureFlag {
  id: string;
  key: string;
  name: string;
  description: string;
  type: FeatureFlagType;
  status: FeatureFlagStatus;
  value: boolean | number | string[] | string;
  conditions?: FlagCondition[];
  rolloutPercentage?: number;
  targetUsers?: string[];
  excludedUsers?: string[];
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  updatedBy: string;
}

export interface FlagCondition {
  field: string;
  operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin' | 'contains';
  value: unknown;
}

export interface FlagEvaluationContext {
  userId?: string;
  email?: string;
  role?: string;
  userAgent?: string;
  ip?: string;
  country?: string;
  customAttributes?: Record<string, unknown>;
}

export interface FlagEvaluationResult {
  flagKey: string;
  enabled: boolean;
  value: unknown;
  reason: string;
  timestamp: Date;
}

export interface FlagAnalytics {
  flagKey: string;
  totalEvaluations: number;
  enabledCount: number;
  disabledCount: number;
  uniqueUsers: number;
  lastEvaluated: Date | null;
  evaluationHistory: FlagEvaluationRecord[];
  dailyStats: Record<string, { enabled: number; disabled: number }>;
}

export interface FlagEvaluationRecord {
  userId?: string;
  result: boolean;
  value: unknown;
  context: Partial<FlagEvaluationContext>;
  timestamp: Date;
  reason: string;
}

export interface FlagRolloutStrategy {
  type: 'gradual' | 'immediate' | 'scheduled';
  percentage?: number;
  startDate?: Date;
  endDate?: Date;
  targetSegments?: string[];
}

export interface FlagSegment {
  id: string;
  name: string;
  description: string;
  conditions: FlagCondition[];
  userCount: number;
  createdAt: Date;
  updatedAt: Date;
}
