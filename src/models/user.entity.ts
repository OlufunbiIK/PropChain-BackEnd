// User entity type definitions
// These are local type definitions that match the Prisma schema

export type UserRole = 'USER' | 'ADMIN' | 'AGENT';

export interface User {
  id: string;
  email: string;
  walletAddress: string | null;
  role: UserRole;
  roleId: string | null;
  password: string | null;
  isVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
  bio: string | null;
  location: string | null;
  avatarUrl: string | null;

  // Preferences and privacy
  preferences: Record<string, unknown> | null;
  privacySettings: Record<string, unknown> | null;
  exportRequestedAt: Date | null;

  // Relationships
  followers?: unknown[];
  following?: unknown[];

  // Activity
  activities?: UserActivity[];
}

/**
 * Input used when creating a user
 * Flexible enough for email/password and Web3 users
 */
export type CreateUserInput = {
  email: string;
  password?: string;
  walletAddress?: string;
  role?: UserRole;
  roleId?: string;
};

export type UpdateUserInput = Partial<CreateUserInput>;

export type PrismaUser = User;

// User activity entity
export class UserActivity {
  id: string;
  userId: string;
  action: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}