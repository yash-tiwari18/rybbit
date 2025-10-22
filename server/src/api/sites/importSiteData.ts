import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { FastifyRequest, FastifyReply } from "fastify";
import { DateTime } from "luxon";
import { z } from "zod";
import { IS_CLOUD } from "../../lib/const.js";
import { getUserHasAdminAccessToSite } from "../../lib/auth-utils.js";
import { getJobQueue } from "../../queues/jobQueueFactory.js";
import { ImportLimiter } from "../../services/import/importLimiter.js";
import { ImportStatusManager } from "../../services/import/importStatusManager.js";
import { deleteImportFile } from "../../services/import/utils.js";
import { CSV_PARSE_QUEUE } from "../../services/import/workers/jobs.js";
import { r2Storage } from "../../services/storage/r2StorageService.js";

const isValidDate = (date: string) => {
  const dt = DateTime.fromFormat(date, "yyyy-MM-dd", { zone: "utc" });
  return dt.isValid;
};

const parseDate = (date: string) => DateTime.fromFormat(date, "yyyy-MM-dd", { zone: "utc" });

const importDataFieldsSchema = z.object({
  fields: z.object({
    source: z.enum(["umami"]),
    startDate: z.string().refine(isValidDate).optional(),
    endDate: z.string().refine(isValidDate).optional(),
  }).refine((fields) => {
    if (fields.startDate && fields.endDate) {
      const start = parseDate(fields.startDate);
      const end = parseDate(fields.endDate);
      return start <= end;
    }
    return true;
  }).refine((fields) => {
    if (fields.startDate) {
      const today = DateTime.utc().startOf("day");
      const start = parseDate(fields.startDate);
      return start <= today;
    }
    return true;
  }),
}).strict();

const importDataRequestSchema = z.object({
  params: z.object({
    site: z.string().min(1),
  }),
}).strict();

type ImportDataRequest = {
  Params: z.infer<typeof importDataRequestSchema.shape.params>;
};

export async function importSiteData(
  request: FastifyRequest<ImportDataRequest>,
  reply: FastifyReply,
) {
  try {
    const parsedParams = importDataRequestSchema.safeParse({
      params: request.params,
    });

    if (!parsedParams.success) {
      return reply.status(400).send({ error: "Validation error" });
    }

    const { site } = parsedParams.data.params;

    const userHasAccess = await getUserHasAdminAccessToSite(request, site);
    if (!userHasAccess) {
      return reply.status(403).send({ error: "Forbidden" });
    }

    const concurrentImportLimitResult = await ImportLimiter.checkConcurrentImportLimit(Number(site));
    if (!concurrentImportLimitResult.allowed) {
      return reply.status(429).send({ error: concurrentImportLimitResult.reason });
    }

    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ error: "No file uploaded." });
    }

    if (data.mimetype !== "text/csv" || !data.filename.endsWith(".csv")) {
      return reply.status(400).send({ error: "Invalid file type. Only .csv files are accepted." });
    }

    const parsedFields = importDataFieldsSchema.safeParse({
      fields: {
        source: (data.fields.source as any)?.value,
        startDate: (data.fields.startDate as any)?.value,
        endDate: (data.fields.endDate as any)?.value,
      },
    });

    if (!parsedFields.success) {
      return reply.status(400).send({ error: "Validation error" });
    }

    const { source, startDate, endDate } = parsedFields.data.fields;
    const organization = concurrentImportLimitResult.organizationId;
    const importId = randomUUID();

    await ImportStatusManager.createImportStatus({
      importId,
      siteId: Number(site),
      organizationId: organization,
      source,
      status: "pending",
      fileName: data.filename,
    });

    let storageLocation: string;

    try {
      if (IS_CLOUD && r2Storage.isEnabled()) {
        const r2Key = `imports/${importId}/${data.filename}`;

        await r2Storage.storeImportFile(r2Key, data.file);
        storageLocation = r2Key;

        console.log(`[Import] File streamed to R2: ${r2Key}`);
      } else {
        const importDir = "/tmp/imports";
        const savedFileName = `${importId}.csv`;
        const tempFilePath = path.join(importDir, savedFileName);

        await mkdir(importDir, { recursive: true });
        await pipeline(data.file, createWriteStream(tempFilePath));
        storageLocation = tempFilePath;

        console.log(`[Import] File stored locally: ${tempFilePath}`);
      }
    } catch (fileError) {
      await ImportStatusManager.updateStatus(importId, "failed", "Failed to save uploaded file");
      console.error("Failed to save uploaded file:", fileError);
      return reply.status(500).send({ error: "Could not process file upload." });
    }

    try {
      const jobQueue = getJobQueue();
      await jobQueue.send(CSV_PARSE_QUEUE, {
        site,
        importId,
        source,
        storageLocation,
        isR2Storage: IS_CLOUD && r2Storage.isEnabled(),
        organization,
        startDate,
        endDate,
      });
    } catch (queueError) {
      await ImportStatusManager.updateStatus(importId, "failed", "Failed to queue import job");
      await deleteImportFile(storageLocation, IS_CLOUD && r2Storage.isEnabled());
      console.error("Failed to enqueue import job:", queueError);
      return reply.status(500).send({ error: "Failed to initiate import process." });
    }

    return reply.status(202).send({
      data: {
        message: "File upload accepted and is now being processed.",
      }
    });
  } catch (error) {
    console.error("Unexpected error during import:", error);
    return reply.status(500).send({ error: "An unexpected error occurred. Please try again later." });
  }
}
