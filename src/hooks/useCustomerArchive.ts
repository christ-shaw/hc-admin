import { callFunction } from '../lib/cloudbase';
import { customerWriteRequest } from '../utils/customerWriteRequest';
import type { CustomerIdentityMatch, CustomerLinkCandidate, CustomerLinkCandidateMember } from '../types';
export interface ArchiveCandidate extends CustomerLinkCandidate {
  matches: Array<CustomerIdentityMatch & { displayName: string }>;
}
export type ArchiveMember = CustomerLinkCandidateMember;
export interface ArchiveProgress {
  requestId: string; status: string; next: number; total: number; customerId: string | null;
  results: Array<{ memberId: string; orderId: string; status: string; code?: string }>;
}
export interface ArchiveRequestSummary { requestId: string; status: string; next: number; total: number; mode: string }
export interface ArchiveScan {
  _id?: string; status?: string; cursor: string; scanned: number; skipped: number; eligible?: number;
  scanMode?: 'all' | 'new'; createdAt?: string; totalOrders?: number; hasMoreNewOrders?: boolean;
  errorCount?: number; errors?: Array<{ orderId: string; code: string }>;
  dryRun?: boolean; completed?: boolean; previews?: Array<{ orderId: string; candidateId: string }>;
}
interface Result<T> { success: boolean; data: T; total?: number; errMsg?: string }
export async function listArchive<T>(options: Record<string, unknown> = {}) {
  const result = await callFunction<Result<T[]>>('manageCustomers', { ...options, action: 'listLinkCandidates' });
  if (!result.success) throw new Error(result.errMsg || '加载待归档数据失败');
  return { data: result.data, total: result.total || 0 };
}
export const ARCHIVE_SCAN_CLICK_LIMIT = 500;
const SCAN_REQUEST_LIMIT = 20;
export async function scanArchive(options: { dryRun: boolean; cursor?: string; taskId?: string; scanMode?: 'all' | 'new' },
  onProgress?: (scan: ArchiveScan, batch: number) => void | boolean) {
  let cursor = options.cursor;
  let previewScanned = 0, previewSkipped = 0;
  const previews: NonNullable<ArchiveScan['previews']> = [];
  let latest: ArchiveScan | undefined;
  // Bound one user action to 500 orders while keeping each existing cloud request
  // short. A persisted task always resumes from its server-side cursor.
  for (let batch = 1; batch <= ARCHIVE_SCAN_CLICK_LIMIT / SCAN_REQUEST_LIMIT; batch++) {
    const result = await callFunction<Result<ArchiveScan>>('manageCustomers', {
      ...options, ...(options.dryRun ? { cursor } : {}), action: options.scanMode === 'new' ? 'scanNewOrders' : 'scanUnlinkedOrders', limit: SCAN_REQUEST_LIMIT,
    });
    if (!result.success) throw new Error(result.errMsg || '扫描失败');
    latest = result.data;
    if (options.dryRun) {
      previewScanned += latest.scanned; previewSkipped += latest.skipped;
      previews.push(...(latest.previews || [])); cursor = latest.cursor;
      latest = { ...latest, scanned: previewScanned, skipped: previewSkipped, previews: [...previews] };
    }
    if (onProgress?.(latest, batch) === false) break;
    if (latest.completed || latest.status === 'completed' || latest.status === 'failed') break;
  }
  return latest!;
}
export async function resolveArchive(options: Record<string, unknown>, onProgress: (progress: ArchiveProgress) => void) {
  return customerWriteRequest('resolveLinkCandidate', options, async requestId => {
    let payload: Record<string, unknown> = { ...options, requestId };
    for (let batch = 0; batch < 11; batch++) {
      const result = await callFunction<Result<ArchiveProgress>>('manageCustomers', { ...payload, action: 'resolveLinkCandidate' });
      if (!result.success) throw new Error(result.errMsg || '归档失败，可从处理记录继续');
      onProgress(result.data);
      if (result.data.status === 'completed') return result.data;
      payload = { requestId, resume: true };
    }
    throw new Error('处理尚未完成，请从处理记录继续');
  });
}
