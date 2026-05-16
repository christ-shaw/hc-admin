/** 格式化日期 */
export function formatDate(dateStr: string | Date | { $date: string } | null, withTime = true): string {
  if (!dateStr) return '-';

  const actualDateStr = typeof dateStr === 'object' && '$date' in dateStr ? dateStr.$date : dateStr;
  const date = new Date(actualDateStr as string);
  if (isNaN(date.getTime())) return '-';

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  if (withTime) {
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  }

  return `${year}-${month}-${day}`;
}

/** 提取日期字符串 YYYY-MM-DD */
export function extractDateString(dateInput: unknown): string | null {
  if (!dateInput) return null;

  const actualDateStr = typeof dateInput === 'object' && dateInput !== null && '$date' in dateInput
    ? (dateInput as { $date: string }).$date
    : dateInput;

  if (typeof actualDateStr === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(actualDateStr)) return actualDateStr;
    const match = actualDateStr.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) return match[1];
  }

  const date = new Date(actualDateStr as string);
  if (isNaN(date.getTime())) return null;

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 获取手机数量 */
export function getTotalQuantity(record: { phoneModels?: { quantity?: number }[] }): number {
  if (record.phoneModels && Array.isArray(record.phoneModels)) {
    return record.phoneModels.reduce((sum, item) => sum + (item.quantity || 0), 0);
  }
  return 0;
}

/** 渠道类型映射 */
const CHANNEL_TYPE_MAP: Record<string, string> = {
  return: '归还',
  afterSale: '售后',
  recycle: '回收',
  purchase: '采购',
  normal: '正常',
};

/** 获取渠道类型文本 */
export function getChannelTypeText(channelType: string | undefined): string {
  if (!channelType) return '-';
  return CHANNEL_TYPE_MAP[channelType] || CHANNEL_TYPE_MAP[channelType.toLowerCase()] || channelType;
}
