import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { PrismaService } from '../database/prisma/prisma.service';
import { BackupMetadata, BackupStatus, StorageLocation, DocumentBackupConfig } from './backup.types';

const execAsync = promisify(exec);

/**
 * DocumentBackupService
 * Handles backup and replication of documents across multiple storage locations
 */
@Injectable()
export class DocumentBackupService {
  private readonly logger = new Logger(DocumentBackupService.name);
  private backupDir: string;
  private documentsDir: string;
  private backupMetadata: Map<string, BackupMetadata> = new Map();
  private config: DocumentBackupConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.backupDir = path.join(
      process.cwd(),
      this.configService.get('BACKUP_DIR') || 'backups/documents',
    );
    this.documentsDir = path.join(process.cwd(), 'uploads', 'documents');
    this.config = this.loadConfiguration();
    this.initializeBackupDirectory();
    this.loadBackupMetadata();
  }

  /**
   * Load backup configuration
   */
  private loadConfiguration(): DocumentBackupConfig {
    return {
      enabled: this.configService.get('DOCUMENT_BACKUP_ENABLED', true),
      backupPath: this.configService.get('DOCUMENT_BACKUP_PATH', this.backupDir),
      locations: this.parseStorageLocations(
        this.configService.get('DOCUMENT_BACKUP_LOCATIONS', 'LOCAL,AZURE_BLOB'),
      ),
      encryption: this.configService.get('DOCUMENT_BACKUP_ENCRYPTION', true),
      versioning: this.configService.get('DOCUMENT_BACKUP_VERSIONING', true),
      maxVersions: this.configService.get('DOCUMENT_BACKUP_MAX_VERSIONS', 10),
      schedule: this.configService.get('DOCUMENT_BACKUP_SCHEDULE', '0 3 * * *'), // Daily at 3 AM
    };
  }

  /**
   * Parse storage locations from comma-separated string
   */
  private parseStorageLocations(locations: string): StorageLocation[] {
    return locations.split(',').map((loc) => {
      const trimmed = loc.trim().toUpperCase();
      return (StorageLocation[trimmed] || StorageLocation.LOCAL) as StorageLocation;
    });
  }

  /**
   * Initialize backup directory structure
   */
  private async initializeBackupDirectory(): Promise<void> {
    const dirs = [
      this.backupDir,
      path.join(this.backupDir, 'snapshots'),
      path.join(this.backupDir, 'metadata'),
      path.join(this.backupDir, 'staging'),
      path.join(this.backupDir, 'verification'),
    ];

    for (const dir of dirs) {
      if (!fsSync.existsSync(dir)) {
        fsSync.mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * Load existing backup metadata
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
      this.logger.warn('Failed to load document backup metadata:', error);
    }
  }

  /**
   * Perform full document backup
   */
  async performDocumentBackup(tags?: Record<string, string>): Promise<BackupMetadata> {
    if (!this.config.enabled) {
      throw new Error('Document backup is disabled');
    }

    const backupId = `docs_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const metadata: BackupMetadata = {
      id: backupId,
      timestamp: new Date(),
      type: 'FULL' as any,
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
      this.logger.log(`Starting document backup: ${backupId}`);

      if (!fsSync.existsSync(this.documentsDir)) {
        this.logger.warn('Documents directory not found, skipping backup');
        return metadata;
      }

      // Create backup archive
      const backupPath = path.join(this.backupDir, 'snapshots', `${backupId}.tar.gz`);
      const stagingDir = path.join(this.backupDir, 'staging', backupId);

      await fs.mkdir(stagingDir, { recursive: true });

      // Copy documents to staging area
      await this.copyDocumentsToStaging(this.documentsDir, stagingDir);

      // Create manifest of backed up documents
      const manifest = await this.createBackupManifest(stagingDir, backupId);
      const manifestPath = path.join(stagingDir, 'MANIFEST.json');
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      // Create compressed archive
      await execAsync(`tar -czf ${backupPath} -C ${path.dirname(stagingDir)} ${backupId}`);

      // Calculate checksum
      metadata.checksum = await this.calculateChecksum(backupPath);

      // Get file size
      const stats = await fs.stat(backupPath);
      metadata.size = stats.size;

      // Encrypt if configured
      if (this.config.encryption) {
        await this.encryptBackup(backupPath);
      }

      // Replicate to multiple locations
      metadata.locations = await this.replicateDocumentBackup(backupPath);

      // Record document count and update metadata
      const documents = await this.prisma.document.count();
      metadata.verificationDetails = {
        tableCount: 1,
        recordCount: documents,
        integrityCheckPassed: true,
      };

      metadata.status = BackupStatus.COMPLETED;
      metadata.duration = Date.now() - startTime;

      // Save metadata
      await this.saveBackupMetadata(metadata);
      this.backupMetadata.set(metadata.id, metadata);

      // Cleanup staging
      await fs.rm(stagingDir, { recursive: true, force: true });

      this.logger.log(
        `Document backup completed: ${backupId} (${metadata.size} bytes, ${documents} documents)`,
      );

      return metadata;
    } catch (error) {
      this.logger.error(`Document backup failed: ${error.message}`, error.stack);
      metadata.status = BackupStatus.FAILED;
      metadata.error = error.message;
      await this.saveBackupMetadata(metadata);
      throw error;
    }
  }

  /**
   * Copy documents to staging area with version control
   */
  private async copyDocumentsToStaging(srcDir: string, dstDir: string): Promise<void> {
    const items = await fs.readdir(srcDir);

    for (const item of items) {
      const srcPath = path.join(srcDir, item);
      const dstPath = path.join(dstDir, item);

      const stats = await fs.stat(srcPath);

      if (stats.isDirectory()) {
        await fs.mkdir(dstPath, { recursive: true });
        await this.copyDocumentsToStaging(srcPath, dstPath);
      } else {
        // Skip temporary files
        if (!item.startsWith('.') && !item.includes('tmp')) {
          await fs.copyFile(srcPath, dstPath);
        }
      }
    }
  }

  /**
   * Create backup manifest with document checksums
   */
  private async createBackupManifest(
    dir: string,
    backupId: string,
  ): Promise<{
    backupId: string;
    timestamp: string;
    documents: Array<{
      path: string;
      checksum: string;
      size: number;
    }>;
  }> {
    const documents: Array<{ path: string; checksum: string; size: number }> = [];

    const walkDir = async (currentDir: string): Promise<void> => {
      const items = await fs.readdir(currentDir);

      for (const item of items) {
        if (item === 'MANIFEST.json') continue;

        const fullPath = path.join(currentDir, item);
        const relativePath = path.relative(dir, fullPath);
        const stats = await fs.stat(fullPath);

        if (stats.isDirectory()) {
          await walkDir(fullPath);
        } else {
          const checksum = await this.calculateChecksum(fullPath);
          documents.push({
            path: relativePath,
            checksum,
            size: stats.size,
          });
        }
      }
    };

    await walkDir(dir);

    return {
      backupId,
      timestamp: new Date().toISOString(),
      documents,
    };
  }

  /**
   * Encrypt backup file
   */
  private async encryptBackup(filePath: string): Promise<void> {
    const encryptionKey = this.configService.get<string>('BACKUP_ENCRYPTION_KEY');
    if (!encryptionKey) {
      throw new Error('Encryption key not configured');
    }

    const encryptedPath = `${filePath}.enc`;
    await execAsync(`openssl enc -aes-256-cbc -salt -in ${filePath} -out ${encryptedPath} -k ${encryptionKey}`);

    // Remove unencrypted file
    await fs.unlink(filePath);
    this.logger.log(`Backup encrypted: ${encryptedPath}`);
  }

  /**
   * Replicate document backup to multiple locations
   */
  private async replicateDocumentBackup(backupPath: string): Promise<StorageLocation[]> {
    const locations: StorageLocation[] = [StorageLocation.LOCAL];

    for (const location of this.config.locations) {
      try {
        if (location === StorageLocation.AWS_S3) {
          await this.copyToS3(backupPath);
          locations.push(StorageLocation.AWS_S3);
        } else if (location === StorageLocation.AZURE_BLOB) {
          await this.copyToAzure(backupPath);
          locations.push(StorageLocation.AZURE_BLOB);
        } else if (location === StorageLocation.GCP_STORAGE) {
          await this.copyToGCP(backupPath);
          locations.push(StorageLocation.GCP_STORAGE);
        }
      } catch (error) {
        this.logger.warn(`Failed to replicate document backup to ${location}: ${error.message}`);
      }
    }

    return locations;
  }

  /**
   * Copy to AWS S3
   */
  private async copyToS3(backupPath: string): Promise<void> {
    const bucket = this.configService.get<string>('AWS_BACKUP_BUCKET');
    const region = this.configService.get<string>('AWS_REGION');

    if (!bucket) throw new Error('AWS S3 bucket not configured');

    const fileName = path.basename(backupPath);
    const s3Path = `document-backups/${new Date().getFullYear()}/${new Date().getMonth() + 1}/${fileName}`;

    await execAsync(`aws s3 cp ${backupPath} s3://${bucket}/${s3Path} --region ${region} --sse AES256`);
  }

  /**
   * Copy to Azure Blob Storage
   */
  private async copyToAzure(backupPath: string): Promise<void> {
    const container = this.configService.get<string>('AZURE_BACKUP_CONTAINER');
    const account = this.configService.get<string>('AZURE_STORAGE_ACCOUNT');

    if (!container || !account) throw new Error('Azure Blob Storage not configured');

    const fileName = path.basename(backupPath);
    const blobName = `document-backups/${new Date().getFullYear()}/${new Date().getMonth() + 1}/${fileName}`;

    await execAsync(
      `az storage blob upload --account-name ${account} --container-name ${container} --name ${blobName} --file ${backupPath}`,
    );
  }

  /**
   * Copy to GCP Cloud Storage
   */
  private async copyToGCP(backupPath: string): Promise<void> {
    const bucket = this.configService.get<string>('GCP_BACKUP_BUCKET');

    if (!bucket) throw new Error('GCP Cloud Storage bucket not configured');

    const fileName = path.basename(backupPath);
    const gcpPath = `document-backups/${new Date().getFullYear()}/${new Date().getMonth() + 1}/${fileName}`;

    await execAsync(`gsutil -m cp ${backupPath} gs://${bucket}/${gcpPath}`);
  }

  /**
   * Schedule document backup
   */
  @Cron('0 3 * * *')
  async scheduledDocumentBackup(): Promise<void> {
    try {
      if (this.config.enabled) {
        await this.performDocumentBackup({ type: 'scheduled', frequency: 'daily' });
      }
    } catch (error) {
      this.logger.error('Scheduled document backup failed:', error);
    }
  }

  /**
   * Save backup metadata
   */
  private async saveBackupMetadata(metadata: BackupMetadata): Promise<void> {
    const metadataPath = path.join(this.backupDir, 'metadata', `${metadata.id}.json`);
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
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
   * Calculate retention date
   */
  private calculateRetentionDate(days: number): Date {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return date;
  }

  /**
   * List document backups
   */
  async listDocumentBackups(limit: number = 50, offset: number = 0): Promise<BackupMetadata[]> {
    const backups = Array.from(this.backupMetadata.values()).sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
    );

    return backups.slice(offset, offset + limit);
  }

  /**
   * Verify backup integrity
   */
  async verifyDocumentBackup(backupId: string): Promise<boolean> {
    const metadata = this.backupMetadata.get(backupId);
    if (!metadata) {
      throw new Error(`Backup not found: ${backupId}`);
    }

    try {
      const backupPath = path.join(this.backupDir, 'snapshots', `${backupId}.tar.gz`);

      if (!fsSync.existsSync(backupPath)) {
        throw new Error(`Backup file not found: ${backupPath}`);
      }

      // Verify checksum
      const currentChecksum = await this.calculateChecksum(backupPath);
      if (currentChecksum !== metadata.checksum) {
        throw new Error('Checksum mismatch - backup may be corrupted');
      }

      // Extract and verify manifest
      const extractDir = path.join(this.backupDir, 'verification', backupId);
      await fs.mkdir(extractDir, { recursive: true });

      await execAsync(`tar -xzf ${backupPath} -C ${extractDir}`);

      const manifestPath = path.join(extractDir, backupId, 'MANIFEST.json');
      if (!fsSync.existsSync(manifestPath)) {
        throw new Error('Manifest file not found in backup');
      }

      const manifest = JSON.parse(
        fsSync.readFileSync(manifestPath, 'utf-8'),
      );

      // Verify all files in manifest
      let validFiles = 0;
      for (const doc of manifest.documents) {
        const docPath = path.join(extractDir, backupId, doc.path);
        if (fsSync.existsSync(docPath)) {
          const checksum = await this.calculateChecksum(docPath);
          if (checksum === doc.checksum) {
            validFiles++;
          }
        }
      }

      // Cleanup
      await fs.rm(extractDir, { recursive: true, force: true });

      metadata.verified = true;
      metadata.verificationTimestamp = new Date();
      await this.saveBackupMetadata(metadata);

      this.logger.log(
        `Document backup verified: ${backupId} (${validFiles}/${manifest.documents.length} files valid)`,
      );

      return validFiles === manifest.documents.length;
    } catch (error) {
      this.logger.error(`Verification failed for backup ${backupId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get backup statistics
   */
  async getDocumentBackupStatistics() {
    const backups = Array.from(this.backupMetadata.values());

    return {
      totalBackups: backups.length,
      totalSize: backups.reduce((sum, b) => sum + b.size, 0),
      verifiedBackups: backups.filter((b) => b.verified).length,
      failedBackups: backups.filter((b) => b.status === BackupStatus.FAILED).length,
      averageDuration: Math.round(backups.reduce((sum, b) => sum + b.duration, 0) / backups.length || 0),
      locations: [...new Set(backups.flatMap((b) => b.locations))],
    };
  }
}
