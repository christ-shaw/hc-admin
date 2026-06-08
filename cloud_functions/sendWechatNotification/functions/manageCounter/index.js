/**
 * manageCounter - 管理计数器（获取/设置，事务版）
 * 
 * action: "get" | "set"
 * counterName: 计数器名称
 * value: 设置的值（仅 set 时需要）
 * 
 * set 操作使用事务，避免与 getAndIncrementCounter 的自增操作冲突。
 * get 操作无需事务（只读）。
 * 
 * 数据库集合: system_counters
 */

const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

const MAX_RETRY = 3;

exports.main = async (event, context) => {
  const { action = 'get', counterName = 'orderSerialNumber', value } = event.data || {};

  try {
    const collection = db.collection('system_counters');

    if (action === 'get') {
      try {
        const result = await collection.doc(counterName).get();
        return {
          success: true,
          value: result.data?.value || 0,
        };
      } catch (err) {
        if (err.errCode === -1 || err.message?.includes('not exist') || err.message?.includes('does not exist')) {
          return {
            success: true,
            value: 0,
          };
        }
        throw err;
      }
    }

    if (action === 'set') {
      if (typeof value !== 'number' || value < 0 || !Number.isInteger(value)) {
        return {
          success: false,
          errMsg: '值必须为非负整数',
        };
      }

      for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
        const transaction = await db.startTransaction();

        try {
          let docExists = true;

          try {
            await transaction.collection('system_counters').doc(counterName).get();
          } catch (err) {
            if (err.errCode === -1 || err.message?.includes('not exist') || err.message?.includes('does not exist')) {
              docExists = false;
            } else {
              throw err;
            }
          }

          if (docExists) {
            await transaction.collection('system_counters').doc(counterName).update({
              data: {
                value: value,
                updatedAt: db.serverDate(),
              },
            });
          } else {
            await transaction.collection('system_counters').add({
              data: {
                _id: counterName,
                value: value,
                updatedAt: db.serverDate(),
              },
            });
          }

          await transaction.commit();

          return {
            success: true,
            value: value,
          };
        } catch (err) {
          try { await transaction.rollback(); } catch (_) {}

          const isRetryable = err.errCode === -1 ||
                              err.message?.includes('conflict') ||
                              err.message?.includes('retry') ||
                              err.message?.includes('transaction');

          if (isRetryable && attempt < MAX_RETRY) {
            console.warn(`manageCounter 事务冲突，第 ${attempt} 次重试...`);
            continue;
          }

          throw err;
        }
      }

      return {
        success: false,
        errMsg: '事务重试耗尽',
      };
    }

    return {
      success: false,
      errMsg: '不支持的操作类型',
    };
  } catch (error) {
    console.error('管理计数器失败:', error);
    return {
      success: false,
      value: 0,
      errMsg: error.message || '操作失败',
    };
  }
};
