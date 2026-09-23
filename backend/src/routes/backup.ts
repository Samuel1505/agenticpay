/**
 * backup.ts — Issue #880
 *
 * Extended backup router that wraps BackupAutomationService:
 *
 *   POST /backup/trigger              Trigger a backup (full or incremental)
 *   GET  /backup/restore-points       List all restore points
 *   GET  /backup/restore-points/:id   Get a single restore point
 *   POST /backup/restore/:id          Initiate a restore from a restore point
 *   POST /backup/restore/:id/dry-run  Dry-run restore (validate chain only)
 *   GET  /backup/pitr                 PITR window info + recent entries
 *   GET  /backup/pitr/at              Lookup the best restore point for a time
 *
 * The legacy config / job / recovery-point CRUD endpoints below are retained
 * for backward compatibility.
 */
import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { backupAutomationService } from '../services/backup/BackupAutomationService.js';

export const backupRouter = Router();

// ── New endpoints (Issue #880) ────────────────────────────────────────────

/**
 * POST /backup/trigger
 *
 * Body: { type?: 'full' | 'incremental' }
 * Triggers a backup job immediately and returns the resulting BackupRecord.
 */
backupRouter.post('/trigger', asyncHandler(async (req, res) => {
  const type: 'full' | 'incremental' = req.body?.type === 'incremental' ? 'incremental' : 'full';

  const record = type === 'full'
    ? await backupAutomationService.runFullBackup()
    : await backupAutomationService.runIncrementalBackup();

  const httpStatus = record.status === 'completed' ? 200 : 500;
  res.status(httpStatus).json(record);
}));

/**
 * GET /backup/restore-points
 *
 * Returns all restore points, newest first.
 * Optional query params:
 *   limit (default 50)
 *   status ('available' | 'restoring' | 'restored' | 'failed')
 */
backupRouter.get('/restore-points', asyncHandler(async (req, res) => {
  const limitParam = req.query['limit'];
  const limit = Math.min(parseInt(String(limitParam ?? '50'), 10) || 50, 200);
  const statusFilter = req.query['status'] as string | undefined;

  let points = backupAutomationService.getRestorePoints();
  if (statusFilter) {
    points = points.filter((rp) => rp.status === statusFilter);
  }

  res.json({ restorePoints: points.slice(0, limit), total: points.length });
}));

/**
 * GET /backup/restore-points/:id
 */
backupRouter.get('/restore-points/:id', asyncHandler(async (req, res) => {
  const rp = backupAutomationService.getRestorePoint(req.params['id']!);
  if (!rp) {
    res.status(404).json({ error: 'Restore point not found' });
    return;
  }
  res.json(rp);
}));

/**
 * POST /backup/restore/:id
 *
 * Body: { targetDbUrl?: string }
 * Restores the database from the given restore point.
 * If targetDbUrl is provided, restores to that database instead of the default.
 */
backupRouter.post('/restore/:id', asyncHandler(async (req, res) => {
  const restorePointId = req.params['id']!;
  const targetDbUrl: string | undefined = req.body?.targetDbUrl;

  const rp = backupAutomationService.getRestorePoint(restorePointId);
  if (!rp) {
    res.status(404).json({ error: 'Restore point not found' });
    return;
  }

  const success = await backupAutomationService.restore(restorePointId, targetDbUrl);

  res.status(success ? 200 : 500).json({
    restorePointId,
    success,
    targetDbUrl: targetDbUrl ?? '(default)',
  });
}));

/**
 * POST /backup/restore/:id/dry-run
 *
 * Validates the full backup chain for restore point `id` without touching
 * any database.  Returns a structured report of what would happen.
 */
backupRouter.post('/restore/:id/dry-run', asyncHandler(async (req, res) => {
  const restorePointId = req.params['id']!;
  const result = await backupAutomationService.dryRunRestore(restorePointId);

  res.status(result.valid ? 200 : 400).json(result);
}));

/**
 * GET /backup/pitr
 *
 * Returns the PITR window configuration and the most recent entries.
 */
backupRouter.get('/pitr', asyncHandler(async (_req, res) => {
  const entries = backupAutomationService.getPitrEntries();
  res.json({
    windowHours: parseInt(process.env['BACKUP_PITR_WINDOW_HOURS'] ?? '168', 10),
    description: 'Point-in-time recovery entries within the configured window',
    supported: true,
    entryCount: entries.length,
    entries: entries.slice(0, 50),
  });
}));

/**
 * GET /backup/pitr/at?time=<ISO-8601>
 *
 * Returns the best restore point that can satisfy the given target time.
 */
backupRouter.get('/pitr/at', asyncHandler(async (req, res) => {
  const timeParam = req.query['time'] as string | undefined;
  if (!timeParam) {
    res.status(400).json({ error: 'Query param "time" (ISO-8601) is required' });
    return;
  }

  const targetTime = new Date(timeParam);
  if (isNaN(targetTime.getTime())) {
    res.status(400).json({ error: `Invalid date: "${timeParam}"` });
    return;
  }

  const entry = backupAutomationService.getPitrEntryAt(targetTime);
  if (!entry) {
    res.status(404).json({
      error: 'No PITR entry available at or before the requested time',
      requestedTime: targetTime.toISOString(),
    });
    return;
  }

  res.json({ entry, requestedTime: targetTime.toISOString() });
}));

/**
 * GET /backup/records
 *
 * Returns all backup records tracked by BackupAutomationService, newest first.
 */
backupRouter.get('/records', asyncHandler(async (req, res) => {
  const limitParam = req.query['limit'];
  const limit = Math.min(parseInt(String(limitParam ?? '50'), 10) || 50, 200);
  const typeFilter = req.query['type'] as string | undefined;

  let records = backupAutomationService.getAllBackups();
  if (typeFilter === 'full' || typeFilter === 'incremental') {
    records = records.filter((r) => r.type === typeFilter);
  }

  res.json({ records: records.slice(0, limit), total: records.length });
}));

/**
 * GET /backup/records/:id
 */
backupRouter.get('/records/:id', asyncHandler(async (req, res) => {
  const record = backupAutomationService.getBackup(req.params['id']!);
  if (!record) {
    res.status(404).json({ error: 'Backup record not found' });
    return;
  }
  res.json(record);
}));

interface BackupConfig {
  id: string;
  name: string;
  schedule: string;
  retentionDays: number;
  enabled: boolean;
  lastBackup?: Date;
  lastStatus?: 'success' | 'failed' | 'in_progress';
  lastSize?: number;
  lastError?: string;
}

interface RecoveryPoint {
  id: string;
  backupId: string;
  timestamp: Date;
  size: number;
  status: 'completed' | 'failed' | 'verifying';
  verificationPassed?: boolean;
}

interface BackupJob {
  id: string;
  configId: string;
  startTime: Date;
  endTime?: Date;
  status: 'running' | 'completed' | 'failed';
  size?: number;
  error?: string;
}

const backupConfigs: Map<string, BackupConfig> = new Map();
const recoveryPoints: RecoveryPoint[] = [];
const backupJobs: BackupJob[] = [];
const backupMetadata: Map<string, { encrypted: boolean; checksum: string; region: string }> = new Map();

const STORAGE_PROVIDERS = ['aws', 'gcp', 'azure'];
const DEFAULT_SCHEDULE = '0 2 * * *';
const DEFAULT_RETENTION_DAYS = 30;
const PITR_WINDOW_HOURS = 24;

backupConfigs.set('default', {
  id: 'default',
  name: 'Default Automated Backup',
  schedule: DEFAULT_SCHEDULE,
  retentionDays: DEFAULT_RETENTION_DAYS,
  enabled: true,
  lastBackup: new Date(),
  lastStatus: 'success',
  lastSize: 1024 * 1024 * 50,
});

function generateId(): string {
  return `backup_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

async function performBackup(config: BackupConfig): Promise<BackupJob> {
  const job: BackupJob = {
    id: generateId(),
    configId: config.id,
    startTime: new Date(),
    status: 'running',
  };

  config.lastStatus = 'in_progress';
  backupJobs.push(job);

  try {
    console.log(`[Backup] Starting backup for config: ${config.name}`);
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const size = Math.floor(Math.random() * 100000000) + 10000000;
    job.status = 'completed';
    job.endTime = new Date();
    job.size = size;

    config.lastBackup = new Date();
    config.lastStatus = 'success';
    config.lastSize = size;

    const recoveryPoint: RecoveryPoint = {
      id: generateId(),
      backupId: config.id,
      timestamp: new Date(),
      size,
      status: 'completed',
      verificationPassed: true,
    };
    recoveryPoints.push(recoveryPoint);

    console.log(`[Backup] Completed backup ${job.id}, size: ${size} bytes`);
  } catch (error) {
    job.status = 'failed';
    job.endTime = new Date();
    job.error = error instanceof Error ? error.message : 'Unknown error';
    config.lastStatus = 'failed';
    config.lastError = job.error;

    const recoveryPoint: RecoveryPoint = {
      id: generateId(),
      backupId: config.id,
      timestamp: new Date(),
      size: 0,
      status: 'failed',
    };
    recoveryPoints.push(recoveryPoint);
  }

  return job;
}

async function performRecovery(recoveryPointId: string): Promise<{ success: boolean; timeMs: number }> {
  const recoveryPoint = recoveryPoints.find(rp => rp.id === recoveryPointId);
  if (!recoveryPoint) {
    throw new Error('Recovery point not found');
  }

  const start = Date.now();
  recoveryPoint.status = 'verifying';

  await new Promise(resolve => setTimeout(resolve, 2000));

  recoveryPoint.status = 'completed';
  recoveryPoint.verificationPassed = true;

  const timeMs = Date.now() - start;
  console.log(`[Backup] Recovery completed in ${timeMs}ms`);

  return { success: true, timeMs };
}

backupRouter.get('/configs', asyncHandler(async (req, res) => {
  const configs = Array.from(backupConfigs.values());
  res.json({ configs });
}));

backupRouter.get('/configs/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const config = backupConfigs.get(id);
  if (!config) {
    res.status(404).json({ error: 'Backup config not found' });
    return;
  }
  res.json(config);
}));

backupRouter.post('/configs', asyncHandler(async (req, res) => {
  const { name, schedule, retentionDays, enabled } = req.body;
  
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  const id = generateId();
  const config: BackupConfig = {
    id,
    name,
    schedule: schedule || DEFAULT_SCHEDULE,
    retentionDays: retentionDays || DEFAULT_RETENTION_DAYS,
    enabled: enabled !== false,
  };

  backupConfigs.set(id, config);
  res.status(201).json(config);
}));

backupRouter.put('/configs/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, schedule, retentionDays, enabled } = req.body;
  
  const existing = backupConfigs.get(id);
  if (!existing) {
    res.status(404).json({ error: 'Backup config not found' });
    return;
  }

  const config: BackupConfig = {
    ...existing,
    name: name || existing.name,
    schedule: schedule || existing.schedule,
    retentionDays: retentionDays || existing.retentionDays,
    enabled: enabled !== undefined ? enabled : existing.enabled,
  };

  backupConfigs.set(id, config);
  res.json(config);
}));

backupRouter.delete('/configs/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  
  if (!backupConfigs.has(id)) {
    res.status(404).json({ error: 'Backup config not found' });
    return;
  }

  backupConfigs.delete(id);
  res.json({ success: true });
}));

backupRouter.post('/trigger/:configId', asyncHandler(async (req, res) => {
  const { configId } = req.params;
  const config = backupConfigs.get(configId);
  
  if (!config) {
    res.status(404).json({ error: 'Backup config not found' });
    return;
  }

  const job = await performBackup(config);
  res.json({
    jobId: job.id,
    status: job.status,
    startTime: job.startTime,
    endTime: job.endTime,
    size: job.size,
    error: job.error,
  });
}));

backupRouter.get('/jobs', asyncHandler(async (req, res) => {
  const { configId, status, limit = '50' } = req.query;
  
  let filtered = backupJobs;
  
  if (configId) {
    filtered = filtered.filter(j => j.configId === configId);
  }
  if (status) {
    filtered = filtered.filter(j => j.status === status);
  }
  
  const limitNum = Math.min(parseInt(limit as string, 10) || 50, 200);
  res.json({ jobs: filtered.slice(-limitNum) });
}));

backupRouter.get('/jobs/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const job = backupJobs.find(j => j.id === id);
  if (!job) {
    res.status(404).json({ error: 'Backup job not found' });
    return;
  }
  res.json(job);
}));

backupRouter.get('/recovery', asyncHandler(async (req, res) => {
  const { configId, from, to, limit = '50' } = req.query;
  
  let filtered = recoveryPoints;
  
  if (configId) {
    filtered = filtered.filter(rp => rp.configId === configId);
  }
  if (from) {
    const fromDate = new Date(from as string);
    filtered = filtered.filter(rp => new Date(rp.timestamp) >= fromDate);
  }
  if (to) {
    const toDate = new Date(to as string);
    filtered = filtered.filter(rp => new Date(rp.timestamp) <= toDate);
  }
  
  const limitNum = Math.min(parseInt(limit as string, 10) || 50, 200);
  res.json({ recoveryPoints: filtered.slice(-limitNum) });
}));

backupRouter.post('/recovery/:pointId', asyncHandler(async (req, res) => {
  const { pointId } = req.params;
  const { targetAddress } = req.body;

  const recoveryPoint = recoveryPoints.find(rp => rp.id === pointId);
  if (!recoveryPoint) {
    res.status(404).json({ error: 'Recovery point not found' });
    return;
  }

  const result = await performRecovery(pointId);
  res.json({
    recoveryPointId: pointId,
    targetAddress,
    success: result.success,
    recoveryTimeMs: result.timeMs,
    verified: recoveryPoint.verificationPassed,
  });
}));

backupRouter.post('/recovery/:pointId/verify', asyncHandler(async (req, res) => {
  const { pointId } = req.params;
  
  const recoveryPoint = recoveryPoints.find(rp => rp.id === pointId);
  if (!recoveryPoint) {
    res.status(404).json({ error: 'Recovery point not found' });
    return;
  }

  console.log(`[Backup] Verifying recovery point ${pointId}`);
  recoveryPoint.status = 'verifying';

  await new Promise(resolve => setTimeout(resolve, 1500));

  recoveryPoint.status = 'completed';
  recoveryPoint.verificationPassed = Math.random() > 0.1;

  res.json({
    recoveryPointId: pointId,
    status: recoveryPoint.status,
    verificationPassed: recoveryPoint.verificationPassed,
  });
}));

backupRouter.get('/pitr', asyncHandler(async (req, res) => {
  res.json({
    windowHours: PITR_WINDOW_HOURS,
    description: 'Point-in-time recovery available within last 24 hours',
    supported: true,
  });
}));

backupRouter.post('/test-recovery', asyncHandler(async (req, res) => {
  const { recoveryPointId } = req.body;
  
  if (!recoveryPointId) {
    res.status(400).json({ error: 'recoveryPointId is required' });
    return;
  }

  const recoveryPoint = recoveryPoints.find(rp => rp.id === recoveryPointId);
  if (!recoveryPoint) {
    res.status(404).json({ error: 'Recovery point not found' });
    return;
  }

  const start = Date.now();
  
  console.log(`[Backup] Testing disaster recovery from ${recoveryPointId}`);
  
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  const testResult = {
    success: true,
    recoveredData: {
      transactions: Math.floor(Math.random() * 1000),
      wallets: Math.floor(Math.random() * 100),
      invoices: Math.floor(Math.random() * 500),
    },
    timeMs: Date.now() - start,
    status: 'verified',
  };

  res.json({
    testId: generateId(),
    recoveryPointId,
    result: testResult,
  });
}));

backupRouter.get('/storage', asyncHandler(async (req, res) => {
  const { provider } = req.query;
  
  if (provider && !STORAGE_PROVIDERS.includes(provider as string)) {
    res.status(400).json({ error: 'Unsupported storage provider' });
    return;
  }

  const providers = provider 
    ? [{ name: provider, enabled: true, region: 'us-east-1' }]
    : STORAGE_PROVIDERS.map(p => ({ name: p, enabled: true, region: 'us-east-1' }));

  res.json({
    providers,
    defaultProvider: 'aws',
    encryption: { enabled: true, algorithm: 'AES-256' },
    crossRegionReplication: { enabled: true, targetRegion: 'us-west-2' },
  });
}));