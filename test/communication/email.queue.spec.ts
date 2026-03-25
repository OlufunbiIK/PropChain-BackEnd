import Bull from 'bull';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { EmailQueueService } from '../../src/communication/email/email.queue';

const createQueueMock = () => ({
  add: jest.fn().mockResolvedValue({ id: 'job-1' }),
  process: jest.fn(),
  on: jest.fn(),
  removeListener: jest.fn(),
  close: jest.fn().mockResolvedValue(undefined),
  clean: jest.fn().mockResolvedValue(undefined),
  getWaiting: jest.fn().mockResolvedValue([]),
  getActive: jest.fn().mockResolvedValue([]),
  getCompleted: jest.fn().mockResolvedValue([]),
  getFailed: jest.fn().mockResolvedValue([]),
  pause: jest.fn(),
  resume: jest.fn(),
  getJob: jest.fn(),
});

const queueMocks = [createQueueMock(), createQueueMock(), createQueueMock()];

jest.mock('bull', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => queueMocks.shift()),
  };
});


describe('EmailQueueService', () => {
  beforeAll(() => {
    // Suppress ALL Logger messages for this test suite
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'verbose').mockImplementation(() => {});
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });


  beforeEach(() => {

    jest.useFakeTimers();
    jest.clearAllMocks();
    queueMocks.splice(0, queueMocks.length, createQueueMock(), createQueueMock(), createQueueMock());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const createConfigService = () =>
    ({
      get: jest.fn((key: string, fallback: any) => {
        const values: Record<string, any> = {
          EMAIL_JOB_TIMEOUT_MS: 25,
          EMAIL_QUEUE_MEMORY_MONITOR_INTERVAL_MS: 1000,
          EMAIL_QUEUE_MEMORY_WARNING_MB: 1,
          EMAIL_QUEUE_CLEANUP_INTERVAL_MS: 1000,
          EMAIL_QUEUE_REMOVE_ON_COMPLETE: 10,
          EMAIL_QUEUE_REMOVE_ON_FAIL: 5,
          REDIS_HOST: 'localhost',
          REDIS_PORT: 6379,
          REDIS_DB: 0,
        };

        return values[key] ?? fallback;
      }),
    }) as unknown as ConfigService;

  it('applies timeout defaults when adding jobs', async () => {
    const mockEmailQueue = createQueueMock() as any;
    const mockBatchQueue = createQueueMock() as any;
    const mockPriorityQueue = createQueueMock() as any;

    const service = new EmailQueueService(
      createConfigService(),
      mockEmailQueue,
      mockBatchQueue,
      mockPriorityQueue,
    );

    await service.add('default', { type: 'single', data: {} });

    expect(mockEmailQueue.add).toHaveBeenCalledWith(
      { type: 'single', data: {} },
      expect.objectContaining({
        timeout: 25,
      }),
    );
  });

  it('fails jobs that exceed the configured timeout', async () => {
    const mockEmailQueue = createQueueMock() as any;
    const mockBatchQueue = createQueueMock() as any;
    const mockPriorityQueue = createQueueMock() as any;

    const service = new EmailQueueService(
      createConfigService(),
      mockEmailQueue,
      mockBatchQueue,
      mockPriorityQueue,
    );

    jest
      .spyOn<any, any>(service as any, 'processSingleEmail')
      .mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ success: true }), 100)),
      );

    const pending = service.processEmailJob({
      id: 'job-timeout',
      data: { type: 'single', data: {} },
    });

    await jest.advanceTimersByTimeAsync(30);
    const result = await pending;

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  });

  it('removes listeners and clears monitors during shutdown', async () => {
    const mockEmailQueue = createQueueMock() as any;
    const mockBatchQueue = createQueueMock() as any;
    const mockPriorityQueue = createQueueMock() as any;

    const service = new EmailQueueService(
      createConfigService(),
      mockEmailQueue,
      mockBatchQueue,
      mockPriorityQueue,
    );

    await service.onModuleDestroy();

    expect(mockEmailQueue.removeListener).toHaveBeenCalled();
    expect(mockPriorityQueue.removeListener).toHaveBeenCalled();
    expect(mockBatchQueue.removeListener).toHaveBeenCalled();
    expect(mockEmailQueue.close).toHaveBeenCalled();
    expect(mockPriorityQueue.close).toHaveBeenCalled();
    expect(mockBatchQueue.close).toHaveBeenCalled();
  });
});