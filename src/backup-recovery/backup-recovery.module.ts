import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../database/database.module';
import { DatabaseBackupService } from './database-backup.service';
import { DocumentBackupService } from './document-backup.service';
import { DisasterRecoveryService } from './disaster-recovery.service';
import { BackupMonitoringService } from './backup-monitoring.service';
import { BackupVerificationService } from './backup-verification.service';
import { BackupRecoveryController } from './backup-recovery.controller';

/**
 * BackupRecoveryModule
 * Comprehensive backup and disaster recovery system
 */
@Module({
  imports: [
    ScheduleModule.forRoot(),
    ConfigModule,
    DatabaseModule,
  ],
  controllers: [BackupRecoveryController],
  providers: [
    DatabaseBackupService,
    DocumentBackupService,
    DisasterRecoveryService,
    BackupMonitoringService,
    BackupVerificationService,
  ],
  exports: [
    DatabaseBackupService,
    DocumentBackupService,
    DisasterRecoveryService,
    BackupMonitoringService,
    BackupVerificationService,
  ],
})
export class BackupRecoveryModule {}
