/**
 * Backup and Disaster Recovery Types
 * Defines core types for backup operations
 */

export enum BackupType {
  FULL = 'FULL',
  INCREMENTAL = 'INCREMENTAL',
  DIFFERENTIAL = 'DIFFERENTIAL',
  SNAPSHOT = 'SNAPSHOT',
}

export enum BackupStatus {
  PENDING = 'PENDING',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  VERIFIED = 'VERIFIED',
  ARCHIVED = 'ARCHIVED',
}

export enum StorageLocation {
  LOCAL = 'LOCAL',
  AWS_S3 = 'AWS_S3',
  AZURE_BLOB = 'AZURE_BLOB',
  GCP_STORAGE = 'GCP_STORAGE',
  BACKUP_REGION_1 = 'BACKUP_REGION_1',
  BACKUP_REGION_2 = 'BACKUP_REGION_2',
}

export enum RecoveryPoint {
  RPO_1_HOUR = '1h',
  RPO_4_HOURS = '4h',
  RPO_24_HOURS = '24h',
  RPO_WEEKLY = 'weekly',
  RPO_MONTHLY = 'monthly',
}

export enum RTO {
  RTO_15_MINUTES = '15m',
  RTO_1_HOUR = '1h',
  RTO_4_HOURS = '4h',
  RTO_24_HOURS = '24h',
}

export interface BackupConfiguration {
  enabled: boolean;
  backupType: BackupType;
  schedule: string; // Cron expression
  retention: {
    days: number;
    weeks: number;
    months: number;
    years: number;
  };
  locations: StorageLocation[];
  encryption: boolean;
  compression: boolean;
  verification: boolean;
  replication: {
    enabled: boolean;
    regions: string[];
    syncInterval: number; // milliseconds
  };
}

export interface BackupMetadata {
  id: string;
  timestamp: Date;
  type: BackupType;
  status: BackupStatus;
  size: number;
  duration: number; // milliseconds
  checksum: string;
  locations: StorageLocation[];
  retentionUntil: Date;
  verified: boolean;
  verificationTimestamp?: Date;
  verificationDetails?: {
    tableCount: number;
    recordCount: number;
    integrityCheckPassed: boolean;
  };
  error?: string;
  tags?: Record<string, string>;
}

export interface PointInTimeRecovery {
  backupId: string;
  targetTimestamp: Date;
  recoveryWindow: {
    start: Date;
    end: Date;
  };
  dataConsistency: boolean;
  transactionLogs?: string[];
}

export interface DisasterRecoveryPlan {
  id: string;
  name: string;
  rpo: RecoveryPoint;
  rto: RTO;
  failoverRegions: string[];
  healthCheckInterval: number;
  automaticFailover: boolean;
  notificationChannels: string[];
  testInterval: number; // milliseconds
  lastTest?: Date;
  lastTestResult?: boolean;
}

export interface BackupIntegrityCheck {
  backupId: string;
  checksum: string;
  fileSize: number;
  accessible: boolean;
  restorable: boolean;
  tableIntegrity: {
    totalTables: number;
    validTables: number;
    errors: string[];
  };
  lastVerified: Date;
}

export interface DocumentBackupConfig {
  enabled: boolean;
  backupPath: string;
  locations: StorageLocation[];
  encryption: boolean;
  versioning: boolean;
  maxVersions: number;
  schedule: string; // Cron expression
}

export interface BackupAlert {
  id: string;
  type: 'BACKUP_FAILED' | 'BACKUP_TIMEOUT' | 'STORAGE_FULL' | 'REPLICATION_FAILED' | 'VERIFICATION_FAILED';
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  message: string;
  timestamp: Date;
  resolved: boolean;
  acknowledgement?: {
    acknowledgedBy: string;
    acknowledgedAt: Date;
  };
}

export interface RecoveryTestResult {
  id: string;
  backupId: string;
  startTime: Date;
  endTime: Date;
  duration: number;
  success: boolean;
  targetEnvironment: string;
  dataValidation: {
    tablesVerified: number;
    recordsVerified: number;
    errors: string[];
  };
  notes?: string;
}
