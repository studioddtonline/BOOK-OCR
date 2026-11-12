export { openDb } from "./connection.js";
export { inTransaction, isBusyError } from "./tx.js";
export { LATEST_SCHEMA_VERSION, MIGRATIONS, getUserVersion, migrate } from "./migrations.js";
export { isReviewed } from "./types.js";
export type { OcrLogOutcome, QueueRow, QueueStatus, SourceImageRow } from "./types.js";
export { insertOcrLog, type OcrLogEntry } from "./ocr-log.js";
export { getImageStats, getSourceImage, insertSourceImage, type ImageStats } from "./source-images.js";
export { getFtsIndexedTermCount, rebuildFtsIndex } from "./fts.js";
export { getProviderUsageToday, isValidTimeZone, markProviderExhausted, recordProviderRequest, usageDate } from "./usage.js";
export {
  claimNextQueueItem,
  completeQueueItem,
  failQueueItem,
  getQueueItemBySourceImage,
  getQueueSummary,
  hasPendingQueueItems,
  insertQueueItem,
  listErrorQueueItems,
  listQueueItems,
  markQueueItemError,
  requeueSourceImage,
  resetProcessingToPending,
  retryAllErrors,
  retryQueueItems,
  type AttemptMeta,
  type CompleteResult,
  type FailParams,
  type OcrSavePayload,
  type RequeueResult,
  type RetryResult,
} from "./queue.js";
