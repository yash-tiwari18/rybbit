import { access, constants } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { parse } from "@fast-csv/parse";
import { DateTime } from "luxon";
import { getJobQueue } from "../../../queues/jobQueueFactory.js";
import { r2Storage } from "../../storage/r2StorageService.js";
import { CSV_PARSE_QUEUE, CsvParseJob, DATA_INSERT_QUEUE } from "./jobs.js";
import { UmamiEvent, umamiHeaders } from "../mappings/umami.js";
import { ImportStatusManager } from "../importStatusManager.js";
import { ImportLimiter } from "../importLimiter.js";
import { deleteImportFile } from "../utils.js";

const getImportDataHeaders = (source: string) => {
  switch (source) {
    case "umami":
      return umamiHeaders;
    default:
      throw new Error(`Unsupported import source: ${source}`);
  }
};

const createR2FileStream = async (storageLocation: string, source: string) => {
  console.log(`[CSV Parser] Reading from R2: ${storageLocation}`);
  const fileStream = await r2Storage.getImportFileStream(storageLocation);
  return fileStream.pipe(parse({
    headers: getImportDataHeaders(source),
    renameHeaders: true,
    ignoreEmpty: true,
  }));
};

const createLocalFileStream = async (storageLocation: string, source: string) => {
  console.log(`[CSV Parser] Reading from local disk: ${storageLocation}`);
  await access(storageLocation, constants.F_OK | constants.R_OK);
  return createReadStream(storageLocation).pipe(parse({
    headers: getImportDataHeaders(source),
    renameHeaders: true,
    ignoreEmpty: true,
  }));
};

/**
 * Create a date range filter function.
 * Parses start/end dates once for performance.
 */
const createDateRangeFilter = (startDateStr?: string, endDateStr?: string) => {
  // Parse dates once, not for every row
  const startDate = startDateStr
    ? DateTime.fromFormat(startDateStr, "yyyy-MM-dd", { zone: "utc" }).startOf("day")
    : null;

  const endDate = endDateStr
    ? DateTime.fromFormat(endDateStr, "yyyy-MM-dd", { zone: "utc" }).endOf("day")
    : null;

  // Validate parsed dates
  if (startDate && !startDate.isValid) {
    throw new Error(`Invalid start date: ${startDateStr}`);
  }
  if (endDate && !endDate.isValid) {
    throw new Error(`Invalid end date: ${endDateStr}`);
  }

  // Return fast filter function
  return (dateStr: string): boolean => {
    const createdAt = DateTime.fromFormat(dateStr, "yyyy-MM-dd HH:mm:ss", { zone: "utc" });
    if (!createdAt.isValid) {
      return false;
    }

    if (startDate && createdAt < startDate) {
      return false;
    }

    if (endDate && createdAt > endDate) {
      return false;
    }

    return true;
  };
};

export async function registerCsvParseWorker() {
  const jobQueue = getJobQueue();

  await jobQueue.work<CsvParseJob>(
    CSV_PARSE_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: 10 },
    async ([job]) => {
      const { site, importId, source, storageLocation, isR2Storage, organization, startDate, endDate } = job.data;

    try {
      const importableEvents = await ImportLimiter.countImportableEvents(organization);
      if (importableEvents <= 0) {
        await ImportStatusManager.updateStatus(importId, "failed", "Event import limit reached");
        const deleteResult = await deleteImportFile(storageLocation, isR2Storage);
        if (!deleteResult.success) {
          console.warn(`[Import ${importId}] File cleanup failed: ${deleteResult.error}`);
        }
        return;
      }

      const chunkSize = 5000;
      let chunk: UmamiEvent[] = [];
      let rowsProcessed = 0;
      let chunksSent = 0; // Track total chunks sent

      const stream = isR2Storage
        ? await createR2FileStream(storageLocation, source)
        : await createLocalFileStream(storageLocation, source);

      await ImportStatusManager.updateStatus(importId, "processing");

      // Create date filter once for performance (not per-row)
      const isDateInRange = createDateRangeFilter(startDate, endDate);

      for await (const data of stream) {
        if (!data.created_at || !isDateInRange(data.created_at)) {
          continue;
        }

        if (rowsProcessed >= importableEvents) {
          break;
        }

        chunk.push(data);
        rowsProcessed++;

        if (chunk.length >= chunkSize) {
          await jobQueue.send(DATA_INSERT_QUEUE, {
            site,
            importId,
            source,
            chunk,
            chunkNumber: chunksSent,
            allChunksSent: false,
          });
          chunksSent++;
          chunk = [];
        }
      }

      // Send final chunk if any data remains
      if (chunk.length > 0) {
        await jobQueue.send(DATA_INSERT_QUEUE, {
          site,
          importId,
          source,
          chunk,
          chunkNumber: chunksSent,
          allChunksSent: false,
        });
        chunksSent++;
      }

      // Send finalization signal with total chunk count
      await jobQueue.send(DATA_INSERT_QUEUE, {
        site,
        importId,
        source,
        chunk: [],
        totalChunks: chunksSent,
        allChunksSent: true,
      });
      } catch (error) {
        console.error("Error in CSV parse worker:", error);
        await ImportStatusManager.updateStatus(
          importId,
          "failed",
          error instanceof Error ? error.message : "Unknown error occurred"
        );
        throw error;
      } finally {
        // Clean up file - don't throw on failure to prevent worker crashes
        const deleteResult = await deleteImportFile(storageLocation, isR2Storage);
        if (!deleteResult.success) {
          console.warn(
            `[Import ${importId}] File cleanup failed, will remain in storage: ${deleteResult.error}`
          );
          // File will be orphaned but import status is already recorded
          // Could implement a cleanup job here to retry later
        }
      }
    }
  );
}
