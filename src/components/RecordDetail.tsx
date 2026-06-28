import { useState, useEffect, useCallback } from 'react';
import { Dialog, Tag, Loading } from 'tdesign-react';
import { InboundRecord, OutboundRecord } from '../types';
import { formatDate, getTotalQuantity } from '../utils/format';
import { useLogs } from '../hooks/useLogs';
import { DICT_CODES, useDictionaries } from '../contexts/DictionaryContext';
import { getCloudFileURLs } from '../lib/cloudbase';

interface RecordDetailProps {
  visible: boolean;
  record: InboundRecord | OutboundRecord | null;
  type: 'inbound' | 'outbound';
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export function RecordDetail({ visible, record, type, onClose, onEdit, onDelete }: RecordDetailProps) {
  const { fetchRecordHistory } = useLogs();
  const dictionaries = useDictionaries();
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [imagesLoading, setImagesLoading] = useState(false);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyData, setHistoryData] = useState<Array<Record<string, unknown>>>([]);
  const [previewVisible, setPreviewVisible] = useState(false);
  const [previewSrc, setPreviewSrc] = useState('');

  const isInbound = type === 'inbound';

  // 当 record 变化时，重置并加载图片
  useEffect(() => {
    const packagePhotos = isInbound ? (record as InboundRecord)?.packagePhotos : [];
    const phonePhotos = record?.phonePhotos;
    const allPhotos = [...(packagePhotos || []), ...(phonePhotos || [])];

    if (allPhotos.length === 0) {
      setImageUrls({});
      setImagesLoading(false);
      return;
    }

    let cancelled = false;
    setImagesLoading(true);
    setImageUrls({});

    (async () => {
      try {
        const fileList = await getCloudFileURLs(allPhotos);
        if (cancelled) return;
        const urls = Object.fromEntries(
          fileList.map(item => [item.fileID, item.tempFileURL || item.fileID])
        );
        setImageUrls(urls);
      } catch {
        if (!cancelled) {
          setImageUrls(Object.fromEntries(allPhotos.map(photo => [photo, photo])));
        }
      } finally {
        if (!cancelled) setImagesLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [record?._id, isInbound]);

  const loadHistory = useCallback(async () => {
    if (!record?._id) return;
    setHistoryVisible(true);
    setHistoryLoading(true);
    const result = await fetchRecordHistory(record._id);
    if (result?.success) {
      setHistoryData((result.data || []) as Array<Record<string, unknown>>);
    }
    setHistoryLoading(false);
  }, [record?._id, fetchRecordHistory]);

  if (!record) return null;

  const packagePhotos = isInbound ? (record as InboundRecord).packagePhotos || [] : [];
  const phonePhotos = record.phonePhotos || [];

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
            <button onClick={onEdit} className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary-hover cursor-pointer">
              编辑
            </button>
            <button onClick={onDelete} className="px-4 py-2 bg-danger text-white rounded-lg hover:bg-red-400 cursor-pointer">
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
              <DetailItem label="渠道类型" value={dictionaries.getLabel(DICT_CODES.channelType, (record as InboundRecord).type) || '-'} />
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

          {/* 包裹照片 */}
          {isInbound && packagePhotos.length > 0 && (
            <div>
              <span className="text-sm text-gray-500">包裹照片：</span>
              {imagesLoading && Object.keys(imageUrls).length === 0 ? (
                <div className="flex items-center gap-2 py-4"><Loading size="small" /><span className="text-xs text-gray-400">加载中...</span></div>
              ) : (
                <div className="grid grid-cols-4 gap-2 mt-2">
                  {packagePhotos.map((photo, i) => (
                    <PhotoItem key={`pkg-${i}`} photo={photo} imageUrls={imageUrls} onPreview={(src) => { setPreviewSrc(src); setPreviewVisible(true); }} />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 手机照片 */}
          {phonePhotos.length > 0 && (
            <div>
              <span className="text-sm text-gray-500">手机照片：</span>
              {imagesLoading && Object.keys(imageUrls).length === 0 ? (
                <div className="flex items-center gap-2 py-4"><Loading size="small" /><span className="text-xs text-gray-400">加载中...</span></div>
              ) : (
                <div className="grid grid-cols-4 gap-2 mt-2">
                  {phonePhotos.map((photo, i) => (
                    <PhotoItem key={`phone-${i}`} photo={photo} imageUrls={imageUrls} onPreview={(src) => { setPreviewSrc(src); setPreviewVisible(true); }} />
                  ))}
                </div>
              )}
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

      {/* 照片预览弹窗 */}
      {previewVisible && (
        <div
          className="fixed inset-0 z-[9999] bg-black/80 flex items-center justify-center"
          onClick={() => setPreviewVisible(false)}
        >
          <button
            className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/20 hover:bg-white/40 flex items-center justify-center text-white text-xl cursor-pointer z-10"
            onClick={() => setPreviewVisible(false)}
          >
            ✕
          </button>
          <img
            src={previewSrc}
            alt="照片预览"
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
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

function PhotoItem({ photo, imageUrls, onPreview }: { photo: string; imageUrls: Record<string, string>; onPreview: (src: string) => void }) {
  const src = imageUrls[photo];
  const isLoaded = !!src;
  return (
    <div className="relative group">
      {isLoaded ? (
        <img
          src={src}
          alt="照片"
          onClick={() => onPreview(src)}
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = 'none';
            (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden');
          }}
          className="w-full h-20 object-cover rounded-lg border border-gray-200 hover:opacity-80 cursor-zoom-in"
        />
      ) : null}
      <div className={`w-full h-20 rounded-lg border border-gray-200 bg-gray-100 flex items-center justify-center text-gray-400 text-xs ${isLoaded ? 'hidden' : ''}`}>
        加载中...
      </div>
    </div>
  );
}
