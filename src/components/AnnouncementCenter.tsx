import { useEffect, useMemo, useState } from 'react';
import { Button, Dialog, MessagePlugin, Tag } from 'tdesign-react';
import { Bell, Check, ExternalLink, Sparkles } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { callFunction } from '../lib/cloudbase';
import { formatDate } from '../utils/format';
import type { FeatureAnnouncement, ManageAnnouncementsResult } from '../types/announcement';
import { usePermission } from '../hooks/usePermission';

type DetailSource = 'auto' | 'history';

export function AnnouncementCenter() {
  const navigate = useNavigate();
  const { canAccessPage } = usePermission();
  const [announcements, setAnnouncements] = useState<FeatureAnnouncement[]>([]);
  const [loading, setLoading] = useState(false);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [detailVisible, setDetailVisible] = useState(false);
  const [detailSource, setDetailSource] = useState<DetailSource>('history');
  const [current, setCurrent] = useState<FeatureAnnouncement | null>(null);
  const [marking, setMarking] = useState(false);

  const unread = useMemo(() => announcements.filter(item => !item.read), [announcements]);

  const openDetail = (announcement: FeatureAnnouncement, source: DetailSource) => {
    setCurrent(announcement);
    setDetailSource(source);
    setDetailVisible(true);
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const result = await callFunction<ManageAnnouncementsResult>('manageAnnouncements', {
          data: { action: 'listPublished' },
        });
        if (cancelled || !result.success) return;
        const data = Array.isArray(result.data) ? result.data : [];
        setAnnouncements(data);
        const firstUnread = data.find(item => !item.read);
        if (firstUnread) openDetail(firstUnread, 'auto');
      } catch (error) {
        console.error('获取新功能通知失败:', error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const markRead = async (announcement: FeatureAnnouncement) => {
    if (announcement.read) return true;
    setMarking(true);
    try {
      const result = await callFunction<ManageAnnouncementsResult>('manageAnnouncements', {
        data: { action: 'markRead', announcementId: announcement._id },
      });
      if (!result.success) {
        MessagePlugin.error(result.errMsg || '记录已读失败');
        return false;
      }
      const readAt = new Date().toISOString();
      setAnnouncements(prev => prev.map(item => (
        item._id === announcement._id ? { ...item, read: true, readAt } : item
      )));
      setCurrent(prev => prev?._id === announcement._id ? { ...prev, read: true, readAt } : prev);
      return true;
    } catch (error) {
      MessagePlugin.error('记录已读失败: ' + String(error));
      return false;
    } finally {
      setMarking(false);
    }
  };

  const handleConfirm = async () => {
    if (!current) return;
    if (!(await markRead(current))) return;

    if (detailSource === 'auto') {
      const nextUnread = announcements.find(item => item._id !== current._id && !item.read);
      if (nextUnread) {
        setCurrent(nextUnread);
        return;
      }
    }
    setDetailVisible(false);
  };

  const handleNavigate = async () => {
    if (!current?.actionPath) return;
    if (!(await markRead(current))) return;
    setDetailVisible(false);
    setHistoryVisible(false);
    navigate(current.actionPath);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setHistoryVisible(true)}
        className="relative inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-600 shadow-sm transition hover:border-primary/40 hover:text-primary"
      >
        <Bell size={16} />
        新功能通知
        {unread.length > 0 && (
          <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-red-500 px-1.5 text-xs leading-5 text-white">
            {unread.length > 99 ? '99+' : unread.length}
          </span>
        )}
      </button>

      <Dialog
        header="新功能通知"
        visible={historyVisible}
        onClose={() => setHistoryVisible(false)}
        footer={null}
        width="680px"
      >
        <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
          {loading ? (
            <div className="py-12 text-center text-sm text-gray-400">正在加载通知...</div>
          ) : announcements.length === 0 ? (
            <div className="py-12 text-center text-sm text-gray-400">暂无新功能通知</div>
          ) : announcements.map(item => (
            <button
              type="button"
              key={item._id}
              onClick={() => openDetail(item, 'history')}
              className="flex w-full items-start gap-3 rounded-xl border border-gray-100 bg-white p-4 text-left transition hover:border-primary/30 hover:bg-primary/5"
            >
              <div className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-blue-50 text-primary">
                <Sparkles size={17} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-gray-800">{item.title}</span>
                  {item.versionLabel && <Tag size="small" theme="primary" variant="light">{item.versionLabel}</Tag>}
                  {!item.read && <Tag size="small" theme="danger" variant="light">未读</Tag>}
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-gray-500">{item.summary || item.content}</p>
                <p className="mt-2 text-xs text-gray-400">{formatDate(item.publishedAt || null)}</p>
              </div>
            </button>
          ))}
        </div>
      </Dialog>

      <Dialog
        header={detailSource === 'auto' ? '新功能上线' : '通知详情'}
        visible={detailVisible}
        onClose={() => setDetailVisible(false)}
        onConfirm={handleConfirm}
        confirmBtn={{
          content: current?.read ? '关闭' : '我知道了',
          loading: marking,
          icon: current?.read ? undefined : <Check size={15} />,
        }}
        cancelBtn={null}
        width="640px"
      >
        {current && (
          <div>
            <div className="rounded-xl bg-gradient-to-br from-blue-50 to-indigo-50 p-5">
              <div className="flex items-start gap-4">
                <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-primary text-white shadow-sm">
                  <Sparkles size={22} />
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-xl font-semibold text-gray-900">{current.title}</h2>
                    {current.versionLabel && <Tag theme="primary" variant="light">{current.versionLabel}</Tag>}
                  </div>
                  {current.summary && <p className="mt-2 text-sm leading-6 text-gray-600">{current.summary}</p>}
                  <p className="mt-2 text-xs text-gray-400">发布于 {formatDate(current.publishedAt || null)}</p>
                </div>
              </div>
            </div>

            <div className="max-h-[42vh] overflow-y-auto py-5">
              <div className="whitespace-pre-wrap break-words text-sm leading-7 text-gray-700">{current.content}</div>
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-gray-100 pt-4">
              <span className="text-xs text-gray-400">
                {detailSource === 'auto' && unread.length > 1 ? `还有 ${unread.length - 1} 条未读通知` : ''}
              </span>
              {current.actionPath && canAccessPage(current.actionPath) && (
                <Button
                  variant="outline"
                  icon={<ExternalLink size={15} />}
                  loading={marking}
                  onClick={handleNavigate}
                >
                  立即体验
                </Button>
              )}
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
