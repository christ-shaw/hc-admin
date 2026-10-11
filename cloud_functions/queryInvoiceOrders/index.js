const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
exports.main = async event => {
  try {
    const data = event.data || event;
    if (data.action === 'orderChannels') {
      if (!Array.isArray(data.orderIds) || data.orderIds.length > 100 || data.orderIds.some(id => typeof id !== 'string' || !id.trim())) throw new Error('订单ID无效');
      const orders = data.orderIds.length ? (await db.collection('orders').where({ _id: db.command.in(data.orderIds) }).limit(100).get()).data : [];
      return { success: true, channels: orders.map(order => ({ orderId: order._id, salesChannel: order.salesChannel || '' })) };
    }
    if (data.action === 'invoiceDetail') {
      if (typeof data.invoiceId !== 'string' || !data.invoiceId.trim()) throw new Error('缺少发票ID');
      const result = await db.collection('invoices').doc(data.invoiceId).get();
      if (!result.data) throw new Error('发票不存在');
      return { success: true, invoice: result.data };
    }
    const { result } = await cloud.callFunction({ name: 'queryOrders', data: { data: {
      limit: 20, cursor: data.cursor || null, serialNumber: data.serialNumber,
      onlineOrderNumber: data.onlineOrderNumber, customerName: data.customerName,
      startDate: data.startDate, endDate: data.endDate, salesChannel: data.salesChannel,
    } } });
    if (!result?.success) return result;
    const ids = result.data.map(order => order._id);
    const links = ids.length ? (await db.collection('invoiceOrderLinks').where({ _id: db.command.in(ids) }).limit(20).get()).data : [];
    const byId = new Map(links.map(link => [link._id, link.invoiceId]));
    return { ...result, data: result.data.map(order => ({ ...order, linkedInvoiceId: byId.get(order._id) || '' })) };
  } catch (error) { return { success: false, errMsg: error.message || '查询失败' }; }
};
