import { IsOptional, IsString, IsNumber, IsEnum, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IntersectionType } from '@nestjs/swagger';
import { PaginationDto, SortDto } from '../../common/dto';
import { PropertyType, PropertyStatus } from './create-property.dto';

export class PropertyFilterDto {
  @ApiPropertyOptional({
    description: 'Search by title or description',
    example: 'apartment',
  })
  @IsOptional()
  @IsString({ message: 'Search must be a string' })
  search?: string;

  @ApiPropertyOptional({
    description: 'Filter by property type',
    enum: PropertyType,
  })
  @IsOptional()
  @IsEnum(PropertyType, { message: 'Invalid property type' })
  type?: PropertyType;

  @ApiPropertyOptional({
    description: 'Filter by status',
    enum: PropertyStatus,
  })
  @IsOptional()
  @IsEnum(PropertyStatus, { message: 'Invalid status' })
  status?: PropertyStatus;

  @ApiPropertyOptional({
    description: 'Filter by city',
    example: 'New York',
  })
  @IsOptional()
  @IsString({ message: 'City must be a string' })
  city?: string;

  @ApiPropertyOptional({
    description: 'Filter by country',
    example: 'United States',
  })
  @IsOptional()
  @IsString({ message: 'Country must be a string' })
  country?: string;

  @ApiPropertyOptional({
    description: 'Minimum price',
    example: 100000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'minPrice must be a number' })
  @Min(0, { message: 'minPrice cannot be negative' })
  minPrice?: number;

  @ApiPropertyOptional({
    description: 'Maximum price',
    example: 500000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'maxPrice must be a number' })
  @Min(0, { message: 'maxPrice cannot be negative' })
  maxPrice?: number;

  @ApiPropertyOptional({
    description: 'Minimum bedrooms',
    example: 2,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'minBedrooms must be a number' })
  @Min(0, { message: 'minBedrooms cannot be negative' })
  minBedrooms?: number;

  @ApiPropertyOptional({
    description: 'Maximum bedrooms',
    example: 5,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'maxBedrooms must be a number' })
  @Min(0, { message: 'maxBedrooms cannot be negative' })
  maxBedrooms?: number;

  @ApiPropertyOptional({
    description: 'Filter by owner ID',
    example: 'user_abc123',
  })
  @IsOptional()
  @IsString({ message: 'Owner ID must be a string' })
  ownerId?: string;

  @ApiPropertyOptional({
    description: 'Minimum bathrooms',
    example: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'minBathrooms must be a number' })
  @Min(0, { message: 'minBathrooms cannot be negative' })
  minBathrooms?: number;

  @ApiPropertyOptional({
    description: 'Maximum bathrooms',
    example: 4,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'maxBathrooms must be a number' })
  @Min(0, { message: 'maxBathrooms cannot be negative' })
  maxBathrooms?: number;

  @ApiPropertyOptional({
    description: 'Minimum square footage',
    example: 500,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'minArea must be a number' })
  @Min(0, { message: 'minArea cannot be negative' })
  minArea?: number;

  @ApiPropertyOptional({
    description: 'Maximum square footage',
    example: 5000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'maxArea must be a number' })
  @Min(0, { message: 'maxArea cannot be negative' })
  maxArea?: number;
}

class PropertyPaginationSortDto extends IntersectionType(PaginationDto, SortDto) {}

export class PropertyQueryDto extends IntersectionType(PropertyFilterDto, PropertyPaginationSortDto) {
  declare search?: string;
  declare type?: PropertyType;
  declare status?: PropertyStatus;
  declare city?: string;
  declare country?: string;
  declare minPrice?: number;
  declare maxPrice?: number;
  declare minBedrooms?: number;
  declare maxBedrooms?: number;
  declare ownerId?: string;
  declare minBathrooms?: number;
  declare maxBathrooms?: number;
  declare minArea?: number;
  declare maxArea?: number;
  declare page?: number;
  declare limit?: number;
  declare sortBy?: string;
  declare sortOrder?: 'asc' | 'desc';
}
