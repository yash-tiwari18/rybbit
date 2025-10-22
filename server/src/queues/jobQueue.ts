export interface JobConfig {
  /**
   * Number of jobs to process in a batch (pg-boss specific)
   * For BullMQ, this maps to concurrency
   */
  batchSize?: number;

  /**
   * Polling interval in seconds (pg-boss specific)
   * BullMQ uses event-driven model and ignores this
   */
  pollingIntervalSeconds?: number;

  /**
   * Number of concurrent workers (BullMQ specific)
   * Falls back to batchSize if not specified
   */
  concurrency?: number;

  /**
   * Rate limiting configuration (BullMQ specific)
   */
  limiter?: {
    max: number;
    duration: number;
  };
}

export interface JobResult {
  success: boolean;
  error?: Error;
}

export interface JobData<T> {
  id: string;
  data: T;
}

export interface IJobQueue {
  start(): Promise<void>;
  stop(): Promise<void>;
  createQueue(queueName: string): Promise<void>;
  send<T = any>(
    queueName: string,
    data: T,
    options?: {
      priority?: number;
      delay?: number;
    }
  ): Promise<string>;
  work<T = any>(
    queueName: string,
    config: JobConfig,
    handler: (jobs: JobData<T>[]) => Promise<void | JobResult>
  ): Promise<void>;
}
