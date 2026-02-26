import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { PrismaService } from '../database/prisma/prisma.service';
import {
  BackupMetadata,
  BackupStatus,
  BackupType,
  StorageLocation,
  BackupConfiguration,
  PointInTimeRecovery,
} from './backup.types';

const execAsync = promisify(exec);

/**
 * DatabaseBackupService
 * Handles automated database backups with point-in-time recovery capabilities
 */
@Injectable()
export class DatabaseBackupService {
  private readonly logger = new Logger(DatabaseBackupService.name);
  private backupDir: string;
  private backupMetadata: Map<string, BackupMetadata> = new Map();
  private isBackupRunning = false;
  private readonly maxConcurrentBackups = 1;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.backupDir = path.join(
      process.cwd(),
      this.configService.get('BACKUP_DIR') || 'backups/database',
    );
    this.initializeBackupDirectory();
    this.loadBackupMetadata();
  }

  /**
   * Initialize backup directory structure
   */
  private async initializeBackupDirectory(): Promise<void> {
    const dirs = [
      this.backupDir,
      path.join(this.backupDir, 'full'),
      path.join(this.backupDir, 'incremental'),
      path.join(this.backupDir, 'snapshots'),
      path.join(this.backupDir, 'metadata'),
      path.join(this.backupDir, 'logs'),
    ];

    for (const dir of dirs) {
      if (!fsSync.existsSync(dir)) {
        fsSync.mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * Load existing backup metadata from disk
   */
  private loadBackupMetadata(): void {
    try {
      const metadataDir = path.join(this.backupDir, 'metadata');
      if (fsSync.existsSync(metadataDir)) {
        const files = fsSync.readdirSync(metadataDir);
        files.forEach((file) => {
          const content = fsSync.readFileSync(path.join(metadataDir, file), 'utf-8');
          const metadata: BackupMetadata = JSON.parse(content);
          this.backupMetadata.set(metadata.id, metadata);
        });
      }
    } catch (error) {
      this.logger.warn('Failed to load backup metadata:', error);
    }
  }

  /**
   * Perform full database backup
   * @param tags Optional tags for backup identification
   */
  async performFullBackup(tags?: Record<string, string>): Promise<BackupMetadata> {
    if (this.isBackupRunning) {
      throw new Error('Another backup is already in progress');
    }

    this.isBackupRunning = true;
    const backupId = `full_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const metadata: BackupMetadata = {
      id: backupId,
      timestamp: new Date(),
      type: BackupType.FULL,
      status: BackupStatus.IN_PROGRESS,
      size: 0,
      duration: 0,
      checksum: '',
      locations: [],
      retentionUntil: this.calculateRetentionDate(30),
      verified: false,
      tags,
    };

    try {
      const startTime = Date.now();
      this.logger.log(`Starting full database backup: ${backupId}`);

      // Get database URL
      const databaseUrl = this.configService.get<string>('DATABASE_URL');
      if (!databaseUrl) {
        throw new Error('DATABASE_URL not configured');
      }

      // Create backup dumps
      const backupPath = path.join(this.backupDir, 'full', backupId);
      await this.createDatabaseDumps(databaseUrl, backupPath);

      // Calculate checksum
      const dumpFile = `${backupPath}.dump`;
      metadata.checksum = await this.calculateChecksum(dumpFile);

      // Get file size
      const stats = await fs.stat(dumpFile);
      metadata.size = stats.size;

      // Compress backup
      await this.compressBackup(dumpFile);

      // Store in multiple locations
      metadata.locations = await this.replicateBackup(backupPath);

      // Update metadata
      metadata.status = BackupStatus.COMPLETED;
      metadata.duration = Date.now() - startTime;

      // Save metadata
      await this.saveBackupMetadata(metadata);
      this.backupMetadata.set(metadata.id, metadata);

      this.logger.log(`Full backup completed: ${backupId} (${metadata.size} bytes in ${metadata.duration}ms)`);

      return metadata;
    } catch (error) {
      this.logger.error(`Full backup failed: ${error.message}`, error.stack);
      metadata.status = BackupStatus.FAILED;
      metadata.error = error.message;
      await this.saveBackupMetadata(metadata);
      throw error;
    } finally {
      this.isBackupRunning = false;
    }
  }

  /**
   * Perform incremental backup
   */
  async performIncrementalBackup(): Promise<BackupMetadata> {
    if (this.isBackupRunning) {
      throw new Error('Another backup is already in progress');
    }

    this.isBackupRunning = true;
    const backupId = `incr_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const metadata: BackupMetadata = {
      id: backupId,
      timestamp: new Date(),
      type: BackupType.INCREMENTAL,
      status: BackupStatus.IN_PROGRESS,
      size: 0,
      duration: 0,
      checksum: '',
      locations: [],
      retentionUntil: this.calculateRetentionDate(7),
      verified: false,
    };

    try {
      const startTime = Date.now();
      const databaseUrl = this.configService.get<string>('DATABASE_URL');

      // Create WAL-based incremental backup
      const backupPath = path.join(this.backupDir, 'incremental', backupId);
      await fs.mkdir(path.dirname(backupPath), { recursive: true });

      // Execute incremental backup command
      await execAsync(`
        pg_basebackup -D ${backupPath} -Ft -z -P -l "incremental_${backupId}"
      `, { env: { ...process.env, PGPASSWORD: this.extractPassword(databaseUrl) } });

      const stats = await fs.stat(backupPath);
      metadata.size = stats.size;
      metadata.checksum = await this.calculateChecksum(backupPath);
      metadata.locations = await this.replicateBackup(backupPath);
      metadata.status = BackupStatus.COMPLETED;
      metadata.duration = Date.now() - startTime;

      await this.saveBackupMetadata(metadata);
      this.backupMetadata.set(metadata.id, metadata);

      return metadata;
    } catch (error) {
      this.logger.error(`Incremental backup failed: ${error.message}`);
      metadata.status = BackupStatus.FAILED;
      metadata.error = error.message;
      await this.saveBackupMetadata(metadata);
      throw error;
    } finally {
      this.isBackupRunning = false;
    }
  }

  /**
   * Create database dumps (binary, schema, and data-only)
   */
  private async createDatabaseDumps(databaseUrl: string, backupPath: string): Promise<void> {
    const { host, port, user, password, database } = this.parseDatabaseUrl(databaseUrl);

    await fs.mkdir(path.dirname(backupPath), { recursive: true });

    const env = { ...process.env, PGPASSWORD: password };

    // Custom format dump (most reliable for restore)
    await execAsync(
      `pg_dump -h ${host} -p ${port} -U ${user} -d ${database} -F c -b -v -f ${backupPath}.dump`,
      { env },
    );

    // Schema only (for documentation)
    await execAsync(
      `pg_dump -h ${host} -p ${port} -U ${user} -d ${database} --schema-only -f ${backupPath}_schema.sql`,
      { env },
    );

    // Data only (for reference)
    await execAsync(
      `pg_dump -h ${host} -p ${port} -U ${user} -d ${database} --data-only -f ${backupPath}_data.sql`,
      { env },
    );
  }

  /**
   * Compress a backup file
   */
  private async compressBackup(filePath: string): Promise<void> {
    const gzipFile = `${filePath}.gz`;
    if (fsSync.existsSync(filePath)) {
      await execAsync(`gzip -k "${filePath}"`);
      this.logger.log(`Compressed backup: ${gzipFile}`);
    }
  }

  /**
   * Calculate file checksum
   */
  private async calculateChecksum(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fsSync.createReadStream(filePath);

      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  /**
   * Replicate backup to multiple storage locations
   */
  private async replicateBackup(backupPath: string): Promise<StorageLocation[]> {
    const locations: StorageLocation[] = [StorageLocation.LOCAL];
    const storageLocations = this.configService.get<string>('BACKUP_STORAGE_LOCATIONS')?.split(',') || [];

    for (const location of storageLocations) {
      try {
        if (location === 'S3') {
          await this.copyToS3(backupPath);
          locations.push(StorageLocation.AWS_S3);
        } else if (location === 'AZURE') {
          await this.copyToAzure(backupPath);
          locations.push(StorageLocation.AZURE_BLOB);
        }
      } catch (error) {
        this.logger.warn(`Failed to replicate backup to ${location}: ${error.message}`);
      }
    }

    return locations;
  }

  /**
   * Copy backup to AWS S3
   */
  private async copyToS3(backupPath: string): Promise<void> {
    const s3Bucket = this.configService.get<string>('AWS_BACKUP_BUCKET');
    const awsRegion = this.configService.get<string>('AWS_REGION');

    if (!s3Bucket || !awsRegion) {
      throw new Error('AWS S3 configuration incomplete');
    }

    const fileName = path.basename(backupPath);
    const s3Path = `database-backups/${new Date().getFullYear()}/${new Date().getMonth() + 1}/${fileName}`;

    await execAsync(`aws s3 cp ${backupPath} s3://${s3Bucket}/${s3Path} --region ${awsRegion} --sse AES256`);
  }

  /**
   * Copy backup to Azure Blob Storage
   */
  private async copyToAzure(backupPath: string): Promise<void> {
    const azureContainer = this.configService.get<string>('AZURE_BACKUP_CONTAINER');
    const azureAccount = this.configService.get<string>('AZURE_STORAGE_ACCOUNT');

    if (!azureContainer || !azureAccount) {
      throw new Error('Azure Blob Storage configuration incomplete');
    }

    const fileName = path.basename(backupPath);
    const blobName = `database-backups/${new Date().getFullYear()}/${new Date().getMonth() + 1}/${fileName}`;

    await execAsync(
      `az storage blob upload --account-name ${azureAccount} --container-name ${azureContainer} --name ${blobName} --file ${backupPath}`,
    );
  }

  /**
   * Schedule full backup daily at 2 AM
   */
  @Cron('0 2 * * *')
  async scheduledFullBackup(): Promise<void> {
    try {
      await this.performFullBackup({ type: 'scheduled', frequency: 'daily' });
    } catch (error) {
      this.logger.error('Scheduled full backup failed:', error);
    }
  }

  /**
   * Schedule incremental backup every 6 hours
   */
  @Cron('0 */6 * * *')
  async scheduledIncrementalBackup(): Promise<void> {
    try {
      await this.performIncrementalBackup();
    } catch (error) {
      this.logger.error('Scheduled incremental backup failed:', error);
    }
  }

  /**
   * Save backup metadata to disk
   */
  private async saveBackupMetadata(metadata: BackupMetadata): Promise<void> {
    const metadataPath = path.join(this.backupDir, 'metadata', `${metadata.id}.json`);
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
  }

  /**
   * Get backup by ID
   */
  async getBackup(backupId: string): Promise<BackupMetadata | null> {
    return this.backupMetadata.get(backupId) || null;
  }

  /**
   * List all backups with filters
   */
  async listBackups(filters?: {
    type?: BackupType;
    status?: BackupStatus;
    limit?: number;
    offset?: number;
  }): Promise<BackupMetadata[]> {
    let backups = Array.from(this.backupMetadata.values());

    if (filters?.type) {
      backups = backups.filter((b) => b.type === filters.type);
    }

    if (filters?.status) {
      backups = backups.filter((b) => b.status === filters.status);
    }

    backups.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    const limit = filters?.limit || 50;
    const offset = filters?.offset || 0;

    return backups.slice(offset, offset + limit);
  }

  /**
   * Get point-in-time recovery information
   */
  async getPointInTimeRecovery(targetTimestamp: Date): Promise<PointInTimeRecovery> {
    // Find the most recent backup before target timestamp
    const backups = Array.from(this.backupMetadata.values())
      .filter((b) => b.timestamp <= targetTimestamp && b.status === BackupStatus.VERIFIED)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    if (backups.length === 0) {
      throw new Error('No suitable backup found for point-in-time recovery');
    }

    const baseBackup = backups[0];

    return {
      backupId: baseBackup.id,
      targetTimestamp,
      recoveryWindow: {
        start: baseBackup.timestamp,
        end: targetTimestamp,
      },
      dataConsistency: true,
      transactionLogs: await this.getTransactionLogs(baseBackup.timestamp, targetTimestamp),
    };
  }

  /**
   * Get transaction logs between two timestamps
   */
  private async getTransactionLogs(start: Date, end: Date): Promise<string[]> {
    const logsDir = path.join(this.backupDir, 'logs');
    if (!fsSync.existsSync(logsDir)) {
      return [];
    }

    const files = fsSync.readdirSync(logsDir);
    return files.filter((f) => {
      const stats = fsSync.statSync(path.join(logsDir, f));
      return stats.mtime >= start && stats.mtime <= end;
    });
  }

  /**
   * Calculate retention date based on days
   */
  private calculateRetentionDate(days: number): Date {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return date;
  }

  /**
   * Parse database URL
   */
  private parseDatabaseUrl(url: string) {
    const regex =
      /postgresql:\/\/(.*?):(.*?)@(.*?):(\d+)\/(.*?)(\?|$)/;
    const match = url.match(regex);

    if (!match) {
      throw new Error('Invalid database URL format');
    }

    return {
      user: match[1],
      password: match[2],
      host: match[3],
      port: match[4],
      database: match[5],
    };
  }

  /**
   * Extract password from database URL
   */
  private extractPassword(url: string): string {
    const match = url.match(/:(.*?)@/);
    return match ? match[1] : '';
  }

  /**
   * Get backup statistics
   */
  async getBackupStatistics() {
    const backups = Array.from(this.backupMetadata.values());

    return {
      totalBackups: backups.length,
      totalSize: backups.reduce((sum, b) => sum + b.size, 0),
      byType: {
        full: backups.filter((b) => b.type === BackupType.FULL).length,
        incremental: backups.filter((b) => b.type === BackupType.INCREMENTAL).length,
      },
      byStatus: {
        completed: backups.filter((b) => b.status === BackupStatus.COMPLETED).length,
        verified: backups.filter((b) => b.status === BackupStatus.VERIFIED).length,
        failed: backups.filter((b) => b.status === BackupStatus.FAILED).length,
      },
      averageDuration: Math.round(backups.reduce((sum, b) => sum + b.duration, 0) / backups.length),
    };
  }
}
