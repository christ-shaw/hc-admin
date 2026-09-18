import { customerArchiveConflict } from '../utils/customerArchiveConflict';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Dialog, Input } from 'tdesign-react';
import { useCustomers } from '../hooks/useCustomers';
import { listArchive, resolveArchive } from '../hooks/useCustomerArchive';
import type { ArchiveCandidate, ArchiveMember } from '../hooks/useCustomerArchive';
import { loadAllPendingMembers } from '../utils/quickCustomerArchive';
import { BULK_ARCHIVE_LIMIT, archiveIdentityKey, checkArchiveDuplicates, bulkArchiveEntry, bulkArchiveValidation, runBulkArchive } from '../utils/bulkCustomerArchive';
import type { BulkArchiveEntry } from '../utils/bulkCustomerArchive';

const statusNames = { loading: '正在核对', ready: '待提交', review: '需要核对', running: '处理中', failed: '失败，可重试', completed: '已完成' };
const reasonNames: Record<string, string> = { name_exact: '名称或别名一致', phone_exact: '电话一致', address_exact: '地址一致', consignee_exact: '收货人一致' };

export function BulkCustomerArchive({ groups, onClose, onSaved }: {
  groups: ArchiveCandidate[]; onClose: () => void; onSaved: () => void;
}) {
  const { checkCustomerIdentity, getOrderSelection } = useCustomers();
  const queue = useRef(groups.map(bulkArchiveEntry));
  const [, render] = useState(0), [busy, setBusy] = useState(false), [paused, setPaused] = useState(false);
  const mounted = useRef(true), running = useRef(false), stop = useRef(false);
  const changed = useCallback(() => { if (mounted.current) render(value => value + 1); }, []);
  const loadMembers = useCallback((entry: BulkArchiveEntry) => loadAllPendingMembers(entry.group._id,
    page => listArchive<ArchiveMember>({ view: 'members', candidateId: entry.group._id, status: 'pending', page, pageSize: 20 })), []);
  const checkDuplicates = useCallback((entry: BulkArchiveEntry) => checkArchiveDuplicates(entry, { checkCustomerIdentity, getOrderSelection }), [checkCustomerIdentity, getOrderSelection]);
  const prepare = useCallback(async (entry: BulkArchiveEntry, alive = () => mounted.current, forceCheck = false) => {
    entry.status = 'loading'; entry.error = ''; changed();
    try {
      const members = await loadMembers(entry);
      if (!alive()) return;
      entry.members = members;
      const validation = bulkArchiveValidation(entry);
      if (validation) throw new Error(validation);
      // The list already contains matching evidence and display names. Opening
      // the dialog only loads the explicit order range; writes revalidate versions.
      const duplicates = !forceCheck && entry.duplicates?.identityKey === archiveIdentityKey(entry)
        ? entry.duplicates : await checkDuplicates(entry);
      if (!alive()) return;
      if (entry.duplicates?.signature !== duplicates.signature) entry.acknowledged = false;
      entry.duplicates = duplicates;
      entry.status = duplicates.total && !entry.target && !entry.acknowledged ? 'review' : 'ready';
    } catch (error) {
      if (!alive()) return;
      entry.status = 'review'; entry.error = error instanceof Error ? error.message : '核对失败';
    }
    if (alive()) changed();
  }, [loadMembers, checkDuplicates, changed]);
  useEffect(() => {
    mounted.current = true;
    let alive = true;
    // New entries for each effect setup prevent StrictMode's cancelled reads from
    // modifying the live queue. No writes occur during initial review.
    const entries = groups.map(bulkArchiveEntry); queue.current = entries;
    void (async () => { for (const entry of entries) { if (!alive) break; await prepare(entry, () => alive); } })();
    return () => { alive = false; mounted.current = false; stop.current = true; };
  }, [groups, prepare]);
  const edit = (entry: BulkArchiveEntry, patch: Partial<BulkArchiveEntry>) => {
    const before = archiveIdentityKey(entry);
    Object.assign(entry, patch);
    if (archiveIdentityKey(entry) !== before) { entry.acknowledged = false; entry.duplicates = null; }
    const validation = bulkArchiveValidation(entry);
    entry.error = validation || (!entry.duplicates ? '身份资料已修改，请重新核对本组' : '');
    entry.status = validation || !entry.duplicates || (entry.duplicates.total && !entry.target && !entry.acknowledged) ? 'review' : 'ready';
    changed();
  };
  const submit = async () => {
    if (running.current) return;
    running.current = true; stop.current = false; setBusy(true); setPaused(false);
    try {
      await runBulkArchive(queue.current, { loadMembers, checkDuplicates, resolve: resolveArchive,
        requestId: () => crypto.randomUUID(), changed, stopped: () => stop.current || !mounted.current });
    } finally {
      running.current = false;
      if (mounted.current) { setBusy(false); onSaved(); }
    }
  };
  const entries = queue.current;
  const included = entries.filter(entry => entry.included);
  const runnable = included.filter(entry => ['ready', 'failed'].includes(entry.status));
  const review = included.filter(entry => entry.status === 'review');
  const loading = entries.some(entry => entry.status === 'loading');
  const results = entries.flatMap(entry => entry.progress?.results || []);
  const conflicts = results.filter(row => row.status === 'conflict').length;
  const accepted = results.filter(row => row.status === 'accepted').length;
  return <Dialog header="批量建档归档" visible width="1000px" top="3vh" closeOnOverlayClick={false}
    onClose={() => { if (!busy) onClose(); }} footer={<div className="flex flex-wrap items-center justify-between gap-3">
      <span className="text-sm">待提交 {runnable.length} 组 / {runnable.reduce((sum, entry) => sum + entry.members.length, 0)} 条，需核对 {review.length} 组</span>
      <div className="flex gap-2"><Button disabled={busy} onClick={onClose}>关闭</Button>
        {busy ? <Button disabled={paused} onClick={() => { stop.current = true; setPaused(true); }}>处理完当前组后暂停</Button>
          : <Button theme="primary" disabled={loading || !runnable.length} onClick={submit}>确认批量处理 {runnable.length} 组</Button>}</div>
    </div>}>
    <div className="max-h-[67vh] overflow-auto space-y-4 pr-1">
      <p className="text-sm text-gray-600">每个勾选的组包含下方列出的全部待处理订单。默认分别新建客户；有重复提示时可改归已有客户。需核对的组会跳过，其他已核对的组继续处理。</p>
      <div role="status" className="rounded bg-blue-50 p-3 text-sm">已完成 {entries.filter(entry => entry.status === 'completed').length} / {entries.length} 组，已归档 {accepted} 条，冲突 {conflicts} 条。{paused && (busy ? '正在等待当前组处理结束…' : '已暂停，可继续提交剩余组。')}</div>
      {entries.map((entry, index) => {
        const locked = busy || !!entry.input || entry.status === 'loading' || entry.status === 'completed';
        const canChoose = !locked && !!entry.duplicates && !!entry.members.length && !bulkArchiveValidation(entry);
        return <section key={entry.group._id} className="rounded border border-gray-200 p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="flex gap-2 font-medium"><input type="checkbox" aria-label={`纳入批量组 ${index + 1}`} disabled={busy || entry.status === 'completed'} checked={entry.included} onChange={event => { entry.included = event.target.checked; changed(); }} />{index + 1}. {entry.group.observedIdentity.customerName || '未填写名称'} · {entry.members.length} 条订单</label>
            <span className={entry.status === 'review' || entry.status === 'failed' ? 'text-amber-700' : 'text-gray-500'}>{entry.included || entry.status === 'completed' ? statusNames[entry.status] : '本批不处理'}</span>
          </div>
          {entry.status === 'completed' ? <div className="text-sm text-green-700">已归档 {entry.progress?.results.filter(row => row.status === 'accepted').length || 0} 条。
            {entry.progress?.customerId && <p>{entry.target ? '归入已有客户' : '新建客户'}：{entry.target?.displayName || entry.displayName}</p>}
            {entry.progress?.results.filter(row => row.status === 'conflict').map(row => <p key={row.memberId} className="text-amber-700">订单 {entry.members.find(member => member._id === row.memberId)?.serialNumber || row.orderId}：{customerArchiveConflict(row.code)}</p>)}</div>
            : <>
              {entry.target ? <div className="rounded bg-blue-50 p-2 text-sm">归入已有客户：<strong>{entry.target.displayName}</strong><Button size="small" variant="text" disabled={locked} onClick={() => edit(entry, { target: null })}>改为新建</Button></div>
                : <label className="block text-sm">客户主名称<Input aria-label={`批量客户主名称 ${index + 1}`} disabled={locked} value={entry.displayName} onChange={value => edit(entry, { displayName: String(value) })} /></label>}
              <details className="text-sm"><summary className="cursor-pointer">核对 {entry.members.length} 条订单与收货资料：{entry.recipient.consignee} · {entry.recipient.phone}</summary>
                <div className="mt-3 space-y-3">
                  <p className="break-words">订单序号：{entry.members.map(row => row.serialNumber || row.orderId).join('、') || '尚未加载'}</p>
                  <p className="break-words text-gray-500">网店订单号：{entry.members.map(row => row.onlineOrderNumber || '未填写').join('、')}</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{(['consignee', 'phone', 'address'] as const).map(key => <label key={key} className={key === 'address' ? 'sm:col-span-2' : ''}>{({ consignee: '收货人', phone: '电话', address: '地址' })[key]}<Input aria-label={`批量${key} ${index + 1}`} disabled={locked} value={entry.recipient[key]} onChange={value => edit(entry, { recipient: { ...entry.recipient, [key]: String(value) } })} /></label>)}</div>
                </div>
              </details>
              <div className="flex flex-wrap gap-4 text-sm">
                <label className="flex gap-2"><input type="checkbox" disabled={locked || !entry.group.observedIdentity.customerName.trim()} checked={entry.saveAlias} onChange={event => edit(entry, { saveAlias: event.target.checked })} />保留下单名称为别名</label>
                <label className="flex gap-2"><input type="checkbox" disabled={locked} checked={entry.saveRecipient} onChange={event => edit(entry, { saveRecipient: event.target.checked })} />保存收货档案</label>
              </div>
              {!entry.target && entry.duplicates && <div className="text-sm space-y-2">{entry.duplicates.total ? <>
                <p className="text-amber-700">发现 {entry.duplicates.total} 位可能相关的客户{entry.duplicates.total > 20 ? '（展示前 20 位）' : ''}，请核对：</p>
                {entry.duplicates.details.map(row => <div key={row._id} className="flex flex-wrap items-center gap-2"><strong>{row.displayName}</strong><span className="text-gray-500">{row.reasons.map(reason => reasonNames[reason] || reason).join('、')}</span><Button size="small" disabled={!canChoose} onClick={() => { entry.target = row; entry.status = 'ready'; entry.error = ''; changed(); }}>归入此客户</Button></div>)}
                <label className="flex gap-2"><input type="checkbox" disabled={!canChoose} checked={entry.acknowledged} onChange={event => { entry.acknowledged = event.target.checked; entry.status = event.target.checked ? 'ready' : 'review'; entry.error = ''; changed(); }} />已核对，仍新建独立客户</label>
              </> : <p className="text-gray-500">现有匹配结果未发现相关客户；提交前会确认结果是否仍然有效。</p>}</div>}
              {entry.status === 'review' && <Button size="small" variant="outline" disabled={locked} onClick={() => void prepare(entry, undefined, true)}>重新加载并核对本组</Button>}
              {!!entry.input && <p className="text-xs text-gray-500">已锁定本组资料；重试沿用原请求，保留已完成的订单。</p>}
              {entry.progress && <p className="text-sm">已处理 {entry.progress.next} / {entry.progress.total} 条</p>}
              {entry.error && <p role="alert" className="text-sm text-red-600">{entry.error}</p>}
            </>}
        </section>;
      })}
      <p className="text-xs text-gray-500">每批最多 {BULK_ARCHIVE_LIMIT} 组，每组最多 100 条；超出范围请从单组入口分批处理。原订单名称和收货信息保持原样。关闭页面会停止后续组，已提交的未完成请求可从“未完成的处理”继续；尚未提交的组需重新勾选。</p>
    </div>
  </Dialog>;
}
