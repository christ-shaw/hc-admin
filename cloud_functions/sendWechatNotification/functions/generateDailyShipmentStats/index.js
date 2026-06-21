/**
 * generateDailyShipmentStats - 每日生成近7日发货统计
 *
 * 统计口径：不含今天，昨日往前7天。
 * 数据库集合：
 * - inbound_records: 入库记录
 * - outbound_records: 出库记录
 * - daily_shipment_stats: 日切发货统计
 */

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const STATS_COLLECTION = 'daily_shipment_stats';
const INBOUND_COLLECTION = 'inbound_records';
const OUTBOUND_COLLECTION = 'outbound_records';

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function getTotalQuantity(record) {
  const models = Array.isArray(record.phoneModels) ? record.phoneModels : [];
  return models.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
}

async function fetchRecords(collectionName, dateField, startDate, endDate) {
  const records = [];
  const limit = 100;
  let skip = 0;
  let hasMore = true;

  while (hasMore && records.length < 10000) {
    const result = await db.collection(collectionName)
      .where({
        [dateField]: _.and(_.gte(startDate), _.lte(endDate)),
      })
      .orderBy(dateField, 'asc')
      .skip(skip)
      .limit(limit)
      .get();

    const data = result.data || [];
    records.push(...data);
    skip += data.length;
    hasMore = data.length === limit;
  }

  return records;
}

async function upsertStats(record) {
  const existed = await db.collection(STATS_COLLECTION)
    .where({ statDate: record.statDate })
    .limit(1)
    .get();

  if (existed.data && existed.data.length > 0) {
    await db.collection(STATS_COLLECTION).doc(existed.data[0]._id).update({
      data: {
        ...record,
        updatedAt: new Date(),
      },
    });
    return existed.data[0]._id;
  }

  const addResult = await db.collection(STATS_COLLECTION).add({
    data: {
      ...record,
      generatedAt: new Date(),
      updatedAt: new Date(),
    },
  });
  return addResult._id;
}

exports.main = async (event, context) => {
  try {
    const now = event && event.now ? new Date(event.now) : new Date();
    const end = addDays(now, -1);
    const start = addDays(end, -6);
    const statDate = formatDate(now);
    const startDate = formatDate(start);
    const endDate = formatDate(end);

    const dateList = [];
    for (let i = 0; i < 7; i++) {
      dateList.push(formatDate(addDays(start, i)));
    }

    const inboundRecords = await fetchRecords(INBOUND_COLLECTION, 'inboundDate', startDate, endDate);
    const records = await fetchRecords(OUTBOUND_COLLECTION, 'outboundDate', startDate, endDate);
    const recordsByDate = new Map(dateList.map(date => [date, []]));
    const modelMap = new Map();

    records.forEach(record => {
      const date = record.outboundDate;
      if (recordsByDate.has(date)) {
        recordsByDate.get(date).push(record);
      }

      const models = Array.isArray(record.phoneModels) ? record.phoneModels : [];
      models.forEach(phone => {
        const model = phone.model || phone.name || '未知型号';
        modelMap.set(model, (modelMap.get(model) || 0) + (Number(phone.quantity) || 0));
      });
    });

    const shipmentTrend = dateList.map(date => {
      const dayRecords = recordsByDate.get(date) || [];
      return {
        date: date.slice(5),
        发货数量: dayRecords.length,
        发货台数: dayRecords.reduce((sum, record) => sum + getTotalQuantity(record), 0),
      };
    });

    const topShippedModels = Array.from(modelMap.entries())
      .map(([model, count]) => ({ model, 发货台数: count }))
      .sort((a, b) => b.发货台数 - a.发货台数)
      .slice(0, 5);

    const statsRecord = {
      statDate,
      startDate,
      endDate,
      shipmentTrend,
      topShippedModels,
      totalInbound: inboundRecords.length,
      totalPhones: inboundRecords.reduce((sum, record) => sum + getTotalQuantity(record), 0),
      totalOutbound: records.length,
      totalOutboundPhones: records.reduce((sum, record) => sum + getTotalQuantity(record), 0),
    };

    const id = await upsertStats(statsRecord);

    return {
      success: true,
      _id: id,
      data: statsRecord,
      errMsg: '生成日切发货统计成功',
    };
  } catch (error) {
    console.error('生成日切发货统计失败:', error);
    return {
      success: false,
      errMsg: error.message || '生成日切发货统计失败',
    };
  }
};
