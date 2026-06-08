import { useState, useEffect } from 'react';
import { Button, Input, MessagePlugin } from 'tdesign-react';
import { Settings, Save, RotateCcw } from 'lucide-react';
import { callFunction } from '../lib/cloudbase';

export function SettingsPage() {
  const [counterValue, setCounterValue] = useState<number>(0);
  const [savedValue, setSavedValue] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  /** 加载计数器当前值 */
  const fetchCounter = async () => {
    setLoading(true);
    try {
      const result = await callFunction<{ success: boolean; value: number }>('manageCounter', {
        data: { action: 'get', counterName: 'orderSerialNumber' },
      });
      if (result.success) {
        setCounterValue(result.value);
        setSavedValue(result.value);
      }
    } catch (err) {
      MessagePlugin.error('获取计数器失败: ' + String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCounter();
  }, []);

  /** 保存计数器值 */
  const handleSave = async () => {
    if (counterValue < 0) {
      MessagePlugin.warning('计数器值不能为负数');
      return;
    }
    if (!Number.isInteger(counterValue)) {
      MessagePlugin.warning('计数器值必须为整数');
      return;
    }
    setSaving(true);
    try {
      const result = await callFunction<{ success: boolean; value: number; errMsg?: string }>('manageCounter', {
        data: { action: 'set', counterName: 'orderSerialNumber', value: counterValue },
      });
      if (result.success) {
        setSavedValue(counterValue);
        MessagePlugin.success(`计数器已更新为 ${counterValue}，下一个订单序号将为 ${counterValue + 1}`);
      } else {
        MessagePlugin.error('保存失败: ' + (result.errMsg || '未知错误'));
      }
    } catch (err) {
      MessagePlugin.error('保存失败: ' + String(err));
    } finally {
      setSaving(false);
    }
  };

  const hasChanged = counterValue !== savedValue;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-800">系统设置</h1>
        <p className="text-gray-500 mt-1">管理系统的全局配置</p>
      </div>

      {/* 订单序号计数器 */}
      <div className="glass-card p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
            <Settings size={20} className="text-blue-600" />
          </div>
          <div>
            <h3 className="text-base font-medium text-gray-800">订单序号计数器</h3>
            <p className="text-sm text-gray-500">控制新建订单的序号自增值，下一个订单将使用 当前值+1 作为序号</p>
          </div>
        </div>

        <div className="bg-gray-50 rounded-lg p-4 space-y-4">
          <div className="flex items-center gap-4">
            <div className="flex-1 max-w-xs">
              <label className="block text-sm text-gray-600 mb-1">当前计数器值</label>
              <Input
                type="number"
                value={String(counterValue)}
                onChange={val => setCounterValue(Number(val))}
                placeholder="请输入计数值"
              />
            </div>
            <div className="pt-5 flex gap-2">
              <Button
                theme="primary"
                icon={<Save size={16} />}
                loading={saving}
                disabled={!hasChanged}
                onClick={handleSave}
              >
                保存
              </Button>
              <Button
                variant="outline"
                icon={<RotateCcw size={16} />}
                disabled={!hasChanged}
                onClick={() => setCounterValue(savedValue)}
              >
                还原
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-6 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-gray-500">当前值:</span>
              <span className="font-mono font-medium text-gray-800">{savedValue}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-gray-500">下一个订单序号:</span>
              <span className="font-mono font-medium text-blue-600">{savedValue + 1}</span>
            </div>
          </div>

          <div className="text-xs text-gray-400 space-y-1">
            <p>• 修改计数器值后，下次新建订单将使用 <span className="font-mono text-gray-600">新值+1</span> 作为序号</p>
            <p>• 如果序号出现冲突（如手动导入已有序号的数据），可在此调整计数器到最大序号值</p>
            <p>• 建议将计数器值设置为历史订单中的最大序号，避免序号重复</p>
          </div>
        </div>
      </div>
    </div>
  );
}
