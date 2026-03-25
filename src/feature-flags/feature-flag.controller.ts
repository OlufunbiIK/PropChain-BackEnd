import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery, ApiBearerAuth, ApiBody } from '@nestjs/swagger';
import { FeatureFlagService } from './feature-flag.service';
import {
  CreateFeatureFlagDto,
  UpdateFeatureFlagDto,
  EvaluateFlagDto,
  BulkEvaluateFlagsDto,
  FlagQueryDto,
} from './dto/feature-flag.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RbacGuard } from '../auth/guards/rbac.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { FlagEvaluationResult } from './models/feature-flag.entity';

@ApiTags('Feature Flags')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacGuard)
@Controller('feature-flags')
export class FeatureFlagController {
  constructor(private readonly featureFlagService: FeatureFlagService) {}

  @Post()
  @Roles('feature-flags', 'create')
  @ApiOperation({ summary: 'Create a new feature flag' })
  @ApiResponse({ status: 201, description: 'Feature flag created successfully' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 409, description: 'Feature flag already exists' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  async create(@Body() createFlagDto: CreateFeatureFlagDto, @Request() req: any) {
    return this.featureFlagService.create(createFlagDto, req.user.id);
  }

  @Get()
  @Roles('feature-flags', 'read')
  @ApiOperation({ summary: 'Get all feature flags with filtering and pagination' })
  @ApiResponse({ status: 200, description: 'Feature flags retrieved successfully' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiQuery({ name: 'keys', required: false, description: 'Filter by flag keys (comma separated)' })
  @ApiQuery({ name: 'status', required: false, description: 'Filter by status' })
  @ApiQuery({ name: 'type', required: false, description: 'Filter by type' })
  @ApiQuery({ name: 'tags', required: false, description: 'Filter by tags (comma separated)' })
  @ApiQuery({ name: 'search', required: false, description: 'Search in name and description' })
  @ApiQuery({ name: 'page', required: false, description: 'Page number' })
  @ApiQuery({ name: 'limit', required: false, description: 'Items per page' })
  async findAll(@Query() query: FlagQueryDto) {
    return this.featureFlagService.findAll(query);
  }

  @Get(':id')
  @Roles('feature-flags', 'read')
  @ApiOperation({ summary: 'Get a specific feature flag by ID' })
  @ApiResponse({ status: 200, description: 'Feature flag retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Feature flag not found' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiParam({ name: 'id', description: 'Feature flag ID' })
  async findOne(@Param('id') id: string) {
    return this.featureFlagService.findOne(id);
  }

  @Get('key/:key')
  @Roles('feature-flags', 'read')
  @ApiOperation({ summary: 'Get a specific feature flag by key' })
  @ApiResponse({ status: 200, description: 'Feature flag retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Feature flag not found' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiParam({ name: 'key', description: 'Feature flag key' })
  async findByKey(@Param('key') key: string) {
    return this.featureFlagService.getByKey(key);
  }

  @Patch(':id')
  @Roles('feature-flags', 'update')
  @ApiOperation({ summary: 'Update a feature flag' })
  @ApiResponse({ status: 200, description: 'Feature flag updated successfully' })
  @ApiResponse({ status: 404, description: 'Feature flag not found' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiParam({ name: 'id', description: 'Feature flag ID' })
  async update(@Param('id') id: string, @Body() updateFlagDto: UpdateFeatureFlagDto, @Request() req: any) {
    return this.featureFlagService.update(id, updateFlagDto, req.user.id);
  }

  @Delete(':id')
  @Roles('feature-flags', 'delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a feature flag' })
  @ApiResponse({ status: 204, description: 'Feature flag deleted successfully' })
  @ApiResponse({ status: 404, description: 'Feature flag not found' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiParam({ name: 'id', description: 'Feature flag ID' })
  async remove(@Param('id') id: string) {
    return this.featureFlagService.remove(id);
  }

  @Post('evaluate')
  @ApiOperation({ summary: 'Evaluate a single feature flag' })
  @ApiResponse({ status: 200, description: 'Flag evaluated successfully' })
  @ApiResponse({ status: 404, description: 'Feature flag not found' })
  @ApiBody({ type: EvaluateFlagDto })
  async evaluate(@Body() evaluateDto: EvaluateFlagDto, @Request() req: any) {
    const context = {
      userId: evaluateDto.userId || req.user?.id,
      email: evaluateDto.email || req.user?.email,
      role: evaluateDto.role || req.user?.role,
      customAttributes: evaluateDto.customAttributes,
    };

    return this.featureFlagService.evaluate(evaluateDto.flagKey, context);
  }

  @Post('evaluate-bulk')
  @ApiOperation({ summary: 'Evaluate multiple feature flags' })
  @ApiResponse({ status: 200, description: 'Flags evaluated successfully' })
  @ApiBody({ type: BulkEvaluateFlagsDto })
  async bulkEvaluate(@Body() bulkEvaluateDto: BulkEvaluateFlagsDto, @Request() req: any) {
    const context = {
      userId: bulkEvaluateDto.userId || req.user?.id,
      email: bulkEvaluateDto.email || req.user?.email,
      role: bulkEvaluateDto.role || req.user?.role,
      customAttributes: bulkEvaluateDto.customAttributes,
    };

    return this.featureFlagService.bulkEvaluate(bulkEvaluateDto.flagKeys, context);
  }

  @Get(':key/analytics')
  @Roles('feature-flags', 'read')
  @ApiOperation({ summary: 'Get analytics for a specific feature flag' })
  @ApiResponse({ status: 200, description: 'Analytics retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Feature flag not found' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiParam({ name: 'key', description: 'Feature flag key' })
  @ApiQuery({ name: 'days', required: false, description: 'Number of days to analyze (default: 30)' })
  async getAnalytics(@Param('key') key: string, @Query('days') days?: number) {
    return this.featureFlagService.getAnalytics(key, days);
  }
}

@ApiTags('Feature Flags - Public')
@Controller('public/feature-flags')
export class PublicFeatureFlagController {
  constructor(private readonly featureFlagService: FeatureFlagService) {}

  @Post('evaluate')
  @ApiOperation({ summary: 'Evaluate feature flags (public endpoint)' })
  @ApiResponse({ status: 200, description: 'Flags evaluated successfully' })
  @ApiBody({ type: BulkEvaluateFlagsDto })
  async evaluatePublic(@Body() bulkEvaluateDto: BulkEvaluateFlagsDto) {
    const context = {
      userId: bulkEvaluateDto.userId,
      email: bulkEvaluateDto.email,
      role: bulkEvaluateDto.role,
      customAttributes: bulkEvaluateDto.customAttributes,
    };

    return this.featureFlagService.bulkEvaluate(bulkEvaluateDto.flagKeys, context);
  }

  @Post(':key/evaluate')
  @ApiOperation({ summary: 'Evaluate a single feature flag (public endpoint)' })
  @ApiResponse({ status: 200, description: 'Flag evaluated successfully' })
  @ApiParam({ name: 'key', description: 'Feature flag key' })
  @ApiBody({ type: EvaluateFlagDto })
  async evaluateSinglePublic(@Param('key') key: string, @Body() evaluateDto: EvaluateFlagDto) {
    const context = {
      userId: evaluateDto.userId,
      email: evaluateDto.email,
      role: evaluateDto.role,
      customAttributes: evaluateDto.customAttributes,
    };

    return this.featureFlagService.evaluate(key, context);
  }
}
