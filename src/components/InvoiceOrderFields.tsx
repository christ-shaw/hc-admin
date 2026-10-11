import { useRef, useState, useEffect, type Dispatch, type SetStateAction, type ReactNode } from 'react';
import { Button, Dialog, Input, Select, MessagePlugin } from 'tdesign-react';
import type { InvoiceFile, InvoiceLinkedOrder, InvoiceRecord, OrderRecord } from '../types';
import { DICT_CODES, useDictionaries } from '../contexts/DictionaryContext';
import { getDictLabel } from '../types';
import { callFunction } from '../lib/cloudbase';
import { money, orderSnapshot, orderTotal, replaceLinkedOrders, type InvoiceDraft } from '../utils/invoiceOrders';

type Candidate = OrderRecord & { linkedInvoiceId: string };
export type InvoiceConflict = { orderId: string; invoiceId: string };
type Props = { form: InvoiceDraft; onChange: Dispatch<SetStateAction<InvoiceDraft>>; invoiceId?: string; conflicts?: InvoiceConflict[]; renderAttachments: (files: InvoiceFile[]) => ReactNode; onViewInvoice: (record: InvoiceRecord) => void };
function useOrderChannels(orders: InvoiceLinkedOrder[]) {
  const dictionaries = useDictionaries();
  const map = dictionaries.getMap(DICT_CODES.salesChannel);
  const [channels, setChannels] = useState<Record<string, string>>({});
  const missingIds = JSON.stringify(orders.filter(order => order.salesChannel === undefined).map(order => order.orderId));
  useEffect(() => {
    let cancelled = false;
    const ids: string[] = JSON.parse(missingIds);
    if (!ids.length) return;
    async function fetchChannels() {
      try {
        const fetched: Record<string, string> = {};
        for (let offset = 0; offset < ids.length; offset += 100) {
          const result = await callFunction<{ success: boolean; channels: { orderId: string; salesChannel: string }[] }>('queryInvoiceOrders', { data: { action: 'orderChannels', orderIds: ids.slice(offset, offset + 100) } });
          if (!result.success) return;
          for (const item of result.channels) fetched[item.orderId] = item.salesChannel;
        }
        if (!cancelled) setChannels(fetched);
      } catch { /* 保留发票主体信息，渠道查询失败时明确显示未获取。 */ }
    }
    void fetchChannels();
    return () => { cancelled = true; };
  }, [missingIds]);
  return (order: InvoiceLinkedOrder) => {
    const channel = order.salesChannel ?? channels[order.orderId];
    return channel === undefined ? '未获取' : channel ? getDictLabel(map, channel) : '未填写';
  };
}
export function InvoiceOrderSummary({ form, renderAttachments }: Pick<Props, 'form' | 'renderAttachments'>) {
  const channelLabel = useOrderChannels(form.linkedOrders || []);
  if (form.entryMode !== 'linkedOrders') return null;
  return <div className="space-y-3">
    {(form.linkedOrders || []).map(order => <div key={order.orderId} className="border rounded-lg p-3 space-y-2">
      <div className="font-medium">订单 #{order.serialNumber} · {money(order.amount)}</div>
      <div className="text-xs text-gray-500">渠道：{channelLabel(order)} · {order.onlineOrderNumber || '无网店订单号'} · {order.customerName} · {order.orderDate}</div>
      <div className="text-sm">{order.productSummary || '无货品摘要'}</div>
      {order.attachments.length ? renderAttachments(order.attachments) : <div className="text-xs text-gray-400">暂无订单附件</div>}
    </div>)}
    <div className="text-sm">关联 {form.linkedOrders?.length || 0} 张订单 · 订单合计 {money(orderTotal(form.linkedOrders || []))}</div>
    <div className="text-sm">最终开票金额 {money(form.invoiceAmount)} · 调整差额 {money(form.invoiceAmount - orderTotal(form.linkedOrders || []))}</div>
    {form.amountAdjustmentReason && <div className="text-sm">调整原因：{form.amountAdjustmentReason}</div>}
  </div>;
}
export default function InvoiceOrderFields({ form, onChange, invoiceId, conflicts = [], renderAttachments, onViewInvoice }: Props) {
  const linked = form.entryMode === 'linkedOrders';
  const channelLabel = useOrderChannels(form.linkedOrders || []);
  const dictionaries = useDictionaries();
  const channelMap = dictionaries.getMap(DICT_CODES.salesChannel);
  const [visible, setVisible] = useState(false);
  const [kind, setKind] = useState('serialNumber');
  const [keyword, setKeyword] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [channel, setChannel] = useState('');
  const [rows, setRows] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<Map<string, Candidate>>(new Map());
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [adjusted, setAdjusted] = useState(() => linked && Math.round(form.invoiceAmount * 100) !== Math.round(orderTotal(form.linkedOrders || []) * 100));
  const [changed, setChanged] = useState(false);
  const request = useRef(0);
  const linkedAdjustment = useRef(adjusted);
  const drafts = useRef<Partial<Record<'manual' | 'linkedOrders', InvoiceDraft>>>({});
  const appliedSearch = useRef<Record<string, unknown>>({});
  const total = orderTotal(form.linkedOrders || []);
  const difference = Math.round((form.invoiceAmount - total) * 100) / 100;
  async function viewInvoice(id: string) {
    try {
      const result = await callFunction<{ success: boolean; invoice: InvoiceRecord; errMsg?: string }>('queryInvoiceOrders', { data: { action: 'invoiceDetail', invoiceId: id } });
      if (!result.success) throw new Error(result.errMsg || '加载失败');
      onViewInvoice(result.invoice);
    } catch (err) { MessagePlugin.error(String(err)); }
  }
  async function search(nextCursor: string | null = null) {
    const token = ++request.current;
    if (startDate && endDate && startDate > endDate) { setError('开始日期不能晚于结束日期'); return; }
    if (!nextCursor) appliedSearch.current = { ...(keyword.trim() ? { [kind]: keyword.trim() } : {}), startDate, endDate, salesChannel: channel.trim() };
    setLoading(true); setError('');
    try {
      const result = await callFunction<{ success: boolean; data: Candidate[]; cursor: string | null; errMsg?: string }>('queryInvoiceOrders', { data: { ...appliedSearch.current, cursor: nextCursor } });
      if (token !== request.current) return;
      if (!result.success || !Array.isArray(result.data)) throw new Error(result.errMsg || '查询失败');
      setRows(prev => nextCursor ? [...prev, ...result.data] : result.data); setCursor(result.cursor);
      setSelected(prev => {
        const next = new Map(prev);
        for (const row of result.data) {
          if (next.has(row._id) && row.linkedInvoiceId && row.linkedInvoiceId !== invoiceId) next.delete(row._id);
        }
        return next;
      });
    } catch (err) { if (token === request.current) setError(String(err)); }
    finally { if (token === request.current) setLoading(false); }
  }
  function changeOrders(orders: InvoiceLinkedOrder[]) {
    onChange(prev => replaceLinkedOrders(prev, orders, adjusted));
    setChanged(adjusted);
  }
  function switchMode(mode: 'manual' | 'linkedOrders') {
    if (linked) linkedAdjustment.current = adjusted;
    drafts.current[linked ? 'linkedOrders' : 'manual'] = form;
    const cached = drafts.current[mode];
    onChange(prev => ({ ...prev, entryMode: mode, linkedOrders: cached?.linkedOrders || [], linkedOrderTotal: cached?.linkedOrderTotal || 0, invoiceAmount: cached?.invoiceAmount || 0, amountAdjustmentReason: cached?.amountAdjustmentReason || '', phoneProducts: cached?.phoneProducts || [], phoneModel: cached?.phoneModel || '', phoneQuantity: cached?.phoneQuantity || 0, unitPrice: cached?.unitPrice || 0 }));
    setAdjusted(mode === 'linkedOrders' && linkedAdjustment.current); setChanged(false);
  }
  return <div className="col-span-2 space-y-3">
    <div className="flex gap-2" role="group" aria-label="开票方式">
      <Button theme={linked ? 'primary' : 'default'} onClick={() => !linked && switchMode('linkedOrders')}>关联订单开票</Button>
      <Button theme={!linked ? 'primary' : 'default'} onClick={() => linked && switchMode('manual')}>手工填写</Button>
    </div>
    {linked && <>
      <div className="flex justify-between items-center"><span className="font-medium text-sm">关联订单</span><Button variant="outline" onClick={() => { setVisible(true); setSelected(new Map()); void search(); }}>添加订单</Button></div>
      {!form.linkedOrders?.length && <div className="rounded-lg bg-gray-50 p-4 text-sm text-gray-500">尚未关联订单。找不到订单时，可切换手工填写。</div>}
      {(form.linkedOrders || []).map(order => {
        const conflict = conflicts.find(item => item.orderId === order.orderId);
        return <div key={order.orderId} className={`border rounded-lg p-3 space-y-2 ${conflict ? 'border-red-400' : ''}`}>
          <div className="flex justify-between"><strong className="text-sm">订单 #{order.serialNumber}</strong><Button size="small" variant="text" theme="danger" onClick={() => changeOrders((form.linkedOrders || []).filter(item => item.orderId !== order.orderId))}>移除</Button></div>
          <div className="text-xs text-gray-500">渠道：{channelLabel(order)} · {order.onlineOrderNumber || '无网店订单号'} · {order.customerName} · {order.orderDate}</div>
          <div className="text-sm">{order.productSummary || '无货品摘要'}</div>
          <div className="text-sm font-medium">关联金额：{money(order.amount)}</div>
          {order.attachments.length ? renderAttachments(order.attachments) : <div className="text-xs text-gray-400">暂无订单附件</div>}
          {conflict && <div className="text-sm text-red-600">该订单已关联其他发票，请移除。<Button variant="text" size="small" onClick={() => void viewInvoice(conflict.invoiceId)}>查看发票</Button></div>}
        </div>;
      })}
      <div className="bg-gray-50 rounded-lg p-3 space-y-3">
        <div className="text-sm">已关联 {form.linkedOrders?.length || 0} 张订单 · 订单合计 <strong>{money(total)}</strong></div>
        <label className="block text-sm">本次开票金额 *<Input type="number" aria-label="本次开票金额" value={String(form.invoiceAmount || '')} onChange={value => { setAdjusted(true); onChange(prev => ({ ...prev, invoiceAmount: Number(value) })); }} /></label>
        <div className="flex justify-between text-sm"><span>调整差额：{money(difference)}</span><Button size="small" variant="text" onClick={() => { setAdjusted(false); setChanged(false); onChange(prev => ({ ...prev, invoiceAmount: total, amountAdjustmentReason: '' })); }}>恢复为订单合计</Button></div>
        {difference !== 0 && <label className="block text-sm">调整原因 *<Input aria-label="金额调整原因" value={form.amountAdjustmentReason || ''} onChange={value => onChange(prev => ({ ...prev, amountAdjustmentReason: String(value) }))} /></label>}
        {changed && <div className="text-xs text-orange-600" role="status">关联订单已变化，请核对开票金额。</div>}
      </div>
    </>}
    <Dialog header="添加关联订单" visible={visible} width="900px" onClose={() => { request.current++; setLoading(false); setVisible(false); }} footer={<div className="flex justify-between items-center"><span>已选 {selected.size} 张 · 合计 {money(orderTotal([...selected.values()].map(orderSnapshot)))}</span><div className="flex gap-2"><Button onClick={() => setVisible(false)}>取消</Button><Button theme="primary" disabled={!selected.size || loading} onClick={() => { const existing = form.linkedOrders || []; changeOrders([...existing, ...[...selected.values()].filter(row => !existing.some(item => item.orderId === row._id)).map(orderSnapshot)]); setVisible(false); }}>添加所选订单</Button></div></div>}>
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2"><Select aria-label="订单搜索类型" value={kind} onChange={value => setKind(String(value))} options={[{ label: '订单序号', value: 'serialNumber' }, { label: '网店订单号', value: 'onlineOrderNumber' }, { label: '客户名称', value: 'customerName' }]} style={{ width: 150 }} popupProps={{ zIndex: 6000 }} /><Input aria-label="订单搜索关键词" value={keyword} onChange={value => setKeyword(String(value))} placeholder="输入搜索内容" style={{ width: 220 }} /><Button theme="primary" loading={loading} onClick={() => void search()}>搜索</Button></div>
        <div className="flex flex-wrap gap-3 text-xs"><label>开始日期 <input aria-label="订单开始日期" type="date" value={startDate} onChange={event => setStartDate(event.target.value)} /></label><label>结束日期 <input aria-label="订单结束日期" type="date" value={endDate} onChange={event => setEndDate(event.target.value)} /></label><Input aria-label="渠道筛选" placeholder="渠道（可选）" value={channel} onChange={value => setChannel(String(value))} style={{ width: 150 }} /></div>
        {error && <div className="text-red-600" role="alert">{error}</div>}
        <div className="max-h-[45vh] overflow-auto space-y-2">
          {!loading && !rows.length && !error && <p className="text-gray-500 py-4">没有找到订单，可调整条件或使用手工填写。</p>}
          {rows.map(row => {
            const snapshot = orderSnapshot(row); const added = form.linkedOrders?.some(item => item.orderId === row._id); const occupied = !!row.linkedInvoiceId && row.linkedInvoiceId !== invoiceId;
            return <div key={row._id} className="border rounded-lg p-3">
              <div className="flex gap-3 items-start"><input type="checkbox" aria-label={`选择订单 ${row.serialNumber}`} disabled={!!added || occupied || loading} checked={!!added || selected.has(row._id)} onChange={event => { const checked = event.target.checked; setSelected(prev => { const next = new Map(prev); if (checked) next.set(row._id, row); else next.delete(row._id); return next; }); }} /><div className="flex-1 space-y-1"><div className="flex justify-between text-sm"><strong>#{row.serialNumber} · {row.customerName}</strong><strong>{money(snapshot.amount)}</strong></div><div className="text-xs text-gray-500">渠道：{row.salesChannel ? getDictLabel(channelMap, row.salesChannel) : '未填写'} · {row.onlineOrderNumber || '无网店订单号'} · {row.date}</div><div className="text-xs">{snapshot.productSummary}</div>{occupied ? <Button variant="text" size="small" onClick={() => void viewInvoice(row.linkedInvoiceId)}>已关联发票 · 查看</Button> : added ? <span className="text-xs text-blue-600">已添加</span> : null}<details><summary className="text-xs cursor-pointer">附件 {snapshot.attachments.length} 个</summary>{snapshot.attachments.length > 0 && renderAttachments(snapshot.attachments)}</details></div></div>
            </div>;
          })}
        </div>
        {cursor && <Button loading={loading} onClick={() => void search(cursor)}>加载更多订单</Button>}
      </div>
    </Dialog>
  </div>;
}
