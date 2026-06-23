import { useState, useEffect } from 'react';
import { Dialog, Input, Select, Button, MessagePlugin } from 'tdesign-react';
import { Plus, Trash2 } from 'lucide-react';
import { InboundRecord, OutboundRecord } from '../types';
import { usePhoneModels } from '../hooks/usePhoneModels';
import { DICT_CODES, useDictionaries } from '../contexts/DictionaryContext';

interface RecordEditProps {
  visible: boolean;
  record: InboundRecord | OutboundRecord | null;
  type: 'inbound' | 'outbound';
  onClose: () => void;
  onSave: (recordId: string, updateData: Record<string, unknown>) => Promise<boolean>;
}

export function RecordEdit({ visible, record, type, onClose, onSave }: RecordEditProps) {
  const { loadAllModels } = usePhoneModels();
  const dictionaries = useDictionaries();
  const channelTypeOptions = dictionaries.getOptions(DICT_CODES.channelType);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const [customerName, setCustomerName] = useState('');
  const [date, setDate] = useState('');
  const [channelType, setChannelType] = useState('');
  const [shopName, setShopName] = useState('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [phoneModels, setPhoneModels] = useState<Array<{ model: string; quantity: number }>>([]);

  const isInbound = type === 'inbound';

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
    loadAllModels().then(models => setModelOptions(models));
  }, [loadAllModels]);

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
    if (validModels.length === 0) { MessagePlugin.warning('请至少添加一个手机型号'); return; }

    setSaving(true);
    const updateData: Record<string, unknown> = {
      customerName,
      phoneModels: validModels,
    };

    if (isInbound) {
      updateData.inboundDate = date;
      updateData.type = channelType;
      updateData.shopName = shopName;
      updateData.trackingNumber = trackingNumber;
    } else {
      updateData.outboundDate = date;
      updateData.trackingNumber = trackingNumber;
    }

    const success = await onSave(record!._id, updateData);
    setSaving(false);

    if (success) {
      MessagePlugin.success('保存成功');
      onClose();
    } else {
      MessagePlugin.error('保存失败');
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
            <button onClick={addModelRow} className="text-primary text-sm flex items-center gap-1 hover:underline cursor-pointer">
              <Plus size={14} /> 添加型号
            </button>
          </div>
          <div className="space-y-2">
            {phoneModels.map((item, index) => (
              <div key={index} className="flex gap-2 items-center">
                <Select
                  value={item.model}
                  onChange={(val) => updateModelRow(index, 'model', val as string)}
                  options={modelOptions.map(m => ({ label: m, value: m }))}
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
        </div>
      </div>
    </Dialog>
  );
}
