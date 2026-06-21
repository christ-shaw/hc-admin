import type { OrderRecord, OutboundRecord } from '../types';

export const OUTBOUND_STATUS_MAP = {
  pending: '待出库',
  completed: '已出库',
  cancelled: '已取消',
} as const;

export const OUTBOUND_SOURCE_MAP = {
  order: '订单同步',
  manual: '手工录入',
} as const;

export const OUTBOUND_SYNC_STATUS_MAP = {
  none: '无出库',
  pending: '待出库',
  completed: '已出库',
} as const;

export type OutboundStatus = keyof typeof OUTBOUND_STATUS_MAP;
export type OutboundSyncStatus = keyof typeof OUTBOUND_SYNC_STATUS_MAP;
export type TagTheme = 'success' | 'warning' | 'danger' | 'default' | 'primary';

export function resolveOutboundStatus(record?: Pick<OutboundRecord, 'outboundStatus' | 'trackingNumber'> | null): OutboundStatus | undefined {
  if (!record) return undefined;
  if (record.outboundStatus) return record.outboundStatus;
  if (record.trackingNumber) return 'completed';
  return undefined;
}

export function getOutboundStatusText(status?: OutboundStatus): string {
  return status ? OUTBOUND_STATUS_MAP[status] : '-';
}

export function getOutboundStatusTheme(status?: OutboundStatus): TagTheme {
  if (status === 'completed') return 'success';
  if (status === 'pending') return 'warning';
  if (status === 'cancelled') return 'danger';
  return 'default';
}

export function resolveOutboundSyncStatus(order?: Pick<OrderRecord, 'outboundSyncStatus' | 'linkedOutboundId' | 'linkedOutboundNumber'> | null): OutboundSyncStatus {
  if (!order) return 'none';
  if (order.outboundSyncStatus) return order.outboundSyncStatus;
  return order.linkedOutboundId || order.linkedOutboundNumber ? 'pending' : 'none';
}

export function getOutboundSyncStatusTheme(status?: OutboundSyncStatus): TagTheme {
  if (status === 'completed') return 'success';
  if (status === 'pending') return 'warning';
  return 'default';
}

export function getOutboundSourceText(source?: OutboundRecord['source']): string {
  if (!source) return '-';
  return (OUTBOUND_SOURCE_MAP as Record<string, string>)[source] || source;
}
