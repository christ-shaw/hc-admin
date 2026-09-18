import type { ArchiveCandidate, ArchiveMember, ArchiveProgress } from '../hooks/useCustomerArchive';
import type { CustomerIdentityCheckResult, CustomerIdentityMatchResult, CustomerObservedIdentity, CustomerSelectionItem } from '../types';
import { completeArchiveRecipient, duplicateCandidates, quickArchiveInput } from './quickCustomerArchive';

export const BULK_ARCHIVE_LIMIT = 100;
export function selectArchiveGroups(previous: Map<string, ArchiveCandidate>, rows: ArchiveCandidate[], checked: boolean) {
  const next = new Map(previous);
  for (const row of rows) {
    if (!checked) next.delete(row._id);
    else if (row.pendingCount > 0 && (next.has(row._id) || next.size < BULK_ARCHIVE_LIMIT)) next.set(row._id, row);
  }
  return next;
}
export interface ArchiveDuplicate extends CustomerSelectionItem { reasons: string[] }
export interface ArchiveDuplicateCheck {
  details: ArchiveDuplicate[]; signature: string; total: number;
  identityKey?: string; identityRevision?: number; normalizationVersion?: string;
}
export interface BulkArchiveEntry {
  group: ArchiveCandidate; included: boolean; displayName: string; recipient: CustomerObservedIdentity;
  saveAlias: boolean; saveRecipient: boolean; members: ArchiveMember[];
  duplicates: ArchiveDuplicateCheck | null; acknowledged: boolean; target: CustomerSelectionItem | null;
  status: 'loading' | 'ready' | 'review' | 'running' | 'failed' | 'completed'; error: string;
  input?: Record<string, unknown>; progress?: ArchiveProgress;
}
export function bulkArchiveEntry(group: ArchiveCandidate): BulkArchiveEntry {
  const entry: BulkArchiveEntry = { group, included: true, displayName: group.observedIdentity.customerName, recipient: { ...group.observedIdentity },
    saveAlias: !!group.observedIdentity.customerName.trim(), saveRecipient: completeArchiveRecipient(group.observedIdentity),
    members: [], duplicates: null, acknowledged: false, target: null, status: 'loading', error: '' };
  if (group.matchStatus && group.matchStatus !== 'invalid_cluster') {
    const candidates = duplicateCandidates([{ status: group.matchStatus, candidates: group.matches || [] }]);
    entry.duplicates = { details: candidates.slice(0, 20).map(row => ({ ...row, _id: row.customerId,
      displayName: group.matches.find(match => match.customerId === row.customerId)?.displayName || '客户已不存在' })),
      signature: JSON.stringify(candidates), total: group.matchCount, identityKey: archiveIdentityKey(entry),
      // Truncated/legacy evidence is useful to display, but cannot skip a fresh check.
      identityRevision: group.matchCount === group.matches?.length ? group.identityRevision : undefined,
      normalizationVersion: group.normalizationVersion };
  }
  return entry;
}
export function archiveIdentityKey(entry: BulkArchiveEntry) {
  return JSON.stringify([entry.displayName, entry.group.observedIdentity.customerName,
    entry.recipient.consignee, entry.recipient.phone, entry.recipient.address].map(value => value.trim()));
}

export async function checkArchiveDuplicates(entry: BulkArchiveEntry, api: {
  checkCustomerIdentity: (identity: CustomerObservedIdentity, cached?: ArchiveDuplicateCheck) => Promise<CustomerIdentityCheckResult>;
  getOrderSelection: (id: string) => Promise<CustomerSelectionItem>;
}): Promise<ArchiveDuplicateCheck> {
  const identityKey = archiveIdentityKey(entry);
  const cached = entry.duplicates?.identityKey === identityKey ? entry.duplicates : undefined;
  const names = [...new Set([entry.displayName.trim(), entry.group.observedIdentity.customerName.trim()].filter(Boolean))];
  if (!names.length) throw new Error('请填写客户主名称');
  const first = await api.checkCustomerIdentity({ ...entry.recipient, customerName: names[0] }, cached);
  if ('unchanged' in first) {
    if (!cached || first.identityRevision !== cached.identityRevision || first.normalizationVersion !== cached.normalizationVersion) throw new Error('匹配版本不一致，请重新核对');
    return cached;
  }
  const results: CustomerIdentityMatchResult[] = [first];
  for (const customerName of names.slice(1)) {
    const result = await api.checkCustomerIdentity({ ...entry.recipient, customerName });
    if ('unchanged' in result) throw new Error('匹配结果不完整，请重新核对');
    results.push(result);
  }
  const candidates = duplicateCandidates(results);
  const namesById = new Map(results.flatMap(result => result.candidates).filter(row => row.displayName !== undefined).map(row => [row.customerId, row.displayName!]));
  const details = await Promise.all(candidates.slice(0, 20).map(async row => ({ ...row, _id: row.customerId,
    displayName: namesById.get(row.customerId) ?? (await api.getOrderSelection(row.customerId)).displayName })));
  return { details, total: candidates.length, signature: JSON.stringify(candidates), identityKey,
    identityRevision: results.every(result => result.identityRevision === first.identityRevision && result.normalizationVersion === first.normalizationVersion) ? first.identityRevision : undefined,
    normalizationVersion: first.normalizationVersion };
}
export function archiveMemberSignature(members: ArchiveMember[]) {
  return JSON.stringify(members.map(row => [row._id, row.revision]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}
export function bulkArchiveValidation(entry: BulkArchiveEntry) {
  if (!entry.members.length) return '本组已没有待处理订单';
  if (!entry.target && !entry.displayName.trim()) return '请填写客户主名称';
  if (entry.saveRecipient && !completeArchiveRecipient(entry.recipient)) return '请补全收货资料，或取消保存收货档案';
  return '';
}

// Entries are a dialog-local queue. Once a write is attempted its input is frozen,
// including the request ID, so retries cannot create another customer.
export async function runBulkArchive(entries: BulkArchiveEntry[], deps: {
  loadMembers: (entry: BulkArchiveEntry) => Promise<ArchiveMember[]>;
  checkDuplicates: (entry: BulkArchiveEntry) => Promise<ArchiveDuplicateCheck>;
  resolve: (input: Record<string, unknown>, progress: (value: ArchiveProgress) => void) => Promise<ArchiveProgress>;
  requestId: () => string; changed: () => void; stopped: () => boolean;
}) {
  for (const entry of entries) {
    if (deps.stopped()) break;
    if (!entry.included || !['ready', 'failed'].includes(entry.status)) continue;
    entry.status = 'running'; entry.error = ''; deps.changed();
    try {
      if (!entry.input) {
        const validation = bulkArchiveValidation(entry);
        if (validation) throw new Error(validation);
        const members = await deps.loadMembers(entry);
        if (archiveMemberSignature(members) !== archiveMemberSignature(entry.members)) throw new Error('订单范围已变化，请重新加载并核对本组');
        if (!entry.target) {
          const latest = await deps.checkDuplicates(entry);
          const approved = entry.acknowledged && entry.duplicates?.signature === latest.signature;
          entry.duplicates = latest;
          if (latest.total && !approved) {
            entry.acknowledged = false;
            throw new Error('发现可能重复的客户，请选择已有客户或核对后仍然新建');
          }
        }
        if (deps.stopped()) { entry.status = 'ready'; deps.changed(); break; }
        entry.input = { ...quickArchiveInput(entry.group, entry.members, entry.displayName, entry.saveAlias,
          entry.saveRecipient, entry.recipient, entry.target?._id), requestId: deps.requestId() };
      }
      if (deps.stopped()) { entry.status = 'failed'; deps.changed(); break; }
      entry.progress = await deps.resolve(entry.input, progress => { entry.progress = progress; deps.changed(); });
      entry.status = entry.progress.status === 'completed' ? 'completed' : 'failed';
    } catch (error) {
      entry.status = entry.input ? 'failed' : 'review';
      entry.error = error instanceof Error ? error.message : '处理失败，请重试';
    }
    deps.changed();
  }
}
