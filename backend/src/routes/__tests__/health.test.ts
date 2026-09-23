import { describe, it, expect, vi, beforeEach } from 'vitest';
import { healthRouter } from '../health.js';
import { Request, Response, Router, RequestHandler } from 'express';
import { server as stellarServer } from '../../services/stellar.js';
import { getJobScheduler } from '../../jobs/index.js';
import { prisma } from '../../lib/prisma.js';

vi.mock('../../services/stellar.js', () => ({
  server: {
    root: vi.fn(),
  },
}));

vi.mock('../../jobs/index.js', () => ({
  getJobScheduler: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    $queryRaw: vi.fn(),
  },
}));

describe('Health Router', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let resJson: any;
  let resStatus: any;

  const getRouteHandler = (router: Router, path: string): RequestHandler => {
    const layer = router.stack.find((entry) => entry.route?.path === path);
    const handler = layer?.route?.stack[0]?.handle;

    if (!handler) {
      throw new Error(`Route handler not found for ${path}`);
    }

    return handler;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resJson = vi.fn();
    resStatus = vi.fn().mockReturnValue({ json: resJson });
    mockReq = {};
    mockRes = {
      status: resStatus,
    };
  });

  describe('GET /health', () => {
    it('returns 200 and healthy status when all dependencies are up', async () => {
      const mockedStellarRoot = vi.mocked(
        (stellarServer as unknown as { root: () => Promise<unknown> }).root
      );

      mockedStellarRoot.mockResolvedValue({});
      vi.mocked(getJobScheduler).mockReturnValue({} as any);
      process.env.OPENAI_API_KEY = 'test-key';

      const handler = getRouteHandler(healthRouter, '/health');
      await handler(mockReq as Request, mockRes as Response, vi.fn());

      expect(resStatus).toHaveBeenCalledWith(200);
      expect(resJson).toHaveBeenCalledWith(expect.objectContaining({
        status: 'healthy',
        dependencies: {
          stellar: 'healthy',
          openai: 'healthy',
          scheduler: 'healthy',
        },
      }));
    });

    it('returns 200 and degraded status when OpenAI is missing', async () => {
      const mockedStellarRoot = vi.mocked(
        (stellarServer as unknown as { root: () => Promise<unknown> }).root
      );

      mockedStellarRoot.mockResolvedValue({});
      vi.mocked(getJobScheduler).mockReturnValue({} as any);
      const originalKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      const handler = getRouteHandler(healthRouter, '/health');
      await handler(mockReq as Request, mockRes as Response, vi.fn());

      expect(resStatus).toHaveBeenCalledWith(200);
      expect(resJson).toHaveBeenCalledWith(expect.objectContaining({
        status: 'degraded',
        dependencies: {
          stellar: 'healthy',
          openai: 'unhealthy',
          scheduler: 'healthy',
        },
      }));

      process.env.OPENAI_API_KEY = originalKey;
    });

    it('returns 503 and unhealthy status when Stellar Horizon is down', async () => {
      const mockedStellarRoot = vi.mocked(
        (stellarServer as unknown as { root: () => Promise<unknown> }).root
      );

      mockedStellarRoot.mockRejectedValue(new Error('Horizon Down'));
      vi.mocked(getJobScheduler).mockReturnValue({} as any);
      process.env.OPENAI_API_KEY = 'test-key';

      const handler = getRouteHandler(healthRouter, '/health');
      await handler(mockReq as Request, mockRes as Response, vi.fn());

      expect(resStatus).toHaveBeenCalledWith(503);
      expect(resJson).toHaveBeenCalledWith(expect.objectContaining({
        status: 'unhealthy',
        dependencies: {
          stellar: 'unhealthy',
          openai: 'healthy',
          scheduler: 'healthy',
        },
      }));
    });
  });

  describe('GET /health/db', () => {
    it('returns 200 and healthy status when the database responds', async () => {
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ '?column?': 1 }]);

      const handler = getRouteHandler(healthRouter, '/health/db');
      await handler(mockReq as Request, mockRes as Response, vi.fn());

      expect(resStatus).toHaveBeenCalledWith(200);
      expect(resJson).toHaveBeenCalledWith(expect.objectContaining({
        status: 'healthy',
        connected: true,
      }));
    });

    it('returns 503 and unhealthy status when the database query fails', async () => {
      vi.mocked(prisma.$queryRaw).mockRejectedValue(new Error('connection refused'));

      const handler = getRouteHandler(healthRouter, '/health/db');
      await handler(mockReq as Request, mockRes as Response, vi.fn());

      expect(resStatus).toHaveBeenCalledWith(503);
      expect(resJson).toHaveBeenCalledWith(expect.objectContaining({
        status: 'unhealthy',
        connected: false,
        error: 'connection refused',
      }));
    });
  });

  describe('GET /ready', () => {
    it('returns 200 and ready status', async () => {
      const handler = getRouteHandler(healthRouter, '/ready');
      await handler(mockReq as Request, mockRes as Response, vi.fn());

      expect(resStatus).toHaveBeenCalledWith(200);
      expect(resJson).toHaveBeenCalledWith(expect.objectContaining({
        status: 'ready',
      }));
    });
  });
});
