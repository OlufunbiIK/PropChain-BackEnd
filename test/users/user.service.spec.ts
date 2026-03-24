import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { UserService } from '../../src/users/user.service';
import { PrismaService } from '../../src/database/prisma/prisma.service';
import { PasswordValidator } from '../../src/common/validators/password.validator';
import { PasswordRotationService } from '../../src/common/services/password-rotation.service';
import { ConfigService } from '@nestjs/config';
import { MultiLevelCacheService } from '../../src/common/cache/multi-level-cache.service';

describe('UserService', () => {
  let service: UserService;

  const mockPrismaService = {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    userActivity: {
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
    },
    userRelationship: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
    },
  };

  const mockPasswordValidator = {
    validatePassword: jest.fn().mockReturnValue({ valid: true, errors: [] }),
  };

  const mockPasswordRotationService = {
    validatePasswordRotation: jest.fn().mockResolvedValue({ valid: true }),
    addPasswordToHistory: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn((key: string, fallback: number) => fallback),
  };

  const mockCacheService = {
    wrap: jest.fn(async (_key, factory) => factory()),
    del: jest.fn(),
    invalidateByPattern: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: PasswordValidator, useValue: mockPasswordValidator },
        { provide: PasswordRotationService, useValue: mockPasswordRotationService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: MultiLevelCacheService, useValue: mockCacheService },
      ],
    }).compile();

    service = module.get<UserService>(UserService);
    jest.clearAllMocks();
    mockCacheService.wrap.mockImplementation(async (_key, factory) => factory());
  });

  it('uses a single conflict lookup when updating email or wallet address', async () => {
    mockPrismaService.user.findFirst.mockResolvedValue(null);
    mockPrismaService.user.update.mockResolvedValue({ id: 'user-1', email: 'updated@example.com' });

    await service.updateUser('user-1', {
      email: 'updated@example.com',
      walletAddress: '0xabc',
    });

    expect(mockPrismaService.user.findFirst).toHaveBeenCalledTimes(1);
    expect(mockPrismaService.user.findFirst).toHaveBeenCalledWith({
      where: {
        id: { not: 'user-1' },
        OR: [{ email: 'updated@example.com' }, { walletAddress: '0xabc' }],
      },
      select: {
        email: true,
        walletAddress: true,
      },
    });
  });

  it('throws a conflict when the combined lookup finds a duplicate email', async () => {
    mockPrismaService.user.findFirst.mockResolvedValue({
      email: 'updated@example.com',
      walletAddress: null,
    });

    await expect(service.updateUser('user-1', { email: 'updated@example.com' })).rejects.toThrow(ConflictException);
  });

  it('loads followers with join strategy and caches the result', async () => {
    mockPrismaService.userRelationship.findMany.mockResolvedValue([
      {
        id: 'rel-1',
        follower: { id: 'user-2', email: 'follower@example.com' },
      },
    ]);

    const result = await service.getFollowers('user-1', 10);

    expect(result).toHaveLength(1);
    expect(mockCacheService.wrap).toHaveBeenCalled();
    expect(mockPrismaService.userRelationship.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { followingId: 'user-1', status: 'active' },
        take: 10,
        relationLoadStrategy: 'join',
      }),
    );
  });
});
