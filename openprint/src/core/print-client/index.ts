/**
 * 本地打印机客户端服务层入口
 *
 * 用法：
 * ```ts
 * import { checkHealth, listPrinters, submitPrintJob } from '@/core/print-client'
 * import { resolvePrinterBaseUrl } from '@/config/printer'
 *
 * const base = resolvePrinterBaseUrl()
 * const health = await checkHealth(base)
 * const printers = await listPrinters(base)
 * ```
 */
export {
  DEFAULT_PRINTER_BASE_URL,
  PROBE_TIMEOUT_MS,
  SUBMIT_TIMEOUT_MS,
  checkHealth,
  listPrinters,
  submitPrintJob,
  generateJobId,
  blobToBase64,
  blobToText,
  listSystemFonts,
  systemFontDataUrl,
  fontFormatToCss,
  fontContentType,
  ROWS_DEFAULT_LIMIT,
  ROWS_MAX_LIMIT,
  listClientDatabases,
  listClientTables,
  listClientColumns,
  fetchClientRows,
  postClientRows,
} from './client'

export type {
  ClientDataQuery,
  ClientRowsPostBody,
} from './client'

export { PrintClientError, describePrintError } from './types'

export {
  buildPrintPayload,
  formatPayloadSize,
  isRawPayloadMode,
  RAW_PAYLOAD_MODES,
  RAW_PAYLOAD_MODE_LABELS,
} from './payload'
export type { PrintPayload, BuildPrintPayloadOptions, PrintPayloadMode } from './payload'

export { printDocument } from './print'
export type { PrintDocumentOptions } from './print'

export { buildRawPayloadObject, sanitizeTemplate, sanitizeControl } from './raw-sanitize'

export { FALLBACK_PRINT_DPI, MIN_PRINT_DPI, clampDpi, resolvePrintDpi } from './dpi'

export { resolvePrintOrientation } from './orientation'
export type { OrientationPref } from './orientation'

/** 引擎归一化（sqlite / postgres / odbc）——值导出，非类型 */
export { normalizeDbEngine } from './types'

export type {
  PrinterHealth,
  PrinterInfo,
  PrinterKind,
  PrinterState,
  PrinterListResponse,
  PrintPayloadFormat,
  PrintPayloadEncoding,
  PrintJobRequest,
  PrintJobResponse,
  PrintClientErrorCode,
  SystemFontEntry,
  SystemFontListResponse,
  DbEngine,
  ClientDatabase,
  ClientTable,
  ClientColumn,
  ClientDataListResponse,
  ClientRowsResponse,
} from './types'
