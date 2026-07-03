/**
 * migrateOrdersToProducts - 订单数据结构迁移：扁平单货品 -> products 数组
 *
 * 旧结构：一条逻辑订单的多条货品 = 多条 orders 文档（共用 serialNumber 与公共字段），
 *        货品字段（brand/productName/specification/quantity/unitPrice/amount/paymentAccount/paymentSplits）扁平在文档上。
 * 新结构：一条逻辑订单 = 一条文档，货品在 products 数组中。
 *
 * 迁移规则：
 * - 仅处理没有 products 字段的文档；
 * - 按 serialNumber|date|customerName 分组（与建单时共用公共字段的粒度一致）；serialNumber 为空的文档单独成组；
 * - 每组按 createTime/_id 排序，保留第一条为主文档：写入 products 数组并清空扁平货品字段，其余文档删除；
 * - 支持 dryRun 预览，支持 limit 控制单次处理组数（避免云函数超时），可重复调用直至 remaining 为 0。
 *
 * 调用：callFunction('migrateOrdersToProducts', { data: { dryRun: true, limit: 200 } })
 */

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const ORDERS_COLLECTION = 'orders';
const PAGE_SIZE = 100;
const MAX_FETCH = 10000;

function toProductItem(doc) {
  return {
    brand: doc.brand || '',
    productName: doc.productName || '',
    specification: doc.specification || '',
    quantity: Number(doc.quantity) || 0,
    unitPrice: Number(doc.unitPrice) || 0,
    amount: Number(doc.amount) || 0,
    paymentAccount: doc.paymentAccount || '',
    paymentSplits: Array.isArray(doc.paymentSplits) ? doc.paymentSplits : [],
    ...(doc.sourceOrderItemNo ? { sourceOrderItemNo: doc.sourceOrderItemNo } : {}),
  };
}

function sortKey(doc) {
  const t = doc.createTime && doc.createTime.$date ? doc.createTime.$date : doc.createTime;
  const time = t ? new Date(t).getTime() : 0;
  return `${String(time).padStart(15, '0')}_${doc._id}`;
}

async function fetchLegacyDocs() {
  const docs = [];
  let skip = 0;
  while (skip < MAX_FETCH) {
    const res = await db.collection(ORDERS_COLLECTION)
      .where({ products: _.exists(false) })
      .skip(skip)
      .limit(PAGE_SIZE)
      .get();
    const batch = res.data || [];
    docs.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
  }
  return docs;
}

exports.main = async (event) => {
  const payload = (event && event.data) || event || {};
  const dryRun = payload.dryRun === true;
  const groupLimit = Math.max(1, Math.min(Number(payload.limit) || 200, 1000));

  try {
    const legacyDocs = await fetchLegacyDocs();
    if (legacyDocs.length === 0) {
      return { success: true, dryRun, groupsProcessed: 0, docsMerged: 0, docsDeleted: 0, remaining: 0, errMsg: '没有需要迁移的订单' };
    }

    // 分组：同一逻辑订单的多条货品文档
    const groups = new Map();
    for (const doc of legacyDocs) {
      const key = doc.serialNumber
        ? `sn_${doc.serialNumber}|${doc.date || ''}|${doc.customerName || ''}`
        : `doc_${doc._id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(doc);
    }

    const allGroups = Array.from(groups.values());
    const batch = allGroups.slice(0, groupLimit);
    const preview = [];
    let docsMerged = 0;
    let docsDeleted = 0;

    for (const group of batch) {
      group.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
      const primary = group[0];
      const products = group.map(toProductItem);

      if (dryRun) {
        preview.push({
          primaryId: primary._id,
          serialNumber: primary.serialNumber,
          customerName: primary.customerName,
          productCount: products.length,
          deleteIds: group.slice(1).map((d) => d._id),
        });
        continue;
      }

      await db.collection(ORDERS_COLLECTION).doc(primary._id).update({
        data: {
          products,
          // 清空扁平货品字段，避免与 products 并存产生歧义
          brand: '',
          productName: '',
          specification: '',
          quantity: 0,
          unitPrice: 0,
          amount: 0,
          paymentAccount: '',
          paymentSplits: [],
          migratedToProductsAt: db.serverDate(),
        },
      });
      docsMerged += 1;

      for (const extra of group.slice(1)) {
        await db.collection(ORDERS_COLLECTION).doc(extra._id).remove();
        docsDeleted += 1;
      }
    }

    return {
      success: true,
      dryRun,
      groupsProcessed: batch.length,
      docsMerged,
      docsDeleted,
      remaining: allGroups.length - batch.length,
      preview: dryRun ? preview.slice(0, 50) : undefined,
      errMsg: dryRun
        ? `预览：共 ${allGroups.length} 组待迁移（本次展示 ${batch.length} 组）`
        : `迁移完成：合并 ${docsMerged} 组，删除冗余文档 ${docsDeleted} 条，剩余 ${allGroups.length - batch.length} 组`,
    };
  } catch (error) {
    console.error('[migrateOrdersToProducts] 迁移失败:', error);
    return { success: false, errMsg: error.message || '迁移失败' };
  }
};
