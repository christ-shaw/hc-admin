/**
 * getAndIncrementCounter - 获取计数器当前值并自增（事务版）
 * 
 * 使用数据库事务保证读-改-写原子性，消除并发竞态条件。
 * 事务在文档级别加锁，同一计数器的并发请求会串行执行。
 * 
 * 返回值: { success, value }  value 为自增后的新值
 * 数据库集合: system_counters
 * 文档结构: { _id: counterName, value: number, updatedAt: Date }
 */

const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

const MAX_RETRY = 3;

exports.main = async (event, context) => {
  const { counterName = 'orderSerialNumber' } = event.data || {};

  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    const transaction = await db.startTransaction();

    try {
      let currentValue = 0;
      let docExists = true;

      // 在事务内读取计数器
      try {
        const result = await transaction.collection('system_counters').doc(counterName).get();
        currentValue = result.data.value || 0;
      } catch (err) {
        if (err.errCode === -1 || err.message?.includes('not exist') || err.message?.includes('does not exist')) {
          docExists = false;
          currentValue = 0;
        } else {
          throw err;
        }
      }

      const newValue = currentValue + 1;

      // 在事务内写入新值
      if (docExists) {
        await transaction.collection('system_counters').doc(counterName).update({
          data: {
            value: newValue,
            updatedAt: db.serverDate(),
          },
        });
      } else {
        await transaction.collection('system_counters').add({
          data: {
            _id: counterName,
            value: newValue,
            updatedAt: db.serverDate(),
          },
        });
      }

      // 提交事务
      await transaction.commit();

      return {
        success: true,
        value: newValue,  // 返回自增后的新值，前端直接使用
      };
    } catch (err) {
      // 回滚事务
      try { await transaction.rollback(); } catch (_) {}

      // 判断是否可重试（事务冲突）
      const isRetryable = err.errCode === -1 || 
                          err.message?.includes('conflict') || 
                          err.message?.includes('retry') ||
                          err.message?.includes('transaction');

      if (isRetryable && attempt < MAX_RETRY) {
        console.warn(`计数器事务冲突，第 ${attempt} 次重试...`);
        continue;
      }

      console.error('计数器事务失败:', err);
      return {
        success: false,
        value: 0,
        errMsg: err.message || '计数器操作失败',
      };
    }
  }

  return {
    success: false,
    value: 0,
    errMsg: '计数器事务重试耗尽',
  };
};
