/**
 * generateOutboundRecord - 根据订单生成待出库单
 *
 * 输入: { orderId: string }
 * 输出: { success, data: { outboundId, outboundNumber, outboundStatus } }
 */

const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

const MAX_RETRY = 3;

const ORDER_TYPE_VIRTUAL_PRODUCTS = {
  newBusiness: ['平台租金', '续期租金'],
  postRentalPayment: ['补收差价', '仅退款', '利润差额', '维修费', '快递费'],
  deposit: ['收押金', '退押金'],
};

function normalizeDate(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.slice(0, 10);
  }
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getDateKey(value) {
  return normalizeDate(value).replace(/-/g, '');
}

function isPendingShipmentStatus(status) {
  return !status || status === 'unknown' || status === '--';
}

function requiresPhysicalShipment(order) {
  if (order.status === 'noShip') return false;
  if (order.brand === '虚拟产品') return false;

  const virtualProducts = ORDER_TYPE_VIRTUAL_PRODUCTS[order.orderType] || [];
  if (virtualProducts.includes(order.productName)) return false;

  return true;
}

function buildPhoneModel(order) {
  const parts = [order.brand, order.productName];
  if (order.specification && order.specification !== '默认') {
    parts.push(order.specification);
  }
  return parts.filter(Boolean).join(' / ') || order.productName || order.brand || '-';
}

function buildOutboundRecord(order, outboundNumber) {
  const outboundDate = normalizeDate(order.date);

  return {
    outboundNumber,
    outboundStatus: 'pending',
    customerName: order.customerName || order.consignee || '',
    consignee: order.consignee || '',
    consigneePhone: order.consigneePhone || '',
    consigneeAddress: order.consigneeAddress || '',
    outboundDate,
    trackingNumber: '',
    phoneModels: [
      {
        model: buildPhoneModel(order),
        quantity: Number(order.quantity) || 1,
      },
    ],
    linkedOrderId: order._id,
    linkedOrderSerialNumber: order.serialNumber || 0,
    linkedOrderStatus: 'active',
    source: 'order',
    remark: order.customerRemark ? `订单备注：${order.customerRemark}` : '',
    createTime: db.serverDate(),
    updateTime: db.serverDate(),
  };
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

async function getAndIncrementCounter(transaction, counterName) {
  let currentValue = 0;
  let docExists = true;

  try {
    const result = await transaction.collection('system_counters').doc(counterName).get();
    currentValue = result.data.value || 0;
  } catch (err) {
    if (isNotFoundError(err)) {
      docExists = false;
      currentValue = 0;
    } else {
      throw err;
    }
  }

  const newValue = currentValue + 1;

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

  return newValue;
}

exports.main = async (event, context) => {
  const { orderId } = event.data || {};

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

      if (order.linkedOutboundId || order.linkedOutboundNumber) {
        await transaction.rollback();
        return {
          success: true,
          data: {
            outboundId: order.linkedOutboundId,
            outboundNumber: order.linkedOutboundNumber,
            outboundStatus: order.outboundSyncStatus || 'pending',
          },
          errMsg: '订单已有关联出库单',
        };
      }

      if (!isPendingShipmentStatus(order.status)) {
        await transaction.rollback();
        return {
          success: false,
          errMsg: '仅待发货订单可生成出库单',
        };
      }

      if (!requiresPhysicalShipment(order)) {
        await transaction.rollback();
        return {
          success: false,
          errMsg: '该订单无需实物出库',
        };
      }

      const dateKey = getDateKey(order.date);
      const counterName = `db_counter_outbound_${dateKey}`;
      const sequence = await getAndIncrementCounter(transaction, counterName);
      const outboundNumber = `CK-${dateKey}-${String(sequence).padStart(5, '0')}`;
      const outboundData = buildOutboundRecord(order, outboundNumber);

      const outboundResult = await transaction.collection('outbound_records').add({
        data: outboundData,
      });

      const outboundId = outboundResult._id;

      await transaction.collection('orders').doc(orderId).update({
        data: {
          linkedOutboundId: outboundId,
          linkedOutboundNumber: outboundNumber,
          outboundSyncStatus: 'pending',
          updateTime: db.serverDate(),
        },
      });

      await transaction.commit();

      return {
        success: true,
        data: {
          outboundId,
          outboundNumber,
          outboundStatus: 'pending',
        },
        errMsg: '出库单生成成功',
      };
    } catch (err) {
      try { await transaction.rollback(); } catch (_) {}

      if (isRetryableError(err) && attempt < MAX_RETRY) {
        console.warn(`生成出库单事务冲突，第 ${attempt} 次重试...`);
        continue;
      }

      console.error('生成出库单失败:', err);
      return {
        success: false,
        errMsg: err.message || '生成出库单失败',
      };
    }
  }

  return {
    success: false,
    errMsg: '事务重试耗尽',
  };
};
