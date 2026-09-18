/**
 * saveOrders - 批量保存订单记录
 * 
 * 支持批量导入订单到 orders 集合
 * 每条记录自动添加 createTime 字段
 */

const cloud = require('wx-server-sdk');
const { getCurrentUser } = require('./permissionAuth');
const { requireOrderPermission } = require('./customer/orderPermission');
const { createOrderIngestion } = require('./customer/orderIngestion');
const { createOrderArchive } = require('./customer/orderArchive');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const customerOrders = createOrderIngestion(db);
const archiveOrder = createOrderArchive(db);

exports.main = async (event, context) => {
  const { orders } = event.data || {};

  if (!orders || !Array.isArray(orders) || orders.length === 0) {
    return {
      success: false,
      savedCount: 0,
      errMsg: '缺少订单数据或数据为空',
    };
  }

  try {
    const actor = await requireOrderPermission(db, getCurrentUser, 'orders:create');
    const now = db.serverDate();
    let savedCount = 0;
    const savedIds = [];
    const customerArchives = [];
    const errors = [];

    // 逐条插入，支持大批量数据
    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];
      try {
        const transaction = await db.startTransaction();
        let addRes;
        let archiveRequested = false;
        try {
          const orderData = await customerOrders.prepareOrder(order, actor, transaction);
          // Only new rental orders can request deferred archive creation. The caller
          // cannot inject the persisted marker or use it for derived orders.
          archiveRequested = order.createCustomerArchive === true && !orderData.customerId
            && ['rental1', 'rental2', '租赁1', '租赁2'].includes(orderData.orderAttribute)
            && !order.renewalSourceOrderId && !order.rental2TransferSourceOrderId && !order.afterSaleSourceOrderId;
          delete orderData.createCustomerArchive;
          delete orderData.customerArchiveRequested;
          if (archiveRequested) orderData.customerArchiveRequested = true;
          orderData.createTime = now;
          addRes = await transaction.collection('orders').add({ data: orderData });
          await customerOrders.recordPreparedLink(addRes._id, orderData, actor, transaction);
          await transaction.commit();
        } catch (error) { await transaction.rollback().catch(() => {}); throw error; }
        savedIds.push(addRes._id);
        savedCount++;
        // Archive failures are reported separately; the order is already committed.
        if (archiveRequested) {
          try {
            await requireOrderPermission(db, getCurrentUser, 'customers:write');
            customerArchives.push({ orderId: addRes._id, ...await archiveOrder(addRes._id, actor) });
          } catch (error) {
            customerArchives.push({ orderId: addRes._id, status: 'pending', code: error.code || 'CUSTOMER_ARCHIVE_FAILED',
              message: '客户档案待补建，可重试建档' });
          }
        } else await customerOrders.ingestOrder(addRes._id, actor);
      } catch (err) {
        console.error('订单保存失败', { index: i, code: err.code || 'ORDER_SAVE_FAILED' });
        errors.push({
          index: i,
          serialNumber: order.serialNumber,
          customerName: order.customerName,
          error: err.message,
        });
      }
    }

    return {
      success: savedCount > 0,
      savedCount,
      savedIds,
      customerArchives,
      failedCount: orders.length - savedCount,
      errors: errors.length > 0 ? errors : undefined,
      errMsg: savedCount === orders.length 
        ? `成功保存 ${savedCount} 条订单` 
        : `保存 ${savedCount}/${orders.length} 条订单，${orders.length - savedCount} 条失败`,
    };
  } catch (error) {
    console.error('批量保存订单失败:', error);
    return {
      success: false,
      savedCount: 0,
      code: error.code || 'ORDER_SAVE_FAILED',
      errMsg: error.message || '批量保存订单失败',
    };
  }
};
