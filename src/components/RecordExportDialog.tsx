import { useEffect, useState } from 'react';
import { Button, Dialog, MessagePlugin } from 'tdesign-react';
import { ChevronLeft, ChevronRight, FileDown } from 'lucide-react';

function formatLocalDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function getDefaultDateRange() {
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - 183);
  return { startDate: formatLocalDate(start), endDate: formatLocalDate(today) };
}

export function RecordExportDialog({ visible, recordLabel, exporting, onClose, onExport }: {
  visible: boolean;
  recordLabel: '入库记录' | '出库记录';
  exporting: boolean;
  onClose: () => void;
  onExport: (startDate: string, endDate: string) => Promise<void>;
}) {
  const [step, setStep] = useState(1);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  useEffect(() => {
    if (!visible) return;
    const range = getDefaultDateRange();
    setStep(1);
    setStartDate(range.startDate);
    setEndDate(range.endDate);
  }, [visible]);

  const validateDateRange = (): string | null => {
    if (!startDate || !endDate) return '请选择完整的日期范围';
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (start > end) return '开始日期不能晚于结束日期';
    const diffDays = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
    if (diffDays > 183) return '日期范围不能超过半年（183 天）';
    return null;
  };

  const handleNext = () => {
    const error = validateDateRange();
    if (error) {
      MessagePlugin.warning(error);
      return;
    }
    setStep(2);
  };

  const setQuickRange = (days: number) => {
    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - days);
    setStartDate(formatLocalDate(start));
    setEndDate(formatLocalDate(today));
  };

  return (
    <Dialog header={`导出${recordLabel}`} visible={visible} onClose={onClose} width="560px" footer={null}>
      <div className="space-y-4">
        <div className="flex items-center justify-center gap-0 mb-2">
          {[1, 2].map(item => (
            <div key={item} className="flex items-center">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                item <= step ? 'bg-blue-500 text-white' : 'bg-gray-200 text-gray-500'
              }`}>
                {item < step ? '✓' : item}
              </div>
              {item < 2 && <div className={`w-20 h-0.5 mx-1 ${item < step ? 'bg-blue-500' : 'bg-gray-200'}`} />}
            </div>
          ))}
        </div>
        <div className="text-center text-xs text-gray-400 mb-4">
          {step === 1 ? '选择日期范围' : '确认导出信息'}
        </div>

        {step === 1 && (
          <div className="space-y-3">
            <p className="text-sm text-gray-500">选择需要导出的{recordLabel}日期范围，最多支持半年的数据导出。</p>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1">开始日期 <span className="text-red-500">*</span></label>
                <input
                  type="date"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
                  value={startDate}
                  onChange={event => setStartDate(event.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">结束日期 <span className="text-red-500">*</span></label>
                <input
                  type="date"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
                  value={endDate}
                  onChange={event => setEndDate(event.target.value)}
                />
              </div>
            </div>
            <div className="flex gap-2 flex-wrap">
              {[{ label: '近 1 个月', days: 30 }, { label: '近 3 个月', days: 90 }, { label: '近半年', days: 183 }].map(option => (
                <Button key={option.days} size="small" variant="outline" onClick={() => setQuickRange(option.days)}>
                  {option.label}
                </Button>
              ))}
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            <p className="text-sm text-gray-500">请确认本次导出范围，系统将导出范围内的全部记录。</p>
            <div className="rounded-xl border border-blue-100 bg-blue-50/60 p-4 text-sm">
              <div className="flex justify-between gap-4 py-1">
                <span className="text-gray-500">数据类型</span>
                <span className="font-medium text-gray-800">{recordLabel}</span>
              </div>
              <div className="flex justify-between gap-4 py-1">
                <span className="text-gray-500">日期范围</span>
                <span className="font-medium text-gray-800">{startDate} 至 {endDate}</span>
              </div>
              <div className="flex justify-between gap-4 py-1">
                <span className="text-gray-500">文件格式</span>
                <span className="font-medium text-gray-800">Excel（.xlsx）</span>
              </div>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between pt-4 border-t border-gray-100">
          <div>
            {step === 2 && (
              <Button variant="outline" icon={<ChevronLeft size={14} />} onClick={() => setStep(1)}>上一步</Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button disabled={exporting} onClick={onClose}>取消</Button>
            {step === 1 ? (
              <Button theme="primary" icon={<ChevronRight size={14} />} onClick={handleNext}>下一步</Button>
            ) : (
              <Button theme="primary" icon={<FileDown size={14} />} loading={exporting} onClick={() => onExport(startDate, endDate)}>
                导出 Excel
              </Button>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
