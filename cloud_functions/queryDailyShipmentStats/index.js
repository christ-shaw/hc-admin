/**
 * queryDailyShipmentStats - 查询每日发货统计
 *
 * 默认返回最新一条日切统计；也支持按 statDate 查询。
 */

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const STATS_COLLECTION = 'daily_shipment_stats';
const GENERATE_FUNCTION = 'generateDailyShipmentStats';

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function queryStats(statDate) {
  let query = db.collection(STATS_COLLECTION);
  if (statDate) {
    query = query.where({ statDate });
  }

  const result = await query
    .orderBy('statDate', 'desc')
    .limit(1)
    .get();

  return result.data && result.data.length > 0 ? result.data[0] : null;
}

exports.main = async (event, context) => {
  const data = event.data || {};
  const requestedStatDate = data.statDate;
  const expectedStatDate = requestedStatDate || formatDate(new Date());

  try {
    let record = await queryStats(expectedStatDate);
    if (!record && !requestedStatDate) {
      const generated = await cloud.callFunction({
        name: GENERATE_FUNCTION,
        data: { now: new Date().toISOString() },
      });
      record = generated && generated.result && generated.result.data || await queryStats(expectedStatDate);
    }

    return {
      success: true,
      data: record,
      errMsg: record ? '查询成功' : '暂无日切发货统计',
    };
  } catch (error) {
    console.error('查询日切发货统计失败:', error);
    return {
      success: false,
      data: null,
      errMsg: error.message || '查询日切发货统计失败',
    };
  }
};
