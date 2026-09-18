import { customerArchiveConflict } from '../utils/customerArchiveConflict';
import { QuickCustomerArchive } from './QuickCustomerArchive';
import { BulkCustomerArchive } from './BulkCustomerArchive';
import { BULK_ARCHIVE_LIMIT, selectArchiveGroups } from '../utils/bulkCustomerArchive';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Dialog, Input, MessagePlugin, Pagination, Textarea } from 'tdesign-react';
import { usePermission } from '../contexts/PermissionContext';
import { useCustomers } from '../hooks/useCustomers';
import { ARCHIVE_SCAN_CLICK_LIMIT, listArchive, resolveArchive, scanArchive } from '../hooks/useCustomerArchive';
import type { ArchiveCandidate, ArchiveMember, ArchiveProgress, ArchiveRequestSummary, ArchiveScan } from '../hooks/useCustomerArchive';
import type { CustomerSelectionItem } from '../types';
import { formatDate } from '../utils/format';

const reasons: Record<string, string> = { name_exact: '主名或别名一致', phone_exact: '电话一致', address_exact: '地址一致', consignee_exact: '收货人一致' };
const states: Record<string, string> = { pending: '待处理', accepted: '已归档', ignored: '已忽略', stale: '订单已变化', running: '进行中', completed: '已完成', failed: '失败，可继续' };
const modes: Record<string, string> = { link: '归入已有客户', create: '新建客户并归档', ignore: '忽略订单', reject: '拒绝推荐客户' };
const matchStates: Record<string, string> = { exact: '唯一精确匹配，仍需人工确认', ambiguous: '多个客户匹配，请人工核对', incomplete: '身份资料不完整', no_match: '没有精确匹配', invalid_cluster: '客户合并资料异常，需核对' };

export function CustomerArchive({ onChanged }: { onChanged: () => void }) {
  const { can } = usePermission();
  const canWrite = can('customers:write'), canScan = can('*');
  const customers = useCustomers();
  const [bulkSelection, setBulkSelection] = useState<Map<string, ArchiveCandidate>>(new Map());
  const [bulkGroups, setBulkGroups] = useState<ArchiveCandidate[] | null>(null);
  const [quickGroup, setQuickGroup] = useState<ArchiveCandidate | null>(null);
  const [rows, setRows] = useState<ArchiveCandidate[]>([]);
  const [page, setPage] = useState(1), [total, setTotal] = useState(0), [filter, setFilter] = useState('pending');
  const [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const [group, setGroup] = useState<ArchiveCandidate | null>(null), [members, setMembers] = useState<ArchiveMember[]>([]);
  const [memberPage, setMemberPage] = useState(1), [memberTotal, setMemberTotal] = useState(0);
  const [memberFilter, setMemberFilter] = useState('pending'), [memberError, setMemberError] = useState(''), [memberLoading, setMemberLoading] = useState(false);
  const [selected, setSelected] = useState<Map<string, ArchiveMember>>(new Map());
  const [mode, setMode] = useState('link'), [target, setTarget] = useState<CustomerSelectionItem | null>(null);
  const [keyword, setKeyword] = useState(''), [searchRows, setSearchRows] = useState<CustomerSelectionItem[]>([]), [searchPage, setSearchPage] = useState(1), [searchTotal, setSearchTotal] = useState(0);
  const [displayName, setDisplayName] = useState(''), [reason, setReason] = useState('');
  const [addAlias, setAddAlias] = useState(false), [aliasName, setAliasName] = useState(''), [channel, setChannel] = useState('');
  const [addRecipient, setAddRecipient] = useState(false), [recipient, setRecipient] = useState({ consignee: '', phone: '', address: '', label: '' });
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [progress, setProgress] = useState<ArchiveProgress | null>(null);
  const [requests, setRequests] = useState<ArchiveRequestSummary[]>([]), [tasks, setTasks] = useState<ArchiveScan[]>([]);
  const [preview, setPreview] = useState<ArchiveScan | null>(null), [scanBusy, setScanBusy] = useState(false), [scanConfirm, setScanConfirm] = useState(false);
  const [scanBatch, setScanBatch] = useState(0);
  const scanRunning = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const listGeneration = useRef(0), memberGeneration = useRef(0), searchGeneration = useRef(0);
  const refresh = useCallback(async () => {
    const generation = ++listGeneration.current;
    setLoading(true); setError('');
    try {
      const [list, own, scans] = await Promise.all([
        listArchive<ArchiveCandidate>({ page, status: filter }), listArchive<ArchiveRequestSummary>({ view: 'requests' }),
        canScan ? listArchive<ArchiveScan>({ view: 'tasks', pageSize: 5 }) : Promise.resolve({ data: [] }),
      ]);
      if (generation !== listGeneration.current) return;
      setRows(list.data); setTotal(list.total); setRequests(own.data); setTasks(scans.data);
    } catch (e) { if (generation === listGeneration.current) setError(e instanceof Error ? e.message : '加载失败'); }
    finally { if (generation === listGeneration.current) setLoading(false); }
  }, [page, filter, canScan]);
  useEffect(() => { void refresh(); return () => { listGeneration.current++; }; }, [refresh]);
  const refreshMembers = useCallback(async () => {
    if (!group) return;
    const generation = ++memberGeneration.current;
    setMemberLoading(true); setMemberError('');
    try {
      const list = await listArchive<ArchiveMember>({ view: 'members', candidateId: group._id, page: memberPage, status: memberFilter });
      if (generation !== memberGeneration.current) return;
      setMembers(list.data); setMemberTotal(list.total);
    } catch (e) { if (generation === memberGeneration.current) setMemberError(e instanceof Error ? e.message : '加载订单失败'); }
    finally { if (generation === memberGeneration.current) setMemberLoading(false); }
  }, [group, memberPage, memberFilter]);
  useEffect(() => { void refreshMembers(); return () => { memberGeneration.current++; }; }, [refreshMembers]);
  const open = (row: ArchiveCandidate) => {
    searchGeneration.current++; setGroup(row); setMembers([]); setMemberPage(1); setMemberFilter('pending'); setSelected(new Map());
    setMode('link'); setTarget(null); setKeyword(''); setSearchRows([]); setSearchTotal(0); setProgress(null);
    setDisplayName(row.observedIdentity.customerName); setReason(''); setAddAlias(false); setAliasName(row.observedIdentity.customerName); setChannel('');
    setAddRecipient(false); setRecipient({ ...row.observedIdentity, label: '' });
  };
  const search = async (nextPage = 1) => {
    if (!keyword.trim()) return;
    const generation = ++searchGeneration.current;
    try {
      const result = await customers.searchCustomers(keyword, nextPage);
      if (generation !== searchGeneration.current) return;
      setSearchRows(result.data); setSearchTotal(result.total); setSearchPage(nextPage);
    } catch (e) { if (generation === searchGeneration.current) MessagePlugin.error(e instanceof Error ? e.message : '搜索失败'); }
  };
  const toggle = (member: ArchiveMember, checked: boolean) => setSelected(previous => {
    const next = new Map(previous);
    if (checked && next.size < 100) next.set(member._id, member); else if (!checked) next.delete(member._id);
    return next;
  });
  const validate = () => {
    if (!selected.size) return '请先勾选需要处理的订单';
    if (['link', 'reject'].includes(mode) && !target) return '请选择目标客户';
    if (mode === 'create' && !displayName.trim()) return '请填写客户主名称';
    if (['ignore', 'reject'].includes(mode) && !reason.trim()) return '请填写处理原因';
    if (['create', 'link'].includes(mode) && addAlias && !aliasName.trim()) return '请填写别名';
    if (['create', 'link'].includes(mode) && addRecipient && (!recipient.consignee.trim() || !recipient.phone.trim() || !recipient.address.trim())) return '请完整填写收货档案';
    return '';
  };
  const perform = async (resumeId?: string) => {
    if (!resumeId && !group) return;
    setBusy(true); setConfirm(false);
    try {
      const input = resumeId ? { requestId: resumeId, resume: true } : {
        mode, candidateId: group!._id, evidenceVersion: group!.evidenceVersion,
        members: [...selected.values()].map(row => ({ memberId: row._id, revision: row.revision })),
        customerId: target?._id, displayName, reason,
        ...(['link', 'create'].includes(mode) && addAlias ? { newAlias: { name: aliasName, salesChannel: channel } } : {}),
        ...(['link', 'create'].includes(mode) && addRecipient ? { newRecipient: recipient } : {}),
      };
      const result = await resolveArchive(input, setProgress);
      const conflicts = result.results.filter(row => row.status === 'conflict').length;
      if (conflicts) MessagePlugin.warning(`已处理 ${result.total - conflicts} 条，${conflicts} 条发生冲突，请核对处理结果`);
      else MessagePlugin.success(`已处理 ${result.total} 条订单`);
      setSelected(new Map()); await refresh(); await refreshMembers(); onChanged();
    } catch (e) { MessagePlugin.error(e instanceof Error ? e.message : '处理失败，可从处理记录继续'); await refresh(); }
    finally { setBusy(false); }
  };
  const scan = async (dryRun: boolean, taskId?: string, cursor?: string, scanMode: 'all' | 'new' = 'all') => {
    if (scanRunning.current) return;
    scanRunning.current = true;
    setScanBusy(true); setScanConfirm(false); setScanBatch(0);
    try {
      const result = await scanArchive({ dryRun, scanMode, ...(dryRun ? { cursor } : { taskId: taskId || crypto.randomUUID() }) }, (value, batch) => {
        if (!mounted.current) return false;
        setScanBatch(batch);
        if (dryRun) setPreview(value);
        else setTasks(previous => [value, ...previous.filter(row => row._id !== value._id)].slice(0, 5));
      });
      if (!mounted.current) return;
      if (dryRun) setPreview(result);
      else {
        await refresh();
        if (result.status === 'failed') MessagePlugin.warning('扫描中断，已保存进度，可继续重试');
        else if (scanMode === 'new' && result.status === 'completed') {
          if (result.hasMoreNewOrders) MessagePlugin.success(`本批新增 ${result.eligible || 0} 条待归档订单，请再次点击「扫描新增订单」处理下一批`);
          else if (result.eligible) MessagePlugin.success(`已新增 ${result.eligible} 条待归档订单`);
          else MessagePlugin.info('没有需要新增扫描的订单，已有候选可在列表中继续处理');
        }
      }
    } catch (e) { if (mounted.current) { MessagePlugin.error(e instanceof Error ? e.message : '扫描失败'); await refresh(); } }
    finally { scanRunning.current = false; if (mounted.current) setScanBusy(false); }
  };
  const selectBulkGroup = (row: ArchiveCandidate, checked: boolean) => setBulkSelection(previous => selectArchiveGroups(previous, [row], checked));
  const pagePending = rows.filter(row => row.pendingCount > 0);
  const pageSelectedCount = pagePending.filter(row => bulkSelection.has(row._id)).length;
  const selectedRows = [...selected.values()];
  const recommendationMembers = selectedRows.length ? selectedRows : members.filter(row => row.status === 'pending');
  const suggestions = group?.matches.filter(match => !recommendationMembers.length || !recommendationMembers.every(row => row.rejectedCustomerIds.includes(match.customerId))) || [];
  return <div className="space-y-4">
    <div className="glass-card p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-3"><h2 className="text-lg font-semibold">历史订单待归档</h2><p className="text-sm text-gray-500">扫描只生成建议，勾选订单并确认后才修改归属。</p></div>
      {canScan ? <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <Button theme="primary" loading={scanBusy} onClick={() => {
            const unfinished = tasks.find(task => task.scanMode === 'new' && task.status !== 'completed');
            void scan(false, unfinished?._id, undefined, 'new');
          }}>扫描新增订单</Button>
          <Button disabled={scanBusy} variant="outline" onClick={() => scan(true)}>预览历史订单</Button>
          <Button disabled={scanBusy} onClick={() => setScanConfirm(true)}>新建全量扫描任务</Button>
        </div>
        <p className="text-sm text-gray-500">新增扫描只为尚未生成候选的未归档租赁订单生成建议，每批最多 {ARCHIVE_SCAN_CLICK_LIMIT} 条，不重复处理已有候选。全量扫描可重新检查历史订单。</p>
        {scanBusy && <p role="status" className="text-sm text-blue-600">{scanBatch ? `正在扫描，已完成 ${scanBatch} 个小批次，请保持页面打开。` : '正在查找需要扫描的订单，请稍候…'}</p>}
        {preview && <div className="text-sm text-gray-600">本批预览 {preview.scanned} 条，符合条件 {preview.previews?.length || 0} 条，跳过 {preview.skipped} 条。未写入数据。{!preview.completed && <Button size="small" variant="text" loading={scanBusy} onClick={() => scan(true, undefined, preview.cursor)}>预览下一批</Button>}</div>}
        {tasks.map(task => <div key={task._id} className="flex flex-wrap items-center gap-3 rounded border border-gray-100 p-2 text-sm text-gray-600">
          <span className="font-medium">{task.scanMode === 'new' ? '新增订单扫描' : '全量扫描'} · {formatDate(task.createdAt || null)}</span>
          <span>{states[task.status || 'running']}，已检查 {task.scanned}{task.totalOrders !== undefined ? ` / ${task.totalOrders}` : ''} 条，{task.scanMode === 'new' ? '新增候选' : '符合条件'} {task.eligible || 0} 条，错误 {task.errorCount || 0} 次</span>
          {task.status !== 'completed' && <Button size="small" disabled={scanBusy} onClick={() => scan(false, task._id, undefined, task.scanMode || 'all')}>继续扫描</Button>}
          {task.status === 'completed' && task.hasMoreNewOrders && <span className="text-blue-600">还有新增订单，可点击「扫描新增订单」继续</span>}
          {task.errors?.length ? <span className="text-red-600">最近错误：{task.errors[task.errors.length - 1]?.code}</span> : null}
        </div>)}
      </div> : <p className="text-sm text-gray-500">历史扫描由管理员启动；此处处理已生成的候选。</p>}
      {canWrite && requests.length > 0 && <div className="rounded bg-amber-50 p-3 text-sm space-y-2"><p>有未完成的处理，已完成部分会保留，请从记录继续。</p>{requests.map(row => <div key={row.requestId} className="flex items-center gap-3"><span>{modes[row.mode]}：{row.next} / {row.total} 条</span><Button size="small" disabled={busy} onClick={() => perform(row.requestId)}>继续处理</Button></div>)}</div>}
      <div className="flex gap-3 items-center"><label>显示 <select aria-label="候选状态" className="border rounded p-2" value={filter} onChange={e => { setFilter(e.target.value); setPage(1); }}><option value="pending">待处理</option><option value="processed">已处理</option><option value="all">全部</option></select></label><Button variant="text" loading={loading} onClick={refresh}>刷新</Button></div>
      {canWrite && <div className="flex flex-wrap items-center gap-3 rounded bg-blue-50 p-3">
        <Button theme="primary" disabled={busy || loading || !bulkSelection.size} onClick={() => setBulkGroups([...bulkSelection.values()])}>批量建档归档 {bulkSelection.size ? `（${bulkSelection.size} 组）` : ''}</Button>
        <Button variant="text" disabled={busy || !bulkSelection.size} onClick={() => setBulkSelection(new Map())}>清空勾选</Button>
        <span className="text-sm text-gray-600">已跨页选择 {bulkSelection.size} / {BULK_ARCHIVE_LIMIT} 组，本页已选 {pageSelectedCount} 组；翻页保留勾选。</span>
        {bulkSelection.size >= BULK_ARCHIVE_LIMIT && <span role="status" className="text-sm text-amber-700">已达到 {BULK_ARCHIVE_LIMIT} 组上限，请先处理或取消部分勾选，再选择其他组。</span>}
      </div>}
      {error && <p role="alert" className="text-red-600">{error}</p>}
      <div className="overflow-auto"><table className="w-full text-sm text-left"><thead className="bg-gray-50"><tr>{canWrite && <th className="p-3"><input type="checkbox" aria-label="选择本页待归档组" ref={element => { if (element) element.indeterminate = pageSelectedCount > 0 && pageSelectedCount < pagePending.length; }} disabled={busy || loading || !pagePending.length || (bulkSelection.size >= BULK_ARCHIVE_LIMIT && !pageSelectedCount)} checked={!!pagePending.length && pageSelectedCount === pagePending.length} onChange={event => {
        const checked = event.target.checked;
        setBulkSelection(previous => selectArchiveGroups(previous, pagePending, checked));
      }} /></th>}{['客户名称 / 收货资料', '订单数量', '匹配建议', '操作'].map(label => <th key={label} className="p-3">{label}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row._id} className="border-b">{canWrite && <td className="p-3"><input type="checkbox" aria-label={`选择候选组 ${row.observedIdentity.customerName || row._id}`} checked={bulkSelection.has(row._id)} disabled={busy || loading || !row.pendingCount || (!bulkSelection.has(row._id) && bulkSelection.size >= BULK_ARCHIVE_LIMIT)} onChange={event => selectBulkGroup(row, event.target.checked)} /></td>}<td className="p-3"><div className="font-medium">{row.observedIdentity.customerName || '未填写名称'}</div><div>{row.observedIdentity.consignee} · {row.observedIdentity.phone}</div><div className="text-gray-500 max-w-lg">{row.observedIdentity.address || '未填写地址'}</div></td><td className="p-3">待处理 {row.pendingCount} / 总数 {row.orderCount}<div className="text-gray-500">租赁 1：{row.rental1Count}，租赁 2：{row.rental2Count}</div></td><td className="p-3">{matchStates[row.matchStatus]}<div className="text-gray-500">{row.matchCount} 位候选客户</div></td><td className="p-3"><Button variant="text" disabled={busy} onClick={() => open(row)}>{canWrite ? '查看并处理' : '查看'}</Button>{canWrite && row.pendingCount > 0 && <Button theme="primary" variant="outline" disabled={busy} onClick={() => setQuickGroup(row)}>新建客户并归档</Button>}</td></tr>)}</tbody></table>{!loading && !rows.length && <p className="py-10 text-center text-gray-400">暂无候选；生成历史扫描后在此查看。</p>}</div>
      <Pagination current={page} pageSize={20} total={total} showPageSize={false} onCurrentChange={setPage} />
      {!group && progress && <p className="text-sm">处理进度：{progress.next} / {progress.total}，冲突 {progress.results.filter(row => row.status === 'conflict').length} 条。</p>}
    </div>
    {bulkGroups && canWrite && <BulkCustomerArchive groups={bulkGroups} onClose={() => { setBulkGroups(null); setBulkSelection(new Map()); void refresh(); }} onSaved={() => { void refresh(); onChanged(); }} />}
    {quickGroup && canWrite && <QuickCustomerArchive key={quickGroup._id} group={quickGroup} onClose={() => { setQuickGroup(null); void refresh(); }}
      onSaved={() => { void refresh(); onChanged(); }} onNext={async () => {
        const list = await listArchive<ArchiveCandidate>({ status: 'pending', page: 1 });
        const next = list.data.find(row => row._id !== quickGroup._id && row.pendingCount > 0);
        if (next) setQuickGroup(next); else { setQuickGroup(null); MessagePlugin.success('没有其它待处理组'); }
      }} />}
    <Dialog header="候选订单归档" visible={!!group} width="1100px" top="4vh" footer={false} onClose={() => { if (!busy) setGroup(null); }}>
      {group && <div className="max-h-[70vh] overflow-auto space-y-4 pr-2">
        <div className="rounded bg-gray-50 p-3"><strong>{group.observedIdentity.customerName || '未填写名称'}</strong><p>{group.observedIdentity.consignee} · {group.observedIdentity.phone} · {group.observedIdentity.address}</p><p className="text-sm text-gray-500">{matchStates[group.matchStatus]}</p></div>
        <div className="flex gap-3 items-center"><label>订单状态 <select aria-label="归档订单状态" className="border rounded p-1" disabled={busy} value={memberFilter} onChange={e => { setMemberFilter(e.target.value); setMemberPage(1); }}><option value="pending">待处理</option><option value="all">全部</option></select></label><span>已选 {selected.size} 条（最多 100 条）</span>{canWrite && <><Button size="small" disabled={busy || memberLoading} onClick={() => members.filter(row => row.status === 'pending').forEach(row => toggle(row, true))}>选择本页待处理订单</Button><Button size="small" disabled={busy} variant="text" onClick={() => setSelected(new Map())}>清空选择</Button></>}</div>
        {memberError && <p role="alert" className="text-red-600">{memberError}<Button variant="text" onClick={refreshMembers}>重试</Button></p>}
        <div className="overflow-auto"><table className="w-full text-sm text-left"><thead><tr>{['选择', '订单', '类型 / 日期', '状态', '已拒绝推荐'].map(label => <th className="p-2" key={label}>{label}</th>)}</tr></thead><tbody>{members.map(row => <tr key={row._id} className="border-b"><td className="p-2"><input type="checkbox" aria-label={`选择订单 ${row.serialNumber || row.orderId}`} checked={selected.has(row._id)} disabled={!canWrite || busy || row.status !== 'pending' || memberLoading} onChange={e => toggle(row, e.target.checked)} /></td><td className="p-2">{row.serialNumber}<div className="text-gray-500">{row.onlineOrderNumber}</div></td><td className="p-2">{row.rentalType === 'rental1' ? '租赁 1' : '租赁 2'} / {row.date}</td><td className="p-2">{states[row.status]}{row.reason && <div>{row.reason}</div>}</td><td className="p-2">{row.rejectedCustomerIds.map(id => group.matches.find(match => match.customerId === id)?.displayName || '历史推荐客户').join('、') || '无'}</td></tr>)}</tbody></table></div>
        <Pagination current={memberPage} pageSize={20} total={memberTotal} showPageSize={false} onCurrentChange={value => { if (!busy) setMemberPage(value); }} />
        <div><h3 className="font-medium">推荐客户</h3><p className="text-sm text-gray-500">评分仅作参考；已被所选订单（未选择时为当前页）全部拒绝的推荐会隐藏。</p>{suggestions.map(match => <div key={match.customerId} className="border rounded p-2 mt-2 flex flex-wrap items-center gap-3"><strong>{match.displayName}</strong><span>{match.score} 分 · {match.reasons.map(value => reasons[value] || value).join('、')}</span>{canWrite && <Button size="small" variant="outline" disabled={busy} onClick={() => setTarget({ _id: match.customerId, displayName: match.displayName })}>选择该客户</Button>}</div>)}{!suggestions.length && <p className="text-gray-400 py-2">暂无可用推荐，可搜索已有客户或新建客户。</p>}</div>
        {canWrite && <fieldset disabled={busy} className="space-y-3 border-t pt-3">
          <legend className="font-medium">处理选中的订单</legend>
          <label>处理方式 <select aria-label="归档处理方式" className="border rounded p-2" value={mode} onChange={e => { setMode(e.target.value); setTarget(null); }}>{Object.entries(modes).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          {['link', 'reject'].includes(mode) && <div className="space-y-2"><div className="flex items-center gap-2"><Input aria-label="搜索目标客户" value={keyword} placeholder="搜索已有客户" onChange={value => { searchGeneration.current++; setKeyword(String(value)); setSearchRows([]); setSearchTotal(0); }} onEnter={() => search()} /><Button onClick={() => search()}>搜索</Button></div><div className="flex flex-wrap gap-2">{searchRows.map(row => <Button key={row._id} size="small" variant="outline" onClick={() => setTarget(row)}>{row.displayName}</Button>)}</div>{searchTotal > 20 && <Pagination current={searchPage} pageSize={20} total={searchTotal} showPageSize={false} onCurrentChange={search} />}<p>目标客户：<strong>{target?.displayName || '尚未选择'}</strong></p>{mode === 'reject' && <p className="text-sm text-gray-500">拒绝操作只适用于本组当前推荐的客户，订单仍保留在待处理列表。</p>}</div>}
          {mode === 'create' && <label className="block">客户主名称<Input aria-label="新客户主名称" value={displayName} onChange={value => setDisplayName(String(value))} /></label>}
          {['link', 'create'].includes(mode) && <div className="space-y-3">
            <label className="flex gap-2"><input type="checkbox" checked={addAlias} onChange={e => setAddAlias(e.target.checked)} />将下单名称保存为客户别名（相同名称及渠道会复用）</label>
            {addAlias && <div className="grid grid-cols-2 gap-2"><label>别名<Input value={aliasName} onChange={value => setAliasName(String(value))} /></label><label>渠道<Input placeholder="留空表示不限渠道" value={channel} onChange={value => setChannel(String(value))} /></label></div>}
            <label className="flex gap-2"><input type="checkbox" checked={addRecipient} onChange={e => setAddRecipient(e.target.checked)} />保存收货档案（相同资料会复用）</label>
            {addRecipient && <div className="grid grid-cols-2 gap-2">{(['label', 'consignee', 'phone', 'address'] as const).map(key => <label key={key}>{({ label: '标签', consignee: '收货人', phone: '电话', address: '地址' })[key]}<Input value={recipient[key]} onChange={value => setRecipient(previous => ({ ...previous, [key]: String(value) }))} /></label>)}</div>}
          </div>}
          {['ignore', 'reject'].includes(mode) && <label className="block">处理原因<Textarea aria-label="归档处理原因" value={reason} maxlength={1000} onChange={value => setReason(String(value))} /></label>}
          <p className="text-sm text-gray-500">只处理明确勾选的订单，原订单中的名称和收货信息保持原样。</p>
          <Button theme="primary" disabled={!selected.size || memberLoading} loading={busy} onClick={() => { const message = validate(); if (message) MessagePlugin.warning(message); else setConfirm(true); }}>核对并确认处理 {selected.size} 条</Button>
        </fieldset>}
        {progress && <div className="rounded bg-blue-50 p-3 text-sm" role="status"><p>已处理 {progress.next} / {progress.total} 条</p>{progress.results.filter(row => row.status === 'conflict').map(row => <p key={row.memberId} className="text-red-600">订单 {row.orderId}：{customerArchiveConflict(row.code)}</p>)}</div>}
      </div>}
    </Dialog>
    <Dialog header="确认归档处理" visible={confirm} onClose={() => setConfirm(false)} onConfirm={() => perform()} confirmBtn="确认处理"><p>将对已勾选的 {selected.size} 条订单执行“{modes[mode]}”。</p>{['link', 'create', 'reject'].includes(mode) && <p>客户：{mode === 'create' ? displayName : target?.displayName}</p>}{['ignore', 'reject'].includes(mode) && <p>原因：{reason}</p>}<p>确认后逐单处理；发生冲突的订单会跳过并显示原因。</p></Dialog>
    <Dialog header="生成历史订单待归档候选" visible={scanConfirm} onClose={() => setScanConfirm(false)} onConfirm={() => scan(false)} confirmBtn="开始扫描"><p>从头检查历史订单，本次最多检查 {ARCHIVE_SCAN_CLICK_LIMIT} 条，筛选待归档的租赁订单。仅生成或更新候选，不修改订单归属；可在扫描记录中继续扫描后续订单。</p></Dialog>
  </div>;
}
