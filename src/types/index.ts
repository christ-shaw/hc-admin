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
  packagePhotos?: string[];
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

/** 订单记录 —— 对齐 Excel「订单明细」工作表 25 列 */
export interface OrderRecord {
  _id: string;
  serialNumber: number;             // 序号
  date: string;                     // 日期
  orderSource: string;              // 订单来源: 新增/服务
  orderAttribute: string;           // 订单属性: 租赁1/租赁2
  orderType: string;                // 订单类型: 新增业务/租后发货/租后退货/仅退款/退租金
  salesChannel: string;             // 销售渠道
  salesperson: string;              // 人员
  channelCategory: string;          // 渠道类别
  onlineOrderNumber: string;        // 网店订单号
  customerName: string;             // 客户名称
  brand: string;                    // 品牌
  productName: string;              // 货品名称
  specification: string;            // 规格
  quantity: number;                 // 数量
  unitPrice: number;                // 单价
  amount: number;                   // 金额
  paymentAccount: string;           // 收款账户
  trackingNumber: string;           // 物流单号
  consignee: string;                // 收货人名称
  consigneePhone: string;           // 收货人电话
  consigneeAddress: string;         // 收货人地址
  status: string;                   // 订单状态: 已发货/--/未发货
  customerRemark: string;           // 客服备注
  transferProductName: string;      // 转租赁2货品名称
  transferSpecification: string;    // 转租赁2规格
  paidPeriod: number;               // 已交租期
  paidRent: number;                 // 已交租金
  createTime?: { $date: string };
}

/** 货品条目（新增订单时支持多条） */
export interface ProductItem {
  brand: string;
  productName: string;
  specification: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  paymentAccount: string;
}

/** 订单状态映射 */
export const ORDER_STATUS_MAP: Record<string, string> = {
  '已发货': '已发货',
  '不用发货': '不用发货',
  '退货已收': '退货已收',
  '退发已发': '退发已发',
  '--': '--',
};

/** 订单来源映射 */
export const ORDER_SOURCE_MAP: Record<string, string> = {
  '新增': '新增',
  '服务': '服务',
};

/** 订单属性映射 */
export const ORDER_ATTRIBUTE_MAP: Record<string, string> = {
  '租赁1': '租赁1',
  '租赁2': '租赁2',
};

/** 订单类型映射 */
export const ORDER_TYPE_MAP: Record<string, string> = {
  '新增业务': '新增业务',
  '租后发货': '租后发货',
  '租后退货': '租后退货',
  '仅退款': '仅退款',
  '退租金': '退租金',
};

/** 销售渠道映射 */
export const SALES_CHANNEL_MAP: Record<string, string> = {
  'A人人租': 'A人人租',
  'F人人租': 'F人人租',
  '云途': '云途',
  '汇租机': '汇租机',
  '租机乐': '租机乐',
  '倬石电子': '倬石电子',
  '云界互联': '云界互联',
  '极客矩阵': '极客矩阵',
  '极速闪租': '极速闪租',
  'L人人租': 'L人人租',
  'J人人租': 'J人人租',
  'G人人租': 'G人人租',
  'X/ZZ': 'X/ZZ',
  'X/LL': 'X/LL',
  'X/XX': 'X/XX',
  'X/YY': 'X/YY',
};

/** 渠道类别映射 */
export const CHANNEL_CATEGORY_MAP: Record<string, string> = {
  '平台': '平台',
  '线下': '线下',
};

/** 订单筛选条件 */
export interface OrderFilters {
  customerName?: string;
  salesperson?: string;
  salesChannel?: string;
  orderType?: string;
  orderSource?: string;
  orderAttribute?: string;
  status?: string;
  onlineOrderNumber?: string;
  startDate?: string;
  endDate?: string;
}

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

/** 电子发票文件 */
export interface InvoiceFile {
  fileID: string;                 // 云存储文件ID，如 cloud://env-id/invoices/xxx.png
  fileName: string;               // 原始文件名
}

/** 发票记录 */
export interface InvoiceRecord {
  _id: string;
  applyDate: string;              // 申请日期
  companyName: string;            // 公司名称（单位名称）
  applicant: string;              // 开票申请人
  shopName: string;               // 店铺名字
  status: '未开票' | '已开票';    // 开票状态
  taxId: string;                  // 纳税人识别号
  registeredAddress: string;      // 注册地址
  contactPhone: string;           // 联系电话
  bankName: string;               // 开户行名称
  bankAccount: string;            // 账号
  bankCode: string;               // 开户行行号
  invoiceCategory: string;        // 开票类目
  invoiceAmount: number;          // 开票金额
  phoneModel?: string;            // 手机型号（二手手机类目）
  phoneQuantity?: number;         // 手机数量（二手手机类目）
  unitPrice?: number;             // 单价（二手手机类目）
  invoiceFiles?: InvoiceFile[];   // 电子发票图片（多张）
  attachments?: InvoiceFile[];    // 开票附件（多张）
  completedTime?: string;         // 开票完成时间
  createTime?: { $date: string };
}

/** 发票状态映射 */
export const INVOICE_STATUS_MAP: Record<string, string> = {
  '未开票': '未开票',
  '已开票': '已开票',
};

/** 发票筛选条件 */
export interface InvoiceFilters {
  companyName?: string;
  applicant?: string;
  status?: string;
  startDate?: string;
  endDate?: string;
}

/** 公司模版 */
export interface CompanyTemplate {
  _id: string;
  companyName: string;            // 单位名称
  taxId: string;                  // 纳税人识别号
  registeredAddress: string;      // 注册地址
  contactPhone: string;           // 联系电话
  bankName: string;               // 开户行名称
  bankAccount: string;            // 账号
  bankCode: string;               // 开户行行号
  createTime?: { $date: string };
}
