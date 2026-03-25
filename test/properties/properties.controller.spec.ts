import { Test, TestingModule } from '@nestjs/testing';
import { PropertiesController } from '../../src/properties/properties.controller';
import { PropertiesService } from '../../src/properties/properties.service';
import { PropertySearchService } from '../../src/properties/search/property-search.service';
import { CreatePropertyDto, PropertyType } from '../../src/properties/dto/create-property.dto';
import { UpdatePropertyDto } from '../../src/properties/dto/update-property.dto';
import { PropertyQueryDto } from '../../src/properties/dto/property-query.dto';
import { JwtAuthGuard } from '../../src/auth/guards/jwt-auth.guard';
import { ExecutionContext } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';

// Type aliases for test compatibility
type Property = any; // Using any for now since Prisma client isn't generated
enum PropertyStatus {
  DRAFT = 'DRAFT',
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  LISTED = 'LISTED',
  SOLD = 'SOLD',
  OFF_MARKET = 'OFF_MARKET',
  UNDER_CONTRACT = 'UNDER_CONTRACT',
  EXPIRED = 'EXPIRED',
  AVAILABLE = 'AVAILABLE',
  WITHDRAWN = 'WITHDRAWN',
  REJECTED = 'REJECTED',
}

describe('PropertiesController', () => {
  let controller: PropertiesController;
  let service: PropertiesService;

  const mockUser = {
    id: 'user_123',
    email: 'test@example.com',
    role: 'USER',
  };

  const mockProperty: Property = {
    id: 'prop_123',
    title: 'Test Property',
    description: 'Test Description',
    location: '123 Test St, Test City, Test State, 12345, Test Country',
    price: new Decimal(500000),
    status: PropertyStatus.LISTED,
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

  const mockPropertiesService = {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    searchNearby: jest.fn(),
    updateStatus: jest.fn(),
    findByOwner: jest.fn(),
    getStatistics: jest.fn(),
  };

  const mockPropertySearchService = {
    search: jest.fn(),
  };

  const mockJwtAuthGuard = {
    canActivate: jest.fn((context: ExecutionContext) => {
      const request = context.switchToHttp().getRequest();
      request.user = mockUser;
      return true;
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PropertiesController],
      providers: [
        {
          provide: PropertiesService,
          useValue: mockPropertiesService,
        },
        {
          provide: PropertySearchService,
          useValue: mockPropertySearchService,
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(mockJwtAuthGuard)
      .compile();

    controller = module.get<PropertiesController>(PropertiesController);
    service = module.get<PropertiesService>(PropertiesService);
  });

  afterEach(() => {
    jest.clearAllMocks();
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
      status: PropertyStatus.AVAILABLE as any,
      bedrooms: 3,
      bathrooms: 2,
      areaSqFt: 1500,
    };

    it('should create a property', async () => {
      mockPropertiesService.create.mockResolvedValue(mockProperty);

      const result = await controller.create(createPropertyDto, { user: mockUser });

      expect(result).toEqual(mockProperty);
      expect(service.create).toHaveBeenCalledWith(createPropertyDto, mockUser.id);
    });
  });

  describe('findAll', () => {
    it('should return paginated properties', async () => {
      const query: PropertyQueryDto = {
        page: 1,
        limit: 10,
        sortBy: 'createdAt',
        sortOrder: 'desc',
      };

      const mockResponse = {
        properties: [mockProperty],
        total: 1,
        page: 1,
        limit: 10,
        totalPages: 1,
      };

      mockPropertiesService.findAll.mockResolvedValue(mockResponse);

      const result = await controller.findAll(query);

      expect(result).toEqual(mockResponse);
      expect(service.findAll).toHaveBeenCalledWith(query);
    });

    it('should handle filters correctly', async () => {
      const query: PropertyQueryDto = {
        search: 'test',
        type: PropertyType.RESIDENTIAL,
        status: PropertyStatus.AVAILABLE as any,
        minPrice: 100000,
        maxPrice: 500000,
      };

      mockPropertiesService.findAll.mockResolvedValue({
        properties: [],
        total: 0,
        page: 1,
        limit: 20,
        totalPages: 0,
      });

      await controller.findAll(query);

      expect(service.findAll).toHaveBeenCalledWith(query);
    });
  });

  describe('searchNearby', () => {});

  describe('getStatistics', () => {
    it('should return property statistics', async () => {
      const mockStats = {
        total: 100,
        byStatus: { [PropertyStatus.LISTED]: 50, [PropertyStatus.SOLD]: 30 },
        byType: { [PropertyType.RESIDENTIAL]: 70, [PropertyType.COMMERCIAL]: 30 },
        averagePrice: 450000,
      };

      mockPropertiesService.getStatistics.mockResolvedValue(mockStats);

      const result = await controller.getStatistics();

      expect(result).toEqual(mockStats);
      expect(service.getStatistics).toHaveBeenCalled();
    });
  });

  describe('findByOwner', () => {
    it('should return properties by owner', async () => {
      const mockResponse = {
        properties: [mockProperty],
        total: 1,
      };

      mockPropertiesService.findByOwner.mockResolvedValue(mockResponse);

      const result = await controller.findByOwner('user_123', {});

      expect(result).toEqual(mockResponse);
      expect(service.findByOwner).toHaveBeenCalledWith('user_123', {});
    });

    it('should pass query parameters to service', async () => {
      const query: PropertyQueryDto = {
        status: PropertyStatus.AVAILABLE as any,
        page: 2,
        limit: 5,
      };

      mockPropertiesService.findByOwner.mockResolvedValue({
        properties: [],
        total: 0,
      });

      await controller.findByOwner('user_123', query);

      expect(service.findByOwner).toHaveBeenCalledWith('user_123', query);
    });
  });

  describe('findOne', () => {
    it('should return a property by ID', async () => {
      mockPropertiesService.findOne.mockResolvedValue(mockProperty);

      const result = await controller.findOne('prop_123');

      expect(result).toEqual(mockProperty);
      expect(service.findOne).toHaveBeenCalledWith('prop_123');
    });
  });

  describe('update', () => {
    const updatePropertyDto: UpdatePropertyDto = {
      title: 'Updated Property',
      price: 600000,
    };

    it('should update a property', async () => {
      const updatedProperty = { ...mockProperty, title: 'Updated Property', price: 600000 };
      mockPropertiesService.update.mockResolvedValue(updatedProperty);

      const result = await controller.update('prop_123', updatePropertyDto);

      expect(result).toEqual(updatedProperty);
      expect(service.update).toHaveBeenCalledWith('prop_123', updatePropertyDto);
    });
  });

  describe('updateStatus', () => {
    it('should update property status', async () => {
      const updatedProperty = { ...mockProperty, status: PropertyStatus.SOLD };
      mockPropertiesService.updateStatus.mockResolvedValue(updatedProperty);

      const result = await controller.updateStatus('prop_123', PropertyStatus.SOLD as any, {
        user: mockUser,
      });

      expect(result).toEqual(updatedProperty);
      expect(service.updateStatus).toHaveBeenCalledWith(
        'prop_123',
        PropertyStatus.SOLD,
        mockUser.id,
      );
    });
  });

  describe('remove', () => {
    it('should delete a property', async () => {
      mockPropertiesService.remove.mockResolvedValue(undefined);

      await expect(controller.remove('prop_123')).resolves.not.toThrow();
      expect(service.remove).toHaveBeenCalledWith('prop_123');
    });
  });
});