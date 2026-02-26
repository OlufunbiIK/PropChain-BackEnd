# Backup and Disaster Recovery System - Operational Runbooks

## Table of Contents

1. [Database Backup Operations](#database-backup-operations)
2. [Document Backup Operations](#document-backup-operations)
3. [Disaster Recovery Procedures](#disaster-recovery-procedures)
4. [Emergency Recovery Steps](#emergency-recovery-steps)
5. [Monitoring and Alerting](#monitoring-and-alerting)
6. [Incident Response](#incident-response)

---

## Database Backup Operations

### 1. Manual Full Database Backup

**Purpose**: Create a complete point-in-time snapshot of the production database

**Procedure**:

```bash
# Using API
curl -X POST http://localhost:3000/v1/backup-recovery/database/backup/full \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "tags": {
      "type": "manual",
      "reason": "pre-deployment",
      "operator": "admin@propchain.local"
    }
  }'

# Using CLI
npm run db:backup
```

**Expected Outcome**:
- HTTP Status: 202 (Accepted)
- Response includes backup ID, timestamp, and estimated duration
- Backup process runs asynchronously in background
- Monitor progress via `/backup-recovery/database/backups/:backupId`

**Troubleshooting**:
- If backup times out (>30 minutes), check database locks: `SELECT * FROM pg_locks;`
- If storage space insufficient, run retention policies: `POST /backup-recovery/retention/enforce-policies`

---

### 2. Verify Database Backup Integrity

**Purpose**: Ensure backup is restorable and not corrupted

**Procedure**:

```bash
# Trigger verification
curl -X POST http://localhost:3000/v1/backup-recovery/verification/verify/:backupId \
  -H "Authorization: Bearer <token>"

# Get verification results
curl -X GET http://localhost:3000/v1/backup-recovery/verification/:backupId \
  -H "Authorization: Bearer <token>"
```

**Expected Results**:
- Checksum verification: PASSED
- File accessibility: Accessible
- Restorability test: Restorable
- Duration: <5 minutes

**If Verification Fails**:
1. Check backup file exists: `ls -lh backups/database/full/:backupId.dump`
2. Check file permissions: `stat backups/database/full/:backupId.dump`
3. Test database connectivity
4. Recreate backup if corrupted

---

### 3. Point-in-Time Recovery (PITR)

**Purpose**: Restore database to a specific point in time

**Procedure**:

```bash
# Step 1: Get PITR information for target timestamp
curl -X GET "http://localhost:3000/v1/backup-recovery/recovery/point-in-time/2024-01-15T14:30:00Z" \
  -H "Authorization: Bearer <token>"

# Step 2: Initiate PITR
curl -X POST http://localhost:3000/v1/backup-recovery/disaster-recovery/point-in-time-recovery \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "targetTimestamp": "2024-01-15T14:30:00Z",
    "backupId": "full_1705329600000_abc123",
    "targetEnvironment": "staging"
  }'

# Step 3: Monitor recovery progress
curl -X GET http://localhost:3000/v1/backup-recovery/disaster-recovery/status \
  -H "Authorization: Bearer <token>"
```

**Expected Duration**: 20-45 minutes (depending on database size)

**Validation**:
- Check record counts match expected values
- Query known data points
- Verify application can connect
- Test critical business flows

**Rollback**:
- If recovery fails, promote previous replica
- Issue: `POST /backup-recovery/disaster-recovery/failover` to alternate region

---

### 4. Backup Retention Policy

**Policy**:
- Daily full backups: Retain 30 days
- Incremental backups: Retain 7 days
- Weekly point-in-time: Retain 12 weeks
- Monthly snapshots: Retain 12 months
- Archived backups: Retain 7 years (cold storage)

**Automatic Enforcement**:
- Runs daily at 01:00 UTC
- Old backups automatically deleted
- Expired backups moved to archive storage

**Manual Enforcement**:

```bash
curl -X POST http://localhost:3000/v1/backup-recovery/retention/enforce-policies \
  -H "Authorization: Bearer <token>"
```

---

## Document Backup Operations

### 1. Manual Document Backup

**Purpose**: Backup all user-uploaded documents

**Procedure**:

```bash
curl -X POST http://localhost:3000/v1/backup-recovery/documents/backup \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "tags": {
      "type": "manual",
      "reason": "audit"
    }
  }'
```

**Locations Replicated To**:
- Local storage: `backups/documents/snapshots/`
- Azure Blob Storage: `document-backups/2024/01/`
- AWS S3: `s3://propchain-backups/document-backups/2024/01/`

---

### 2. Verify Document Backup

**Purpose**: Ensure all documents are properly backed up

**Procedure**:

```bash
# Trigger verification
curl -X POST http://localhost:3000/v1/backup-recovery/documents/backups/:backupId/verify \
  -H "Authorization: Bearer <token>"

# Get statistics
curl -X GET http://localhost:3000/v1/backup-recovery/documents/statistics \
  -H "Authorization: Bearer <token>"
```

**Verification Checks**:
- Archive integrity
- Manifest validity
- File checksums
- All data accessible

---

### 3. Restore Document from Backup

**Procedure**:

```bash
# 1. Extract backup archive
tar -xzf backups/documents/snapshots/docs_1705329600000_abc123.tar.gz

# 2. Verify manifest
cat backups/documents/snapshots/docs_1705329600000_abc123/MANIFEST.json

# 3. Restore specific document
cp -r docs_backup/document_id/* uploads/documents/document_id/

# 4. Verify restoration
curl -X GET http://localhost:3000/v1/documents/document_id \
  -H "Authorization: Bearer <token>"
```

---

## Disaster Recovery Procedures

### 1. Create Disaster Recovery Plan

**Purpose**: Define recovery strategy for critical failures

**Procedure**:

```bash
curl -X POST http://localhost:3000/v1/backup-recovery/disaster-recovery/plans \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "production_dr_plan",
    "name": "Production Disaster Recovery Plan",
    "rpo": "1h",
    "rto": "4h",
    "failoverRegions": ["us-east-1", "eu-west-1"],
    "healthCheckInterval": 300000,
    "automaticFailover": false,
    "notificationChannels": ["slack", "email"],
    "testInterval": 604800000
  }'
```

**Parameters**:
- **RPO** (Recovery Point Objective): Maximum acceptable data loss (1 hour = max 1 hour of data loss)
- **RTO** (Recovery Time Objective): Maximum acceptable downtime (4 hours)
- **failoverRegions**: Ordered list of fallback regions
- **automaticFailover**: Enable automated failover (false = manual only)

---

### 2. Automated DR Testing

**Purpose**: Validate recovery procedures without impacting production

**Procedure**:

```bash
# Trigger manual DR test
curl -X POST http://localhost:3000/v1/backup-recovery/disaster-recovery/test/production_dr_plan \
  -H "Authorization: Bearer <token>"

# Monitor test progress
curl -X GET http://localhost:3000/v1/backup-recovery/disaster-recovery/status \
  -H "Authorization: Bearer <token>"
```

**Test Steps**:
1. Create isolated test environment
2. Restore latest production backup
3. Run application smoke tests
4. Validate data consistency
5. Cleanup test environment

**Expected Duration**: 30-60 minutes

**Review Results**:
```bash
curl -X GET http://localhost:3000/v1/backup-recovery/verification/lifecycle-stats \
  -H "Authorization: Bearer <token>"
```

---

### 3. Manual Failover to Alternate Region

**Purpose**: Redirect traffic to standby region during primary region failure

**Prerequisites**:
- Verify DR plan exists and is active
- Confirm target region has current replica
- Notify stakeholders

**Procedure**:

```bash
# Step 1: Initiate failover
curl -X POST http://localhost:3000/v1/backup-recovery/disaster-recovery/failover \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "planId": "production_dr_plan",
    "targetRegion": "us-east-1"
  }'

# Response:
# {
#   "status": "INITIATED",
#   "failoverStartTime": "2024-01-15T10:00:00Z",
#   "estimatedCompletionTime": "2024-01-15T10:30:00Z"
# }

# Step 2: Monitor failover progress
curl -X GET http://localhost:3000/v1/backup-recovery/disaster-recovery/status \
  -H "Authorization: Bearer <token>"
```

**Failover Sequence**:
1. ✅ Notify stakeholders via all channels
2. ✅ Prepare target infrastructure
3. ✅ Promote read replica to primary
4. ✅ Update DNS records (TTL: 60 seconds)
5. ✅ Validate application connectivity
6. ✅ Monitor health checks
7. ✅ Confirm failover success

**Expected Duration**: 10-15 minutes

**Post-Failover**:
- Monitor application metrics for 30 minutes
- Verify all integrations are working
- Update status page
- Begin primary region investigation

---

## Emergency Recovery Steps

### Scenario 1: Complete Database Failure (Primary Region)

**Symptoms**:
- Database connection errors from all applications
- Health checks failing
- No backups in primary region

**Recovery Steps**:

```bash
# Step 1: Assess situation
curl -X GET http://localhost:3000/v1/backup-recovery/disaster-recovery/status

# Step 2: Verify backup availability in alternate regions
curl -X GET http://localhost:3000/v1/backup-recovery/database/backups?status=VERIFIED

# Step 3: Initiate failover
curl -X POST http://localhost:3000/v1/backup-recovery/disaster-recovery/failover \
  -H "Authorization: Bearer <token>" \
  -d '{"planId": "production_dr_plan", "targetRegion": "eu-west-1"}'

# Step 4: Monitor restoration
curl -X GET http://localhost:3000/v1/backup-recovery/disaster-recovery/status

# Step 5: Investigate primary region
# - Check RDS status in AWS console
# - Review CloudWatch logs
# - Check storage capacity
# - Verify network connectivity
```

**RTO: 15-30 minutes**

---

### Scenario 2: Data Corruption or Ransomware

**Symptoms**:
- Unusual data modifications
- Large-scale deletions
- Unknown encryption applied

**Recovery Steps**:

```bash
# Step 1: IMMEDIATELY isolate affected systems
# - Stop replication
# - Block database access except for recovery team
# - Capture forensics from affected nodes

# Step 2: Find last known-good backup
curl -X GET http://localhost:3000/v1/backup-recovery/recovery/point-in-time/$(date -d '1 hour ago' --rfc-3339=seconds) \
  -H "Authorization: Bearer <token>"

# Step 3: Perform point-in-time recovery to staging
curl -X POST http://localhost:3000/v1/backup-recovery/disaster-recovery/point-in-time-recovery \
  -H "Authorization: Bearer <token>" \
  -d '{
    "targetTimestamp": "2024-01-15T09:00:00Z",
    "backupId": "full_1705329600000_abc123",
    "targetEnvironment": "forensics"
  }'

# Step 4: Validate recovered data
# - Sample data queries
# - Application connectivity
# - No corruption indicators

# Step 5: If validated, promote to production
# - DNS update
# - Monitor
# - Communication with users

# Step 6: Forensic analysis
# - Review audit logs
# - Identify attack vector
# - Update security policies
```

**RTO: 1-2 hours**

---

### Scenario 3: Document Storage Failure

**Symptoms**:
- Document download failures
- Storage replication errors
- High latency

**Recovery Steps**:

```bash
# Step 1: Check backup status
curl -X GET http://localhost:3000/v1/backup-recovery/documents/statistics

# Step 2: Identify affected documents
curl -X GET http://localhost:3000/v1/documents?status=failed

# Step 3: Restore from latest backup
# Extract backup archive and restore missing documents
tar -xzf backups/documents/snapshots/docs_latest.tar.gz
cp -r docs_backup/* uploads/documents/

# Step 4: Verify restoration
curl -X GET http://localhost:3000/v1/backup-recovery/documents/backups/:backupId/verify

# Step 5: Resume normal operations
```

**RTO: 30 minutes**

---

## Monitoring and Alerting

### 1. Critical Alerts

**Alert**: Backup Failed (CRITICAL)
- **Action**: Immediate investigation required
- **Steps**: 
  ```bash
  curl -X GET http://localhost:3000/v1/backup-recovery/monitoring/alerts?severity=CRITICAL
  ```

**Alert**: Backup Timeout (CRITICAL)
- **Action**: Kill backup process, investigate database locks, restart backup
  
**Alert**: Storage Full (CRITICAL)
- **Action**: Run retention policies immediately or expand storage

---

### 2. Monitoring Dashboard

Access operational metrics:

```bash
curl -X GET http://localhost:3000/v1/backup-recovery/monitoring/dashboard \
  -H "Authorization: Bearer <token>"

# Response includes:
# {
#   "alerts": { "critical": 0, "high": 1, "total": 2 },
#   "recentBackups": [...]
#   "systemHealth": { "status": "HEALTHY" }
# }
```

---

### 3. Alert Management

```bash
# Acknowledge alert
curl -X POST http://localhost:3000/v1/backup-recovery/monitoring/alerts/:alertId/acknowledge \
  -H "Authorization: Bearer <token>" \
  -d '{"acknowledgedBy": "admin@propchain.local"}'

# Resolve alert
curl -X POST http://localhost:3000/v1/backup-recovery/monitoring/alerts/:alertId/resolve \
  -H "Authorization: Bearer <token>"
```

---

## Incident Response

### Incident Severity Levels

| Level | Response Time | Escalation |
|-------|--------------|------------|
| P1 - Critical | 15 minutes | VP Engineering + DevOps |
| P2 - High | 30 minutes | Engineering Lead + DevOps |
| P3 - Medium | 1 hour | DevOps Team |
| P4 - Low | 4 hours | DevOps Team |

---

### Incident Communication Template

```
Subject: [INCIDENT] Backup System - <Issue Description>

SEVERITY: P<1-4>
START_TIME: <UTC timestamp>
IMPACT: <number of users affected, %>
ESTIMATED_RECOVERY: <time estimate>

STATUS: <INVESTIGATING|IN_PROGRESS|MONITORING|RESOLVED>

SUMMARY:
<Brief description of issue>

ACTIONS:
- <Action 1>
- <Action 2>

NEXT_UPDATE: <timestamp + 30 min>

Contact: <on-call engineer>
```

---

### Post-Incident Review

After resolving incidents:

1. **Document findings**: Root cause analysis
2. **Timeline**: Exact sequence of events
3. **Impact**: Data affected, users impacted
4. **Response**: Actions taken and their effectiveness
5. **Prevention**: Changes to prevent recurrence
6. **Recommendation**: Process improvements

---

## Contact Information

- **On-Call DevOps**: +1-XXX-XXX-XXXX
- **Backup System Owner**: backup-oncall@propchain.local
- **Escalation**: infrastructure-oncall@propchain.local
- **Status Page**: status.propchain.local
- **Slack Channel**: #incident-response

---

## Quick Reference

```bash
# Emergency failover
POST /backup-recovery/disaster-recovery/failover

# Trigger immediate backup
POST /backup-recovery/database/backup/full

# Check system health
GET /backup-recovery/monitoring/dashboard

# List critical alerts
GET /backup-recovery/monitoring/alerts?severity=CRITICAL

# Get point-in-time recovery information
GET /backup-recovery/recovery/point-in-time/:timestamp

# Verify all backups
POST /backup-recovery/verification/verify-all

# Enforce retention policies
POST /backup-recovery/retention/enforce-policies
```

---
