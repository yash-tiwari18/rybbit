import { getJobQueue } from "../../../queues/jobQueueFactory.js";
import { CSV_PARSE_QUEUE, DATA_INSERT_QUEUE } from "./jobs.js";

export const createJobQueues = async () => {
  const jobQueue = getJobQueue();

  try {
    await jobQueue.createQueue(CSV_PARSE_QUEUE);
    await jobQueue.createQueue(DATA_INSERT_QUEUE);
  } catch (error) {
    throw new Error(`Failed to create job queues: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}
