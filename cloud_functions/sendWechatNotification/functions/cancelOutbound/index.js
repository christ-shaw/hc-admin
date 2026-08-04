/**
 * cancelOutbound - 取消订单关联的待出库单
 *
 * 输入: { orderId: string, reason?: string, operator?: string }
 */

const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

const MAX_RETRY = 3;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isNotFoundError(err) {
  return err?.errCode === -1 ||
    err?.message?.includes('not exist') ||
    err?.message?.includes('does not exist') ||
    err?.message?.includes('document not exists');
}

function isRetryableError(err) {
  return err?.errCode === -1 ||
    err?.message?.includes('conflict') ||
    err?.message?.includes('retry') ||
    err?.message?.includes('transaction');
}

function resolveOutboundStatus(outbound) {
  if (outbound.outboundStatus) return outbound.outboundStatus;
  return outbound.trackingNumber ? 'completed' : 'pending';
}

function getOperator(data, context) {
  return trimString(data.completedBy) ||
    trimString(data.operator) ||
    trimString(data.userInfo?.nickName) ||
    trimString(context?.OPENID) ||
    '未知操作人';
}

exports.main = async (event, context) => {
  const data = event.data || event || {};
  const orderId = trimString(data.orderId || data._id);
  const reason = trimString(data.reason) || '手动取消出库';
  const operator = getOperator(data, context);

  if (!orderId) {
    return {
      success: false,
      errMsg: '缺少订单ID',
    };
  }

  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    const transaction = await db.startTransaction();

    try {
      let order;
      try {
        const orderResult = await transaction.collection('orders').doc(orderId).get();
        order = { ...orderResult.data, _id: orderId };
      } catch (err) {
        if (isNotFoundError(err)) {
          await transaction.rollback();
          return {
            success: false,
            errMsg: '订单不存在',
          };
        }
        throw err;
      }

      const outboundId = trimString(order.linkedOutboundId);
      const outboundNumber = trimString(order.linkedOutboundNumber);

      if (!outboundId && !outboundNumber) {
        await transaction.rollback();
        return {
          success: true,
          data: {
            outboundStatus: 'cancelled',
            orderUpdated: false,
            idempotent: true,
          },
          errMsg: '订单没有关联出库单',
        };
      }

      let outbound = null;
      if (outboundId) {
        try {
          const outboundResult = await transaction.collection('outbound_records').doc(outboundId).get();
          outbound = { ...outboundResult.data, _id: outboundId };
        } catch (err) {
          if (!isNotFoundError(err)) throw err;
        }
      }

      if (outbound) {
        const currentStatus = resolveOutboundStatus(outbound);
        if (currentStatus === 'completed') {
          await transaction.rollback();
          return {
            success: false,
            errMsg: '出库单已完成，不能取消',
          };
        }

        if (currentStatus !== 'cancelled') {
          await transaction.collection('outbound_records').doc(outbound._id).update({
            data: {
              outboundStatus: 'cancelled',
              cancelledDate: db.serverDate(),
              cancelledBy: operator,
              cancelReason: reason,
              updateTime: db.serverDate(),
            },
          });
        }

        await transaction.collection('operation_logs').add({
          data: {
            operationType: 'update',
            logType: 'outbound',
            logId: outbound._id,
            operationContent: outbound.customerName || outbound.consignee || outbound.outboundNumber || outbound._id,
            operator,
            operatorOpenid: context?.OPENID || '',
            operationTime: new Date().toISOString(),
            createTime: db.serverDate(),
            changes: [
              { field: 'outboundStatus', oldValue: currentStatus, newValue: 'cancelled' },
              { field: 'cancelReason', oldValue: '', newValue: reason },
            ],
          },
        });
      }

      await transaction.collection('orders').doc(orderId).update({
        data: {
          linkedOutboundId: '',
          linkedOutboundNumber: '',
          outboundSyncStatus: 'none',
          updateTime: db.serverDate(),
        },
      });

      await transaction.commit();

      return {
        success: true,
        data: {
          outboundId: outbound?._id || outboundId,
          outboundNumber: outbound?.outboundNumber || outboundNumber,
          outboundStatus: 'cancelled',
          orderUpdated: true,
          outboundMissing: !outbound,
        },
        errMsg: outbound ? '已取消出库' : '已清空订单出库关联，原出库单不存在',
      };
    } catch (err) {
      try { await transaction.rollback(); } catch (_) {}

      if (isRetryableError(err) && attempt < MAX_RETRY) {
        console.warn(`取消出库事务冲突，第 ${attempt} 次重试...`);
        continue;
      }

      console.error('取消出库失败:', err);
      return {
        success: false,
        errMsg: err.message || '取消出库失败',
      };
    }
  }

  return {
    success: false,
    errMsg: '事务重试耗尽',
  };
};
