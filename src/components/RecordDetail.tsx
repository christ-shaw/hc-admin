import { useState } from 'react';
import { Dialog, Tag, Loading } from 'tdesign-react';
import { InboundRecord, OutboundRecord, CHANNEL_TYPE_MAP } from '../types';
import { formatDate, getTotalQuantity } from '../utils/format';
import { useStorage } from '../hooks/useStorage';
import { useLogs } from '../hooks/useLogs';

interface RecordDetailProps {
  visible: boolean;
  record: InboundRecord | OutboundRecord | null;
  type: 'inbound' | 'outbound';
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export function RecordDetail({ visible, record, type, onClose, onEdit, onDelete }: RecordDetailProps) {
  const { getRealImageUrl } = useStorage();
  const { fetchRecordHistory } = useLogs();
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [historyVisible, setHistoryVisible] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyData, setHistoryData] = useState<Array<Record<string, unknown>>>([]);
  const [imagesLoaded, setImagesLoaded] = useState(false);

  const isInbound = type === 'inbound';

  const loadImages = async (photos: string[]) => {
    const urls: Record<string, string> = {};
    for (const photo of photos) {
      const url = await getRealImageUrl(photo);
      urls[photo] = url;
    }
    setImageUrls(urls);
    setImagesLoaded(true);
  };

  const loadHistory = async () => {
    if (!record?._id) return;
    setHistoryVisible(true);
    setHistoryLoading(true);
    const result = await fetchRecordHistory(record._id);
    if (result?.success) {
      setHistoryData((result.data || []) as Array<Record<string, unknown>>);
    }
    setHistoryLoading(false);
  };

  if (!record) return null;

  const photos = record.phonePhotos || [];
  if (photos.length > 0 && !imagesLoaded) {
    loadImages(photos);
  }

  return (
    <>
      <Dialog
        header="记录详情"
        visible={visible}
        onClose={onClose}
        width="600px"
        footer={
          <div className="flex gap-2">
            <button onClick={loadHistory} className="text-primary text-sm hover:underline cursor-pointer">
              修改历史
            </button>
            <div className="flex-1" />
            <button onClick={onEdit} className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors cursor-pointer">
              编辑
            </button>
            <button onClick={onDelete} className="px-4 py-2 bg-danger text-white rounded-lg hover:bg-red-400 transition-colors cursor-pointer">
              删除
            </button>
          </div>
        }
      >
        <div className="space-y-3">
          <DetailItem label="客户名称" value={record.customerName} />
          <DetailItem label="日期" value={isInbound ? formatDate((record as InboundRecord).inboundDate) : formatDate((record as OutboundRecord).outboundDate)} />
          {isInbound && (
            <>
              <DetailItem label="渠道类型" value={CHANNEL_TYPE_MAP[(record as InboundRecord).type] || (record as InboundRecord).type || '-'} />
              <DetailItem label="渠道名称" value={(record as InboundRecord).shopName || '-'} />
            </>
          )}
          <DetailItem label="快递单号" value={(isInbound ? (record as InboundRecord).trackingNumber : (record as OutboundRecord).trackingNumber) || '-'} />
          <DetailItem label="手机型号" value={
            <div className="space-y-1">
              {record.phoneModels?.map((m, i) => (
                <div key={i} className="flex gap-2 text-sm">
                  <span>{m.model}</span>
                  <Tag theme="primary" variant="light">x{m.quantity}</Tag>
                </div>
              )) || '-'}
            </div>
          } />
          <DetailItem label="手机总数" value={String(getTotalQuantity(record))} />
          <DetailItem label="异常状态" value={
            record.hasIssue
              ? <Tag theme="danger" variant="light">有异常</Tag>
              : <Tag theme="success" variant="light">正常</Tag>
          } />
          {record.remark && <DetailItem label="备注" value={record.remark} />}

          {/* 照片 */}
          {photos.length > 0 && (
            <div>
              <span className="text-sm text-gray-500">照片：</span>
              <div className="grid grid-cols-4 gap-2 mt-2">
                {photos.map((photo, i) => (
                  <a key={i} href={imageUrls[photo] || photo} target="_blank" rel="noreferrer">
                    <img
                      src={imageUrls[photo] || photo}
                      alt={`照片${i + 1}`}
                      className="w-full h-20 object-cover rounded-lg border border-gray-200 hover:opacity-80 transition-opacity"
                    />
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      </Dialog>

      {/* 修改历史弹窗 */}
      <Dialog
        header="修改历史"
        visible={historyVisible}
        onClose={() => setHistoryVisible(false)}
        width="600px"
        footer={null}
      >
        {historyLoading ? (
          <div className="flex justify-center py-8"><Loading /></div>
        ) : historyData.length === 0 ? (
          <p className="text-center text-gray-400 py-8">暂无修改历史</p>
        ) : (
          <div className="space-y-4 max-h-[60vh] overflow-auto">
            {historyData.map((item, i) => (
              <div key={i} className="border border-gray-200 rounded-lg overflow-hidden">
                <div className="bg-gray-50 px-4 py-2 text-sm flex gap-4">
                  <span className="text-primary font-medium">#{i + 1}</span>
                  <span className="text-gray-500">{formatDate(item.operationTime as string)}</span>
                  <span className="text-success">{item.operator as string}</span>
                </div>
                {(item.changes as Array<Record<string, unknown>>)?.length > 0 && (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50">
                        <th className="px-3 py-2 text-left">字段</th>
                        <th className="px-3 py-2 text-left">旧值</th>
                        <th className="px-3 py-2 text-left">新值</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(item.changes as Array<Record<string, unknown>>).map((change, j) => (
                        <tr key={j} className="border-t">
                          <td className="px-3 py-2 font-medium">{change.field as string}</td>
                          <td className="px-3 py-2 text-danger bg-red-50">
                            <pre className="text-xs whitespace-pre-wrap">{JSON.stringify(change.oldValue, null, 2)}</pre>
                          </td>
                          <td className="px-3 py-2 text-success bg-green-50">
                            <pre className="text-xs whitespace-pre-wrap">{JSON.stringify(change.newValue, null, 2)}</pre>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
          </div>
        )}
      </Dialog>
    </>
  );
}

function DetailItem({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex py-2 border-b border-gray-50">
      <span className="w-24 text-sm text-gray-500 flex-shrink-0">{label}</span>
      <div className="text-sm text-gray-800">{value}</div>
    </div>
  );
}
