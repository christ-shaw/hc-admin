/**
 * completeOutbound - 完成出库并回写订单物流信息
 *
 * 输入: {
 *   outboundId: string,
 *   trackingNumber: string,
 *   completedBy?: string,
 *   phoneModels?: Array<{ model: string, quantity: number }>
 * }
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

function normalizePhoneModels(phoneModels) {
  if (!Array.isArray(phoneModels)) return undefined;
  const validModels = phoneModels
    .map(item => ({
      model: trimString(item?.model),
      quantity: Number(item?.quantity) || 0,
    }))
    .filter(item => item.model && item.quantity > 0);
  return validModels.length > 0 ? validModels : undefined;
}

function getOperator(event, context) {
  return trimString(event.completedBy) ||
    trimString(event.operator) ||
    trimString(event.userInfo?.nickName) ||
    trimString(context?.OPENID) ||
    '未知操作人';
}

exports.main = async (event, context) => {
  const data = event.data || event || {};
  const outboundId = trimString(data.outboundId || data._id);
  const trackingNumber = trimString(data.trackingNumber);
  const completedBy = getOperator(data, context);
  const phoneModels = normalizePhoneModels(data.phoneModels);

  if (!outboundId) {
    return {
      success: false,
      errMsg: '缺少出库单ID',
    };
  }

  if (!trackingNumber) {
    return {
      success: false,
      errMsg: '请填写物流单号',
    };
  }

  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    const transaction = await db.startTransaction();

    try {
      let outbound;
      try {
        const outboundResult = await transaction.collection('outbound_records').doc(outboundId).get();
        outbound = { ...outboundResult.data, _id: outboundId };
      } catch (err) {
        if (isNotFoundError(err)) {
          await transaction.rollback();
          return {
            success: false,
            errMsg: '出库单不存在',
          };
        }
        throw err;
      }

      const currentStatus = resolveOutboundStatus(outbound);
      const existingTrackingNumber = trimString(outbound.trackingNumber);

      if (currentStatus === 'completed') {
        await transaction.rollback();

        if (existingTrackingNumber === trackingNumber) {
          return {
            success: true,
            data: {
              outboundId,
              linkedOrderId: outbound.linkedOrderId || '',
              trackingNumber,
              outboundStatus: 'completed',
              orderUpdated: false,
              idempotent: true,
            },
            errMsg: '出库单已完成',
          };
        }

        return {
          success: false,
          errMsg: '出库单已完成，物流单号不一致',
        };
      }

      if (currentStatus !== 'pending') {
        await transaction.rollback();
        return {
          success: false,
          errMsg: `当前出库状态不允许完成：${currentStatus}`,
        };
      }

      let orderUpdated = false;
      let orderMissing = false;
      const linkedOrderId = trimString(outbound.linkedOrderId);

      if (linkedOrderId) {
        try {
          const orderResult = await transaction.collection('orders').doc(linkedOrderId).get();
          const order = orderResult.data || {};
          const orderTrackingNumber = trimString(order.trackingNumber);

          if (order.status === 'shipped' && orderTrackingNumber && orderTrackingNumber !== trackingNumber) {
            await transaction.rollback();
            return {
              success: false,
              errMsg: '关联订单已发货且物流单号不一致',
            };
          }

          await transaction.collection('orders').doc(linkedOrderId).update({
            data: {
              trackingNumber,
              status: 'shipped',
              outboundSyncStatus: 'completed',
              linkedOutboundId: outboundId,
              linkedOutboundNumber: outbound.outboundNumber || order.linkedOutboundNumber || '',
              updateTime: db.serverDate(),
            },
          });
          orderUpdated = true;
        } catch (err) {
          if (isNotFoundError(err)) {
            orderMissing = true;
          } else {
            throw err;
          }
        }
      }

      const outboundUpdateData = {
        outboundStatus: 'completed',
        completedDate: db.serverDate(),
        completedBy,
        trackingNumber,
        linkedOrderStatus: orderMissing ? 'missing' : (linkedOrderId ? 'active' : outbound.linkedOrderStatus || 'missing'),
        updateTime: db.serverDate(),
      };

      if (phoneModels) {
        outboundUpdateData.phoneModels = phoneModels;
      }

      await transaction.collection('outbound_records').doc(outboundId).update({
        data: outboundUpdateData,
      });

      await transaction.collection('operation_logs').add({
        data: {
          operationType: 'update',
          logType: 'outbound',
          logId: outboundId,
          operationContent: outbound.customerName || outbound.consignee || outbound.outboundNumber || outboundId,
          operator: completedBy,
          operatorOpenid: context?.OPENID || '',
          operationTime: new Date().toISOString(),
          createTime: db.serverDate(),
          changes: [
            { field: 'outboundStatus', oldValue: currentStatus, newValue: 'completed' },
            { field: 'trackingNumber', oldValue: existingTrackingNumber || '', newValue: trackingNumber },
            { field: 'orderUpdated', oldValue: false, newValue: orderUpdated },
          ],
        },
      });

      await transaction.commit();

      return {
        success: true,
        data: {
          outboundId,
          linkedOrderId,
          trackingNumber,
          outboundStatus: 'completed',
          orderUpdated,
          orderMissing,
        },
        errMsg: orderMissing ? '出库已完成，但关联订单不存在' : '出库完成',
      };
    } catch (err) {
      try { await transaction.rollback(); } catch (_) {}

      if (isRetryableError(err) && attempt < MAX_RETRY) {
        console.warn(`完成出库事务冲突，第 ${attempt} 次重试...`);
        continue;
      }

      console.error('完成出库失败:', err);
      return {
        success: false,
        errMsg: err.message || '完成出库失败',
      };
    }
  }

  return {
    success: false,
    errMsg: '事务重试耗尽',
  };
};
