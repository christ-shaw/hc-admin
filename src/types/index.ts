/** 手机型号项 */
export interface PhoneModelItem {
  model: string;
  quantity: number;
}

/** 入库记录 */
export interface InboundRecord {
  _id: string;
  customerName: string;
  inboundDate: string;
  type: string; // 渠道类型: return | afterSale | recycle | purchase | normal
  shopName: string;
  trackingNumber: string;
  phoneModels: PhoneModelItem[];
  phonePhotos?: string[];
  hasIssue?: boolean;
  remark?: string;
  createTime?: { $date: string };
}

/** 出库记录 */
export interface OutboundRecord {
  _id: string;
  customerName: string;
  outboundDate: string;
  trackingNumber?: string;
  phoneModels: PhoneModelItem[];
  phonePhotos?: string[];
  hasIssue?: boolean;
  remark?: string;
  createTime?: { $date: string };
}

/** 记录联合类型 */
export type RecordItem = InboundRecord | OutboundRecord;

/** 操作日志 */
export interface OperationLog {
  _id: string;
  operationType: 'create' | 'update' | 'delete';
  logType: 'inbound' | 'outbound';
  logId: string;
  operationContent: string;
  operator: string;
  operationTime: string;
  originalData?: Record<string, unknown>;
  modifiedData?: Record<string, unknown>;
  changes?: Array<{
    field: string;
    oldValue: unknown;
    newValue: unknown;
  }>;
}

/** 分页查询结果 */
export interface PaginatedResult<T> {
  records: T[];
  cursor: string | null;
  hasMore: boolean;
  currentPage: number;
  total?: number;
}

/** 入库筛选条件 */
export interface InboundFilters {
  customerName?: string;
  channelType?: string;
  shopName?: string;
  trackingNumber?: string;
  model?: string;
  hasIssue?: boolean;
  startDate?: string;
  endDate?: string;
}

/** 出库筛选条件 */
export interface OutboundFilters {
  customerName?: string;
  trackingNumber?: string;
  model?: string;
  startDate?: string;
  endDate?: string;
}

/** 日志筛选条件 */
export interface LogFilters {
  operator?: string;
  operationType?: string;
  logType?: string;
  startDate?: string;
  endDate?: string;
}

/** 手机品牌 */
export interface PhoneBrand {
  brand: string;
  models: string[];
}

/** 渠道类型映射 */
export const CHANNEL_TYPE_MAP: Record<string, string> = {
  return: '归还',
  afterSale: '售后',
  recycle: '回收',
  purchase: '采购',
  normal: '正常',
};

/** 统计数据 */
export interface StatsData {
  dates: string[];
  inboundCounts: number[];
  inboundPhones: number[];
  outboundCounts: number[];
  outboundPhones: number[];
  totalInbound: number;
  totalOutbound: number;
  totalPhones: number;
  totalOutboundPhones: number;
}

/** 型号统计数据 */
export interface ModelStatsItem {
  model: string;
  inbound: number;
  outbound: number;
  inboundOrders: number;
  outboundOrders: number;
  change: number;
}

/** 修改历史条目 */
export interface HistoryChange {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

export interface HistoryItem {
  _id: string;
  operationType: string;
  operator: string;
  operationTime: string;
  changes: HistoryChange[];
}
