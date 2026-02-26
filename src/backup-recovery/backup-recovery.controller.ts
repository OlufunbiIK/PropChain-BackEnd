import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  HttpCode,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { DatabaseBackupService } from './database-backup.service';
import { DocumentBackupService } from './document-backup.service';
import { DisasterRecoveryService } from './disaster-recovery.service';
import { BackupMonitoringService } from './backup-monitoring.service';
import { BackupVerificationService } from './backup-verification.service';
import { BackupMetadata, DisasterRecoveryPlan, RecoveryTestResult } from './backup.types';

/**
 * Backup and Disaster Recovery Controller
 * Exposes APIs for backup management, disaster recovery, and monitoring
 */
@ApiTags('backup-recovery')
@Controller({ path: 'backup-recovery', version: '1' })
@ApiBearerAuth()
export class BackupRecoveryController {
  constructor(
    private readonly databaseBackupService: DatabaseBackupService,
    private readonly documentBackupService: DocumentBackupService,
    private readonly disasterRecoveryService: DisasterRecoveryService,
    private readonly backupMonitoringService: BackupMonitoringService,
    private readonly backupVerificationService: BackupVerificationService,
  ) {}

  // ============ Database Backup Endpoints ============

  @Post('database/backup/full')
  @HttpCode(202)
  @ApiOperation({ summary: 'Perform full database backup' })
  @ApiResponse({
    status: 202,
    description: 'Full backup initiated',
    type: BackupMetadata,
  })
  async performFullBackup(@Body() body?: { tags?: Record<string, string> }): Promise<BackupMetadata> {
    return this.databaseBackupService.performFullBackup(body?.tags);
  }

  @Post('database/backup/incremental')
  @HttpCode(202)
  @ApiOperation({ summary: 'Perform incremental database backup' })
  @ApiResponse({ status: 202, description: 'Incremental backup initiated' })
  async performIncrementalBackup(): Promise<BackupMetadata> {
    return this.databaseBackupService.performIncrementalBackup();
  }

  @Get('database/backups')
  @ApiOperation({ summary: 'List database backups' })
  @ApiResponse({ status: 200, description: 'List of backups', isArray: true })
  async listDatabaseBackups(
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<BackupMetadata[]> {
    return this.databaseBackupService.listBackups({
      type: type as any,
      status: status as any,
      limit: limit ? parseInt(limit) : undefined,
      offset: offset ? parseInt(offset) : undefined,
    });
  }

  @Get('database/backups/:backupId')
  @ApiOperation({ summary: 'Get backup details' })
  @ApiResponse({ status: 200, description: 'Backup details' })
  async getBackup(@Param('backupId') backupId: string): Promise<BackupMetadata | null> {
    return this.databaseBackupService.getBackup(backupId);
  }

  @Get('database/statistics')
  @ApiOperation({ summary: 'Get backup statistics' })
  async getBackupStatistics() {
    return this.databaseBackupService.getBackupStatistics();
  }

  // ============ Document Backup Endpoints ============

  @Post('documents/backup')
  @HttpCode(202)
  @ApiOperation({ summary: 'Perform document backup' })
  @ApiResponse({ status: 202, description: 'Document backup initiated' })
  async performDocumentBackup(@Body() body?: { tags?: Record<string, string> }): Promise<BackupMetadata> {
    return this.documentBackupService.performDocumentBackup(body?.tags);
  }

  @Get('documents/backups')
  @ApiOperation({ summary: 'List document backups' })
  async listDocumentBackups(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<BackupMetadata[]> {
    return this.documentBackupService.listDocumentBackups(
      limit ? parseInt(limit) : 50,
      offset ? parseInt(offset) : 0,
    );
  }

  @Post('documents/backups/:backupId/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Verify document backup integrity' })
  async verifyDocumentBackup(@Param('backupId') backupId: string): Promise<boolean> {
    return this.documentBackupService.verifyDocumentBackup(backupId);
  }

  @Get('documents/statistics')
  @ApiOperation({ summary: 'Get document backup statistics' })
  async getDocumentBackupStatistics() {
    return this.documentBackupService.getDocumentBackupStatistics();
  }

  // ============ Disaster Recovery Endpoints ============

  @Post('disaster-recovery/plans')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create disaster recovery plan' })
  @ApiResponse({ status: 201, description: 'DR plan created' })
  async createDRPlan(@Body() plan: DisasterRecoveryPlan): Promise<DisasterRecoveryPlan> {
    return this.disasterRecoveryService.createDRPlan(plan);
  }

  @Get('disaster-recovery/plans')
  @ApiOperation({ summary: 'List disaster recovery plans' })
  async listDRPlans(): Promise<DisasterRecoveryPlan[]> {
    return this.disasterRecoveryService.listDRPlans();
  }

  @Get('disaster-recovery/plans/:planId')
  @ApiOperation({ summary: 'Get DR plan details' })
  async getDRPlan(@Param('planId') planId: string): Promise<DisasterRecoveryPlan> {
    return this.disasterRecoveryService.getDRPlan(planId);
  }

  @Post('disaster-recovery/failover')
  @HttpCode(202)
  @ApiOperation({ summary: 'Initiate managed failover' })
  @ApiResponse({ status: 202, description: 'Failover initiated' })
  async initiateManagedFailover(
    @Body() body: { planId: string; targetRegion: string },
  ): Promise<any> {
    if (!body.planId || !body.targetRegion) {
      throw new BadRequestException('planId and targetRegion are required');
    }

    return this.disasterRecoveryService.initiateManagedFailover(body.planId, body.targetRegion);
  }

  @Post('disaster-recovery/point-in-time-recovery')
  @HttpCode(202)
  @ApiOperation({ summary: 'Perform point-in-time recovery' })
  @ApiResponse({ status: 202, description: 'Point-in-time recovery initiated' })
  async performPointInTimeRecovery(
    @Body()
    body: {
      targetTimestamp: string;
      backupId: string;
      targetEnvironment?: string;
    },
  ): Promise<any> {
    if (!body.targetTimestamp || !body.backupId) {
      throw new BadRequestException('targetTimestamp and backupId are required');
    }

    return this.disasterRecoveryService.performPointInTimeRecovery(
      new Date(body.targetTimestamp),
      body.backupId,
      body.targetEnvironment,
    );
  }

  @Post('disaster-recovery/test/:planId')
  @HttpCode(202)
  @ApiOperation({ summary: 'Perform DR test' })
  @ApiResponse({ status: 202, description: 'DR test initiated' })
  async performDRTest(@Param('planId') planId: string): Promise<RecoveryTestResult> {
    return this.disasterRecoveryService.performDisasterRecoveryTest(planId);
  }

  @Get('disaster-recovery/status')
  @ApiOperation({ summary: 'Get DR status' })
  async getDRStatus(): Promise<any> {
    return this.disasterRecoveryService.getDRStatus();
  }

  // ============ Backup Monitoring Endpoints ============

  @Get('monitoring/alerts')
  @ApiOperation({ summary: 'Get active backup alerts' })
  async getActiveAlerts(@Query('severity') severity?: string): Promise<any[]> {
    return this.backupMonitoringService.getActiveAlerts(severity as any);
  }

  @Post('monitoring/alerts/:alertId/acknowledge')
  @HttpCode(200)
  @ApiOperation({ summary: 'Acknowledge alert' })
  async acknowledgeAlert(
    @Param('alertId') alertId: string,
    @Body() body: { acknowledgedBy: string },
  ): Promise<void> {
    return this.backupMonitoringService.acknowledgeAlert(alertId, body.acknowledgedBy);
  }

  @Post('monitoring/alerts/:alertId/resolve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Resolve alert' })
  async resolveAlert(@Param('alertId') alertId: string): Promise<void> {
    return this.backupMonitoringService.resolveAlert(alertId);
  }

  @Get('monitoring/dashboard')
  @ApiOperation({ summary: 'Get monitoring dashboard data' })
  async getMonitoringDashboard(): Promise<any> {
    return this.backupMonitoringService.getMonitoringDashboard();
  }

  // ============ Backup Verification Endpoints ============

  @Post('verification/verify-all')
  @HttpCode(202)
  @ApiOperation({ summary: 'Verify all backups' })
  async verifyAllBackups(): Promise<any[]> {
    return this.backupVerificationService.verifyAllBackups();
  }

  @Post('verification/verify/:backupId')
  @HttpCode(202)
  @ApiOperation({ summary: 'Verify specific backup' })
  async verifyBackup(@Param('backupId') backupId: string): Promise<any> {
    return this.backupVerificationService.verifyBackup(backupId);
  }

  @Get('verification/:backupId')
  @ApiOperation({ summary: 'Get verification result' })
  async getVerificationResult(@Param('backupId') backupId: string): Promise<any> {
    return this.backupVerificationService.getVerificationResult(backupId);
  }

  @Get('retention/lifecycle-stats')
  @ApiOperation({ summary: 'Get backup lifecycle statistics' })
  async getBackupLifecycleStats(): Promise<any> {
    return this.backupVerificationService.getBackupLifecycleStats();
  }

  @Post('retention/enforce-policies')
  @HttpCode(200)
  @ApiOperation({ summary: 'Enforce retention policies' })
  async enforceRetentionPolicies(): Promise<any> {
    return this.backupVerificationService.enforceRetentionPolicies();
  }

  // ============ Point-in-Time Recovery Endpoints ============

  @Get('recovery/point-in-time/:timestamp')
  @ApiOperation({ summary: 'Get point-in-time recovery info' })
  async getPointInTimeRecoveryInfo(@Param('timestamp') timestamp: string): Promise<any> {
    try {
      const targetTime = new Date(timestamp);
      if (isNaN(targetTime.getTime())) {
        throw new BadRequestException('Invalid timestamp format');
      }

      return this.databaseBackupService.getPointInTimeRecovery(targetTime);
    } catch (error) {
      throw new BadRequestException(`Failed to get PITR info: ${error.message}`);
    }
  }
}
