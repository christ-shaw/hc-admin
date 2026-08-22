import { useState, useEffect, useMemo } from 'react';
import { Dialog, Input, Select, Button, MessagePlugin } from 'tdesign-react';
import { ExternalLink, Plus, RotateCw, Trash2 } from 'lucide-react';
import { InboundRecord, OutboundRecord } from '../types';
import { usePhoneModels } from '../hooks/usePhoneModels';
import { DICT_CODES, useDictionaries } from '../contexts/DictionaryContext';

interface RecordEditProps {
  visible: boolean;
  record: InboundRecord | OutboundRecord | null;
  type: 'inbound' | 'outbound';
  onClose: () => void;
  onSave: (recordId: string, updateData: Record<string, unknown>) => Promise<boolean>;
  onDirtyChange?: (dirty: boolean) => void;
  onEditLinkedOrders?: () => void;
  onSyncFromOrders?: () => Promise<{
    success: boolean;
    phoneModels?: OutboundRecord['phoneModels'];
    errMsg?: string;
  }>;
}

export function RecordEdit({ visible, record, type, onClose, onSave, onDirtyChange, onEditLinkedOrders, onSyncFromOrders }: RecordEditProps) {
  const { brands, loadBrands, loadAllModels } = usePhoneModels();
  const dictionaries = useDictionaries();
  const channelTypeOptions = dictionaries.getOptions(DICT_CODES.channelType);
  const [legacyModelOptions, setLegacyModelOptions] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [syncingModels, setSyncingModels] = useState(false);

  const [customerName, setCustomerName] = useState('');
  const [date, setDate] = useState('');
  const [channelType, setChannelType] = useState('');
  const [shopName, setShopName] = useState('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [phoneModels, setPhoneModels] = useState<Array<{ model: string; quantity: number }>>([]);

  const isInbound = type === 'inbound';
  const isOrderLinkedOutbound = !isInbound
    && (record as OutboundRecord | null)?.source === 'order'
    && ((record as OutboundRecord | null)?.orderIds?.length || 0) > 0;
  const isLinkedPendingOutbound = isOrderLinkedOutbound
    && (record as OutboundRecord | null)?.outboundStatus === 'pending';

  const modelOptions = useMemo(() => {
    const labels = brands.flatMap(brand => (brand.products || []).flatMap(product => {
      const enabledSpecs = (product.specs || []).filter(spec => spec.enabled !== false);
      const specs = enabledSpecs.length > 0 ? enabledSpecs : [{ name: '默认' }];
      return specs.map(spec => {
        const base = [brand.brand, product.name].filter(Boolean).join(' / ');
        return spec.name && spec.name !== '默认' ? `${base} / ${spec.name}` : base;
      });
    }));
    // 旧记录可能不在当前型号字典中，继续作为选项保留，不改写历史数据。
    const catalogLabels = isInbound ? legacyModelOptions : labels;
    return Array.from(new Set([
      ...phoneModels.map(item => item.model).filter(Boolean),
      ...catalogLabels.filter(Boolean),
    ])).map(model => ({ label: model, value: model }));
  }, [brands, isInbound, legacyModelOptions, phoneModels]);

  useEffect(() => {
    if (record) {
      setCustomerName(record.customerName || '');
      setDate(isInbound ? (record as InboundRecord).inboundDate || '' : (record as OutboundRecord).outboundDate || '');
      if (isInbound) {
        setChannelType((record as InboundRecord).type || '');
        setShopName((record as InboundRecord).shopName || '');
      }
      setTrackingNumber((isInbound ? (record as InboundRecord).trackingNumber : (record as OutboundRecord).trackingNumber) || '');
      setPhoneModels(record.phoneModels?.map(m => ({ ...m })) || [{ model: '', quantity: 1 }]);
    }
  }, [record, isInbound]);

  useEffect(() => {
    if (!visible || !record) {
      onDirtyChange?.(false);
      return;
    }
    const initialModels = record.phoneModels?.map(item => ({ ...item })) || [{ model: '', quantity: 1 }];
    const initialDate = isInbound ? (record as InboundRecord).inboundDate || '' : (record as OutboundRecord).outboundDate || '';
    const dirty = customerName !== (record.customerName || '')
      || date !== initialDate
      || trackingNumber !== (record.trackingNumber || '')
      || (isInbound && (
        channelType !== ((record as InboundRecord).type || '')
        || shopName !== ((record as InboundRecord).shopName || '')
      ))
      || (!isOrderLinkedOutbound && JSON.stringify(phoneModels) !== JSON.stringify(initialModels));
    onDirtyChange?.(dirty);
  }, [channelType, customerName, date, isInbound, isOrderLinkedOutbound, onDirtyChange, phoneModels, record, shopName, trackingNumber, visible]);

  useEffect(() => {
    if (!visible || isOrderLinkedOutbound) return;
    if (isInbound) {
      void loadAllModels().then(setLegacyModelOptions);
    } else {
      void loadBrands();
    }
  }, [isInbound, isOrderLinkedOutbound, loadAllModels, loadBrands, visible]);

  const addModelRow = () => {
    setPhoneModels(prev => [...prev, { model: '', quantity: 1 }]);
  };

  const removeModelRow = (index: number) => {
    setPhoneModels(prev => prev.filter((_, i) => i !== index));
  };

  const updateModelRow = (index: number, field: 'model' | 'quantity', value: string | number) => {
    setPhoneModels(prev => prev.map((item, i) =>
      i === index ? { ...item, [field]: field === 'quantity' ? Number(value) || 1 : value } : item
    ));
  };

  const handleSave = async () => {
    if (!customerName) { MessagePlugin.warning('请输入客户名称'); return; }
    if (!date) { MessagePlugin.warning('请选择日期'); return; }
    const validModels = phoneModels.filter(m => m.model);
    if (!isOrderLinkedOutbound && validModels.length === 0) { MessagePlugin.warning('请至少添加一个手机型号'); return; }

    setSaving(true);
    const updateData: Record<string, unknown> = {
      customerName,
    };
    if (!isOrderLinkedOutbound) updateData.phoneModels = validModels;

    if (isInbound) {
      updateData.inboundDate = date;
      updateData.type = channelType;
      updateData.shopName = shopName;
      updateData.trackingNumber = trackingNumber;
    } else {
      updateData.outboundDate = date;
      updateData.trackingNumber = trackingNumber;
    }

    try {
      const success = await onSave(record!._id, updateData);

      if (success) {
        onDirtyChange?.(false);
        MessagePlugin.success('保存成功');
        onClose();
      } else {
        MessagePlugin.error('保存失败');
      }
    } catch (err) {
      MessagePlugin.error('保存失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  };

  const handleSyncFromOrders = async () => {
    if (!onSyncFromOrders || syncingModels) return;
    setSyncingModels(true);
    try {
      const result = await onSyncFromOrders();
      if (!result.success) {
        MessagePlugin.error(result.errMsg || '从订单同步失败');
        return;
      }
      if (result.phoneModels) setPhoneModels(result.phoneModels.map(item => ({ ...item })));
      MessagePlugin.success(result.errMsg || '已从订单同步型号和数量');
    } catch (err) {
      MessagePlugin.error('从订单同步失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSyncingModels(false);
    }
  };

  return (
    <Dialog
      header="编辑记录"
      visible={visible}
      onClose={onClose}
      width="600px"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button theme="primary" onClick={handleSave} loading={saving}>保存</Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-600 mb-1">客户名称</label>
          <Input value={customerName} onChange={(val) => setCustomerName(val as string)} placeholder="请输入客户名称" />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-600 mb-1">
            {isInbound ? '入库日期' : '出库日期'}
          </label>
          <input
            type="date"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-primary"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>

        {isInbound && (
          <>
            <div>
              <label className="block text-sm font-medium text-gray-600 mb-1">渠道类型</label>
              <Select
                value={channelType}
                onChange={(val) => setChannelType(val as string)}
                options={channelTypeOptions}
                placeholder="请选择渠道类型"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-600 mb-1">渠道名称</label>
              <Input value={shopName} onChange={(val) => setShopName(val as string)} placeholder="请输入渠道名称" />
            </div>
          </>
        )}
        <div>
          <label className="block text-sm font-medium text-gray-600 mb-1">快递单号</label>
          <Input value={trackingNumber} onChange={(val) => setTrackingNumber(val as string)} placeholder="请输入快递单号" />
        </div>

        {/* 手机型号列表 */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium text-gray-600">手机型号</label>
            {!isOrderLinkedOutbound && (
              <button onClick={addModelRow} className="text-primary text-sm flex items-center gap-1 hover:underline cursor-pointer">
                <Plus size={14} /> 添加型号
              </button>
            )}
          </div>
          {isOrderLinkedOutbound ? (
            <div className="rounded-lg border border-blue-100 bg-blue-50 p-3">
              <div className="space-y-2">
                {phoneModels.map((item, index) => (
                  <div key={`${item.model}-${index}`} className="flex items-center justify-between gap-3 text-sm text-gray-700">
                    <span>{item.model || '-'}</span>
                    <span className="shrink-0 text-gray-500">数量 {item.quantity || 0}</span>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex items-center justify-between gap-3 border-t border-blue-100 pt-3">
                <p className="text-xs leading-5 text-blue-700">
                  {isLinkedPendingOutbound
                    ? '型号和数量来自关联订单，订单修改后会自动同步。'
                    : '该记录已完成出库，型号和数量作为历史快照保留。'}
                </p>
                <div className="flex shrink-0 gap-2">
                  {isLinkedPendingOutbound && onSyncFromOrders && (
                    <Button
                      size="small"
                      variant="outline"
                      theme="primary"
                      icon={<RotateCw size={14} />}
                      loading={syncingModels}
                      onClick={handleSyncFromOrders}
                    >
                      从订单同步
                    </Button>
                  )}
                  {onEditLinkedOrders && (
                    <Button size="small" variant="outline" theme="primary" icon={<ExternalLink size={14} />} onClick={onEditLinkedOrders}>
                      查看关联订单
                    </Button>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {phoneModels.map((item, index) => (
                <div key={index} className="flex gap-2 items-center">
                  <Select
                    value={item.model}
                    onChange={(val) => updateModelRow(index, 'model', val as string)}
                    options={modelOptions}
                    placeholder="选择型号"
                    filterable
                    style={{ flex: 1 }}
                  />
                  <Input
                    value={String(item.quantity)}
                    onChange={(val) => updateModelRow(index, 'quantity', val as string)}
                    placeholder="数量"
                    style={{ width: 80 }}
                  />
                  <button
                    onClick={() => removeModelRow(index)}
                    className="text-gray-400 hover:text-danger p-1 cursor-pointer"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
