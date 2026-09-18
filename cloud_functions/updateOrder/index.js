/**
 * updateOrder - 更新订单记录
 * 
 * 根据 _id 更新 orders 集合中的订单记录
 * 自动添加 updateTime 字段
 */

const cloud = require('wx-server-sdk');
const { getCurrentUser } = require('./permissionAuth');
const { requireOrderPermission } = require('./customer/orderPermission');
const { stripLinkFields } = require('./customer/orderIngestion');
const { applyCustomerSelection } = require('./customerSelection');
const {
  aggregateOutboundModels,
  isOrderLinkedPendingOutbound,
  replaceOrderModelsRemark,
} = require('./outboundModels');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

const ORDERS = 'orders';
const OUTBOUND = 'outbound_records';

async function getDocument(transaction, collectionName, id) {
  try {
    const result = await transaction.collection(collectionName).doc(id).get();
    return result && result.data || null;
  } catch (_) {
    return null;
  }
}

exports.main = async (event, context) => {
  const { _id, updateData } = event.data || {};

  if (!_id) {
    return {
      success: false,
      errMsg: '缺少订单ID',
    };
  }

  if (!updateData || typeof updateData !== 'object' || Object.keys(updateData).length === 0) {
    return {
      success: false,
      errMsg: '缺少更新数据',
    };
  }

  try {
    const actor = await requireOrderPermission(db, getCurrentUser, 'orders:update');
    // Ignore raw linkage fields; only an explicit selection can change ownership.
    // 不允许更新的字段
    const forbiddenFields = ['_id', 'createTime', 'customerLinkExpected'];
    const cleanData = stripLinkFields(updateData, true);
    for (const field of forbiddenFields) {
      delete cleanData[field];
    }
    for (const field of Object.keys(cleanData)) {
      if (field.startsWith('customerLinkExpected.')) delete cleanData[field];
    }

    const transaction = await db.startTransaction();
    try {
      const existingOrder = await getDocument(transaction, ORDERS, _id);
      if (!existingOrder) {
        await transaction.rollback();
        return { success: false, errMsg: '订单不存在' };
      }

      // 添加更新时间。先保留纯数据用于重新聚合，避免服务端时间占位符进入快照。
      const linkPatch = await applyCustomerSelection(db, transaction, existingOrder, updateData, { ...existingOrder, ...cleanData }, actor);
      Object.assign(cleanData, linkPatch);
      const nextOrder = { ...existingOrder, ...cleanData };
      cleanData.updateTime = db.serverDate();

      await transaction.collection(ORDERS).doc(_id).update({ data: cleanData });

      // 只同步“订单生成 + 待出库”记录。已出库和手工出库的历史快照保持不变。
      const outboundId = String(nextOrder.outboundRecordId || '').trim();
      let outboundSynced = false;
      if (outboundId) {
        const outbound = await getDocument(transaction, OUTBOUND, outboundId);
        if (isOrderLinkedPendingOutbound(outbound)) {
          const linkedOrders = [];
          const linkedOrderIds = Array.from(new Set([
            ...outbound.orderIds.map(orderId => String(orderId || '').trim()).filter(Boolean),
            String(_id),
          ]));
          for (const orderId of linkedOrderIds) {
            const normalizedId = String(orderId || '').trim();
            if (!normalizedId) continue;
            if (normalizedId === String(_id)) {
              linkedOrders.push(nextOrder);
              continue;
            }
            const linkedOrder = await getDocument(transaction, ORDERS, normalizedId);
            if (linkedOrder) linkedOrders.push(linkedOrder);
          }
          const phoneModels = aggregateOutboundModels(linkedOrders);
          await transaction.collection(OUTBOUND).doc(outboundId).update({
            data: {
              phoneModels,
              remark: replaceOrderModelsRemark(outbound.remark, phoneModels),
              updateTime: db.serverDate(),
            },
          });
          outboundSynced = true;
        }
      }

      await transaction.commit();
      return {
        success: true,
        data: {
          ...linkPatch,
          _id,
          updateTime: new Date().toISOString(),
          outboundSynced,
        },
        errMsg: outboundSynced ? '订单及待出库型号已同步' : '更新成功',
      };
    } catch (transactionError) {
      try { await transaction.rollback(); } catch (_) { /* ignore rollback error */ }
      throw transactionError;
    }
  } catch (error) {
    console.error('更新订单失败:', error);
    return {
      success: false,
      errMsg: error.message || '更新订单失败',
    };
  }
};
