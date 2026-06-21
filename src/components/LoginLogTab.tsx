import { useEffect, useState, useCallback } from 'react';
import { Button, Input, MessagePlugin, Table, DateRangePicker } from 'tdesign-react';
import type { PageInfo } from 'tdesign-react/es/pagination/type';
import { RefreshCw, Search, CheckCircle, XCircle } from 'lucide-react';
import { callFunction } from '../lib/cloudbase';

interface LoginLogRecord {
  _id: string;
  userId: string;
  username: string;
  nickName?: string;
  loginTime: string;
  ip: string;
  userAgent?: string;
  success: boolean;
  failReason?: string;
}

interface ListResult {
  success: boolean;
  data?: LoginLogRecord[];
  total?: number;
  cursor?: string | null;
  errMsg?: string;
}

/** 格式化日期时间 */
function formatDateTime(iso: string): string {
  if (!iso) return '-';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 截取 UserAgent 关键信息 */
function formatUA(ua: string): string {
  if (!ua) return '-';
  if (ua.includes('Chrome')) return 'Chrome';
  if (ua.includes('Firefox')) return 'Firefox';
  if (ua.includes('Safari')) return 'Safari';
  if (ua.includes('Edge')) return 'Edge';
  return ua.slice(0, 20);
}

export function LoginLogTab() {
  const [logs, setLogs] = useState<LoginLogRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [filterUsername, setFilterUsername] = useState('');
  const [filterSuccess, setFilterSuccess] = useState<'all' | 'success' | 'fail'>('all');
  const [dateRange, setDateRange] = useState<string[]>([]);

  const loadLogs = useCallback(async (currentPage = 1) => {
    setLoading(true);
    try {
      const params: Record<string, unknown> = {
        action: 'list',
        limit: pageSize,
        cursor: String((currentPage - 1) * pageSize),
      };
      if (filterUsername.trim()) params.username = filterUsername.trim();
      if (filterSuccess === 'success') params.success = true;
      if (filterSuccess === 'fail') params.success = false;
      if (dateRange && dateRange.length === 2) {
        params.startDate = dateRange[0];
        params.endDate = dateRange[1];
      }

      const result = await callFunction<ListResult>('manageLoginLogs', { data: params });
      if (result.success) {
        setLogs(result.data || []);
        setTotal(result.total || 0);
        setPage(currentPage);
      } else {
        MessagePlugin.error(result.errMsg || '获取登录日志失败');
      }
    } catch (err) {
      MessagePlugin.error('获取登录日志失败: ' + String(err));
    } finally {
      setLoading(false);
    }
  }, [filterUsername, filterSuccess, dateRange, pageSize]);

  useEffect(() => {
    loadLogs(1);
  }, [loadLogs]);

  const handleSearch = () => loadLogs(1);

  const handleReset = () => {
    setFilterUsername('');
    setFilterSuccess('all');
    setDateRange([]);
  };

  const columns = [
    {
      colKey: 'username',
      title: '用户名',
      width: 140,
      cell: ({ row }: { row: LoginLogRecord }) => row.username || '-',
    },
    {
      colKey: 'nickName',
      title: '昵称',
      width: 120,
      cell: ({ row }: { row: LoginLogRecord }) => row.nickName || '-',
    },
    {
      colKey: 'loginTime',
      title: '登录时间',
      width: 180,
      cell: ({ row }: { row: LoginLogRecord }) => (
        <span className="font-mono text-xs text-gray-700">{formatDateTime(row.loginTime)}</span>
      ),
    },
    {
      colKey: 'ip',
      title: 'IP 地址',
      width: 140,
      cell: ({ row }: { row: LoginLogRecord }) => (
        <span className="font-mono text-xs">{row.ip || '-'}</span>
      ),
    },
    {
      colKey: 'userAgent',
      title: '浏览器',
      width: 100,
      cell: ({ row }: { row: LoginLogRecord }) => formatUA(row.userAgent || ''),
    },
    {
      colKey: 'success',
      title: '状态',
      width: 100,
      cell: ({ row }: { row: LoginLogRecord }) => (
        row.success ? (
          <span className="inline-flex items-center gap-1 text-green-600 text-sm">
            <CheckCircle size={14} /> 成功
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-red-500 text-sm">
            <XCircle size={14} /> 失败
          </span>
        )
      ),
    },
    {
      colKey: 'failReason',
      title: '失败原因',
      ellipsis: true,
      cell: ({ row }: { row: LoginLogRecord }) => row.failReason || '-',
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-medium text-gray-800">登录日志</h3>
          <p className="text-sm text-gray-500 mt-1">记录所有用户的登录时间和 IP 地址</p>
        </div>
        <Button variant="outline" icon={<RefreshCw size={16} />} onClick={() => loadLogs(page)}>
          刷新
        </Button>
      </div>

      {/* 筛选栏 */}
      <div className="flex flex-wrap items-center gap-3 bg-gray-50 rounded-lg p-4">
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600">用户名</label>
          <Input
            value={filterUsername}
            onChange={val => setFilterUsername(val as string)}
            placeholder="搜索用户名"
            style={{ width: '160px' }}
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600">状态</label>
          <select
            value={filterSuccess}
            onChange={e => setFilterSuccess(e.target.value as 'all' | 'success' | 'fail')}
            className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white"
          >
            <option value="all">全部</option>
            <option value="success">成功</option>
            <option value="fail">失败</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600">日期范围</label>
          <DateRangePicker
            mode="date"
            value={dateRange}
            onChange={val => setDateRange(val as string[])}
            style={{ width: '260px' }}
            placeholder="选择日期范围"
          />
        </div>
        <div className="flex gap-2">
          <Button theme="primary" icon={<Search size={14} />} onClick={handleSearch}>
            查询
          </Button>
          <Button variant="outline" onClick={handleReset}>
            重置
          </Button>
        </div>
      </div>

      <Table
        data={logs}
        columns={columns}
        loading={loading}
        rowKey="_id"
        stripe
        hover
        pagination={{
          current: page,
          pageSize,
          total,
          onChange: (pageInfo: PageInfo) => loadLogs(pageInfo.current),
        }}
      />
    </div>
  );
}
