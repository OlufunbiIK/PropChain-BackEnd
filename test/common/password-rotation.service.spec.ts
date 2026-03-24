import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PasswordRotationService } from '../../src/common/services/password-rotation.service';
import { PrismaService } from '../../src/database/prisma/prisma.service';
import * as bcrypt from 'bcrypt';

// Mock bcrypt
jest.mock('bcrypt', () => ({
  compare: jest.fn(),
}));

describe('PasswordRotationService', () => {
  let service: PasswordRotationService;
  let prismaService: PrismaService;
  let configService: ConfigService;

  const mockPrismaService = {
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    passwordHistory: {
      findMany: jest.fn(),
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn().mockImplementation((key: string, defaultValue?: number) => {
      const config: Record<string, number> = {
        PASSWORD_EXPIRY_DAYS: 90,
        PASSWORD_HISTORY_COUNT: 5,
        PASSWORD_EXPIRY_WARNING_DAYS: 7,
      };
      return config[key] ?? defaultValue;
    }),
  };

  const MOCK_NOW = new Date('2024-01-01T12:00:00Z');

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(MOCK_NOW);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PasswordRotationService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<PasswordRotationService>(PasswordRotationService);
    prismaService = module.get<PrismaService>(PrismaService);
    configService = module.get<ConfigService>(ConfigService);
  });


  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('checkRotationStatus', () => {
    it('should return canRotate false when user not found', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(null);

      const result = await service.checkRotationStatus('user-id');

      expect(result.canRotate).toBe(false);
      expect(result.reason).toBe('User not found or no password set');
    });

    it('should return canRotate false when user has no password', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'user-id',
        email: 'test@example.com',
        password: null,
        createdAt: new Date(),
        passwordHistory: [],
      });

      const result = await service.checkRotationStatus('user-id');

      expect(result.canRotate).toBe(false);
      expect(result.reason).toBe('User not found or no password set');
    });

    it('should return expired status when password has expired', async () => {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 100); // 100 days ago

      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'user-id',
        email: 'test@example.com',
        password: 'hashed-password',
        createdAt: oldDate,
        passwordHistory: [],
      });

      const result = await service.checkRotationStatus('user-id');

      expect(result.canRotate).toBe(true);
      expect(result.reason).toBe('Password has expired and must be changed');
      expect(result.daysUntilExpiry).toBe(0);
    });

    it('should return valid status with days until expiry', async () => {
      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 30); // 30 days ago

      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'user-id',
        email: 'test@example.com',
        password: 'hashed-password',
        createdAt: recentDate,
        passwordHistory: [],
      });

      const result = await service.checkRotationStatus('user-id');

      expect(result.canRotate).toBe(true);
      expect(result.daysUntilExpiry).toBe(60); // 90 - 30
      expect(result.reason).toBeUndefined();
    });

    it('should use password history date when available', async () => {
      const createdDate = new Date();
      createdDate.setDate(createdDate.getDate() - 100);

      const passwordChangeDate = new Date();
      passwordChangeDate.setDate(passwordChangeDate.getDate() - 30);

      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'user-id',
        email: 'test@example.com',
        password: 'hashed-password',
        createdAt: createdDate,
        passwordHistory: [{ createdAt: passwordChangeDate }],
      });

      const result = await service.checkRotationStatus('user-id');

      expect(result.canRotate).toBe(true);
      expect(result.daysUntilExpiry).toBe(60); // 90 - 30 (from password change date)
      expect(result.lastRotation).toEqual(passwordChangeDate);
    });
  });

  describe('validatePasswordNotInHistory', () => {
    it('should return valid true when history is empty', async () => {
      mockPrismaService.passwordHistory.findMany.mockResolvedValue([]);

      const result = await service.validatePasswordNotInHistory('user-id', 'new-password');

      expect(result.valid).toBe(true);
    });

    it('should return valid true when password not in history', async () => {
      mockPrismaService.passwordHistory.findMany.mockResolvedValue([
        { id: '1', passwordHash: 'old-hash-1' },
        { id: '2', passwordHash: 'old-hash-2' },
      ]);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      const result = await service.validatePasswordNotInHistory('user-id', 'new-password');

      expect(result.valid).toBe(true);
    });

    it('should return valid false when password matches history', async () => {
      mockPrismaService.passwordHistory.findMany.mockResolvedValue([
        { id: '1', passwordHash: 'old-hash-1' },
        { id: '2', passwordHash: 'old-hash-2' },
      ]);
      (bcrypt.compare as jest.Mock).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

      const result = await service.validatePasswordNotInHistory('user-id', 'reused-password');

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Cannot reuse any of your last 5 passwords');
    });

    it('should respect custom password history count', async () => {
      mockConfigService.get.mockImplementation((key: string, defaultValue?: number) => {
        if (key === 'PASSWORD_HISTORY_COUNT') return 10;
        return defaultValue;
      });
      mockPrismaService.passwordHistory.findMany.mockResolvedValue([]);

      await service.validatePasswordNotInHistory('user-id', 'new-password');

      expect(mockPrismaService.passwordHistory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 10 }),
      );
    });
  });

  describe('addPasswordToHistory', () => {
    it('should add password to history and not delete when under limit', async () => {
      const mockTx = {
        passwordHistory: {
          create: jest.fn().mockResolvedValue({ id: 'new-entry-id' }),
          findMany: jest.fn().mockResolvedValue([]),
          deleteMany: jest.fn(),
        },
      };
      mockPrismaService.$transaction.mockImplementation(async (callback: Function) => {
        return callback(mockTx);
      });

      await service.addPasswordToHistory('user-id', 'hashed-password');

      expect(mockTx.passwordHistory.create).toHaveBeenCalledWith({
        data: { userId: 'user-id', passwordHash: 'hashed-password' },
      });
      expect(mockTx.passwordHistory.deleteMany).not.toHaveBeenCalled();
    });

    it('should delete old entries when over limit', async () => {
      const oldEntries = [
        { id: 'old-entry-1' },
        { id: 'old-entry-2' },
      ];
      const mockTx = {
        passwordHistory: {
          create: jest.fn().mockResolvedValue({ id: 'new-entry-id' }),
          findMany: jest.fn().mockResolvedValue(oldEntries),
          deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
        },
      };
      mockPrismaService.$transaction.mockImplementation(async (callback: Function) => {
        return callback(mockTx);
      });

      await service.addPasswordToHistory('user-id', 'hashed-password');

      expect(mockTx.passwordHistory.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['old-entry-1', 'old-entry-2'] } },
      });
    });
  });

  describe('validatePasswordRotation', () => {
    it('should return invalid when rotation status cannot rotate', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(null);

      const result = await service.validatePasswordRotation('user-id', 'new-password');

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('User not found or no password set');
    });

    it('should return invalid when password is in history', async () => {
      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 30);

      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'user-id',
        email: 'test@example.com',
        password: 'hashed-password',
        createdAt: recentDate,
        passwordHistory: [],
      });
      mockPrismaService.passwordHistory.findMany.mockResolvedValue([
        { id: '1', passwordHash: 'old-hash' },
      ]);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      // Reset config mock to return default values
      mockConfigService.get.mockImplementation((key: string, defaultValue?: number) => {
        const config: Record<string, number> = {
          PASSWORD_EXPIRY_DAYS: 90,
          PASSWORD_HISTORY_COUNT: 5,
          PASSWORD_EXPIRY_WARNING_DAYS: 7,
        };
        return config[key] ?? defaultValue;
      });

      const result = await service.validatePasswordRotation('user-id', 'reused-password');

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Cannot reuse any of your last 5 passwords');
    });

    it('should return valid when all checks pass', async () => {
      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 30);

      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'user-id',
        email: 'test@example.com',
        password: 'hashed-password',
        createdAt: recentDate,
        passwordHistory: [],
      });
      mockPrismaService.passwordHistory.findMany.mockResolvedValue([]);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      const result = await service.validatePasswordRotation('user-id', 'new-password');

      expect(result.valid).toBe(true);
    });
  });

  describe('getPasswordHistory', () => {
    it('should return password history with default limit', async () => {
      const mockHistory = [
        { id: '1', userId: 'user-id', createdAt: new Date() },
        { id: '2', userId: 'user-id', createdAt: new Date() },
      ];
      mockPrismaService.passwordHistory.findMany.mockResolvedValue(mockHistory);

      const result = await service.getPasswordHistory('user-id');

      expect(result).toEqual(mockHistory);
      expect(mockPrismaService.passwordHistory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 10 }),
      );
    });

    it('should return password history with custom limit', async () => {
      const mockHistory = [{ id: '1', userId: 'user-id', createdAt: new Date() }];
      mockPrismaService.passwordHistory.findMany.mockResolvedValue(mockHistory);

      const result = await service.getPasswordHistory('user-id', 5);

      expect(result).toEqual(mockHistory);
      expect(mockPrismaService.passwordHistory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5 }),
      );
    });

    it('should select only required fields', async () => {
      mockPrismaService.passwordHistory.findMany.mockResolvedValue([]);

      await service.getPasswordHistory('user-id');

      expect(mockPrismaService.passwordHistory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: { id: true, userId: true, createdAt: true },
        }),
      );
    });
  });

  describe('clearPasswordHistory', () => {
    it('should delete all password history for user', async () => {
      mockPrismaService.passwordHistory.deleteMany.mockResolvedValue({ count: 5 });

      await service.clearPasswordHistory('user-id');

      expect(mockPrismaService.passwordHistory.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-id' },
      });
    });
  });

  describe('getUsersWithExpiredPasswords', () => {
    it('should return empty array when no users have expired passwords', async () => {
      const recentDate = new Date();
      mockPrismaService.user.findMany.mockResolvedValue([
        {
          id: 'user-1',
          email: 'user1@example.com',
          password: 'hash',
          createdAt: recentDate,
          passwordHistory: [],
        },
      ]);

      const result = await service.getUsersWithExpiredPasswords();

      expect(result).toEqual([]);
    });

    it('should return users with expired passwords', async () => {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 100);

      mockPrismaService.user.findMany.mockResolvedValue([
        {
          id: 'user-1',
          email: 'expired@example.com',
          password: 'hash',
          createdAt: oldDate,
          passwordHistory: [],
        },
      ]);

      const result = await service.getUsersWithExpiredPasswords();

      expect(result).toHaveLength(1);
      expect(result[0].userId).toBe('user-1');
      expect(result[0].email).toBe('expired@example.com');
      expect(result[0].daysExpired).toBe(10); // 100 - 90
    });

    it('should use password history date for expiry calculation', async () => {
      const createdDate = new Date();
      createdDate.setDate(createdDate.getDate() - 200);

      const passwordChangeDate = new Date();
      passwordChangeDate.setDate(passwordChangeDate.getDate() - 100);

      mockPrismaService.user.findMany.mockResolvedValue([
        {
          id: 'user-1',
          email: 'expired@example.com',
          password: 'hash',
          createdAt: createdDate,
          passwordHistory: [{ createdAt: passwordChangeDate }],
        },
      ]);

      const result = await service.getUsersWithExpiredPasswords();

      expect(result).toHaveLength(1);
      expect(result[0].daysExpired).toBe(10); // 100 - 90
    });

    it('should only include users with passwords', async () => {
      mockPrismaService.user.findMany.mockResolvedValue([]);

      await service.getUsersWithExpiredPasswords();

      expect(mockPrismaService.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { password: { not: null } },
        }),
      );
    });
  });

  describe('requiresPasswordRotation', () => {
    it('should return false when user not found', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(null);

      const result = await service.requiresPasswordRotation('user-id');

      expect(result).toBe(false);
    });

    it('should return false when user has no password', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'user-id',
        password: null,
        createdAt: new Date(),
        passwordHistory: [],
      });

      const result = await service.requiresPasswordRotation('user-id');

      expect(result).toBe(false);
    });

    it('should return true when password is expired', async () => {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 100);

      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'user-id',
        password: 'hashed-password',
        createdAt: oldDate,
        passwordHistory: [],
      });

      const result = await service.requiresPasswordRotation('user-id');

      expect(result).toBe(true);
    });

    it('should return true when within warning period', async () => {
      const warningPeriodDate = new Date();
      warningPeriodDate.setDate(warningPeriodDate.getDate() - 85); // 90 - 7 = 83, so 85 is within warning

      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'user-id',
        password: 'hashed-password',
        createdAt: warningPeriodDate,
        passwordHistory: [],
      });

      const result = await service.requiresPasswordRotation('user-id');

      expect(result).toBe(true);
    });

    it('should return false when not in warning period and not expired', async () => {
      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 30);

      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'user-id',
        password: 'hashed-password',
        createdAt: recentDate,
        passwordHistory: [],
      });

      const result = await service.requiresPasswordRotation('user-id');

      expect(result).toBe(false);
    });

    it('should use custom warning days from config', async () => {
      mockConfigService.get.mockImplementation((key: string, defaultValue?: number) => {
        if (key === 'PASSWORD_EXPIRY_WARNING_DAYS') return 14;
        if (key === 'PASSWORD_EXPIRY_DAYS') return 90;
        return defaultValue;
      });

      const borderlineDate = new Date();
      borderlineDate.setDate(borderlineDate.getDate() - 75); // 90 - 14 = 76, so 75 is just before warning

      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'user-id',
        password: 'hashed-password',
        createdAt: borderlineDate,
        passwordHistory: [],
      });

      const result = await service.requiresPasswordRotation('user-id');

      expect(result).toBe(false);
    });
  });
});
