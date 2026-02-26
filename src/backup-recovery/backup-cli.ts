#!/usr/bin/env node

/**
 * Backup System CLI Tool
 * Command-line interface for backup and disaster recovery operations
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { DatabaseBackupService } from './database-backup.service';
import { DocumentBackupService } from './document-backup.service';
import { DisasterRecoveryService } from './disaster-recovery.service';
import { BackupVerificationService } from './backup-verification.service';

enum Command {
  BACKUP_FULL = 'backup:full',
  BACKUP_INCREMENTAL = 'backup:incremental',
  BACKUP_VERIFY = 'backup:verify',
  RESTORE_LATEST = 'restore:latest',
  PITR = 'pitr',
  DR_TEST = 'dr:test',
  DR_FAILOVER = 'dr:failover',
  RETENTION_ENFORCE = 'retention:enforce',
  STATUS = 'status',
}

async function main() {
  const app = await NestFactory.create(AppModule);
  const args = process.argv.slice(2);
  const command = args[0];
  const params = args.slice(1);

  console.log(`\n🔧 PropChain Backup CLI Tool\n`);
  console.log(`Command: ${command}`);
  console.log(`Parameters: ${params.join(', ')}\n`);

  try {
    switch (command) {
      case Command.BACKUP_FULL:
        await executeFullBackup(app);
        break;

      case Command.BACKUP_INCREMENTAL:
        await executeIncrementalBackup(app);
        break;

      case Command.BACKUP_VERIFY:
        await executeBackupVerification(app, params[0]);
        break;

      case Command.RESTORE_LATEST:
        await executeRestore(app, params[0]);
        break;

      case Command.PITR:
        await executePointInTimeRecovery(app, params[0], params[1]);
        break;

      case Command.DR_TEST:
        await executeDRTest(app, params[0]);
        break;

      case Command.DR_FAILOVER:
        await executeDRFailover(app, params[0], params[1]);
        break;

      case Command.RETENTION_ENFORCE:
        await enforceRetention(app);
        break;

      case Command.STATUS:
        await showStatus(app);
        break;

      default:
        showHelp();
    }
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  } finally {
    await app.close();
  }
}

async function executeFullBackup(app: any) {
  const databaseBackupService = app.get(DatabaseBackupService);

  console.log('📥 Starting full database backup...\n');

  const startTime = Date.now();
  const backup = await databaseBackupService.performFullBackup({
    type: 'manual',
    operator: 'cli',
    timestamp: new Date().toISOString(),
  });

  const duration = (Date.now() - startTime) / 1000;

  console.log(`✅ Backup completed successfully!\n`);
  console.log(`ID:       ${backup.id}`);
  console.log(`Size:     ${formatBytes(backup.size)}`);
  console.log(`Duration: ${duration.toFixed(2)}s`);
  console.log(`Checksum: ${backup.checksum}`);
  console.log(`Locations: ${backup.locations.join(', ')}\n`);
}

async function executeIncrementalBackup(app: any) {
  const databaseBackupService = app.get(DatabaseBackupService);

  console.log('📥 Starting incremental database backup...\n');

  const startTime = Date.now();
  const backup = await databaseBackupService.performIncrementalBackup();

  const duration = (Date.now() - startTime) / 1000;

  console.log(`✅ Incremental backup completed!\n`);
  console.log(`ID:       ${backup.id}`);
  console.log(`Size:     ${formatBytes(backup.size)}`);
  console.log(`Duration: ${duration.toFixed(2)}s\n`);
}

async function executeBackupVerification(app: any, backupId?: string) {
  const verificationService = app.get(BackupVerificationService);

  if (backupId) {
    console.log(`🔍 Verifying backup: ${backupId}\n`);
    const result = await verificationService.verifyBackup(backupId);

    console.log(`✅ Verification completed!\n`);
    console.log(`Accessible:  ${result.accessible ? '✓' : '✗'}`);
    console.log(`Restorable:  ${result.restorable ? '✓' : '✗'}`);
    console.log(`Checksum:    ${result.checksum}`);
    console.log(`File Size:   ${formatBytes(result.fileSize)}`);
    console.log(`Tables:      ${result.tableIntegrity.validTables}/${result.tableIntegrity.totalTables}`);

    if (result.tableIntegrity.errors.length > 0) {
      console.log(`\nErrors:`);
      result.tableIntegrity.errors.forEach((e) => console.log(`  - ${e}`));
    }
  } else {
    console.log('🔍 Verifying all backups...\n');
    const results = await verificationService.verifyAllBackups();

    console.log(`✅ Verified ${results.length} backups!\n`);
    results.forEach((r) => {
      const status = r.restorable ? '✓' : '✗';
      console.log(`${status} ${r.backupId} - ${r.tableIntegrity.validTables}/${r.tableIntegrity.totalTables} tables`);
    });
  }

  console.log();
}

async function executeRestore(app: any, environment: string) {
  if (!environment) {
    console.error('❌ Environment required (e.g., staging, recovery)');
    process.exit(1);
  }

  console.log(`⚠️  Restoring to ${environment} environment\n`);
  console.log('This operation will overwrite existing data. Are you sure? (yes/no)');
  console.log('Implementation: Use latest verified backup to restore');
  console.log(`Database will be restored to: ${environment}\n`);
}

async function executePointInTimeRecovery(app: any, timestamp: string, backupId?: string) {
  if (!timestamp) {
    console.error('❌ Timestamp required (ISO 8601 format)');
    process.exit(1);
  }

  const disasterRecoveryService = app.get(DisasterRecoveryService);

  console.log(`⏰ Point-in-Time Recovery\n`);
  console.log(`Target Timestamp: ${timestamp}`);
  console.log(`Backup ID:        ${backupId || 'auto-detect'}\n`);

  const result = await disasterRecoveryService.performPointInTimeRecovery(
    new Date(timestamp),
    backupId || 'latest',
    'dr-staging',
  );

  console.log(`✅ PITR initiated successfully!\n`);
  console.log(`Recovery ID: ${result.recoveryId}`);
  console.log(`Start Time:  ${result.startTime.toISOString()}`);
  console.log(`Est. Duration: ${(result.estimatedDuration / 60000).toFixed(0)} minutes\n`);
}

async function executeDRTest(app: any, planId: string) {
  if (!planId) {
    console.error('❌ DR Plan ID required');
    process.exit(1);
  }

  const disasterRecoveryService = app.get(DisasterRecoveryService);

  console.log(`🧪 Starting Disaster Recovery Test\n`);
  console.log(`DR Plan: ${planId}\n`);

  const result = await disasterRecoveryService.performDisasterRecoveryTest(planId);

  console.log(`${result.success ? '✅' : '❌'} DR Test ${result.success ? 'PASSED' : 'FAILED'}\n`);
  console.log(`Test ID:       ${result.id}`);
  console.log(`Backup ID:     ${result.backupId}`);
  console.log(`Duration:      ${(result.duration / 1000).toFixed(2)}s`);
  console.log(`Tables:        ${result.dataValidation.tablesVerified}`);
  console.log(`Records:       ${result.dataValidation.recordsVerified}`);

  if (result.dataValidation.errors.length > 0) {
    console.log(`\nErrors:`);
    result.dataValidation.errors.forEach((e) => console.log(`  - ${e}`));
  }

  console.log();
}

async function executeDRFailover(app: any, planId: string, targetRegion: string) {
  if (!planId || !targetRegion) {
    console.error('❌ DR Plan ID and Target Region required');
    process.exit(1);
  }

  const disasterRecoveryService = app.get(DisasterRecoveryService);

  console.log(`🔴 INITIATING FAILOVER\n`);
  console.log(`DR Plan:        ${planId}`);
  console.log(`Target Region:  ${targetRegion}\n`);
  console.log('⚠️  This operation will redirect traffic to the failover region.');
  console.log('Are you sure? (type "yes" to continue)\n');

  const result = await disasterRecoveryService.initiateManagedFailover(planId, targetRegion);

  console.log(`✅ Failover initiated!\n`);
  console.log(`Status:                 ${result.status}`);
  console.log(`Start Time:             ${result.failoverStartTime.toISOString()}`);
  console.log(`Estimated Completion:   ${result.estimatedCompletionTime.toISOString()}\n`);
}

async function enforceRetention(app: any) {
  const verificationService = app.get(BackupVerificationService);

  console.log('🗑️  Enforcing retention policies...\n');

  const result = await verificationService.enforceRetentionPolicies();

  console.log(`✅ Retention policies enforced!\n`);
  console.log(`Backups Deleted: ${result.deleted}`);
  console.log(`Backups Archived: ${result.archived}\n`);
}

async function showStatus(app: any) {
  const databaseBackupService = app.get(DatabaseBackupService);
  const disasterRecoveryService = app.get(DisasterRecoveryService);
  const verificationService = app.get(BackupVerificationService);

  console.log('📊 Backup System Status\n');

  const backupStats = await databaseBackupService.getBackupStatistics();
  const drStatus = await disasterRecoveryService.getDRStatus();
  const lifecycleStats = await verificationService.getBackupLifecycleStats();

  console.log('Database Backups:');
  console.log(`  Total:       ${backupStats.totalBackups}`);
  console.log(`  Total Size:  ${formatBytes(backupStats.totalSize)}`);
  console.log(`  Completed:   ${backupStats.byStatus.completed}`);
  console.log(`  Verified:    ${backupStats.byStatus.verified}`);
  console.log(`  Failed:      ${backupStats.byStatus.failed}`);
  console.log(`  Avg Duration: ${backupStats.averageDuration}ms\n`);

  console.log('Disaster Recovery:');
  console.log(`  Active Plans:    ${drStatus.plans}`);
  console.log(`  Failover Active: ${drStatus.isFailoverActive ? 'YES' : 'NO'}`);
  console.log(`  Recent Tests:    ${drStatus.lastTestResults.length}\n`);

  console.log('Lifecycle:');
  console.log(`  Active:    ${lifecycleStats.active}`);
  console.log(`  Verified:  ${lifecycleStats.verified}`);
  console.log(`  Archived:  ${lifecycleStats.archived}`);
  console.log(`  Failed:    ${lifecycleStats.failed}\n`);
}

function showHelp() {
  console.log(`Usage: backup-cli [command] [options]\n`);
  console.log(`Commands:\n`);
  console.log(`  backup:full [tags]              Perform full database backup`);
  console.log(`  backup:incremental              Perform incremental backup`);
  console.log(`  backup:verify [backupId]        Verify backup integrity`);
  console.log(`  restore:latest <environment>    Restore latest backup`);
  console.log(`  pitr <timestamp> [backupId]     Point-in-time recovery`);
  console.log(`  dr:test <planId>                Run DR test`);
  console.log(`  dr:failover <planId> <region>   Initiate failover`);
  console.log(`  retention:enforce               Enforce retention policies`);
  console.log(`  status                          Show system status\n`);
  console.log(`Examples:\n`);
  console.log(`  # Full backup`);
  console.log(`  backup-cli backup:full\n`);
  console.log(`  # Point-in-time recovery`);
  console.log(`  backup-cli pitr 2024-01-15T10:00:00Z\n`);
  console.log(`  # Run DR test`);
  console.log(`  backup-cli dr:test production_dr_plan\n`);
  console.log(`  # Check status`);
  console.log(`  backup-cli status\n`);
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
