import Papa from "papaparse";
import { DateTime } from "luxon";
import { authedFetch } from "@/api/utils";
import type { UmamiEvent } from "./types";

export class CSVWorkerManager {
  private aborted = false;
  private quotaExceeded = false;
  private siteId: number = 0;
  private importId: string = "";

  private earliestAllowedDate: DateTime | null = null;
  private latestAllowedDate: DateTime | null = null;

  private uploadQueue: Array<UmamiEvent[]> = [];
  private isProcessing = false;
  private parsingComplete = false;

  startImport(
    file: File,
    siteId: number,
    importId: string,
    earliestAllowedDate: string,
    latestAllowedDate: string
  ): void {
    this.siteId = siteId;
    this.importId = importId;

    this.earliestAllowedDate = DateTime.fromFormat(earliestAllowedDate, "yyyy-MM-dd", { zone: "utc" }).startOf("day");
    this.latestAllowedDate = DateTime.fromFormat(latestAllowedDate, "yyyy-MM-dd", { zone: "utc" }).endOf("day");

    if (!this.earliestAllowedDate.isValid) {
      this.handleError(`Invalid earliest allowed date: ${earliestAllowedDate}`);
      return;
    }

    if (!this.latestAllowedDate.isValid) {
      this.handleError(`Invalid latest allowed date: ${latestAllowedDate}`);
      return;
    }

    Papa.parse(file, {
      header: true,
      skipEmptyLines: "greedy",
      worker: true,
      chunkSize: 9 * 1024 * 1024,
      chunk: (results, parser) => {
        if (this.aborted || this.quotaExceeded) {
          parser.abort();
          return;
        }

        const validEvents: UmamiEvent[] = [];
        for (const row of results.data) {
          const event = this.transformRow(row);
          if (event && event.created_at && this.isDateInRange(event.created_at)) {
            validEvents.push(event);
          }
        }

        this.uploadQueue.push(validEvents);
        this.processQueue();
      },
      complete: () => {
        if (this.aborted) return;

        this.parsingComplete = true;
        this.processQueue();
      },
      error: error => {
        if (this.aborted) return;
        this.handleError(error.message);
      },
    });
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    while (this.uploadQueue.length > 0) {
      if (this.aborted || this.quotaExceeded) {
        this.uploadQueue = [];
        break;
      }

      const events = this.uploadQueue.shift()!;
      await this.uploadChunk(events, false);
    }

    this.isProcessing = false;

    if (this.parsingComplete && this.uploadQueue.length === 0 && !this.aborted) {
      await this.uploadChunk([], true);
    }
  }

  private isDateInRange(dateStr: string): boolean {
    const createdAt = DateTime.fromFormat(dateStr, "yyyy-MM-dd HH:mm:ss", { zone: "utc" });
    if (!createdAt.isValid) {
      return false;
    }

    if (this.earliestAllowedDate && createdAt < this.earliestAllowedDate) {
      return false;
    }

    if (this.latestAllowedDate && createdAt > this.latestAllowedDate) {
      return false;
    }

    return true;
  }

  private transformRow(row: unknown): UmamiEvent | null {
    const rawEvent = row as Record<string, string>;

    const umamiEvent: UmamiEvent = {
      session_id: rawEvent.session_id,
      hostname: rawEvent.hostname,
      browser: rawEvent.browser,
      os: rawEvent.os,
      device: rawEvent.device,
      screen: rawEvent.screen,
      language: rawEvent.language,
      country: rawEvent.country,
      region: rawEvent.region,
      city: rawEvent.city,
      url_path: rawEvent.url_path,
      url_query: rawEvent.url_query,
      referrer_path: rawEvent.referrer_path,
      referrer_query: rawEvent.referrer_query,
      referrer_domain: rawEvent.referrer_domain,
      page_title: rawEvent.page_title,
      event_type: rawEvent.event_type,
      event_name: rawEvent.event_name,
      distinct_id: rawEvent.distinct_id,
      created_at: rawEvent.created_at,
    };

    if (!umamiEvent.created_at) {
      return null;
    }

    return umamiEvent;
  }

  private handleError(message: string): void {
    this.terminate();
  }

  private async uploadChunk(events: UmamiEvent[], isLastBatch: boolean): Promise<void> {
    if (this.quotaExceeded) {
      return;
    }

    // Skip empty chunks unless it's the last one (needed for finalization)
    if (events.length === 0 && !isLastBatch) {
      return;
    }

    try {
      const data = await authedFetch<{
        quotaExceeded?: boolean;
        message?: string;
      }>(`/api/batch-import-events/${this.siteId}/${this.importId}`, undefined, {
        method: "POST",
        data: {
          events,
          isLastBatch,
        },
      });

      if (data.quotaExceeded) {
        this.quotaExceeded = true;
        this.aborted = true;
        return;
      }
    } catch (error) {
      // Critical failure - network error, server error, etc.
      this.terminate();
      return;
    }
  }

  terminate(): void {
    this.aborted = true;
  }
}
