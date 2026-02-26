# Backup and Disaster Recovery System - Setup Guide

## Prerequisites

- NestJS backend application
- PostgreSQL database
- Node.js 18+
- AWS CLI (for S3 replication)
- Azure CLI (for Azure Blob Storage replication)
- GCP CLI (for Cloud Storage replication)
- PostgreSQL client tools (pg_dump, pg_restore)
- tar/gzip utilities

---

## Environment Configuration

### 1. Core Backup Configuration

Add the following environment variables to `.env`:

```bash
# Backup Directory
BACKUP_DIR=backups
BACKUP_STORAGE_MAX_SIZE=1099511627776  # 1 TB in bytes

# Database Configuration
DATABASE_URL=postgresql://user:password@localhost:5432/propchain
BACKUP_RETENTION_DAYS=30
BACKUP_RETENTION_WEEKS=12
BACKUP_RETENTION_MONTHS=12
BACKUP_RETENTION_YEARS=7

# Backup Schedule (Cron expressions)
DATABASE_BACKUP_SCHEDULE=0 2 * * *          # Daily at 2 AM
INCREMENTAL_BACKUP_SCHEDULE=0 */6 * * *   # Every 6 hours
DOCUMENT_BACKUP_SCHEDULE=0 3 * * *         # Daily at 3 AM
VERIFICATION_SCHEDULE=0 4 * * 0            # Weekly Sunday 4 AM
RETENTION_ENFORCEMENT_SCHEDULE=0 1 * * *  # Daily at 1 AM
```

### 2. Multi-Region Replication Configuration

```bash
# Primary Region
PRIMARY_REGION=us-east-1
PRIMARY_DB_ENDPOINT=db.us-east-1.rds.amazonaws.com
PRIMARY_DOMAIN=api.propchain.com

# Backup Regions
BACKUP_REGION_1=us-west-2
BACKUP_REGION_1_ENDPOINT=db.us-west-2.rds.amazonaws.com
BACKUP_REGION_1_DB_ENDPOINT=db.us-west-2.rds.amazonaws.com

BACKUP_REGION_2=eu-west-1
BACKUP_REGION_2_ENDPOINT=db.eu-west-1.rds.amazonaws.com
BACKUP_REGION_2_DB_ENDPOINT=db.eu-west-1.rds.amazonaws.com

# Failover Configuration
AUTO_FAILOVER_ENABLED=false
FAILOVER_HEALTH_CHECK_INTERVAL=300000  # 5 minutes in ms
```

### 3. Cloud Storage Configuration

#### AWS S3
```bash
AWS_REGION=us-east-1
AWS_BACKUP_BUCKET=propchain-database-backups
AWS_ACCESS_KEY_ID=xxxxxxxxxxxxxxxxxxxx
AWS_SECRET_ACCESS_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

#### Azure Blob Storage
```bash
AZURE_STORAGE_ACCOUNT=propchainstorageaccount
AZURE_STORAGE_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
AZURE_BACKUP_CONTAINER=database-backups
```

#### GCP Cloud Storage
```bash
GCP_PROJECT_ID=propchain-prod
GCP_BACKUP_BUCKET=propchain-database-backups
GOOGLE_APPLICATION_CREDENTIALS=/app/credentials/gcp-key.json
```

### 4. Backup Replication Configuration

```bash
# Comma-separated list of storage locations
BACKUP_STORAGE_LOCATIONS=LOCAL,AWS_S3,AZURE_BLOB
```

### 5. Encryption Configuration

```bash
# Backup Encryption
DOCUMENT_BACKUP_ENCRYPTION=true
BACKUP_ENCRYPTION_KEY=your-256-bit-encryption-key-base64-encoded
BACKUP_ENCRYPTION_ALGORITHM=aes-256-cbc
```

### 6. Monitoring and Alerting Configuration

```bash
# Alert Channels
ALERT_CHANNELS=email,slack,pagerduty

# Email Alerts
ALERT_EMAIL_RECIPIENTS=backup-team@propchain.local,devops@propchain.local
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=noreply@propchain.local
SMTP_PASSWORD=xxxxxxxxxxxxxxxx

# Slack Alerts
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR_TEAM_ID/YOUR_APP_ID/YOUR_TOKEN
SLACK_CHANNEL=#backup-alerts

# PagerDuty Alerts
PAGERDUTY_INTEGRATION_KEY=xxxxxxxxxxxxxxxxxxxx
PAGERDUTY_SERVICE_ID=PXXXXXX
```

---

## Module Integration

### 1. Add to App Module

Update `src/app.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { BackupRecoveryModule } from './backup-recovery/backup-recovery.module';
// ... other imports

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    ScheduleModule.forRoot(),
    BackupRecoveryModule,
    // ... other modules
  ],
})
export class AppModule {}
```

### 2. Update package.json Scripts

```json
{
  "scripts": {
    "db:backup": "npm run build && node dist/backup-cli.js backup:full",
    "db:backup:incremental": "npm run build && node dist/backup-cli.js backup:incremental",
    "db:restore": "npm run build && node dist/backup-cli.js restore:latest staging",
    "db:verify": "npm run build && node dist/backup-cli.js backup:verify",
    "dr:test": "npm run build && node dist/backup-cli.js dr:test production_dr_plan",
    "dr:failover": "npm run build && node dist/backup-cli.js dr:failover production_dr_plan us-east-1"
  }
}
```

---

## Database Replication Setup

### 1. PostgreSQL Read Replica Configuration

```sql
-- On Primary Database
-- Create replication user
CREATE USER replication_user WITH REPLICATION ENCRYPTED PASSWORD 'secure_password';

-- Grant necessary permissions
GRANT CONNECT ON DATABASE propchain TO replication_user;
GRANT pg_monitor TO replication_user;

-- Update postgresql.conf
-- max_wal_senders = 10
-- wal_level = replica
-- max_replication_slots = 10

-- Create replication slot
SELECT * FROM pg_create_physical_replication_slot('replica_slot_1');
```

### 2. Create Read Replicas

```bash
# AWS RDS Example
aws rds create-db-instance-read-replica \
  --db-instance-identifier propchain-replica-us-west-2 \
  --source-db-instance-identifier propchain-prod \
  --db-instance-class db.t3.medium \
  --region us-west-2

# For EU region
aws rds create-db-instance-read-replica \
  --db-instance-identifier propchain-replica-eu-west-1 \
  --source-db-instance-identifier propchain-prod \
  --db-instance-class db.t3.medium \
  --region eu-west-1
```

---

## Initial Setup Steps

### 1. Create Backup Directory Structure

```bash
mkdir -p backups/{database,documents,dr-plans,dr-test-results,alerts,archive}
mkdir -p backups/database/{full,incremental,metadata,logs,snapshots,verification}
mkdir -p backups/documents/{snapshots,metadata,staging,verification}

chmod 700 backups  # Restrict access
```

### 2. Initialize Database Backups

```bash
# Run first full backup
npm run db:backup

# Wait for completion and verify
npm run db:verify

# List backups
curl -X GET http://localhost:3000/v1/backup-recovery/database/backups
```

### 3. Setup Document Backups

```bash
# Create first document backup
curl -X POST http://localhost:3000/v1/backup-recovery/documents/backup \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"tags": {"type": "initial", "reason": "setup"}}'

# Verify documentation backup
curl -X GET http://localhost:3000/v1/backup-recovery/documents/statistics
```

### 4. Create Disaster Recovery Plan

```bash
curl -X POST http://localhost:3000/v1/backup-recovery/disaster-recovery/plans \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "production_dr_plan",
    "name": "Production Disaster Recovery Plan",
    "rpo": "1h",
    "rto": "4h",
    "failoverRegions": ["us-west-2", "eu-west-1"],
    "healthCheckInterval": 300000,
    "automaticFailover": false,
    "notificationChannels": ["slack", "email"],
    "testInterval": 604800000
  }'
```

### 5. Run Initial DR Test

```bash
# Trigger DR test
curl -X POST http://localhost:3000/v1/backup-recovery/disaster-recovery/test/production_dr_plan \
  -H "Authorization: Bearer <token>"

# Monitor progress
curl -X GET http://localhost:3000/v1/backup-recovery/disaster-recovery/status \
  -H "Authorization: Bearer <token>"
```

---

## AWS Infrastructure Setup

### 1. S3 Bucket for Backups

```bash
# Create S3 bucket
aws s3api create-bucket \
  --bucket propchain-database-backups \
  --region us-east-1

# Enable versioning
aws s3api put-bucket-versioning \
  --bucket propchain-database-backups \
  --versioning-configuration Status=Enabled

# Configure lifecycle policy
aws s3api put-bucket-lifecycle-configuration \
  --bucket propchain-database-backups \
  --lifecycle-configuration '{
    "Rules": [
      {
        "Id": "ArchiveOldBackups",
        "Status": "Enabled",
        "Transitions": [
          {
            "Days": 30,
            "StorageClass": "STANDARD_IA"
          },
          {
            "Days": 90,
            "StorageClass": "GLACIER"
          }
        ],
        "Expiration": {
          "Days": 2555
        }
      }
    ]
  }'

# Enable server-side encryption
aws s3api put-bucket-encryption \
  --bucket propchain-database-backups \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "AES256"
      }
    }]
  }'
```

### 2. IAM Role for Backup Operations

```bash
# Create IAM policy
cat > backup-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject"
      ],
      "Resource": "arn:aws:s3:::propchain-database-backups/*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket"
      ],
      "Resource": "arn:aws:s3:::propchain-database-backups"
    },
    {
      "Effect": "Allow",
      "Action": [
        "rds:DescribeDBInstances",
        "rds:DescribeDBClusters",
        "rds:PromoteReadReplica"
      ],
      "Resource": "*"
    }
  ]
}
EOF

# Create role
aws iam create-role --role-name propchain-backup-role \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "ecs-tasks.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

# Attach policy
aws iam put-role-policy \
  --role-name propchain-backup-role \
  --policy-name propchain-backup-policy \
  --policy-document file://backup-policy.json
```

---

## Azure Infrastructure Setup

### 1. Create Storage Account

```bash
# Create resource group
az group create \
  --name propchain-backup-rg \
  --location eastus

# Create storage account
az storage account create \
  --name propchainstorageaccount \
  --resource-group propchain-backup-rg \
  --location eastus \
  --sku Standard_ZRS \
  --encryption-services blob

# Create blob container
az storage container create \
  --account-name propchainstorageaccount \
  --name database-backups \
  --public-access off

# Configure lifecycle policy
az storage account management-policy create \
  --account-name propchainstorageaccount \
  --resource-group propchain-backup-rg \
  --policy @lifecycle-policy.json
```

### 2. Configure Backup Replication

```bash
# Enable geo-redundant storage
az storage account update \
  --name propchainstorageaccount \
  --resource-group propchain-backup-rg \
  --sku Standard_GZRS  # Geo-Zone-Redundant Storage
```

---

## Monitoring Setup

### 1. CloudWatch Alarms (AWS)

```bash
# Backup failure alarm
aws cloudwatch put-metric-alarm \
  --alarm-name propchain-backup-failed \
  --alarm-description "Alert when backup fails" \
  --metric-name FunctionErrors \
  --namespace AWS/Lambda \
  --statistic Sum \
  --period 300 \
  --threshold 1 \
  --comparison-operator GreaterThanOrEqualToThreshold \
  --evaluation-periods 1 \
  --alarm-actions arn:aws:sns:us-east-1:123456789:backup-alerts
```

### 2. Slack Integration

Update Slack webhook in environment:

```bash
# Test Slack notification
curl -X POST https://hooks.slack.com/services/T00000000/B00000000/XXXX \
  -H 'Content-type: application/json' \
  -d '{
    "text": "Backup system online and monitoring",
    "blocks": [{
      "type": "section",
      "text": {"type": "mrkdwn", "text": "✅ Backup system initialized"}
    }]
  }'
```

---

## Testing

### 1. Run Unit Tests

```bash
npm run test -- backup-recovery
```

### 2. Integration Tests

```bash
npm run test:integration -- backup-recovery
```

### 3. Manual Backup Test

```bash
# Take manual backup
npm run db:backup

# Monitor in logs
tail -f logs/backup.log

# Verify
npm run db:verify
```

---

## Troubleshooting

### Issue: Backup timeout

**Solution**:
```sql
-- Check for long-running transactions
SELECT * FROM pg_stat_activity WHERE state != 'idle';

-- Cancel blocking transactions
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE state != 'idle';
```

### Issue: Storage space full

**Solution**:
```bash
# Enforce retention policies
curl -X POST http://localhost:3000/v1/backup-recovery/retention/enforce-policies

# Check backup sizes
du -sh backups/database/*
du -sh backups/documents/*
```

### Issue: Replication lag

**Solution**:
```sql
-- Check replication lag on primary
SELECT EXTRACT(EPOCH FROM (NOW() - pg_last_wal_receive_lsn())) AS lsn_lag;

-- Check replica status
SELECT * FROM pg_stat_replication;
```

---

## Maintenance Checklist

- [ ] Weekly: Verify backup integrity
- [ ] Monthly: Run full DR test
- [ ] Quarterly: Review and update DR plan
- [ ] Quarterly: Test point-in-time recovery
- [ ] Annually: Full restore to staging environment
- [ ] Continuously: Monitor alerts and resolve issues

---

## Support and Documentation

- **Backup Types**: See `backup.types.ts`
- **Service APIs**: See `BackupRecoveryController`
- **Operational Runbook**: See `DISASTER_RECOVERY_RUNBOOK.md`
- **API Documentation**: Generated via Swagger at `/api/docs`
