import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { BackupAlert, BackupMetadata, BackupStatus } from './backup.types';

/**
 * BackupMonitoringService
 * Monitors backup system health and generates alerts for issues
 */
@Injectable()
export class BackupMonitoringService {
  private readonly logger = new Logger(BackupMonitoringService.name);
  private alerts: Map<string, BackupAlert> = new Map();
  private backupDir: string;
  private enabledAlertChannels: Set<string> = new Set();

  constructor(private readonly configService: ConfigService) {
    this.backupDir = path.join(process.cwd(), 'backups');
    this.initializeAlertChannels();
  }

  /**
   * Initialize alert channels
   */
  private initializeAlertChannels(): void {
    const channels = this.configService.get('ALERT_CHANNELS', 'email,slack');
    channels.split(',').forEach((channel) => {
      const trimmed = channel.trim().toLowerCase();
      if (trimmed) {
        this.enabledAlertChannels.add(trimmed);
      }
    });

    this.logger.log(`Initialized alert channels: ${Array.from(this.enabledAlertChannels).join(', ')}`);
  }

  /**
   * Check backup health every 5 minutes
   */
  @Cron('*/5 * * * *')
  async monitorBackupHealth(): Promise<void> {
    try {
      await this.checkBackupCompletion();
      await this.checkBackupSize();
      await this.checkStorageSpace();
      await this.checkBackupReplication();
      await this.checkBackupAge();
    } catch (error) {
      this.logger.error('Backup health monitoring failed:', error);
    }
  }

  /**
   * Check if recent backups completed successfully
   */
  private async checkBackupCompletion(): Promise<void> {
    try {
      const backupMetadataDir = path.join(this.backupDir, 'database', 'metadata');

      if (!fsSync.existsSync(backupMetadataDir)) {
        return;
      }

      const metadataFiles = fsSync.readdirSync(backupMetadataDir);
      const oneHourAgo = Date.now() - 3600000;

      let latestBackup: BackupMetadata | null = null;
      let latestTime = 0;

      for (const file of metadataFiles) {
        const content = fsSync.readFileSync(path.join(backupMetadataDir, file), 'utf-8');
        const metadata: BackupMetadata = JSON.parse(content);
        const timestamp = new Date(metadata.timestamp).getTime();

        if (timestamp > latestTime) {
          latestTime = timestamp;
          latestBackup = metadata;
        }
      }

      if (latestBackup && latestTime > oneHourAgo) {
        if (latestBackup.status === BackupStatus.FAILED) {
          await this.createAlert({
            type: 'BACKUP_FAILED',
            severity: 'CRITICAL',
            message: `Recent backup failed: ${latestBackup.id}. Error: ${latestBackup.error}`,
            backupId: latestBackup.id,
          });
        } else if (latestBackup.status === BackupStatus.IN_PROGRESS) {
          const duration = Date.now() - latestTime;
          if (duration > 7200000) {
            // 2 hours
            await this.createAlert({
              type: 'BACKUP_TIMEOUT',
              severity: 'HIGH',
              message: `Backup timeout: ${latestBackup.id} has been running for ${Math.round(duration / 60000)} minutes`,
              backupId: latestBackup.id,
            });
          }
        }
      }
    } catch (error) {
      this.logger.warn('Backup completion check failed:', error);
    }
  }

  /**
   * Check backup sizes for anomalies
   */
  private async checkBackupSize(): Promise<void> {
    try {
      const backupMetadataDir = path.join(this.backupDir, 'database', 'metadata');

      if (!fsSync.existsSync(backupMetadataDir)) {
        return;
      }

      const metadataFiles = fsSync.readdirSync(backupMetadataDir);
      const backups: BackupMetadata[] = [];

      for (const file of metadataFiles) {
        const content = fsSync.readFileSync(path.join(backupMetadataDir, file), 'utf-8');
        backups.push(JSON.parse(content));
      }

      if (backups.length < 2) {
        return;
      }

      // Sort by timestamp descending
      backups.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      const latestBackup = backups[0];
      const previousBackup = backups[1];

      // Check for significant size changes
      const sizeDifference = Math.abs(latestBackup.size - previousBackup.size);
      const percentChange = (sizeDifference / previousBackup.size) * 100;

      if (percentChange > 50) {
        this.logger.warn(
          `Backup size changed significantly: ${percentChange.toFixed(2)}% increase/decrease`,
        );

        await this.createAlert({
          type: 'BACKUP_FAILED',
          severity: 'MEDIUM',
          message: `Backup size anomaly detected: ${percentChange.toFixed(2)}% change from previous backup (${previousBackup.size} -> ${latestBackup.size} bytes)`,
          backupId: latestBackup.id,
        });
      }
    } catch (error) {
      this.logger.warn('Backup size check failed:', error);
    }
  }

  /**
   * Check available storage space
   */
  private async checkStorageSpace(): Promise<void> {
    try {
      const stats = fsSync.statSync(this.backupDir);

      // Get disk usage (simplified - in production use actual du command)
      const backupFiles = this.getAllBackupFiles(this.backupDir);
      let totalSize = 0;

      for (const file of backupFiles) {
        const stat = fsSync.statSync(file);
        totalSize += stat.size;
      }

      const maxStorageSize = this.configService.get('BACKUP_STORAGE_MAX_SIZE', 1099511627776); // 1 TB default
      const utilizationPercent = (totalSize / maxStorageSize) * 100;

      if (utilizationPercent > 90) {
        await this.createAlert({
          type: 'STORAGE_FULL',
          severity: 'CRITICAL',
          message: `Backup storage utilization at ${utilizationPercent.toFixed(2)}%. Please increase storage capacity.`,
        });
      } else if (utilizationPercent > 70) {
        await this.createAlert({
          type: 'STORAGE_FULL',
          severity: 'HIGH',
          message: `Backup storage utilization at ${utilizationPercent.toFixed(2)}%. Consider increasing storage.`,
        });
      }
    } catch (error) {
      this.logger.warn('Storage space check failed:', error);
    }
  }

  /**
   * Check backup replication status
   */
  private async checkBackupReplication(): Promise<void> {
    try {
      const backupMetadataDir = path.join(this.backupDir, 'database', 'metadata');

      if (!fsSync.existsSync(backupMetadataDir)) {
        return;
      }

      const metadataFiles = fsSync.readdirSync(backupMetadataDir);

      for (const file of metadataFiles) {
        const content = fsSync.readFileSync(path.join(backupMetadataDir, file), 'utf-8');
        const metadata: BackupMetadata = JSON.parse(content);

        if (
          metadata.status === BackupStatus.COMPLETED &&
          metadata.timestamp &&
          new Date(metadata.timestamp).getTime() > Date.now() - 86400000
        ) {
          // Last 24 hours
          if (!metadata.locations || metadata.locations.length < 2) {
            await this.createAlert({
              type: 'REPLICATION_FAILED',
              severity: 'HIGH',
              message: `Backup replication incomplete: ${metadata.id} only replicated to ${metadata.locations?.length || 0} location(s)`,
              backupId: metadata.id,
            });
          }
        }
      }
    } catch (error) {
      this.logger.warn('Backup replication check failed:', error);
    }
  }

  /**
   * Check backup age - ensure backups are recent
   */
  private async checkBackupAge(): Promise<void> {
    try {
      const backupMetadataDir = path.join(this.backupDir, 'database', 'metadata');

      if (!fsSync.existsSync(backupMetadataDir)) {
        return;
      }

      const metadataFiles = fsSync.readdirSync(backupMetadataDir);
      let latestBackupTime = 0;

      for (const file of metadataFiles) {
        const content = fsSync.readFileSync(path.join(backupMetadataDir, file), 'utf-8');
        const metadata: BackupMetadata = JSON.parse(content);

        if (metadata.status === BackupStatus.COMPLETED) {
          const timestamp = new Date(metadata.timestamp).getTime();
          if (timestamp > latestBackupTime) {
            latestBackupTime = timestamp;
          }
        }
      }

      if (latestBackupTime === 0) {
        await this.createAlert({
          type: 'BACKUP_FAILED',
          severity: 'CRITICAL',
          message: 'No recent successful backups found',
        });
      } else {
        const ageHours = (Date.now() - latestBackupTime) / 3600000;

        if (ageHours > 25) {
          await this.createAlert({
            type: 'BACKUP_FAILED',
            severity: 'CRITICAL',
            message: `Latest backup is ${ageHours.toFixed(1)} hours old. Backup schedule may have failed.`,
          });
        } else if (ageHours > 12) {
          await this.createAlert({
            type: 'BACKUP_FAILED',
            severity: 'HIGH',
            message: `Latest backup is ${ageHours.toFixed(1)} hours old.`,
          });
        }
      }
    } catch (error) {
      this.logger.warn('Backup age check failed:', error);
    }
  }

  /**
   * Get all backup files recursively
   */
  private getAllBackupFiles(dir: string): string[] {
    const files: string[] = [];

    const walk = (currentDir: string): void => {
      try {
        const items = fsSync.readdirSync(currentDir);

        for (const item of items) {
          const fullPath = path.join(currentDir, item);
          const stat = fsSync.statSync(fullPath);

          if (stat.isDirectory()) {
            walk(fullPath);
          } else {
            files.push(fullPath);
          }
        }
      } catch {
        // Skip directories we can't read
      }
    };

    walk(dir);
    return files;
  }

  /**
   * Create a new alert
   */
  private async createAlert(alertData: {
    type:
      | 'BACKUP_FAILED'
      | 'BACKUP_TIMEOUT'
      | 'STORAGE_FULL'
      | 'REPLICATION_FAILED'
      | 'VERIFICATION_FAILED';
    severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
    message: string;
    backupId?: string;
  }): Promise<void> {
    const alertId = `alert_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    // Check if similar alert exists (deduplication)
    const existingAlert = Array.from(this.alerts.values()).find(
      (a) =>
        a.type === alertData.type &&
        !a.resolved &&
        new Date(a.timestamp).getTime() > Date.now() - 3600000, // Within 1 hour
    );

    if (existingAlert) {
      this.logger.debug(`Alert deduplicated: ${alertData.type}`);
      return;
    }

    const alert: BackupAlert = {
      id: alertId,
      type: alertData.type,
      severity: alertData.severity,
      message: alertData.message,
      timestamp: new Date(),
      resolved: false,
    };

    this.alerts.set(alertId, alert);

    // Log alert
    this.logger.warn(`[${alert.severity}] ${alert.type}: ${alert.message}`);

    // Send notifications
    await this.sendAlertNotifications(alert);

    // Save alert to disk
    await this.saveAlert(alert);
  }

  /**
   * Send alert notifications via configured channels
   */
  private async sendAlertNotifications(alert: BackupAlert): Promise<void> {
    for (const channel of this.enabledAlertChannels) {
      try {
        if (channel === 'email') {
          await this.sendEmailAlert(alert);
        } else if (channel === 'slack') {
          await this.sendSlackAlert(alert);
        } else if (channel === 'pagerduty') {
          await this.sendPagerDutyAlert(alert);
        }
      } catch (error) {
        this.logger.error(`Failed to send alert via ${channel}:`, error);
      }
    }
  }

  /**
   * Send email alert
   */
  private async sendEmailAlert(alert: BackupAlert): Promise<void> {
    const recipients = this.configService.get('ALERT_EMAIL_RECIPIENTS', '').split(',');

    if (recipients.length === 0) {
      return;
    }

    this.logger.log(`Sending email alert: ${alert.type} to ${recipients.join(', ')}`);

    // Implementation would integrate with email service (SendGrid, AWS SES, etc.)
  }

  /**
   * Send Slack alert
   */
  private async sendSlackAlert(alert: BackupAlert): Promise<void> {
    const webhookUrl = this.configService.get('SLACK_WEBHOOK_URL');

    if (!webhookUrl) {
      return;
    }

    this.logger.log(`Sending Slack alert: ${alert.type}`);

    const severity_color = {
      CRITICAL: '#FF0000',
      HIGH: '#FF9900',
      MEDIUM: '#FFFF00',
      LOW: '#00FF00',
    };

    // Implementation would make HTTP POST to Slack webhook
  }

  /**
   * Send PagerDuty alert
   */
  private async sendPagerDutyAlert(alert: BackupAlert): Promise<void> {
    const integrationKey = this.configService.get('PAGERDUTY_INTEGRATION_KEY');

    if (!integrationKey) {
      return;
    }

    this.logger.log(`Sending PagerDuty alert: ${alert.type}`);

    // Implementation would integrate with PagerDuty API
  }

  /**
   * Save alert to disk
   */
  private async saveAlert(alert: BackupAlert): Promise<void> {
    const alertsDir = path.join(this.backupDir, 'alerts');

    if (!fsSync.existsSync(alertsDir)) {
      fsSync.mkdirSync(alertsDir, { recursive: true });
    }

    await fs.writeFile(
      path.join(alertsDir, `${alert.id}.json`),
      JSON.stringify(alert, null, 2),
    );
  }

  /**
   * Get active alerts
   */
  async getActiveAlerts(severity?: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'): Promise<BackupAlert[]> {
    const alerts = Array.from(this.alerts.values())
      .filter((a) => !a.resolved)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    if (severity) {
      return alerts.filter((a) => a.severity === severity);
    }

    return alerts;
  }

  /**
   * Acknowledge alert
   */
  async acknowledgeAlert(alertId: string, acknowledgedBy: string): Promise<void> {
    const alert = this.alerts.get(alertId);

    if (!alert) {
      throw new Error(`Alert not found: ${alertId}`);
    }

    alert.acknowledgement = {
      acknowledgedBy,
      acknowledgedAt: new Date(),
    };

    await this.saveAlert(alert);

    this.logger.log(`Alert acknowledged: ${alertId} by ${acknowledgedBy}`);
  }

  /**
   * Resolve alert
   */
  async resolveAlert(alertId: string): Promise<void> {
    const alert = this.alerts.get(alertId);

    if (!alert) {
      throw new Error(`Alert not found: ${alertId}`);
    }

    alert.resolved = true;

    await this.saveAlert(alert);

    this.logger.log(`Alert resolved: ${alertId}`);
  }

  /**
   * Get monitoring dashboard data
   */
  async getMonitoringDashboard() {
    const criticalAlerts = this.getActiveAlerts('CRITICAL');
    const highAlerts = this.getActiveAlerts('HIGH');

    const backupMetadataDir = path.join(this.backupDir, 'database', 'metadata');
    let recentBackups: BackupMetadata[] = [];

    if (fsSync.existsSync(backupMetadataDir)) {
      const files = fsSync.readdirSync(backupMetadataDir).slice(-10); // Last 10 backups

      for (const file of files) {
        const content = fsSync.readFileSync(path.join(backupMetadataDir, file), 'utf-8');
        recentBackups.push(JSON.parse(content));
      }
    }

    return {
      alerts: {
        critical: (await criticalAlerts).length,
        high: (await highAlerts).length,
        total: this.alerts.size,
      },
      recentBackups: recentBackups.sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      ),
      systemHealth: {
        status: (await criticalAlerts).length === 0 ? 'HEALTHY' : 'DEGRADED',
        lastCheck: new Date(),
      },
    };
  }
}
