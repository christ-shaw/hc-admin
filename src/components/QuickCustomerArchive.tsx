import { customerArchiveConflict } from '../utils/customerArchiveConflict';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Dialog, Input, MessagePlugin, Pagination } from 'tdesign-react';
import { useCustomers } from '../hooks/useCustomers';
import { listArchive, resolveArchive } from '../hooks/useCustomerArchive';
import type { ArchiveCandidate, ArchiveMember, ArchiveProgress } from '../hooks/useCustomerArchive';
import type { CustomerObservedIdentity, CustomerSelectionItem } from '../types';
import { completeArchiveRecipient, duplicateCandidates, loadAllPendingMembers, quickArchiveInput } from '../utils/quickCustomerArchive';

const reasonNames: Record<string, string> = { name_exact: '名称或别名一致', phone_exact: '电话一致', address_exact: '地址一致', consignee_exact: '收货人一致' };
interface Duplicate extends CustomerSelectionItem { reasons: string[]; score: number }
export function QuickCustomerArchive({ group, onClose, onSaved, onNext }: {
  group: ArchiveCandidate; onClose: () => void; onSaved: () => void; onNext: () => Promise<void>;
}) {
  const { matchCustomerIdentity, getOrderSelection } = useCustomers();
  const [displayName, setDisplayName] = useState(group.observedIdentity.customerName);
  const [recipient, setRecipient] = useState<CustomerObservedIdentity>({ ...group.observedIdentity });
  const [saveAlias, setSaveAlias] = useState(!!group.observedIdentity.customerName.trim());
  const [saveRecipient, setSaveRecipient] = useState(completeArchiveRecipient(group.observedIdentity));
  const [members, setMembers] = useState<ArchiveMember[]>([]), [selected, setSelected] = useState<Map<string, ArchiveMember>>(new Map());
  const [page, setPage] = useState(1), [total, setTotal] = useState(group.pendingCount);
  const [loading, setLoading] = useState(true), [memberError, setMemberError] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [duplicates, setDuplicates] = useState<Duplicate[]>([]), [checkBusy, setCheckBusy] = useState(true), [checkError, setCheckError] = useState('');
  const [acknowledged, setAcknowledged] = useState(false), [target, setTarget] = useState<CustomerSelectionItem | null>(null);
  const [progress, setProgress] = useState<ArchiveProgress | null>(null), [retry, setRetry] = useState(0);
  const [resumeId, setResumeId] = useState('');
  const mounted = useRef(true), firstLoad = useRef(true), checkGeneration = useRef(0), submitting = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const pendingInput = useRef<Record<string, unknown> | null>(null);
  const [attempted, setAttempted] = useState(false);
  const loadPage = useCallback((nextPage: number) => listArchive<ArchiveMember>({ view: 'members', candidateId: group._id, status: 'pending', page: nextPage, pageSize: 20 }), [group._id]);
  useEffect(() => {
    let alive = true; setLoading(true); setMemberError('');
    loadPage(page).then(result => {
      if (!alive) return;
      setMembers(result.data); setTotal(result.total);
      // This route explicitly means "archive this group". Only a verified singleton is preselected.
      if (firstLoad.current && result.total === 1 && result.data.length === 1 && result.data[0].status === 'pending') setSelected(new Map([[result.data[0]._id, result.data[0]]]));
      firstLoad.current = false;
    }).catch(e => { if (alive) setMemberError(e.message || '加载订单失败'); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [loadPage, page, retry]);
  const checkDuplicates = useCallback(async () => {
    if (!displayName.trim()) throw new Error('请填写客户主名称');
    // Check the proposed name plus the order's original name; use order recipient evidence
    // even when the user chooses not to save a profile.
    const names = [...new Set([displayName.trim(), group.observedIdentity.customerName.trim()].filter(Boolean))];
    const results = await Promise.all(names.map(customerName => matchCustomerIdentity({ ...recipient, customerName })));
    const candidates = duplicateCandidates(results);
    // Bound detail reads; all candidate IDs still participate in the review signature.
    const details = await Promise.all(candidates.slice(0, 20).map(async row => ({ ...row, _id: row.customerId, displayName: (await getOrderSelection(row.customerId)).displayName })));
    return { details, signature: JSON.stringify(candidates), total: candidates.length };
  }, [displayName, group.observedIdentity.customerName, recipient, matchCustomerIdentity, getOrderSelection]);
  const reviewed = useRef('');
  const [duplicateTotal, setDuplicateTotal] = useState(0);
  useEffect(() => {
    const generation = ++checkGeneration.current;
    setAcknowledged(false); setCheckBusy(true); setCheckError(''); reviewed.current = '';
    const timer = window.setTimeout(() => {
      checkDuplicates().then(result => {
        if (generation !== checkGeneration.current) return;
        setDuplicates(result.details); setDuplicateTotal(result.total); reviewed.current = result.signature;
      }).catch(e => { if (generation === checkGeneration.current) { setCheckError(e.message || '检查已有客户失败'); setDuplicates([]); } })
        .finally(() => { if (generation === checkGeneration.current) setCheckBusy(false); });
    }, 300);
    return () => { window.clearTimeout(timer); checkGeneration.current++; };
  }, [checkDuplicates, retry]);
  const toggle = (row: ArchiveMember, checked: boolean) => setSelected(previous => {
    const next = new Map(previous); if (!checked) next.delete(row._id); else if (next.size < 100) next.set(row._id, row); return next;
  });
  const selectAll = async () => {
    setLoading(true); setMemberError('');
    try { const all = await loadAllPendingMembers(group._id, loadPage); if (mounted.current) setSelected(new Map(all.map(row => [row._id, row]))); }
    catch (e) { if (mounted.current) setMemberError(e instanceof Error ? e.message : '加载订单范围失败'); }
    finally { if (mounted.current) setLoading(false); }
  };
  const submit = async () => {
    if (submitting.current) return;
    if (!resumeId && (!selected.size || memberError)) { setError('请核对并选择需要处理的订单'); return; }
    if (!resumeId && saveRecipient && !completeArchiveRecipient(recipient)) { setError('请补全有效收货资料，或取消保存收货档案'); return; }
    submitting.current = true; setBusy(true); setError('');
    try {
      if (!resumeId && !pendingInput.current && !target) {
        const latest = await checkDuplicates();
        if (latest.total && (!acknowledged || reviewed.current !== latest.signature)) {
          setDuplicates(latest.details); setDuplicateTotal(latest.total); reviewed.current = latest.signature; setAcknowledged(false);
          setError('发现可能重复的客户，请选择已有客户，或核对后勾选仍然新建'); return;
        }
      }
      const input = resumeId ? { requestId: resumeId, resume: true } : pendingInput.current || quickArchiveInput(group, [...selected.values()], displayName, saveAlias, saveRecipient, recipient, target?._id);
      if (!resumeId) pendingInput.current = input;
      setAttempted(true);
      const result = await resolveArchive(input, value => { if (mounted.current) { setProgress(value); setResumeId(value.status === 'completed' ? '' : value.requestId); } });
      if (!mounted.current) return;
      setProgress(result); setResumeId(''); pendingInput.current = null; onSaved();
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : '保存失败，请重试原操作'); }
    finally { submitting.current = false; if (mounted.current) setBusy(false); }
  };
  const completed = progress?.status === 'completed';
  const conflicts = progress?.results.filter(row => row.status === 'conflict') || [];
  const locked = busy || attempted || !!resumeId || !!completed;
  return <Dialog header="新建客户并归档" visible width="860px" top="4vh" closeOnOverlayClick={false}
    onClose={() => { if (!busy) onClose(); }} footer={<div className="flex flex-wrap justify-between items-center gap-3">
      <span className="text-sm text-gray-500">{completed ? `已归档 ${progress.total - conflicts.length} 条，冲突 ${conflicts.length} 条` : `本次 ${selected.size} 条订单；原订单名称和收货信息保持原样`}</span>
      <div className="flex gap-2"><Button disabled={busy} onClick={onClose}>{completed ? '关闭' : '取消'}</Button>
        {completed ? <Button theme="primary" disabled={busy} onClick={async () => { setBusy(true); try { await onNext(); } catch { MessagePlugin.error('加载下一组失败，请重试'); } finally { if (mounted.current) setBusy(false); } }}>处理下一组</Button>
          : <Button theme="primary" loading={busy} disabled={!resumeId && (loading || !!memberError || !selected.size || (!target && (checkBusy || !!checkError)))} onClick={submit}>
            {resumeId ? '继续未完成的归档' : attempted ? '重试本次归档' : target ? `确认归入已有客户 ${selected.size} 条` : selected.size === 1 ? '确认新建并归档此订单' : `确认新建并归档 ${selected.size} 条`}</Button>}
      </div></div>}>
    <div className="max-h-[65vh] overflow-auto space-y-4 pr-1">
      {completed ? <div role="status" className={`rounded p-4 space-y-2 ${conflicts.length ? 'bg-amber-50' : 'bg-green-50'}`}><strong>{conflicts.length === progress.total ? '本组未归档成功' : conflicts.length ? '本组部分归档成功' : '本组处理完成'}</strong><p>已归档 {progress.total - conflicts.length} 条，冲突 {conflicts.length} 条。</p>{conflicts.map(row => <p key={row.memberId} className="text-amber-700">订单 {selected.get(row.memberId)?.serialNumber || row.orderId}：{customerArchiveConflict(row.code)}</p>)}<p>“处理下一组”只打开下一组资料，不会自动提交。当前组未选择的订单仍保留在待归档列表。</p></div> : <>
      <fieldset disabled={locked} className="space-y-3">
        {target ? <div className="rounded bg-blue-50 p-3">归入已有客户：<strong>{target.displayName}</strong><Button size="small" variant="text" disabled={locked} onClick={() => { setTarget(null); setError(''); }}>改为新建客户</Button></div>
          : <label className="block font-medium">客户主名称<Input aria-label="快速建档客户主名称" value={displayName} disabled={locked} onChange={value => setDisplayName(String(value))} /></label>}
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={saveAlias} disabled={!group.observedIdentity.customerName.trim()} onChange={e => setSaveAlias(e.target.checked)} />保留下单名称“{group.observedIdentity.customerName || '未填写'}”作为别名（与主名称相同时复用，不重复创建）</label>
        <label className="flex gap-2 font-medium"><input type="checkbox" checked={saveRecipient} onChange={e => setSaveRecipient(e.target.checked)} />保存收货档案</label>
        {!completeArchiveRecipient(recipient) && <p className="text-sm text-amber-700">收货资料不完整，可补充后保存，也可只建客户。</p>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{(['consignee', 'phone', 'address'] as const).map(key => <label key={key} className={key === 'address' ? 'sm:col-span-2' : ''}>{({ consignee: '收货人', phone: '电话', address: '地址' })[key]}<Input aria-label={`快速建档${({ consignee: '收货人', phone: '电话', address: '地址' })[key]}`} disabled={locked} value={recipient[key]} onChange={value => setRecipient(previous => ({ ...previous, [key]: String(value) }))} /></label>)}</div>
      </fieldset>
      {!target && <section className="rounded border border-amber-100 bg-amber-50/50 p-3 space-y-2"><h3 className="font-medium">已有客户检查</h3>
        {checkBusy ? <p className="text-sm">正在检查名称和收货资料…</p> : checkError ? <p role="alert" className="text-red-600">{checkError}<Button variant="text" disabled={locked} onClick={() => setRetry(value => value + 1)}>重试检查</Button></p>
          : duplicateTotal ? <><p className="text-sm">发现 {duplicateTotal} 位可能相关的客户，{duplicateTotal > 20 ? '展示前 20 位；' : ''}请核对后选择处理方式。</p>{duplicates.map(row => <div key={row._id} className="flex flex-wrap justify-between items-center gap-2 border-t py-2"><div><strong>{row.displayName}</strong><p className="text-xs text-gray-500">{row.reasons.map(reason => reasonNames[reason] || reason).join('、')}</p></div><Button size="small" disabled={locked} onClick={() => { setTarget(row); setError(''); }}>归入此客户</Button></div>)}<label className="flex gap-2 text-sm"><input type="checkbox" disabled={locked} checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} />已核对上述客户，仍需新建独立客户</label></> : <p className="text-sm text-gray-500">暂未发现相关客户，提交前会再次检查。</p>}
      </section>}
      <section className="space-y-2"><div className="flex flex-wrap items-center gap-2"><h3 className="font-medium">核对订单范围</h3><span className="text-sm">已选 {selected.size} / 待处理 {total} 条</span>
        <Button size="small" disabled={locked || loading || total > 100} onClick={selectAll}>选择本组全部待处理订单</Button>
        {total > 100 && <Button size="small" disabled={locked || loading} onClick={() => members.forEach(row => toggle(row, true))}>选择本页</Button>}
        <Button size="small" variant="text" disabled={locked} onClick={() => setSelected(new Map())}>清空选择</Button></div>
        {total > 100 && <p className="text-sm text-gray-500">本次最多 100 条，请按页勾选；其余订单保留待处理。</p>}
        {memberError && <p role="alert" className="text-red-600">{memberError}<Button variant="text" disabled={locked} onClick={() => setRetry(value => value + 1)}>刷新订单</Button></p>}
        {loading ? <p>加载订单中…</p> : <div className="overflow-auto"><table className="w-full text-sm text-left"><thead><tr><th className="p-2">选择</th><th className="p-2">序号 / 网店订单号</th><th className="p-2">类型 / 日期</th></tr></thead><tbody>{members.map(row => <tr key={row._id} className="border-t"><td className="p-2"><input type="checkbox" aria-label={`快速归档订单 ${row.serialNumber || row.orderId}`} checked={selected.has(row._id)} disabled={locked || (!selected.has(row._id) && selected.size >= 100)} onChange={e => toggle(row, e.target.checked)} /></td><td className="p-2">{row.serialNumber || row.orderId}<div className="text-gray-500">{row.onlineOrderNumber}</div></td><td className="p-2">{['rental1', '租赁1'].includes(row.rentalType) ? '租赁 1' : '租赁 2'} / {row.date}</td></tr>)}</tbody></table></div>}
        {total > 20 && <Pagination current={page} total={total} pageSize={20} showPageSize={false} onCurrentChange={value => { if (!locked && !loading) setPage(value); }} />}
        {selected.size > 0 && <p className="break-words text-xs text-gray-500">本次序号：{[...selected.values()].map(row => row.serialNumber || row.orderId).join('、')}</p>}
      </section></>}
      {attempted && !completed && <p className="text-sm text-gray-500">本次资料和订单范围已锁定。失败后请重试本次归档；已有进度时继续原请求，避免重复建档。</p>}
      {error && <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-600">{error}</p>}
      {!completed && progress && <p role="status">已处理 {progress.next} / {progress.total} 条；中断后可继续原请求。</p>}
    </div>
  </Dialog>;
}
