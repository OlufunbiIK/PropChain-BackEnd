import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bull';

/**
 * Email Queue Service
 *
 * Handles email queuing, scheduling, and batch processing
 */
@Injectable()
export class EmailQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(EmailQueueService.name);
  private readonly jobTimeoutMs: number;
  private readonly memoryMonitorIntervalMs: number;
  private readonly memoryWarningThresholdMb: number;
  private readonly completedJobRetention: number;
  private readonly failedJobRetention: number;
  private memoryMonitor: NodeJS.Timeout | null = null;
  private queueCleanupMonitor: NodeJS.Timeout | null = null;
  private readonly listenerDisposers: Array<() => void> = [];

  constructor(
    private readonly configService: ConfigService,
    @InjectQueue('email') private readonly emailQueue: Queue,
    @InjectQueue('email-batch') private readonly batchQueue: Queue,
    @InjectQueue('email-priority') private readonly priorityQueue: Queue,
  ) {
    this.jobTimeoutMs = this.configService.get<number>('EMAIL_JOB_TIMEOUT_MS', 30000);
    this.memoryMonitorIntervalMs = this.configService.get<number>('EMAIL_QUEUE_MEMORY_MONITOR_INTERVAL_MS', 60000);
    this.memoryWarningThresholdMb = this.configService.get<number>('EMAIL_QUEUE_MEMORY_WARNING_MB', 512);
    this.completedJobRetention = this.configService.get<number>('EMAIL_QUEUE_REMOVE_ON_COMPLETE', 100);
    this.failedJobRetention = this.configService.get<number>('EMAIL_QUEUE_REMOVE_ON_FAIL', 50);
    this.startMemoryMonitoring();
    this.startQueueCleanupMonitoring();
    this.setupEventListeners();
  }

  /**
   * Add email to queue
   */
  async add<T = any>(queueName: string, data: T, options?: any): Promise<string> {
    const queue = this.getQueue(queueName);

    try {
      const job = await queue.add(data, {
        attempts: options?.attempts || 3,
        backoff: options?.backoff || 'exponential',
        delay: options?.delay || 0,
        priority: options?.priority || 0,
        timeout: options?.timeout || this.jobTimeoutMs,
        removeOnComplete: options?.removeOnComplete !== false,
        removeOnFail: options?.removeOnFail !== false,
      });

      this.logger.log(`Added job to ${queueName} queue`, {
        jobId: job.id,
        queueName,
        data: typeof data === 'object' ? Object.keys(data as object) : data,
      });

      return job.id?.toString() || '';
    } catch (error) {
      this.logger.error(`Failed to add job to ${queueName} queue`, error);
      throw error;
    }
  }

  /**
   * Add high priority email
   */
  async addHighPriority(emailData: any): Promise<string> {
    return this.add('priority', emailData, {
      priority: 10,
      attempts: 5,
    });
  }

  /**
   * Add scheduled email
   */
  async addScheduled(emailData: any, scheduledFor: Date): Promise<string> {
    const delay = scheduledFor.getTime() - Date.now();

    if (delay <= 0) {
      return this.add('default', emailData);
    }

    return this.add('default', emailData, {
      delay,
      attempts: 3,
    });
  }

  /**
   * Add batch email job
   */
  async addBatch(batchData: BatchEmailJobData): Promise<string> {
    return this.add('batch', batchData, {
      attempts: 2,
      backoff: 'fixed',
      delay: 0,
    });
  }

  /**
   * Process email job
   */
  async processEmailJob(job: any): Promise<EmailJobResult> {
    const startTime = Date.now();
    const startingMemory = this.getMemoryUsageSnapshot();

    try {
      this.logger.log(`Processing email job`, {
        jobId: job.id,
        type: job.data.type,
      });

      const result = await this.withJobTimeout(job, async () => {
        switch (job.data.type) {
          case 'single':
            return this.processSingleEmail(job.data);
          case 'batch':
            return this.processBatchEmail(job.data);
          case 'scheduled':
            return this.processScheduledEmail(job.data);
          default:
            throw new Error(`Unknown job type: ${job.data.type}`);
        }
      });

      const processingTime = Date.now() - startTime;
      const endingMemory = this.getMemoryUsageSnapshot();

      this.logger.log(`Email job completed successfully`, {
        jobId: job.id,
        processingTime,
        result: result.success ? 'success' : 'failed',
        memoryDeltaMb: endingMemory.heapUsedMb - startingMemory.heapUsedMb,
      });

      return {
        ...result,
        processingTime,
        jobId: job.id,
      };
    } catch (error) {
      const processingTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      this.logger.error(`Email job failed`, errorMessage, {
        jobId: job.id,
        processingTime,
      });

      return {
        success: false,
        error: errorMessage,
        processingTime,
        jobId: job.id,
      };
    } finally {
      await this.cleanupJobResources(job);
    }
  }

  /**
   * Get queue statistics
   */
  async getQueueStats(queueName: string): Promise<QueueStats> {
    const queue = this.getQueue(queueName);

    try {
      const waiting = await queue.getWaiting();
      const active = await queue.getActive();
      const completed = await queue.getCompleted();
      const failed = await queue.getFailed();

      return {
        queueName,
        waiting: waiting.length,
        active: active.length,
        completed: completed.length,
        failed: failed.length,
        total: waiting.length + active.length,
      };
    } catch (error) {
      this.logger.error(`Failed to get queue stats for ${queueName}`, error);
      return {
        queueName,
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        total: 0,
      };
    }
  }

  /**
   * Get all queue statistics
   */
  async getAllQueueStats(): Promise<AllQueueStats> {
    const [defaultStats, priorityStats, batchStats] = await Promise.all([
      this.getQueueStats('default'),
      this.getQueueStats('priority'),
      this.getQueueStats('batch'),
    ]);

    return {
      default: defaultStats,
      priority: priorityStats,
      batch: batchStats,
      total: {
        queueName: 'total',
        waiting: defaultStats.waiting + priorityStats.waiting + batchStats.waiting,
        active: defaultStats.active + priorityStats.active + batchStats.active,
        completed: defaultStats.completed + priorityStats.completed + batchStats.completed,
        failed: defaultStats.failed + priorityStats.failed + batchStats.failed,
        total: defaultStats.total + priorityStats.total + batchStats.total,
      },
    };
  }

  /**
   * Pause queue
   */
  async pauseQueue(queueName: string): Promise<void> {
    const queue = this.getQueue(queueName);
    await queue.pause();
    this.logger.log(`Paused ${queueName} queue`);
  }

  /**
   * Resume queue
   */
  async resumeQueue(queueName: string): Promise<void> {
    const queue = this.getQueue(queueName);
    await queue.resume();
    this.logger.log(`Resumed ${queueName} queue`);
  }

  /**
   * Clear queue
   */
  async clearQueue(queueName: string): Promise<void> {
    const queue = this.getQueue(queueName);
    await queue.clean(0, 'completed');
    await queue.clean(0, 'failed');
    this.logger.log(`Cleared ${queueName} queue`);
  }

  /**
   * Retry failed jobs
   */
  async retryFailedJobs(queueName: string): Promise<number> {
    const queue = this.getQueue(queueName);
    const failed = await queue.getFailed();

    let retryCount = 0;
    for (const job of failed) {
      try {
        await job.retry();
        retryCount++;
      } catch (error) {
        this.logger.error(`Failed to retry job ${job.id}`, error);
      }
    }

    this.logger.log(`Retried ${retryCount} failed jobs in ${queueName} queue`);
    return retryCount;
  }

  /**
   * Get job by ID
   */
  async getJob(queueName: string, jobId: string): Promise<any> {
    const queue = this.getQueue(queueName);
    return await queue.getJob(jobId);
  }

  /**
   * Remove job
   */
  async removeJob(queueName: string, jobId: string): Promise<boolean> {
    const queue = this.getQueue(queueName);

    try {
      const job = await queue.getJob(jobId);
      if (job) {
        await job.remove();
        this.logger.log(`Removed job ${jobId} from ${queueName} queue`);
        return true;
      }
      return false;
    } catch (error) {
      this.logger.error(`Failed to remove job ${jobId} from ${queueName} queue`, error);
      return false;
    }
  }

  /**
   * Process single email job
   */
  private async processSingleEmail(_jobData: SingleEmailJobData): Promise<EmailJobResult> {
    await this.delay(Math.random() * 1000 + 500); // 500-1500ms

    return {
      success: true,
      emailId: this.generateEmailId(),
      provider: 'smtp',
      messageId: `msg_${Date.now()}`,
    };
  }

  /**
   * Process batch email job
   */
  private async processBatchEmail(jobData: BatchEmailJobData): Promise<EmailJobResult> {
    const { emails, options } = jobData;
    const results: any[] = [];
    let successCount = 0;
    let failureCount = 0;

    for (const email of emails) {
      try {
        const result = await this.processSingleEmail({ type: 'single', data: email });
        results.push(result);

        if (result.success) {
          successCount++;
        } else {
          failureCount++;
        }

        if (options?.rateLimit) {
          await this.delay(options.rateLimit);
        }
      } catch (error) {
        failureCount++;
        results.push({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return {
      success: true,
      batchId: this.generateBatchId(),
      results,
      successCount,
      failureCount,
    };
  }

  /**
   * Process scheduled email job
   */
  private async processScheduledEmail(jobData: ScheduledEmailJobData): Promise<EmailJobResult> {
    if (jobData.scheduledFor && jobData.scheduledFor > new Date()) {
      const delay = jobData.scheduledFor.getTime() - Date.now();
      await this.add('default', jobData.data, { delay });

      return {
        success: true,
        rescheduled: true,
        newJobId: 'rescheduled',
      };
    }

    return await this.processSingleEmail(jobData.data);
  }

  /**
   * Get queue by name
   */
  private getQueue(queueName: string): Queue {
    switch (queueName) {
      case 'priority':
        return this.priorityQueue;
      case 'batch':
        return this.batchQueue;
      default:
        return this.emailQueue;
    }
  }

  /**
   * Set up queue event listeners
   */
  private setupEventListeners(): void {
    const registerListener = (queue: Queue, event: string, handler: (...args: any[]) => void) => {
      queue.on(event, handler);
      this.listenerDisposers.push(() => queue.removeListener(event, handler));
    };

    registerListener(this.emailQueue, 'completed', (job, result) => {
      this.logger.debug(`Email job completed`, { jobId: job.id, result });
    });

    registerListener(this.emailQueue, 'failed', (job, error) => {
      this.logger.error(`Email job failed`, error, { jobId: job.id, data: job.data });
    });

    registerListener(this.emailQueue, 'stalled', job => {
      this.logger.warn(`Email job stalled`, { jobId: job.id, data: job.data });
    });

    registerListener(this.priorityQueue, 'completed', (job, result) => {
      this.logger.debug(`Priority email job completed`, { jobId: job.id, result });
    });

    registerListener(this.priorityQueue, 'failed', (job, error) => {
      this.logger.error(`Priority email job failed`, error, { jobId: job.id, data: job.data });
    });

    registerListener(this.batchQueue, 'completed', (job, result) => {
      this.logger.debug(`Batch email job completed`, { jobId: job.id, result });
    });

    registerListener(this.batchQueue, 'failed', (job, error) => {
      this.logger.error(`Batch email job failed`, error, { jobId: job.id, data: job.data });
    });
  }

  private startMemoryMonitoring(): void {
    this.memoryMonitor = setInterval(() => {
      const snapshot = this.getMemoryUsageSnapshot();
      this.logger.debug(`Email queue memory usage`, snapshot);

      if (snapshot.heapUsedMb >= this.memoryWarningThresholdMb) {
        this.logger.warn(
          `Email queue memory usage high: heap=${snapshot.heapUsedMb}MB rss=${snapshot.rssMb}MB threshold=${this.memoryWarningThresholdMb}MB`,
        );
      }
    }, this.memoryMonitorIntervalMs);
    this.memoryMonitor.unref?.();
  }

  private startQueueCleanupMonitoring(): void {
    this.queueCleanupMonitor = setInterval(
      async () => {
        try {
          await Promise.all([
            this.emailQueue.clean(24 * 60 * 60 * 1000, 'completed'),
            this.emailQueue.clean(7 * 24 * 60 * 60 * 1000, 'failed'),
            this.priorityQueue.clean(24 * 60 * 60 * 1000, 'completed'),
            this.priorityQueue.clean(7 * 24 * 60 * 60 * 1000, 'failed'),
            this.batchQueue.clean(24 * 60 * 60 * 1000, 'completed'),
            this.batchQueue.clean(7 * 24 * 60 * 60 * 1000, 'failed'),
          ]);
        } catch (error) {
          this.logger.error('Failed to clean queue history', error);
        }
      },
      this.configService.get<number>('EMAIL_QUEUE_CLEANUP_INTERVAL_MS', 300000),
    );
    this.queueCleanupMonitor.unref?.();
  }

  private async withJobTimeout<T>(job: any, operation: () => Promise<T>): Promise<T> {
    let timeoutHandle: NodeJS.Timeout | undefined;

    try {
      return await Promise.race([
        operation(),
        new Promise<T>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new Error(`Email job ${job.id} timed out after ${this.jobTimeoutMs}ms`));
          }, this.jobTimeoutMs);

          timeoutHandle.unref?.();
        }),
      ]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private async cleanupJobResources(job: any): Promise<void> {
    try {
      if (Array.isArray(job?.data?.emails)) {
        job.data.emails.length = 0;
      }

      if (job?.data && typeof job.data === 'object') {
        delete job.data.attachments;
        delete job.data.html;
        delete job.data.text;
      }
    } catch (error) {
      this.logger.warn(
        `Failed to cleanup job resources for ${job?.id}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private getMemoryUsageSnapshot() {
    const usage = process.memoryUsage();
    return {
      rssMb: Math.round(usage.rss / 1024 / 1024),
      heapUsedMb: Math.round(usage.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(usage.heapTotal / 1024 / 1024),
      externalMb: Math.round(usage.external / 1024 / 1024),
    };
  }

  private generateEmailId(): string {
    return `email_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private generateBatchId(): string {
    return `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Graceful shutdown
   */
  async onModuleDestroy(): Promise<void> {
    this.logger.log('Closing email queues...');

    if (this.memoryMonitor) {
      clearInterval(this.memoryMonitor);
      this.memoryMonitor = null;
    }

    if (this.queueCleanupMonitor) {
      clearInterval(this.queueCleanupMonitor);
      this.queueCleanupMonitor = null;
    }

    while (this.listenerDisposers.length > 0) {
      const dispose = this.listenerDisposers.pop();
      dispose?.();
    }

    await Promise.all([this.emailQueue.close(), this.priorityQueue.close(), this.batchQueue.close()]);

    this.logger.log('Email queues closed successfully');
  }
}

// Type definitions
interface EmailJobResult {
  success: boolean;
  emailId?: string;
  provider?: string;
  messageId?: string;
  batchId?: string;
  results?: any[];
  successCount?: number;
  failureCount?: number;
  error?: string;
  processingTime?: number;
  jobId?: string;
  rescheduled?: boolean;
  newJobId?: string;
}

interface SingleEmailJobData {
  type: 'single';
  data: any;
}

interface BatchEmailJobData {
  type: 'batch';
  emails: any[];
  options?: {
    rateLimit?: number;
    maxConcurrency?: number;
  };
}

interface ScheduledEmailJobData {
  type: 'scheduled';
  data: SingleEmailJobData;
  scheduledFor: Date;
}

interface QueueStats {
  queueName: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  total: number;
}

interface AllQueueStats {
  default: QueueStats;
  priority: QueueStats;
  batch: QueueStats;
  total: QueueStats;
}
