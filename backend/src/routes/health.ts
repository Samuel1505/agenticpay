import { Router, Request, Response } from 'express';
import { server as stellarServer } from '../services/stellar.js';
import { getJobScheduler } from '../jobs/index.js';
import { prisma } from '../lib/prisma.js';
import { DatabasePoolManager } from '../db/pool.js';

export const healthRouter = Router();

type HorizonHealthServer = {
  root: () => Promise<unknown>;
};

const horizonHealthServer = stellarServer as unknown as HorizonHealthServer;

/**
 * @openapi
 * /health:
 *   get:
 *     summary: Get service health status
 *     responses:
 *       200:
 *         description: Service is healthy or degraded
 *       503:
 *         description: Service is unhealthy
 */
healthRouter.get('/health', async (_req: Request, res: Response) => {
  const start = Date.now();
  
  const checks = {
    stellar: false,
    openai: false,
    scheduler: false,
  };

  try {
    // 1. Stellar Horizon Check (with timeout)
    const stellarCheck = horizonHealthServer
      .root()
      .then(() => true)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn('Stellar health check failed:', message);
        return false;
      });

    // 2. OpenAI Configuration Check
    checks.openai = !!process.env.OPENAI_API_KEY;

    // 3. Scheduler Initialization Check
    checks.scheduler = !!getJobScheduler();

    // Race Stellar check against a 800ms timeout to keep health check fast
    checks.stellar = await Promise.race([
      stellarCheck,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 800))
    ]) as boolean;

  } catch (error) {
    console.error('Unexpected error during health check:', error);
  }

  const dependencies = {
    stellar: checks.stellar ? 'healthy' : 'unhealthy',
    openai: checks.openai ? 'healthy' : 'unhealthy',
    scheduler: checks.scheduler ? 'healthy' : 'unhealthy',
  };

  const isUnhealthy = dependencies.stellar === 'unhealthy' || dependencies.scheduler === 'unhealthy';
  const isDegraded = dependencies.openai === 'unhealthy';

  let overallStatus = 'healthy';
  if (isUnhealthy) {
    overallStatus = 'unhealthy';
  } else if (isDegraded) {
    overallStatus = 'degraded';
  }

  res.status(overallStatus === 'unhealthy' ? 503 : 200).json({
    status: overallStatus,
    service: 'agenticpay-backend',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    dependencies,
    latency_ms: Date.now() - start
  });
});

/**
 * @openapi
 * /health/db:
 *   get:
 *     summary: Database connectivity and pool health check
 *     responses:
 *       200:
 *         description: Database is reachable
 *       503:
 *         description: Database is unreachable
 *
 * Issue #886: Build database health check endpoint.
 * Runs a real `SELECT 1` against Postgres (not just "is the client
 * configured") and reports latency alongside connection pool stats so
 * this can be wired into readiness probes and dashboards.
 */
healthRouter.get('/health/db', async (_req: Request, res: Response) => {
  const start = Date.now();
  let connected = false;
  let error: string | undefined;

  try {
    await prisma.$queryRaw`SELECT 1`;
    connected = true;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error('Database health check failed:', error);
  }

  const latencyMs = Date.now() - start;
  const pool = DatabasePoolManager.getInstance();
  const poolStats = pool.getStats();

  const status: 'healthy' | 'degraded' | 'unhealthy' = !connected
    ? 'unhealthy'
    : latencyMs > 500
      ? 'degraded'
      : 'healthy';

  res.status(connected ? 200 : 503).json({
    status,
    connected,
    latency_ms: latencyMs,
    pool: poolStats,
    ...(error ? { error } : {}),
    timestamp: new Date().toISOString(),
  });
});

/**
 * @openapi
 * /ready:
 *   get:
 *     summary: Kubernetes readiness probe
 *     responses:
 *       200:
 *         description: Service is ready
 */
healthRouter.get('/ready', (_req: Request, res: Response) => {
  // Application is ready if the router is mounted and responding
  res.status(200).json({
    status: 'ready',
    timestamp: new Date().toISOString()
  });
});
