import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsArray,
  IsBoolean,
  IsNumber,
  Min,
  Max,
  ValidateNested,
  ArrayMaxSize,
  MaxLength,
  IsObject,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FeatureFlagType, FeatureFlagStatus } from '../models/feature-flag.entity';

export class FlagConditionDto {
  @ApiProperty({
    description: 'Field to evaluate',
    example: 'user.role',
  })
  @IsString()
  @IsNotEmpty()
  field: string;

  @ApiProperty({
    description: 'Comparison operator',
    enum: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'contains'],
    example: 'eq',
  })
  @IsEnum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'contains'])
  operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin' | 'contains';

  @ApiProperty({
    description: 'Value to compare against',
    example: 'admin',
  })
  value: unknown;
}

export class CreateFeatureFlagDto {
  @ApiProperty({
    description: 'Unique key for the feature flag',
    example: 'new-dashboard-ui',
    maxLength: 100,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  key: string;

  @ApiProperty({
    description: 'Human-readable name for the feature flag',
    example: 'New Dashboard UI',
    maxLength: 200,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @ApiProperty({
    description: 'Description of what the feature flag controls',
    example: 'Enables the new dashboard interface for selected users',
    maxLength: 1000,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  description: string;

  @ApiProperty({
    description: 'Type of feature flag',
    enum: FeatureFlagType,
    example: FeatureFlagType.PERCENTAGE,
  })
  @IsEnum(FeatureFlagType)
  type: FeatureFlagType;

  @ApiProperty({
    description: 'Status of the feature flag',
    enum: FeatureFlagStatus,
    example: FeatureFlagStatus.ACTIVE,
  })
  @IsEnum(FeatureFlagStatus)
  status: FeatureFlagStatus;

  @ApiPropertyOptional({
    description: 'Value for boolean flags',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  booleanValue?: boolean;

  @ApiPropertyOptional({
    description: 'Percentage value for percentage flags (0-100)',
    example: 25,
    minimum: 0,
    maximum: 100,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  percentageValue?: number;

  @ApiPropertyOptional({
    description: 'List of user IDs for whitelist flags',
    type: [String],
    maxItems: 10000,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(10000)
  whitelistValue?: string[];

  @ApiPropertyOptional({
    description: 'List of user IDs for blacklist flags',
    type: [String],
    maxItems: 10000,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(10000)
  blacklistValue?: string[];

  @ApiPropertyOptional({
    description: 'Conditions for conditional flags',
    type: [FlagConditionDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FlagConditionDto)
  conditions?: FlagConditionDto[];

  @ApiPropertyOptional({
    description: 'Tags for categorizing flags',
    type: [String],
    maxItems: 10,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(10)
  tags?: string[];

  @ApiPropertyOptional({
    description: 'Additional metadata',
    example: { team: 'frontend', priority: 'high' },
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class UpdateFeatureFlagDto {
  @ApiPropertyOptional({
    description: 'Human-readable name for the feature flag',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({
    description: 'Description of what the feature flag controls',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({
    description: 'Status of the feature flag',
    enum: FeatureFlagStatus,
  })
  @IsOptional()
  @IsEnum(FeatureFlagStatus)
  status?: FeatureFlagStatus;

  @ApiPropertyOptional({
    description: 'Type of feature flag',
    enum: FeatureFlagType,
  })
  @IsOptional()
  @IsEnum(FeatureFlagType)
  type?: FeatureFlagType;

  @ApiPropertyOptional({
    description: 'Value for boolean flags',
  })
  @IsOptional()
  @IsBoolean()
  booleanValue?: boolean;

  @ApiPropertyOptional({
    description: 'Percentage value for percentage flags (0-100)',
    minimum: 0,
    maximum: 100,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  percentageValue?: number;

  @ApiPropertyOptional({
    description: 'List of user IDs for whitelist flags',
    type: [String],
    maxItems: 10000,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(10000)
  whitelistValue?: string[];

  @ApiPropertyOptional({
    description: 'List of user IDs for blacklist flags',
    type: [String],
    maxItems: 10000,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(10000)
  blacklistValue?: string[];

  @ApiPropertyOptional({
    description: 'Conditions for conditional flags',
    type: [FlagConditionDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FlagConditionDto)
  conditions?: FlagConditionDto[];

  @ApiPropertyOptional({
    description: 'Tags for categorizing flags',
    type: [String],
    maxItems: 10,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(10)
  tags?: string[];

  @ApiPropertyOptional({
    description: 'Additional metadata',
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class EvaluateFlagDto {
  @ApiProperty({
    description: 'Feature flag key to evaluate',
    example: 'new-dashboard-ui',
  })
  @IsString()
  @IsNotEmpty()
  flagKey: string;

  @ApiPropertyOptional({
    description: 'User ID for evaluation context',
    example: 'user_123',
  })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({
    description: 'User email for evaluation context',
    example: 'user@example.com',
  })
  @IsOptional()
  @IsString()
  email?: string;

  @ApiPropertyOptional({
    description: 'User role for evaluation context',
    example: 'admin',
  })
  @IsOptional()
  @IsString()
  role?: string;

  @ApiPropertyOptional({
    description: 'Custom attributes for evaluation',
    example: { plan: 'premium', region: 'us-east' },
  })
  @IsOptional()
  @IsObject()
  customAttributes?: Record<string, unknown>;
}

export class BulkEvaluateFlagsDto {
  @ApiProperty({
    description: 'List of flag keys to evaluate',
    type: [String],
    maxItems: 100,
  })
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(100)
  flagKeys: string[];

  @ApiPropertyOptional({
    description: 'User ID for evaluation context',
  })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({
    description: 'User email for evaluation context',
  })
  @IsOptional()
  @IsString()
  email?: string;

  @ApiPropertyOptional({
    description: 'User role for evaluation context',
  })
  @IsOptional()
  @IsString()
  role?: string;

  @ApiPropertyOptional({
    description: 'Custom attributes for evaluation',
  })
  @IsOptional()
  @IsObject()
  customAttributes?: Record<string, unknown>;
}

export class FlagQueryDto {
  @ApiPropertyOptional({
    description: 'Filter by flag keys (comma separated)',
    example: 'new-dashboard-ui,experimental-api',
  })
  @IsOptional()
  @IsString()
  keys?: string;

  @ApiPropertyOptional({
    description: 'Filter by status',
    enum: FeatureFlagStatus,
  })
  @IsOptional()
  @IsEnum(FeatureFlagStatus)
  status?: FeatureFlagStatus;

  @ApiPropertyOptional({
    description: 'Filter by type',
    enum: FeatureFlagType,
  })
  @IsOptional()
  @IsEnum(FeatureFlagType)
  type?: FeatureFlagType;

  @ApiPropertyOptional({
    description: 'Filter by tags (comma separated)',
    example: 'frontend,experimental',
  })
  @IsOptional()
  @IsString()
  tags?: string;

  @ApiPropertyOptional({
    description: 'Search in name and description',
    example: 'dashboard',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description: 'Page number',
    example: 1,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    description: 'Items per page',
    example: 20,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
