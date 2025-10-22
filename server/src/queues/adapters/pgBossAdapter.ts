import PgBoss, { Job } from "pg-boss";
import { IJobQueue, JobConfig, JobData, JobResult } from "../jobQueue.js";

export class PgBossAdapter implements IJobQueue {
  private boss: PgBoss;

  constructor() {
    this.boss = new PgBoss({
      host: process.env.POSTGRES_HOST || "postgres",
      port: parseInt(process.env.POSTGRES_PORT || "5432", 10),
      database: process.env.POSTGRES_DB,
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      schema: "pgboss",
      application_name: "data-import-system",
      retryLimit: 0,
    });

    this.boss.on("error", (error) => {
      console.error("[PgBoss] Error:", error);
    });
  }

  async start(): Promise<void> {
    await this.boss.start();
    console.info("[PgBoss] Started successfully");
  }

  async stop(): Promise<void> {
    await this.boss.stop();
    console.info("[PgBoss] Stopped successfully");
  }

  async createQueue(queueName: string): Promise<void> {
    await this.boss.createQueue(queueName);
  }

  async send<T = any>(
    queueName: string,
    data: T,
    options?: { priority?: number; delay?: number }
  ): Promise<string> {
    const jobId = await this.boss.send(queueName, data as object, {
      priority: options?.priority,
      startAfter: options?.delay ? new Date(Date.now() + options.delay) : undefined,
    });

    if (!jobId) {
      throw new Error(`Failed to enqueue job to ${queueName}`);
    }

    return jobId;
  }

  async work<T = any>(
    queueName: string,
    config: JobConfig,
    handler: (jobs: JobData<T>[]) => Promise<void | JobResult>
  ): Promise<void> {
    await this.boss.work(
      queueName,
      {
        batchSize: config.batchSize ?? 1,
        pollingIntervalSeconds: config.pollingIntervalSeconds ?? 2,
      },
      async (jobs: Job<T>[]) => {
        const normalizedJobs: JobData<T>[] = jobs.map((job) => ({
          id: job.id,
          data: job.data,
        }));

        await handler(normalizedJobs);
      }
    );
  }
}
