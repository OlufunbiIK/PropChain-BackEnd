import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { BackupIntegrityCheck, BackupMetadata, BackupStatus } from './backup.types';

/**
 * BackupVerificationService
 * Performs integrity checks on backups and manages retention policies
 */
@Injectable()
export class BackupVerificationService {
  private readonly logger = new Logger(BackupVerificationService.name);
  private backupDir: string;
  private verificationResults: Map<string, BackupIntegrityCheck> = new Map();

  constructor(private readonly configService: ConfigService) {
    this.backupDir = path.join(process.cwd(), 'backups');
  }

  /**
   * Schedule automated backup verification weekly
   */
  @Cron('0 4 * * 0')
  async scheduleBackupVerification(): Promise<void> {
    try {
      this.logger.log('Starting scheduled backup verification');
      await this.verifyAllBackups();
    } catch (error) {
      this.logger.error('Scheduled backup verification failed:', error);
    }
  }

  /**
   * Verify all backups
   */
  async verifyAllBackups(): Promise<BackupIntegrityCheck[]> {
    const backupMetadataDir = path.join(this.backupDir, 'database', 'metadata');

    if (!fsSync.existsSync(backupMetadataDir)) {
      this.logger.warn('Backup metadata directory not found');
      return [];
    }

    const metadataFiles = fsSync.readdirSync(backupMetadataDir);
    const results: BackupIntegrityCheck[] = [];

    for (const file of metadataFiles) {
      try {
        const content = fsSync.readFileSync(path.join(backupMetadataDir, file), 'utf-8');
        const metadata: BackupMetadata = JSON.parse(content);

        if (
          metadata.status === BackupStatus.COMPLETED &&
          (!metadata.verified ||
            !metadata.verificationTimestamp ||
            Date.now() - new Date(metadata.verificationTimestamp).getTime() > 604800000)
        ) {
          // Verify if not verified or older than 7 days
          const result = await this.verifyBackup(metadata.id);
          results.push(result);
        }
      } catch (error) {
        this.logger.warn(`Failed to verify backup from file ${file}:`, error);
      }
    }

    return results;
  }

  /**
   * Verify individual backup integrity
   */
  async verifyBackup(backupId: string): Promise<BackupIntegrityCheck> {
    this.logger.log(`Starting verification for backup: ${backupId}`);

    const check: BackupIntegrityCheck = {
      backupId,
      checksum: '',
      fileSize: 0,
      accessible: false,
      restorable: false,
      tableIntegrity: {
        totalTables: 0,
        validTables: 0,
        errors: [],
      },
      lastVerified: new Date(),
    };

    try {
      // Find backup file
      const backupPath = await this.findBackupFile(backupId);

      if (!backupPath) {
        check.tableIntegrity.errors.push('Backup file not found');
        this.verificationResults.set(backupId, check);
        return check;
      }

      check.accessible = true;

      // Verify file integrity
      await this.verifyFileIntegrity(backupPath, check);

      // Verify content structure
      await this.verifyBackupStructure(backupPath, check);

      // Check restorability
      check.restorable = check.tableIntegrity.errors.length === 0 && check.accessible;

      this.verificationResults.set(backupId, check);
      await this.saveVerificationResult(check);

      this.logger.log(`Backup verification completed: ${backupId} - ${check.restorable ? 'PASSED' : 'FAILED'}`);
    } catch (error) {
      check.tableIntegrity.errors.push(error.message);
      this.logger.error(`Backup verification failed: ${error.message}`);
    }

    return check;
  }

  /**
   * Find backup file
   */
  private async findBackupFile(backupId: string): Promise<string | null> {
    const locations = [
      path.join(this.backupDir, 'database', 'full', `${backupId}.dump`),
      path.join(this.backupDir, 'database', 'full', `${backupId}.dump.gz`),
      path.join(this.backupDir, 'database', 'incremental', backupId),
      path.join(this.backupDir, 'documents', 'snapshots', `${backupId}.tar.gz`),
      path.join(this.backupDir, 'documents', 'snapshots', `${backupId}.tar.gz.enc`),
    ];

    for (const location of locations) {
      if (fsSync.existsSync(location)) {
        return location;
      }
    }

    return null;
  }

  /**
   * Verify file integrity
   */
  private async verifyFileIntegrity(filePath: string, check: BackupIntegrityCheck): Promise<void> {
    const stats = await fs.stat(filePath);
    check.fileSize = stats.size;

    // Check file is not empty
    if (stats.size === 0) {
      check.tableIntegrity.errors.push('Backup file is empty');
      return;
    }

    // Calculate checksum
    check.checksum = await this.calculateChecksum(filePath);

    // Verify file is readable
    try {
      await fs.access(filePath, fsSync.constants.R_OK);
    } catch {
      check.tableIntegrity.errors.push('Backup file is not readable');
    }
  }

  /**
   * Verify backup structure and content
   */
  private async verifyBackupStructure(filePath: string, check: BackupIntegrityCheck): Promise<void> {
    try {
      if (filePath.endsWith('.dump') || filePath.endsWith('.dump.gz')) {
        // Verify PostgreSQL dump file structure
        await this.verifyPostgresBackup(filePath, check);
      } else if (filePath.endsWith('.tar.gz') || filePath.endsWith('.tar.gz.enc')) {
        // Verify tar archive structure
        await this.verifyTarBackup(filePath, check);
      }
    } catch (error) {
      check.tableIntegrity.errors.push(`Structure verification failed: ${error.message}`);
    }
  }

  /**
   * Verify PostgreSQL backup
   */
  private async verifyPostgresBackup(filePath: string, check: BackupIntegrityCheck): Promise<void> {
    // Check if file can be read as valid PostgreSQL backup
    try {
      const buffer = Buffer.alloc(8);
      const fd = fsSync.openSync(filePath, 'r');
      fsSync.readSync(fd, buffer, 0, 8);
      fsSync.closeSync(fd);

      // Check for PostgreSQL dump signature
      const header = buffer.toString('utf-8', 0, 4);
      if (header !== 'PGDM' && !filePath.endsWith('.gz')) {
        check.tableIntegrity.errors.push('Invalid PostgreSQL backup header');
      } else {
        check.tableIntegrity.validTables = 1; // Can verify more granularly with actual restore test
        check.tableIntegrity.totalTables = 1;
      }
    } catch (error) {
      check.tableIntegrity.errors.push(`PostgreSQL backup verification failed: ${error.message}`);
    }
  }

  /**
   * Verify tar archive backup
   */
  private async verifyTarBackup(filePath: string, check: BackupIntegrityCheck): Promise<void> {
    try {
      // Try to list tar contents to verify integrity
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);

      const command = filePath.endsWith('.gz') ? `tar -tzf` : `tar -tf`;

      const { stdout } = await execAsync(`${command} ${filePath} | head -20`);

      const files = stdout.trim().split('\n').filter((f: string) => f.length > 0);

      if (files.length === 0) {
        check.tableIntegrity.errors.push('Tar archive appears empty');
      } else {
        check.tableIntegrity.totalTables = 1;
        check.tableIntegrity.validTables = 1;
      }

      // Check for manifest file
      const hasManifest = files.some((f: string) => f.includes('MANIFEST.json'));
      if (!hasManifest) {
        check.tableIntegrity.errors.push('No manifest file found in archive');
      }
    } catch (error) {
      check.tableIntegrity.errors.push(`Tar archive verification failed: ${error.message}`);
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
   * Save verification result
   */
  private async saveVerificationResult(result: BackupIntegrityCheck): Promise<void> {
    const verificationDir = path.join(this.backupDir, 'verification');

    if (!fsSync.existsSync(verificationDir)) {
      fsSync.mkdirSync(verificationDir, { recursive: true });
    }

    await fs.writeFile(
      path.join(verificationDir, `${result.backupId}_verification.json`),
      JSON.stringify(result, null, 2),
    );
  }

  /**
   * Get verification result
   */
  async getVerificationResult(backupId: string): Promise<BackupIntegrityCheck | null> {
    const result = this.verificationResults.get(backupId);

    if (result) {
      return result;
    }

    // Try to load from disk
    const verificationPath = path.join(
      this.backupDir,
      'verification',
      `${backupId}_verification.json`,
    );

    if (fsSync.existsSync(verificationPath)) {
      const content = fsSync.readFileSync(verificationPath, 'utf-8');
      return JSON.parse(content);
    }

    return null;
  }

  /**
   * Schedule retention policy enforcement daily at 1 AM
   */
  @Cron('0 1 * * *')
  async scheduleRetentionPolicyEnforcement(): Promise<void> {
    try {
      await this.enforceRetentionPolicies();
    } catch (error) {
      this.logger.error('Retention policy enforcement failed:', error);
    }
  }

  /**
   * Enforce retention policies - delete old backups
   */
  async enforceRetentionPolicies(): Promise<{ deleted: number; archived: number }> {
    this.logger.log('Enforcing backup retention policies');

    let deleted = 0;
    let archived = 0;

    try {
      const backupMetadataDir = path.join(this.backupDir, 'database', 'metadata');

      if (!fsSync.existsSync(backupMetadataDir)) {
        return { deleted, archived };
      }

      const metadataFiles = fsSync.readdirSync(backupMetadataDir);

      for (const file of metadataFiles) {
        const content = fsSync.readFileSync(path.join(backupMetadataDir, file), 'utf-8');
        const metadata: BackupMetadata = JSON.parse(content);

        const isExpired = new Date() > new Date(metadata.retentionUntil);

        if (isExpired) {
          const archiveAge = this.calculateArchiveAge(metadata);

          if (archiveAge > 365) {
            // Archive after 1 year
            await this.archiveBackup(metadata);
            archived++;
          } else if (archiveAge > 90) {
            // Delete after 90 days
            await this.deleteBackup(metadata);
            deleted++;
          }
        }
      }

      // Clean up deprecated formats
      const deprecated = await this.removeDeprecatedBackupFormats();
      deleted += deprecated;

      this.logger.log(`Retention policies enforced: ${deleted} deleted, ${archived} archived`);
    } catch (error) {
      this.logger.error('Retention policy enforcement error:', error);
    }

    return { deleted, archived };
  }

  /**
   * Calculate archive age in days
   */
  private calculateArchiveAge(metadata: BackupMetadata): number {
    const now = new Date();
    const timestamp = new Date(metadata.timestamp);
    const diffMillis = now.getTime() - timestamp.getTime();
    return Math.floor(diffMillis / (1000 * 60 * 60 * 24));
  }

  /**
   * Archive backup to cold storage
   */
  private async archiveBackup(metadata: BackupMetadata): Promise<void> {
    this.logger.log(`Archiving backup: ${metadata.id}`);

    try {
      const backupPath = await this.findBackupFile(metadata.id);

      if (!backupPath) {
        this.logger.warn(`Backup file not found for archiving: ${metadata.id}`);
        return;
      }

      const archiveDir = path.join(this.backupDir, 'archive', metadata.timestamp.getFullYear().toString());

      if (!fsSync.existsSync(archiveDir)) {
        fsSync.mkdirSync(archiveDir, { recursive: true });
      }

      // Move to cold storage (in production, move to S3 Glacier, Azure Archive, etc.)
      const archivePath = path.join(archiveDir, path.basename(backupPath));
      await fs.copyFile(backupPath, archivePath);

      metadata.status = BackupStatus.ARCHIVED;
      const metadataPath = path.join(
        this.backupDir,
        'database',
        'metadata',
        `${metadata.id}.json`,
      );
      await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

      this.logger.log(`Backup archived: ${metadata.id}`);
    } catch (error) {
      this.logger.error(`Failed to archive backup ${metadata.id}:`, error);
    }
  }

  /**
   * Delete expired backup
   */
  private async deleteBackup(metadata: BackupMetadata): Promise<void> {
    this.logger.log(`Deleting expired backup: ${metadata.id}`);

    try {
      const backupPath = await this.findBackupFile(metadata.id);

      if (backupPath && fsSync.existsSync(backupPath)) {
        await fs.rm(backupPath, { recursive: true, force: true });

        // Also delete related files
        const extensions = ['.gz', '_schema.sql', '_data.sql', '.sha256'];
        for (const ext of extensions) {
          const relatedFile = `${backupPath.replace(/\.(dump|tar\.gz)$/, '')}${ext}`;
          if (fsSync.existsSync(relatedFile)) {
            await fs.rm(relatedFile, { force: true });
          }
        }

        this.logger.log(`Backup deleted: ${metadata.id}`);
      }

      // Delete metadata
      const metadataPath = path.join(this.backupDir, 'database', 'metadata', `${metadata.id}.json`);
      if (fsSync.existsSync(metadataPath)) {
        await fs.rm(metadataPath);
      }
    } catch (error) {
      this.logger.error(`Failed to delete backup ${metadata.id}:`, error);
    }
  }

  /**
   * Remove deprecated backup formats
   */
  private async removeDeprecatedBackupFormats(): Promise<number> {
    let removed = 0;

    try {
      const deprecatedPatterns = ['_backup.sql', '.old.dump', '.tmp'];

      for (const pattern of deprecatedPatterns) {
        const files = this.findFilesWithPattern(this.backupDir, pattern);

        for (const file of files) {
          const stats = await fs.stat(file);
          const age = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60 * 24); // Age in days

          if (age > 30) {
            await fs.rm(file, { force: true });
            removed++;
          }
        }
      }
    } catch (error) {
      this.logger.warn('Failed to remove deprecated backup formats:', error);
    }

    return removed;
  }

  /**
   * Find files matching pattern recursively
   */
  private findFilesWithPattern(dir: string, pattern: string): string[] {
    const files: string[] = [];

    const walk = (currentDir: string): void => {
      try {
        const items = fsSync.readdirSync(currentDir);

        for (const item of items) {
          const fullPath = path.join(currentDir, item);
          const stat = fsSync.statSync(fullPath);

          if (stat.isDirectory()) {
            walk(fullPath);
          } else if (item.includes(pattern)) {
            files.push(fullPath);
          }
        }
      } catch {
        // Skip unreadable directories
      }
    };

    walk(dir);
    return files;
  }

  /**
   * Get backup lifecycle statistics
   */
  async getBackupLifecycleStats() {
    const backupMetadataDir = path.join(this.backupDir, 'database', 'metadata');
    const stats = {
      active: 0,
      archived: 0,
      verified: 0,
      failed: 0,
      totalSize: 0,
    };

    if (!fsSync.existsSync(backupMetadataDir)) {
      return stats;
    }

    const metadataFiles = fsSync.readdirSync(backupMetadataDir);

    for (const file of metadataFiles) {
      try {
        const content = fsSync.readFileSync(path.join(backupMetadataDir, file), 'utf-8');
        const metadata: BackupMetadata = JSON.parse(content);

        if (metadata.status === BackupStatus.ARCHIVED) {
          stats.archived++;
        } else if (metadata.status === BackupStatus.FAILED) {
          stats.failed++;
        } else {
          stats.active++;
        }

        if (metadata.verified) {
          stats.verified++;
        }

        stats.totalSize += metadata.size;
      } catch {
        // Skip invalid files
      }
    }

    return stats;
  }
}
