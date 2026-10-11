const orders = [
  { _id: 'a', serialNumber: 1024, salesChannel: 'meituan', customerName: '张先生', date: '2026-10-11', onlineOrderNumber: 'ORDER-A', products: [{ productName: 'iPhone 15', quantity: 1, amount: 1000 }], attachments: [{ fileID: 'a', fileName: '订单凭证.png' }], linkedInvoiceId: '' },
  { _id: 'b', serialNumber: 1025, salesChannel: 'offline', customerName: '张先生', date: '2026-10-10', onlineOrderNumber: 'ORDER-B', products: [{ productName: '续期租金', quantity: 1, amount: 500 }], attachments: [], linkedInvoiceId: '' },
  { _id: 'c', serialNumber: 1026, customerName: '李先生', date: '2026-10-10', products: [{ productName: '租金', amount: 800 }], attachments: [], linkedInvoiceId: 'occupied' },
];
export async function callFunction(_name: string, { data }: { data: Record<string, unknown> }) {
  if (data.action === 'invoiceDetail') return { success: true, invoice: { companyName: '已关联公司' } };
  const filtered = orders.filter(o => (!data.serialNumber || o.serialNumber === Number(data.serialNumber)) && (!data.customerName || o.customerName.includes(String(data.customerName))) && (!data.onlineOrderNumber || o.onlineOrderNumber?.includes(String(data.onlineOrderNumber))));
  return { success: true, data: data.cursor ? filtered.slice(2) : filtered.slice(0, 2), cursor: !data.cursor && filtered.length > 2 ? '2' : null };
}
