import { useState, useCallback } from 'react';
import { callFunction, getCurrentPermissionUserPayload } from '../lib/cloudbase';
import { StatsData, ModelStatsItem } from '../types';
import { extractDateString } from '../utils/format';

interface QueryRecordsResult {
  success?: boolean;
  data?: unknown[];
  hasMore: boolean;
  cursor: string | null;
  errMsg?: string;
}

export function useStats() {
  const [loading, setLoading] = useState(false);
  const [statsData, setStatsData] = useState<StatsData | null>(null);
  const [modelStats, setModelStats] = useState<ModelStatsItem[] | null>(null);

  const fetchStatsData = useCallback(async (days = 7) => {
    setLoading(true);
    try {
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days + 1);

      const formatDateStr = (d: Date) => {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
      };

      const startDateStr = formatDateStr(startDate);
      const endDateStr = formatDateStr(endDate);
      const currentUser = await getCurrentPermissionUserPayload().catch(() => null);

      // 获取入库记录
      const inboundRecords: unknown[] = [];
      let cursor: string | null = null;
      let hasMore = true;

      while (hasMore && inboundRecords.length < 10000) {
        const result: QueryRecordsResult = await callFunction<QueryRecordsResult>(
          'queryRecords',
          { data: { type: 'inbound', startDate: startDateStr, endDate: endDateStr, limit: 100, cursor, currentUser } },
        );
        if (result.success === false) throw new Error(result.errMsg || '查询入库统计失败');
        const data = result.data || [];
        inboundRecords.push(...data);
        hasMore = result.hasMore;
        cursor = result.cursor;
      }

      // 获取出库记录
      const outboundRecords: unknown[] = [];
      cursor = null;
      hasMore = true;

      while (hasMore && outboundRecords.length < 10000) {
        const result: QueryRecordsResult = await callFunction<QueryRecordsResult>(
          'queryRecords', {
          data: { type: 'outbound', startDate: startDateStr, endDate: endDateStr, limit: 100, cursor, currentUser },
        });
        if (result.success === false) throw new Error(result.errMsg || '查询出库统计失败');
        const data = result.data || [];
        outboundRecords.push(...data);
        hasMore = result.hasMore;
        cursor = result.cursor;
      }

      // 日期列表
      const dateList: string[] = [];
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dateStr = extractDateString(d);
        if (dateStr) dateList.push(dateStr);
      }

      // 按日期统计
      const stats: StatsData = {
        dates: dateList,
        inboundCounts: [],
        inboundPhones: [],
        outboundCounts: [],
        outboundPhones: [],
        totalInbound: inboundRecords.length,
        totalOutbound: outboundRecords.length,
        totalPhones: 0,
        totalOutboundPhones: 0,
      };

      dateList.forEach(date => {
        const dayInbound = inboundRecords.filter((r: unknown) => {
          const rec = r as Record<string, unknown>;
          const rawDate = rec.inboundDate || (rec.createTime as { $date?: string })?.$date;
          return extractDateString(rawDate) === date;
        });
        stats.inboundCounts.push(dayInbound.length);

        const phoneCount = dayInbound.reduce((sum: number, r: unknown) => {
          const rec = r as Record<string, unknown>;
          const models = rec.phoneModels as { quantity?: number }[] | undefined;
          return sum + (models ? models.reduce((s, p) => s + (p.quantity || 0), 0) : 0);
        }, 0);
        stats.inboundPhones.push(phoneCount);

        const dayOutbound = outboundRecords.filter((r: unknown) => {
          const rec = r as Record<string, unknown>;
          const rawDate = rec.outboundDate || (rec.createTime as { $date?: string })?.$date;
          return extractDateString(rawDate) === date;
        });
        stats.outboundCounts.push(dayOutbound.length);

        const outPhoneCount = dayOutbound.reduce((sum: number, r: unknown) => {
          const rec = r as Record<string, unknown>;
          const models = rec.phoneModels as { quantity?: number }[] | undefined;
          return sum + (models ? models.reduce((s, p) => s + (p.quantity || 0), 0) : 0);
        }, 0);
        stats.outboundPhones.push(outPhoneCount);
      });

      stats.totalPhones = stats.inboundPhones.reduce((a, b) => a + b, 0);
      stats.totalOutboundPhones = stats.outboundPhones.reduce((a, b) => a + b, 0);

      setStatsData(stats);
      return stats;
    } catch (err) {
      console.error('获取统计数据失败:', err);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchModelStats = useCallback(async (date: string) => {
    if (!date) return null;
    setLoading(true);

    const nextDate = new Date(date);
    nextDate.setDate(nextDate.getDate() + 1);
    const endDateStr = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, '0')}-${String(nextDate.getDate()).padStart(2, '0')}`;

    try {
      const currentUser = await getCurrentPermissionUserPayload().catch(() => null);
      const [inboundResult, outboundResult] = await Promise.all([
        callFunction<{ success?: boolean; data?: Record<string, unknown>[]; errMsg?: string }>('queryRecords', {
          data: { type: 'inbound', startDate: date, endDate: endDateStr, limit: 1000, currentUser },
        }),
        callFunction<{ success?: boolean; data?: Record<string, unknown>[]; errMsg?: string }>('queryRecords', {
          data: { type: 'outbound', startDate: date, endDate: endDateStr, limit: 1000, currentUser },
        }),
      ]);
      if (inboundResult.success === false) throw new Error(inboundResult.errMsg || '查询入库型号统计失败');
      if (outboundResult.success === false) throw new Error(outboundResult.errMsg || '查询出库型号统计失败');

      const inboundRecords = inboundResult.data || [];
      const outboundRecords = outboundResult.data || [];

      const modelStatsMap: Record<string, { inbound: number; outbound: number; inboundOrders: number; outboundOrders: number }> = {};

      inboundRecords.forEach(record => {
        const countedModels = new Set<string>();
        const models = record.phoneModels as { model?: string; name?: string; quantity?: number }[] | undefined;
        if (models) {
          models.forEach(phone => {
            const modelName = phone.model || phone.name || '未知型号';
            if (!modelStatsMap[modelName]) {
              modelStatsMap[modelName] = { inbound: 0, outbound: 0, inboundOrders: 0, outboundOrders: 0 };
            }
            modelStatsMap[modelName].inbound += phone.quantity || 0;
            if (!countedModels.has(modelName)) {
              modelStatsMap[modelName].inboundOrders += 1;
              countedModels.add(modelName);
            }
          });
        }
      });

      outboundRecords.forEach(record => {
        const countedModels = new Set<string>();
        const models = record.phoneModels as { model?: string; name?: string; quantity?: number }[] | undefined;
        if (models) {
          models.forEach(phone => {
            const modelName = phone.model || phone.name || '未知型号';
            if (!modelStatsMap[modelName]) {
              modelStatsMap[modelName] = { inbound: 0, outbound: 0, inboundOrders: 0, outboundOrders: 0 };
            }
            modelStatsMap[modelName].outbound += phone.quantity || 0;
            if (!countedModels.has(modelName)) {
              modelStatsMap[modelName].outboundOrders += 1;
              countedModels.add(modelName);
            }
          });
        }
      });

      const statsArray: ModelStatsItem[] = Object.entries(modelStatsMap)
        .map(([model, s]) => ({
          model,
          inbound: s.inbound,
          outbound: s.outbound,
          inboundOrders: s.inboundOrders,
          outboundOrders: s.outboundOrders,
          change: s.inbound - s.outbound,
        }))
        .sort((a, b) => (b.inbound + b.outbound) - (a.inbound + a.outbound));

      setModelStats(statsArray);
      return {
        date,
        stats: statsArray,
        totalInbound: statsArray.reduce((sum, item) => sum + item.inbound, 0),
        totalInboundOrders: inboundRecords.length,
        totalOutbound: statsArray.reduce((sum, item) => sum + item.outbound, 0),
        totalOutboundOrders: outboundRecords.length,
      };
    } catch (err) {
      console.error('按型号统计失败:', err);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  return { loading, statsData, modelStats, fetchStatsData, fetchModelStats };
}
