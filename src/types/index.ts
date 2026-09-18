import type { InvoiceStatus } from '../data/dict';

// 字典常量统一从 data/dict.ts 重新导出（保持现有消费者 import 路径不变）
export {
  CHANNEL_TYPE_MAP,
  ORDER_STATUS_MAP,
  RETURN_STATUS_MAP,
  ORDER_SOURCE_MAP,
  ORDER_ATTRIBUTE_MAP,
  ORDER_TYPE_MAP,
  SALES_CHANNEL_MAP,
  CHANNEL_CATEGORY_MAP,
  INVOICE_STATUS_MAP,
  SHIPPING_FEE_MAP,
  RECORD_TYPE_MAP,
  LOG_ACTION_MAP,
  getDictLabel,
  dictToOptions,
} from '../data/dict';

export type {
  OrderStatus,
  OrderSource,
  OrderAttribute,
  OrderType,
  SalesChannel,
  ChannelCategory,
  InvoiceStatus,
  ShippingFee,
} from '../data/dict';

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
  // 订单↔出库单关联（见 docs/order-outbound-linkage-design.md）
  outboundStatus?: 'pending' | 'completed'; // 待出库/已出库；无此字段的历史记录视为 completed
  orderIds?: string[];                        // 关联订单 _id（支持合并多订单）
  shippingMethod?: string;                    // 快递方式: prepaid|cod|pickup（生成时统一选择）
  source?: 'order' | 'manual';               // 来源：订单生成/手工创建；缺省按 manual
  consignee?: string;                         // 收货人（取自订单）
  consigneePhone?: string;                    // 收货人电话
  consigneeAddress?: string;                  // 收货人地址
  sfExpressOrderRecordId?: string;             // 关联的顺丰实际包裹记录（第一阶段只读）
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
  outboundStatus?: string;   // 出库状态过滤: pending | completed（空=全部）
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
export interface PhoneModelAttributes {
  storage?: string;
  color?: string;
  network?: string;
  [key: string]: unknown;
}

export interface PhoneModelSpec {
  skuId?: string;
  name: string;
  aliases?: string[];
  attributes?: PhoneModelAttributes;
  enabled?: boolean;
  sort?: number;
  systemItem?: boolean;
}

export interface PhoneProduct {
  productId?: string;
  name: string;
  aliases?: string[];
  enabled?: boolean;
  sort?: number;
  systemItem?: boolean;
  specs: PhoneModelSpec[];
}

export interface PhoneBrand {
  _id?: string;
  brandId?: string;
  brand: string;
  aliases?: string[];
  enabled?: boolean;
  sort?: number;
  systemBrand?: boolean;
  products?: PhoneProduct[];
  models?: string[];
}

/** 收款拆分明细 */
export interface PaymentSplit {
  account: string;
  amount: number;
}

export interface SfWaybillNoInfo {
  waybillType?: string | number;
  waybillNo: string;                 // 顺丰运单号
}

export type SfExpressApplyStatus = 'applying' | 'applied' | 'failed' | 'cancelled';
export type SfShipmentStatus =
  | 'packing'
  | 'sealed'
  | 'handed_over'
  | 'picked_up'
  | 'cancelled'
  | 'legacy_locked';

export interface SfExpressOrderRecord {
  sfConfigProfile?: 'hongcheng' | 'huichuan';
  _id: string;
  sourceOrderId: string;
  sourceSerialNumber: number;
  sourceOnlineOrderNumber: string;
  sourceOrderDate: string;
  sfOrderId: string;
  attemptNo: number;
  env: 'sandbox' | 'production';
  isCurrent: boolean;
  status: SfExpressApplyStatus;
  waybillNo: string;
  waybillNoInfoList: SfWaybillNoInfo[];
  linkedOrderIds: string[];
  linkedOutboundIds: string[];
  shipmentStatus: SfShipmentStatus;
  shipmentVersion: number;
  isLegacyShipment: boolean;
  reuseEnabled: boolean;
  reuseEnabledAt?: string;
  reuseDisabledAt?: string;
  finalPackagePhotos?: string[];
  handedOverAt?: string;
  applyRequestId?: string;
  applyRequestTime?: string;
  searchRequestId?: string;
  searchTime?: string;
  cancelRequestId?: string;
  cancelRequestTime?: string;
  applyTime?: string;
  cancelTime?: string;
  errorCode?: string;
  errorMessage?: string;
  orderSnapshot?: {
    customerRemark?: string;
    rawCustomerRemark?: string;
    productRemark?: string;
    printProductRemark?: string;
    products?: Array<{
      brand?: string;
      productName?: string;
      specification?: string;
      quantity?: number;
    }>;
  };
  shipmentRemarkEntries?: Array<{
    orderId: string;
    orderNumber: string;
    role: 'primary' | 'appended';
    productRemark: string;
    printProductRemark?: string;
    customerRemark: string;
    attachedAt: string;
  }>;
  shipmentRemarkFull?: string;
  shipmentPrintRemark?: string;
  printCount: number;
  lastPrintTime?: string | { $date: string };
  lastPrintRequestId?: string;
  createdAt: string;
  updatedAt: string;
  operatorId?: string;
}

export type SfWorkbenchStatus =
  | 'not_required'
  | 'not_created'
  | 'applying'
  | 'applied'
  | 'failed'
  | 'cancelled'
  | 'other_express'
  | 'legacy_unmanaged';

export interface SfOtherEnvSummary {
  env: 'sandbox' | 'production';
  status: SfExpressApplyStatus;
  sfOrderId: string;
  waybillNo: string;
}

export interface SfExportSummary {
  count: number;
  lastExportTime: string;
}

export interface SfExpressWorkbenchRow {
  order: OrderRecord;
  sfStatus: SfWorkbenchStatus;
  currentSfOrder: SfExpressOrderRecord | null;
  otherEnvSummary: SfOtherEnvSummary[];
  exportSummary: SfExportSummary;
}

/** 订单记录 —— 对齐 Excel「订单明细」工作表 25 列 */
export interface OrderRecord {
  _id: string;
  serialNumber: number;             // 序号
  date: string;                     // 日期
  orderSource: string;              // 订单来源: 新增/服务
  orderAttribute: string;           // 订单属性: 租赁1/租赁2
  orderType: string;                // 订单类型: 新增业务/租后发货/租后退货/租后款项/押金/维修
  salesChannel: string;             // 销售渠道
  salesperson: string;              // 人员
  channelCategory: string;          // 渠道类别
  onlineOrderNumber: string;        // 网店订单号
  customerName: string;             // 客户名称
  customerId?: string;              // 关联客户主档案 ID（旧订单允许为空）
  customerAliasId?: string;         // 下单时选用的客户别名 ID
  recipientProfileId?: string;      // 下单时选用的收货档案 ID
  customerLinkStatus?: 'linked' | 'pending' | 'ignored'; // 客户关联状态
  customerLinkedAt?: string;        // 最近关联时间
  customerLinkIgnoreReason?: string; // 人工忽略归档的原因
  customerSelectionMode?: 'explicit' | 'none';
  createCustomerArchive?: boolean;  // 本次新建订单申请随单建档（不持久化）
  customerArchiveRequested?: boolean; // 服务端保存，用于建档失败后的独立重试
  customerLinkExpected?: { customerId: string; customerAliasId: string; recipientProfileId: string };
  customerLinkMethod?: 'manual' | 'inherited' | 'exact' | '';
  customerIngestState?: 'pending' | 'done';
  customerIngestVersion?: number;
  customerIngestActor?: string;
  customerLinkedBy?: string;        // 最近关联操作人
  products?: ProductItem[];         // 货品明细（新结构：一条订单多条货品）
  /** @deprecated 旧扁平结构单货品字段，仅兼容未迁移数据；读取货品请用 getOrderProducts() */
  brand?: string;                   // 品牌
  /** @deprecated 见 brand */
  productName?: string;             // 货品名称
  /** @deprecated 见 brand */
  specification?: string;           // 规格
  /** @deprecated 见 brand */
  quantity?: number;                // 数量
  /** @deprecated 见 brand */
  unitPrice?: number;               // 单价
  /** @deprecated 见 brand */
  amount?: number;                  // 金额
  paymentAccount?: string;          // 收款账户（订单级；旧数据可能存在货品级收款，读取用 getOrderPaymentSplits）
  paymentSplits?: PaymentSplit[] | string; // 多账户收款明细（订单级，合计对齐订单总额；兼容旧字符串数据）
  trackingNumber: string;           // 物流单号
  expressProvider?: string;         // 快递服务商
  consignee: string;                // 收货人名称
  consigneePhone: string;           // 收货人电话
  consigneeAddress: string;         // 收货人地址
  shippingFee: string;              // 邮寄费用: prepaid | cod | pickup
  status: string;                   // 订单状态
  customerRemark: string;           // 客服备注
  transferBrand: string;            // 转租赁2品牌
  transferProductName: string;      // 转租赁2货品名称
  transferSpecification: string;    // 转租赁2规格
  paidPeriod: number;               // 已交租期
  paidRent: number;                 // 已交租金
  transferItems?: string;            // 转租赁2多组货品JSON（兼容多组）
  importSource?: string;            // 订单来源标记（hc-order-assist=赞晨租导入）
  afterSaleSourceOrderId?: string;  // 手工售后订单关联的原订单 ID
  afterSaleSourceSerialNumber?: number; // 原订单序号快照（原订单删除后仍可追溯）
  afterSaleRequestId?: string;      // 售后创建请求 ID（提交重试幂等）
  afterSaleCreatedBy?: string;      // 售后订单创建人 ID
  renewalSourceOrderId?: string;    // 续租订单关联的来源订单 ID
  renewalSourceSerialNumber?: number; // 来源订单序号快照（来源订单删除后仍可追溯）
  renewalRequestId?: string;        // 插件续租请求 ID（用于提交重试幂等）
  rental2TransferSourceOrderId?: string; // 转租赁2订单关联的来源订单 ID
  rental2TransferSourceSerialNumber?: number; // 转租赁2来源订单序号快照
  rental2TransferMode?: 'partial' | 'full'; // 转租赁2方式：部分 / 全部
  attachments: OrderAttachment[];   // 订单附件
  returnStatus?: string;            // 归还状态（租后发货/租后退货时使用）
  returnTrackingNumbers?: string;   // 归还物流单号（多个逗号分隔，归还状态=运输途中时必填）
  needsOutbound?: boolean;          // 是否需要出库（默认按订单类型判定，见出库单关联设计文档）
  outboundRecordId?: string;        // 关联的出库单 _id（生成出库单后回写，防重复生成+完成发货回填）
  sfExpressOrderRecordId?: string;  // 关联的顺丰实际包裹记录（第一阶段只读）
  sharedWaybill?: boolean;          // 是否与其他订单共享同一顺丰运单
  createTime?: { $date: string };
}

export type CustomerStatus = 'active' | 'disabled' | 'merged';
export type CustomerProfileSource = 'manual' | 'order' | 'assist_import';

export interface CustomerStats {
  totalOrderCount: number;
  rental1OrderCount: number;
  rental2OrderCount: number;
  totalAmount: number;
  firstOrderDate?: string;
  lastOrderDate?: string;
}

/** 客户主档案。客户名称、别名和收货信息拆分保存，订单仅持有引用与历史快照。 */
export interface CustomerRecord {
  writeRevision?: number;
  _id: string;
  displayName: string;
  normalizedDisplayName: string;
  status: CustomerStatus;
  mergedIntoCustomerId?: string;
  stats?: CustomerStats;
  normalizationVersion?: string;
  remark: string;
  createdAt?: string;
  createdBy?: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface CustomerAliasRecord {
  _id: string;
  customerId: string;
  name: string;
  normalizedName: string;
  normalizationVersion?: string;
  sourceType: CustomerProfileSource;
  salesChannel: string;
  remark: string;
  enabled: boolean;
  createdAt?: string;
  createdBy?: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface CustomerRecipientProfileRecord {
  _id: string;
  customerId: string;
  label: string;
  consignee: string;
  normalizedConsignee: string;
  phone: string;
  normalizedPhone: string;
  address: string;
  normalizedAddress: string;
  normalizationVersion?: string;
  sourceType: CustomerProfileSource;
  enabled: boolean;
  useCount: number;
  lastUsedAt?: string;
  createdAt?: string;
  createdBy?: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface CustomerDetail extends CustomerRecord {
  aliases: CustomerAliasRecord[];
  recipients: CustomerRecipientProfileRecord[];
  recentOrders: OrderRecord[];
  linkedOrderCount: number;
}

/** Deliberately separate from management detail: no orders, remarks, relations or audit data. */
export interface CustomerSelectionItem {
  _id: string;
  displayName: string;
}

export interface CustomerOrderSelection extends CustomerSelectionItem {
  aliases: Pick<CustomerAliasRecord, '_id' | 'name' | 'salesChannel'>[];
  recipients: Pick<CustomerRecipientProfileRecord, '_id' | 'label' | 'consignee' | 'phone' | 'address'>[];
  aliasPage: number;
  recipientPage: number;
  pageSize: number;
  aliasTotal: number;
  recipientTotal: number;
}

export type CustomerSuggestion = Pick<CustomerOrderSelection, '_id' | 'displayName' | 'aliases' | 'recipients' | 'aliasTotal' | 'recipientTotal'>;

export type CustomerRelationType = 'family' | 'cohabitant' | 'colleague' | 'ordered_on_behalf' | 'guarantor' | 'other';
export type CustomerRelationDirection = 'undirected' | 'directed';
export type CustomerCandidateStatus = 'pending' | 'accepted' | 'rejected' | 'ignored';

export interface CustomerAuditFields {
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface CustomerRelation extends CustomerAuditFields {
  _id: string;
  fromCustomerId: string;
  toCustomerId: string;
  type: CustomerRelationType;
  direction: CustomerRelationDirection;
  remark?: string;
}

export interface CustomerObservedIdentity {
  customerName: string;
  consignee: string;
  phone: string;
  address: string;
}

export interface CustomerIdentityMatch {
  displayName?: string;
  customerId: string;
  score: number;
  reasons: string[];
  evidence?: Array<{ type: 'name_exact' | 'phone_exact' | 'address_exact' | 'consignee_exact'; objectId: string; source: 'displayName' | 'alias' | 'recipient' }>;
  exact?: boolean;
  exactRecipientProfileIds?: string[];
}

export interface CustomerIdentityMatchResult {
  identityRevision?: number;
  normalizationVersion: string;
  identityFingerprint: string | null;
  status: 'exact' | 'no_match' | 'incomplete' | 'ambiguous' | 'invalid_cluster';
  autoLinkEligible: boolean;
  customerId: string | null;
  candidates: CustomerIdentityMatch[];
  issues: Array<{ customerId: string; code: string }>;
}

export type CustomerIdentityCheckResult = CustomerIdentityMatchResult | {
  unchanged: true; identityRevision: number; normalizationVersion: string;
};

export interface CustomerLinkCandidate {
  identityRevision?: number;
  _id: string;
  identityFingerprint: string;
  normalizationVersion: string;
  evidenceVersion: string;
  orderCount: number;
  pendingCount: number;
  rental1Count: number;
  rental2Count: number;
  observedIdentity: CustomerObservedIdentity;
  matches: CustomerIdentityMatch[];
  matchCount: number;
  matchStatus: CustomerIdentityMatchResult['status'];
  status: 'pending' | 'processed';
  createdAt: string;
  updatedAt: string;
}

export interface CustomerLinkCandidateMember {
  _id: string;
  candidateId: string;
  orderId: string;
  orderVersion: string;
  evidenceVersion: string;
  revision: number;
  rentalType: 'rental1' | 'rental2';
  serialNumber: number | string;
  onlineOrderNumber: string;
  date: string;
  observedIdentity: CustomerObservedIdentity;
  status: 'pending' | 'accepted' | 'ignored' | 'stale';
  rejectedCustomerIds: string[];
  resolvedCustomerId?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  reason?: string;
}

export interface CustomerRelationCandidate {
  _id: string;
  fromCustomerId: string;
  toCustomerId: string;
  pairKey: string;
  evidenceVersion: string;
  evidence: Array<{
    type: 'shared_phone' | 'shared_address' | 'shared_phone_address' | 'shared_recipient';
    summary: string;
    count: number;
  }>;
  status: CustomerCandidateStatus;
  resolvedRelationId?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerMergeEvent {
  _id: string;
  sourceCustomerId: string;
  targetCustomerId: string;
  status: 'merged' | 'reverted';
  remark?: string;
  createdAt: string;
  createdBy: string;
  revertedAt?: string;
  revertedBy?: string;
  revertRemark?: string;
}

export interface CustomerAuditRecord {
  _id: string;
  action: string;
  customerId: string;
  objectId: string;
  actorId: string;
  changedFields: string[];
  createdAt: string;
}

/** 转租赁2货品条目（支持多组） */
export interface TransferProductItem {
  brand: string;
  productName: string;
  specification: string;
  paidPeriod: number;
  paidRent: number;
}

/** 货品条目（新增订单时支持多条）；收款已上移订单级，货品级收款字段仅旧数据存在 */
export interface ProductItem {
  brand: string;
  productName: string;
  specification: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  /** @deprecated 收款在订单级 paymentAccount，旧数据回退读取用 */
  paymentAccount?: string;
  /** @deprecated 收款在订单级 paymentSplits，旧数据回退读取用 */
  paymentSplits?: PaymentSplit[];
}

/** 订单筛选条件 */
export interface OrderFilters {
  /** 从关联业务跳转时，按数据库 ID 精确打开订单。 */
  orderId?: string;
  serialNumber?: string;
  customerName?: string;
  salesperson?: string;
  salesChannel?: string;
  orderType?: string;
  orderSource?: string;
  orderAttribute?: string;
  status?: string;
  onlineOrderNumber?: string;
  /** 从出库记录跳转时，精确查看关联订单。 */
  outboundRecordId?: string;
  startDate?: string;
  endDate?: string;
  /** 异常状态筛选：unreceived=未收款，unreturned=未退回入库 */
  abnormalStatus?: string;
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

/** 订单附件文件 */
export interface OrderAttachment {
  fileID: string;                 // 云存储文件ID
  fileName: string;               // 原始文件名
}

/** 电子发票文件 */
export interface InvoiceFile {
  fileID: string;                 // 云存储文件ID，如 cloud://env-id/invoices/xxx.png
  fileName: string;               // 原始文件名
}

/** 二手手机开票货品 */
export interface InvoicePhoneProduct {
  model: string;                  // 手机型号
  quantity: number;               // 数量
  unitPrice: number;              // 单价
  amount: number;                 // 小计（数量 × 单价）
}

/** 发票记录 */
export interface InvoiceRecord {
  _id: string;
  applyDate: string;              // 申请日期
  companyName: string;            // 公司名称（单位名称）
  applicant: string;              // 开票申请人
  shopName: string;               // 店铺名字
  status: InvoiceStatus;          // 开票状态
  taxId: string;                  // 纳税人识别号
  registeredAddress: string;      // 注册地址
  contactPhone: string;           // 联系电话
  bankName: string;               // 开户行名称
  bankAccount: string;            // 账号
  bankCode: string;               // 开户行行号
  invoiceCategory: string;        // 开票类目
  invoiceAmount: number;          // 开票金额
  phoneProducts?: InvoicePhoneProduct[]; // 手机货品明细（二手手机类目，支持多条）
  phoneModel?: string;            // 手机型号（二手手机类目）
  phoneQuantity?: number;         // 手机数量（二手手机类目）
  unitPrice?: number;             // 单价（二手手机类目）
  invoiceFiles?: InvoiceFile[];   // 电子发票图片（多张）
  attachments?: InvoiceFile[];    // 开票附件（多张）
  completedTime?: string;         // 开票完成时间
  createTime?: { $date: string };
}

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
