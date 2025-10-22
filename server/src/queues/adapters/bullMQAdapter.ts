import { Job, Queue, QueueEvents, Worker } from "bullmq";
import type { Redis as RedisType } from "ioredis";
import RedisModule from "ioredis";
import { IJobQueue, JobConfig, JobData, JobResult } from "../jobQueue.js";

// Extract the Redis constructor for NodeNext module resolution
const Redis = RedisModule.default || RedisModule;

export class BullMQAdapter implements IJobQueue {
  private connection: RedisType;
  private queues: Map<string, Queue> = new Map();
  private workers: Map<string, Worker> = new Map();
  private queueEvents: Map<string, QueueEvents> = new Map();

  constructor() {
    this.connection = new Redis({
      host: process.env.REDIS_HOST || "localhost",
      port: parseInt(process.env.REDIS_PORT || "6379", 10),
      password: process.env.REDIS_PASSWORD,
      maxRetriesPerRequest: null,
      retryStrategy: (times: number) => {
        return Math.min(times * 50, 2000);
      },
    });

    this.connection.on("error", (error: Error) => {
      console.error("[BullMQ] Redis connection error:", error);
    });

    this.connection.on("connect", () => {
      console.info("[BullMQ] Connected to Redis");
    });
  }

  async start(): Promise<void> {
    // Verify Redis connection
    await this.connection.ping();
    console.info("[BullMQ] Started successfully");
  }

  async stop(): Promise<void> {
    console.info("[BullMQ] Stopping...");

    // Close all workers first
    await Promise.all(Array.from(this.workers.values()).map(worker => worker.close()));
    this.workers.clear();

    // Close all queue events
    await Promise.all(Array.from(this.queueEvents.values()).map(qe => qe.close()));
    this.queueEvents.clear();

    // Close all queues
    await Promise.all(Array.from(this.queues.values()).map(queue => queue.close()));
    this.queues.clear();

    // Close Redis connection
    await this.connection.quit();
    console.info("[BullMQ] Stopped successfully");
  }

  async createQueue(queueName: string): Promise<void> {
    if (!this.queues.has(queueName)) {
      const queue = new Queue(queueName, {
        connection: this.connection,
        defaultJobOptions: {
          attempts: 1, // No retries, same as pg-boss
          removeOnComplete: true,
          removeOnFail: false, // Keep failed jobs for debugging
        },
      });

      this.queues.set(queueName, queue);

      // Create QueueEvents for monitoring
      const queueEvents = new QueueEvents(queueName, {
        connection: this.connection,
      });

      this.queueEvents.set(queueName, queueEvents);

      // Log job events
      queueEvents.on("completed", ({ jobId }) => {
        console.info(`[BullMQ] Job ${jobId} completed in queue ${queueName}`);
      });

      queueEvents.on("failed", ({ jobId, failedReason }) => {
        console.error(`[BullMQ] Job ${jobId} failed in queue ${queueName}:`, failedReason);
      });
    }
  }

  async send<T = any>(queueName: string, data: T, options?: { priority?: number; delay?: number }): Promise<string> {
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new Error(`Queue ${queueName} not found. Call createQueue first.`);
    }

    const job = await queue.add(queueName, data, {
      priority: options?.priority,
      delay: options?.delay,
    });

    if (!job.id) {
      throw new Error(`Failed to enqueue job to ${queueName}`);
    }

    return job.id;
  }

  async work<T = any>(
    queueName: string,
    config: JobConfig,
    handler: (jobs: JobData<T>[]) => Promise<void | JobResult>
  ): Promise<void> {
    const worker = new Worker(
      queueName,
      async (job: Job<T>) => {
        const normalizedJob: JobData<T> = {
          id: job.id!,
          data: job.data,
        };

        // BullMQ processes one job at a time per worker
        // We wrap it in an array to match the interface
        await handler([normalizedJob]);
      },
      {
        connection: this.connection,
        concurrency: config.concurrency ?? config.batchSize ?? 1,
        limiter: config.limiter,
      }
    );

    worker.on("error", error => {
      console.error(`[BullMQ] Worker error in queue ${queueName}:`, error);
    });

    worker.on("failed", (job, error) => {
      console.error(`[BullMQ] Job ${job?.id} failed in queue ${queueName}:`, error);
    });

    this.workers.set(queueName, worker);
  }
}
