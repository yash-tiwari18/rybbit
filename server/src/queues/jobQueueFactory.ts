import { IS_CLOUD } from "../lib/const.js";
import { IJobQueue } from "./jobQueue.js";
import { PgBossAdapter } from "./adapters/pgBossAdapter.js";
import { BullMQAdapter } from "./adapters/bullMQAdapter.js";

let queueInstance: IJobQueue | null = null;

/**
 * Get the singleton job queue instance
 * Returns BullMQ for cloud deployments, pg-boss for self-hosted
 */
export const getJobQueue = (): IJobQueue => {
  if (!queueInstance) {
    if (IS_CLOUD) {
      console.info("[JobQueue] Initializing BullMQ for cloud deployment");
      queueInstance = new BullMQAdapter();
    } else {
      console.info("[JobQueue] Initializing pg-boss for self-hosted deployment");
      queueInstance = new PgBossAdapter();
    }
  }
  return queueInstance;
};
