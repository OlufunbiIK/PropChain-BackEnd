import { Test, TestingModule } from '@nestjs/testing';
import { PropertiesService } from '../../src/properties/properties.service';
import { PrismaService } from '../../src/database/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { CreatePropertyDto, PropertyStatus, PropertyType } from '../../src/properties/dto/create-property.dto';
import { UpdatePropertyDto } from '../../src/properties/dto/update-property.dto';
import { PropertyQueryDto } from '../../src/properties/dto/property-query.dto';
import { NotFoundException, UserNotFoundException, InvalidInputException, BusinessRuleViolationException } from '../../src/common/errors/custom.exceptions';
import { Decimal } from '@prisma/client/runtime/library';
import { MultiLevelCacheService } from '../../src/common/cache/multi-level-cache.service';

describe('PropertiesService', () => {
  let service: PropertiesService;
  let prismaService: PrismaService;
  let configService: ConfigService;

  const mockUser = {
    id: 'user_123',
    email: 'test@example.com',
    role: 'USER',
  };

  const mockProperty = {
    id: 'prop_123',
    title: 'Test Property',
    description: 'Test Description',
    location: '123 Test St, Test City, Test State, 12345, Test Country',
    price: new Decimal(500000),
    status: 'LISTED',
    ownerId: 'user_123',
    createdAt: new Date(),
    updatedAt: new Date(),
    bedrooms: 3,
    bathrooms: 2,
    squareFootage: new Decimal(1500),
    propertyType: PropertyType.RESIDENTIAL,
    estimatedValue: null,
    valuationDate: null,
    valuationConfidence: null,
    valuationSource: null,
    lastValuationId: null,
    yearBuilt: null,
    lotSize: null,
    latitude: 40.7128,
    longitude: -74.006,
  };

  const mockPrismaService = {
    user: {
      findUnique: jest.fn(),
    },
    property: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
      groupBy: jest.fn(),
      aggregate: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn(),
  };

  const mockCacheService = {
    wrap: jest.fn(async (_key, factory) => factory()),
    del: jest.fn(),
    invalidateByPattern: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PropertiesService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
        {
          provide: MultiLevelCacheService,
          useValue: mockCacheService,
        },
      ],
    }).compile();

    service = module.get<PropertiesService>(PropertiesService);
    prismaService = module.get<PrismaService>(PrismaService);
    configService = module.get<ConfigService>(ConfigService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    mockCacheService.wrap.mockImplementation(async (_key, factory) => factory());
  });

  describe('create', () => {
    const createPropertyDto: CreatePropertyDto = {
      title: 'Test Property',
      description: 'Test Description',
      price: 500000,
      address: {
        street: '123 Test St',
        city: 'Test City',
        state: 'Test State',
        postalCode: '12345',
        country: 'Test Country',
      },
      type: PropertyType.RESIDENTIAL,
      status: PropertyStatus.AVAILABLE,
      bedrooms: 3,
      bathrooms: 2,
      areaSqFt: 1500,
    };

    it('should create a property successfully', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(mockUser);
      mockPrismaService.property.create.mockResolvedValue(mockProperty);

      const result = await service.create(createPropertyDto, 'user_123');

      expect(result).toEqual(mockProperty);
      expect(mockPrismaService.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'user_123' },
      });
      expect(mockPrismaService.property.create).toHaveBeenCalledWith({
        data: {
          title: createPropertyDto.title,
          description: createPropertyDto.description,
          location: '123 Test St, Test City, Test State, 12345, Test Country',
          price: createPropertyDto.price,
          status: 'LISTED',
          ownerId: 'user_123',
          bedrooms: createPropertyDto.bedrooms,
          bathrooms: createPropertyDto.bathrooms,
          squareFootage: createPropertyDto.areaSqFt,
          propertyType: createPropertyDto.type,
        },
        include: {
          owner: {
            select: {
              id: true,
              email: true,
              role: true,
            },
          },
        },
      });
    });

    it('should throw NotFoundException if user does not exist', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(null);

      await expect(service.create(createPropertyDto, 'invalid_user')).rejects.toThrow(UserNotFoundException);
    });

    it('should handle database errors', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(mockUser);
      mockPrismaService.property.create.mockRejectedValue(new Error('Database error'));

      await expect(service.create(createPropertyDto, 'user_123')).rejects.toThrow(InvalidInputException);
    });
  });

  describe('findAll', () => {
    const query: PropertyQueryDto = {
      page: 1,
      limit: 10,
      sortBy: 'createdAt',
      sortOrder: 'desc',
      search: 'test',
      type: PropertyType.RESIDENTIAL,
      status: PropertyStatus.AVAILABLE,
      minPrice: 100000,
      maxPrice: 1000000,
    };

    it('should return paginated properties with filters', async () => {
      const mockProperties = [mockProperty];
      const mockTotal = 1;

      mockPrismaService.property.findMany.mockResolvedValue(mockProperties);
      mockPrismaService.property.count.mockResolvedValue(mockTotal);

      const result = await service.findAll(query);

      expect(result).toEqual({
        properties: mockProperties,
        total: mockTotal,
        page: 1,
        limit: 10,
        totalPages: 1,
      });
      expect(mockCacheService.wrap).toHaveBeenCalled();
    });

    it('should apply search filter correctly', async () => {
      await service.findAll({ search: 'test' });

      expect(mockPrismaService.property.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [
              { title: { contains: 'test', mode: 'insensitive' } },
              { description: { contains: 'test', mode: 'insensitive' } },
              { location: { contains: 'test', mode: 'insensitive' } },
            ],
          }),
        }),
      );
    });

    it('should apply price range filter correctly', async () => {
      await service.findAll({ minPrice: 100000, maxPrice: 500000 });

      expect(mockPrismaService.property.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            price: {
              gte: 100000,
              lte: 500000,
            },
          }),
        }),
      );
    });

    it('should apply property type filter correctly', async () => {
      await service.findAll({ type: PropertyType.RESIDENTIAL });

      expect(mockPrismaService.property.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            propertyType: PropertyType.RESIDENTIAL,
          }),
        }),
      );
    });

    it('should apply status filter correctly', async () => {
      await service.findAll({ status: PropertyStatus.AVAILABLE });

      expect(mockPrismaService.property.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'LISTED',
          }),
        }),
      );
    });

    it('should apply city and country location filter correctly', async () => {
      await service.findAll({ city: 'New York', country: 'USA' });

      expect(mockPrismaService.property.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            location: {
              contains: 'New York, USA',
              mode: 'insensitive',
            },
          }),
        }),
      );
    });

    it('should apply bedroom range filter correctly', async () => {
      await service.findAll({ minBedrooms: 2, maxBedrooms: 4 });

      expect(mockPrismaService.property.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            bedrooms: {
              gte: 2,
              lte: 4,
            },
          }),
        }),
      );
    });

    it('should apply bathroom range filter correctly', async () => {
      await service.findAll({ minBathrooms: 1, maxBathrooms: 3 });

      expect(mockPrismaService.property.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            bathrooms: {
              gte: 1,
              lte: 3,
            },
          }),
        }),
      );
    });

    it('should apply area range filter correctly', async () => {
      await service.findAll({ minArea: 500, maxArea: 2000 });

      expect(mockPrismaService.property.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            squareFootage: {
              gte: 500,
              lte: 2000,
            },
          }),
        }),
      );
    });

    it('should apply owner filter correctly', async () => {
      await service.findAll({ ownerId: 'user_123' });

      expect(mockPrismaService.property.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            ownerId: 'user_123',
          }),
        }),
      );
    });

    it('should apply pagination correctly', async () => {
      await service.findAll({ page: 2, limit: 5 });

      expect(mockPrismaService.property.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 5,
          take: 5,
        }),
      );
    });

    it('should apply sorting correctly', async () => {
      await service.findAll({ sortBy: 'price', sortOrder: 'asc' });

      expect(mockPrismaService.property.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { price: 'asc' },
        }),
      );
    });

    it('should handle empty query with defaults', async () => {
      await service.findAll();

      expect(mockPrismaService.property.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 0,
          take: 20,
          orderBy: { createdAt: 'desc' },
        }),
      );
    });

    it('should handle multiple filters combined', async () => {
      const complexQuery = {
        search: 'luxury',
        type: PropertyType.RESIDENTIAL,
        status: PropertyStatus.AVAILABLE,
        minPrice: 200000,
        maxPrice: 800000,
        minBedrooms: 3,
        maxBedrooms: 5,
        city: 'Miami',
        page: 1,
        limit: 15,
      };

      await service.findAll(complexQuery);

      expect(mockPrismaService.property.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [
              { title: { contains: 'luxury', mode: 'insensitive' } },
              { description: { contains: 'luxury', mode: 'insensitive' } },
              { location: { contains: 'luxury', mode: 'insensitive' } },
            ],
            propertyType: PropertyType.RESIDENTIAL,
            status: 'LISTED',
            price: {
              gte: 200000,
              lte: 800000,
            },
            bedrooms: {
              gte: 3,
              lte: 5,
            },
            location: {
              contains: 'Miami',
              mode: 'insensitive',
            },
          }),
          skip: 0,
          take: 15,
        }),
      );
    });
  });

  describe('findOne', () => {
    it('should return a property by ID', async () => {
      mockPrismaService.property.findUnique.mockResolvedValue(mockProperty);

      const result = await service.findOne('prop_123');

      expect(result).toEqual(mockProperty);
      expect(mockPrismaService.property.findUnique).toHaveBeenCalledWith({
        where: { id: 'prop_123' },
        relationLoadStrategy: 'join',
        include: {
          owner: {
            select: {
              id: true,
              email: true,
              role: true,
            },
          },
          documents: {
            select: {
              id: true,
              name: true,
              type: true,
              status: true,
              createdAt: true,
            },
          },
          valuations: {
            orderBy: { valuationDate: 'desc' },
            take: 5,
          },
        },
      });
    });

    it('should throw NotFoundException if property does not exist', async () => {
      mockPrismaService.property.findUnique.mockResolvedValue(null);

      await expect(service.findOne('invalid_id')).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    const updatePropertyDto: UpdatePropertyDto = {
      title: 'Updated Property',
      price: 600000,
    };

    it('should update a property successfully', async () => {
      mockPrismaService.property.findUnique.mockResolvedValue(mockProperty);
      mockPrismaService.property.update.mockResolvedValue({
        ...mockProperty,
        title: 'Updated Property',
        price: 600000,
      });

      const result = await service.update('prop_123', updatePropertyDto);

      expect(result.title).toBe('Updated Property');
      expect(result.price).toBe(600000);
      expect(mockPrismaService.property.update).toHaveBeenCalledWith({
        where: { id: 'prop_123' },
        data: {
          title: 'Updated Property',
          price: 600000,
        },
        relationLoadStrategy: 'join',
        include: {
          owner: {
            select: {
              id: true,
              email: true,
              role: true,
            },
          },
        },
      });
    });

    it('should throw NotFoundException if property does not exist', async () => {
      mockPrismaService.property.findUnique.mockResolvedValue(null);

      await expect(service.update('invalid_id', updatePropertyDto)).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('should delete a property successfully', async () => {
      mockPrismaService.property.findUnique.mockResolvedValue(mockProperty);
      mockPrismaService.property.delete.mockResolvedValue(mockProperty);

      await expect(service.remove('prop_123')).resolves.not.toThrow();
      expect(mockPrismaService.property.delete).toHaveBeenCalledWith({
        where: { id: 'prop_123' },
      });
    });

    it('should throw NotFoundException if property does not exist', async () => {
      mockPrismaService.property.findUnique.mockResolvedValue(null);

      await expect(service.remove('invalid_id')).rejects.toThrow(NotFoundException);
    });
  });

  describe('searchNearby', () => {
    it('should search properties near a location', async () => {
      mockPrismaService.property.findMany.mockResolvedValue([mockProperty]);

      const result = await service.searchNearby(40.7128, -74.006, 10);

      expect(result).toEqual({
        properties: [mockProperty],
        total: 1,
      });
    });
  });

  describe('updateStatus', () => {
    it('should update property status with valid transition', async () => {
      mockPrismaService.property.findUnique.mockResolvedValue(mockProperty);
      mockPrismaService.property.update.mockResolvedValue({
        ...mockProperty,
        status: 'SOLD',
      });

      const result = await service.updateStatus('prop_123', PropertyStatus.SOLD, 'user_123');

      expect(result.status).toBe('SOLD');
    });

    it('should throw BadRequestException for invalid status transition', async () => {
      mockPrismaService.property.findUnique.mockResolvedValue({
        ...mockProperty,
        status: 'SOLD',
      });

      await expect(service.updateStatus('prop_123', PropertyStatus.AVAILABLE, 'user_123')).rejects.toThrow(
        BusinessRuleViolationException,
      );
    });
  });

  describe('findByOwner', () => {
    it('should return properties by owner', async () => {
      mockPrismaService.property.findMany.mockResolvedValue([mockProperty]);
      mockPrismaService.property.count.mockResolvedValue(1);

      const result = await service.findByOwner('user_123');

      expect(result).toEqual({
        properties: [mockProperty],
        total: 1,
      });
    });
  });

  describe('getStatistics', () => {
    it('should return property statistics', async () => {
      mockPrismaService.property.count.mockResolvedValue(10);
      mockPrismaService.property.groupBy
        .mockResolvedValueOnce([{ status: 'LISTED', _count: 5 }])
        .mockResolvedValueOnce([{ propertyType: PropertyType.RESIDENTIAL, _count: 8 }]);
      mockPrismaService.property.aggregate.mockResolvedValue({
        _avg: { price: 500000 },
      });

      const result = await service.getStatistics();

      expect(result).toEqual({
        total: 10,
        byStatus: { LISTED: 5 },
        byType: { [PropertyType.RESIDENTIAL]: 8 },
        averagePrice: 500000,
      });
    });
  });

  describe('helper methods', () => {
    it('should format address correctly', () => {
      const address = {
        street: '123 Test St',
        city: 'Test City',
        state: 'Test State',
        postalCode: '12345',
        country: 'Test Country',
      };

      const result = (service as any).formatAddress(address);
      expect(result).toBe('123 Test St, Test City, Test State, 12345, Test Country');
    });

    it('should map property status correctly', () => {
      const serviceInstance = service as any;

      expect(serviceInstance.mapPropertyStatus(PropertyStatus.AVAILABLE)).toBe('LISTED');
      expect(serviceInstance.mapPropertyStatus(PropertyStatus.SOLD)).toBe('SOLD');
      expect(serviceInstance.mapPropertyStatus(PropertyStatus.PENDING)).toBe('PENDING');
    });

    it('should validate status transitions correctly', () => {
      const serviceInstance = service as any;

      expect(serviceInstance.isValidStatusTransition('LISTED', 'SOLD')).toBe(true);

      expect(serviceInstance.isValidStatusTransition('SOLD', 'LISTED')).toBe(false);
    });
  });
});
