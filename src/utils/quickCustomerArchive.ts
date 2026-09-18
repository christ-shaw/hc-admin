import type { ArchiveCandidate, ArchiveMember } from '../hooks/useCustomerArchive';
import type { CustomerIdentityMatchResult, CustomerObservedIdentity } from '../types';

export function completeArchiveRecipient(identity: CustomerObservedIdentity) {
  const phone = String(identity.phone || '').normalize('NFKC').replace(/[\s()-]/g, '');
  return !!identity.consignee.trim() && !!identity.address.trim() && /^(?:\+?86)?1[3-9]\d{9}$/.test(phone);
}

export async function loadAllPendingMembers(candidateId: string, load: (page: number) => Promise<{ data: ArchiveMember[]; total: number }>) {
  const first = await load(1);
  if (first.total > 100) throw new Error('本组超过 100 条，请按页勾选，本次最多处理 100 条');
  const rows = [...first.data];
  for (let page = 2; rows.length < first.total; page++) {
    const result = await load(page);
    if (result.total !== first.total || !result.data.length) throw new Error('订单范围已变化，请刷新后重新选择');
    rows.push(...result.data);
  }
  if (rows.length !== first.total || new Set(rows.map(row => row._id)).size !== rows.length
    || rows.some(row => row.candidateId !== candidateId || row.status !== 'pending')) throw new Error('订单范围已变化，请刷新后重新选择');
  return rows;
}

export function quickArchiveInput(group: ArchiveCandidate, members: ArchiveMember[], displayName: string,
  saveAlias: boolean, saveRecipient: boolean, recipient: CustomerObservedIdentity, targetId?: string) {
  return {
    mode: targetId ? 'link' : 'create', candidateId: group._id, evidenceVersion: group.evidenceVersion,
    members: members.map(row => ({ memberId: row._id, revision: row.revision })),
    displayName: displayName.trim(), ...(targetId ? { customerId: targetId } : {}),
    // The create service reuses the initial alias when name/channel are identical.
    ...(saveAlias ? { newAlias: { name: group.observedIdentity.customerName, salesChannel: '' } } : {}),
    ...(saveRecipient ? { newRecipient: { consignee: recipient.consignee.trim(), phone: recipient.phone.trim(), address: recipient.address.trim(), label: '' } } : {}),
  };
}

export function duplicateCandidates(results: Array<Pick<CustomerIdentityMatchResult, 'status' | 'candidates'>>) {
  const byId = new Map<string, { customerId: string; reasons: string[]; score: number }>();
  for (const result of results) {
    // Corrupt merge data must be repaired before confidently reviewing a new identity.
    if (result.status === 'invalid_cluster') throw new Error('客户合并资料异常，请先修复后再建档');
    for (const row of result.candidates) {
      const previous = byId.get(row.customerId);
      byId.set(row.customerId, { customerId: row.customerId, score: Math.max(previous?.score || 0, row.score),
        reasons: [...new Set([...(previous?.reasons || []), ...row.reasons])].sort() });
    }
  }
  return [...byId.values()].sort((a, b) => b.score - a.score || a.customerId.localeCompare(b.customerId));
}
