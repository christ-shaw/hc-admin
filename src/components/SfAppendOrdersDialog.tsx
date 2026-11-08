import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, Input, MessagePlugin, Table } from 'tdesign-react';
import type { OrderRecord, SfExpressWorkbenchRow } from '../types';
import { callFunction } from '../lib/cloudbase';

interface Props {
  target: SfExpressWorkbenchRow | null;
  onClose: () => void;
  onSuccess: () => void;
}

const paymentLabel = (value: string) => ['prepaid', '包邮', '寄付月结'].includes(value) ? '寄付月结' : '收方付';

export function SfAppendOrdersDialog({ target, onClose, onSuccess }: Props) {
  const [date, setDate] = useState('');
  const [keyword, setKeyword] = useState('');
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [selected, setSelected] = useState<Array<string | number>>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const requestSequence = useRef(0);
  const requestId = useRef('');
  const shipment = target?.currentSfOrder;

  const search = async (searchDate: string, searchKeyword: string) => {
    if (!shipment) return;
    const sequence = ++requestSequence.current;
    setLoading(true);
    setOrders([]);
    setSelected([]);
    setConfirmed(false);
    try {
      const result = await callFunction<{ success: boolean; data?: OrderRecord[]; truncated?: boolean; errMsg?: string }>('manageSfShipment', { data: {
        action: 'listAppendOrders', sfExpressOrderId: shipment._id, date: searchDate, onlineOrderNumber: searchKeyword.trim(),
      } });
      if (sequence !== requestSequence.current) return;
      if (!result.success) throw new Error(result.errMsg || '查询失败');
      setOrders(result.data || []);
      setTruncated(!!result.truncated);
    } catch (error) {
      if (sequence === requestSequence.current) MessagePlugin.error(error instanceof Error ? error.message : String(error));
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  };

  useEffect(() => {
    setOrders([]); setSelected([]); setConfirmed(false); setKeyword(''); setTruncated(false);
    requestId.current = crypto.randomUUID();
    if (target) {
      const nextDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
      setDate(nextDate);
      void search(nextDate, '');
    }
    return () => { requestSequence.current += 1; };
  }, [shipment?._id]);

  const append = async () => {
    if (!shipment || !confirmed || !selected.length || saving) return;
    setSaving(true);
    try {
      const result = await callFunction<{ success: boolean; waybillNo?: string; errMsg?: string }>('manageSfShipment', { data: {
        action: 'appendOrders', sfExpressOrderId: shipment._id, shipmentVersion: shipment.shipmentVersion,
        sourceOrderIds: selected.map(String), requestId: requestId.current, confirmShipmentRecipient: true,
      } });
      if (!result.success) throw new Error(result.errMsg || '追加失败');
      MessagePlugin.success(`已追加 ${selected.length} 条订单，继续使用运单 ${result.waybillNo}。新增出库单需独立完成拍照。`);
      onSuccess();
    } catch (error) {
      MessagePlugin.error(error instanceof Error ? error.message : String(error));
    } finally { setSaving(false); }
  };

  const recipient = shipment?.orderSnapshot || target?.order;
  return <Dialog header="追加订单到已打印面单" visible={!!target} width="960px"
    onClose={() => !saving && onClose()} onConfirm={append}
    confirmBtn={{ content: `确认追加（${selected.length}）`, loading: saving,
      disabled: loading || !confirmed || !selected.length || selected.length > 20 }}
    cancelBtn={{ content: '取消', disabled: saving }}>
    <div className="space-y-4 text-sm">
      <div className="space-y-1 rounded-lg bg-blue-50 p-3 text-blue-800">
        <p className="font-medium">原顺丰运单：{shipment?.waybillNo}</p>
        <p>{recipient?.consignee} · {recipient?.consigneePhone} · {paymentLabel(recipient?.shippingFee || '')}</p>
        <p>{recipient?.consigneeAddress}</p>
        <p>追加后继续使用原单号和原面单收件信息，不生成新单号。包裹回到打包中，新增出库单仍需拍照出库。</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <input type="date" aria-label="待追加订单日期" className="rounded border px-2" value={date}
          disabled={saving || loading} onChange={event => { setDate(event.target.value); setOrders([]); setSelected([]); setConfirmed(false); }} />
        <Input className="max-w-xs" placeholder="网店订单号（精确查询，可留空）" value={keyword} disabled={saving || loading}
          onChange={value => { setKeyword(String(value)); setOrders([]); setSelected([]); setConfirmed(false); }} />
        <Button variant="outline" loading={loading} disabled={saving || !date} onClick={() => void search(date, keyword)}>查询订单</Button>
      </div>
      <p className="text-gray-500">仅显示尚未发货、未关联有效运单的顺丰订单；最多追加 20 条。</p>
      {truncated && <p className="text-amber-700">当天订单较多，仅检查前 100 条；未找到时请输入完整网店订单号查询。</p>}
      <div className="max-h-[40vh] overflow-auto">
        <Table rowKey="_id" data={orders} loading={loading} selectedRowKeys={selected}
          empty="没有符合条件的订单，请调整日期或订单号"
          onSelectChange={keys => { setSelected(keys); setConfirmed(false); requestId.current = crypto.randomUUID(); }}
          columns={[
            { colKey: 'row-select', type: 'multiple', width: 44, checkProps: () => ({ disabled: saving }) },
            { colKey: 'onlineOrderNumber', title: '订单', width: 150, cell: ({ row }) => row.onlineOrderNumber || `序号 ${row.serialNumber}` },
            { colKey: 'consignee', title: '收件人', width: 95 },
            { colKey: 'consigneePhone', title: '电话', width: 130 },
            { colKey: 'consigneeAddress', title: '地址' },
            { colKey: 'shippingFee', title: '收费方式', width: 100, cell: ({ row }) => paymentLabel(row.shippingFee) },
          ]} />
      </div>
      <label className="flex items-start gap-2 rounded border border-amber-200 bg-amber-50 p-3">
        <input type="checkbox" checked={confirmed} disabled={saving || !selected.length}
          onChange={event => setConfirmed(event.target.checked)} />
        <span>已核对所选订单，确认全部随此包裹寄出，并使用上方原面单的收件人、电话、地址和收费方式。原纸质面单上的货品备注不会自动更新，如需更新请重新打印。</span>
      </label>
    </div>
  </Dialog>;
}
