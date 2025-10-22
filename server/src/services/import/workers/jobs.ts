import { UmamiEvent } from "../mappings/umami.js";

export const CSV_PARSE_QUEUE = "csv-parse";

export const DATA_INSERT_QUEUE = "data-insert";

interface ImportJob {
  site: string;
  importId: string;
  source: "umami";
}

export interface CsvParseJob extends ImportJob {
  storageLocation: string; // Either local file path or R2 key
  isR2Storage: boolean;
  organization: string;
  startDate?: string;
  endDate?: string;
}

export interface DataInsertJob extends ImportJob {
  chunk: UmamiEvent[];
  chunkNumber?: number; // Chunk sequence number for tracking
  totalChunks?: number; // Expected total chunks for finalization validation
  allChunksSent: boolean; // Finalization signal
}
