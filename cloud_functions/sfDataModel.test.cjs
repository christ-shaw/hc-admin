const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadHelpers(relativePath, exportName = '__test__') {
  const absolutePath = path.join(__dirname, relativePath);
  const source = fs.readFileSync(absolutePath, 'utf8');
  const module = { exports: {} };
  const cloudStub = {
    DYNAMIC_CURRENT_ENV: 'test',
    init() {},
    getWXContext() { return {}; },
    database() {
      return {
        command: {
          in(values) { return values; },
          inc(value) { return value; },
        },
      };
    },
  };
  const sandbox = {
    Buffer,
    URL,
    URLSearchParams,
    Intl,
    console,
    exports: module.exports,
    fetch: async () => { throw new Error('unexpected fetch'); },
    module,
    process: { env: {} },
    require(id) {
      if (id === 'wx-server-sdk') return cloudStub;
      if (id === './permissionAuth') return { getCurrentUser: async () => null };
      if (id === './miniappAuth') return { requireMiniappPermission: async () => ({ allowed: false }) };
      return require(id);
    },
  };
  vm.runInNewContext(source, sandbox, { filename: relativePath });
  return module.exports[exportName];
}

const apply = loadHelpers('applySfExpress/index.js');
const workbench = loadHelpers('querySfExpressOrders/index.js');
const exportLog = loadHelpers('recordSfExport/index.js');
const outbound = loadHelpers('completeOutbound/index.js');
const generateOutbound = loadHelpers('generateOutboundFromOrders/index.js');
const querySfOrder = loadHelpers('querySfOrderResult/index.js');
const cancelSfOrder = loadHelpers('cancelSfExpress/index.js');
const records = loadHelpers('queryRecords/index.js');
const shipment = loadHelpers('manageSfShipment/index.js');

test('首次下单使用第一版客户订单号和确定性记录 ID', () => {
  const plan = apply.planSfAttempt([], 'order-123');
  assert.equal(plan.action, 'create');
  assert.equal(plan.attemptNo, 1);
  assert.equal(plan.sfOrderId, 'HC_order-123');
  assert.equal(
    apply.buildSfRecordId('sandbox', 'order-123', 1),
    apply.buildSfRecordId('sandbox', 'order-123', 1),
  );
  assert.notEqual(
    apply.buildSfRecordId('sandbox', 'order-123', 1),
    apply.buildSfRecordId('production', 'order-123', 1),
  );
});

test('新顺丰记录初始化为单订单包裹关系', () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(apply.buildInitialShipmentFields({
      _id: 'order-123',
      outboundRecordId: 'outbound-456',
    }))),
    {
      linkedOrderIds: ['order-123'],
      linkedOutboundIds: ['outbound-456'],
      shipmentStatus: 'packing',
      shipmentVersion: 1,
      reuseEnabled: false,
      reuseEnabledAt: '',
      reuseDisabledAt: '',
      finalPackagePhotos: [],
      handedOverAt: '',
      shipmentHistory: [],
    },
  );
});

test('历史顺丰记录只读映射为历史锁定且不要求迁移', () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(workbench.normalizeShipmentMeta({
      sourceOrderId: 'order-old',
      status: 'applied',
      waybillNo: 'SF-OLD',
    }))),
    {
      linkedOrderIds: ['order-old'],
      linkedOutboundIds: [],
      shipmentStatus: 'legacy_locked',
      shipmentVersion: 0,
      isLegacyShipment: true,
      finalPackagePhotos: [],
      handedOverAt: '',
      reuseEnabled: false,
      reuseEnabledAt: '',
      reuseDisabledAt: '',
    },
  );
});

test('新包裹关系兼容主订单并去重关联记录', () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(workbench.normalizeShipmentMeta({
      sourceOrderId: 'order-1',
      linkedOrderIds: ['order-1', 'order-2', 'order-2'],
      linkedOutboundIds: ['outbound-1', 'outbound-2', 'outbound-2'],
      shipmentStatus: 'sealed',
      shipmentVersion: 3,
      finalPackagePhotos: ['cloud://photo'],
      handedOverAt: '',
    }))),
    {
      linkedOrderIds: ['order-1', 'order-2'],
      linkedOutboundIds: ['outbound-1', 'outbound-2'],
      shipmentStatus: 'sealed',
      shipmentVersion: 3,
      isLegacyShipment: false,
      finalPackagePhotos: ['cloud://photo'],
      handedOverAt: '',
      reuseEnabled: false,
      reuseEnabledAt: '',
      reuseDisabledAt: '',
    },
  );
});

test('复用候选必须严格匹配收件信息、付款方式和人员', () => {
  const base = {
    consignee: ' 张 三 ',
    consigneePhone: '138-0013-8000',
    consigneeAddress: '深圳市 南山区 科技园',
    shippingFee: 'prepaid',
    salesperson: 'XX',
  };
  assert.equal(
    shipment.buildRecipientMatchKey(base),
    shipment.buildRecipientMatchKey({
      consignee: '张三',
      consigneePhone: '13800138000',
      consigneeAddress: '深圳市南山区科技园',
      shippingFee: '包邮',
      salesperson: 'xx',
    }),
  );
  assert.notEqual(
    shipment.buildRecipientMatchKey(base),
    shipment.buildRecipientMatchKey({ ...base, shippingFee: 'cod' }),
  );
  assert.notEqual(
    shipment.buildRecipientMatchKey(base),
    shipment.buildRecipientMatchKey({ ...base, consigneeAddress: '深圳市福田区' }),
  );
});

test('历史顺丰记录不能开放共享运单', () => {
  assert.throws(
    () => shipment.validateManagedShipment({
      isCurrent: true,
      status: 'applied',
      env: 'sandbox',
      waybillNo: 'SF123',
    }, 'sandbox'),
    /历史顺丰单默认锁定/,
  );
});

test('开放追加只校验顺丰包裹状态，不依赖出库是否完成', () => {
  assert.doesNotThrow(() => shipment.validateReuseToggle({
    isCurrent: true,
    status: 'applied',
    env: 'sandbox',
    waybillNo: 'SF123',
    linkedOrderIds: ['order-1'],
    linkedOutboundIds: ['outbound-pending'],
    shipmentStatus: 'packing',
  }, 'sandbox'));
  assert.throws(
    () => shipment.validateReuseToggle({
      isCurrent: true,
      status: 'applied',
      env: 'sandbox',
      waybillNo: 'SF123',
      linkedOrderIds: ['order-1'],
      linkedOutboundIds: ['outbound-completed'],
      shipmentStatus: 'handed_over',
    }, 'sandbox'),
    /已经交接或取消/,
  );
});

test('失败重试复用原 sfOrderId，取消重下递增后缀', () => {
  const failed = {
    _id: 'failed',
    isCurrent: true,
    status: 'failed',
    attemptNo: 1,
    sfOrderId: 'HC_order-123',
  };
  const retry = apply.planSfAttempt([failed], 'order-123');
  assert.equal(retry.action, 'retry');
  assert.equal(retry.attemptNo, 1);
  assert.equal(retry.sfOrderId, 'HC_order-123');

  const cancelled = { ...failed, status: 'cancelled' };
  const reapplied = apply.planSfAttempt([cancelled], 'order-123');
  assert.equal(reapplied.action, 'create');
  assert.equal(reapplied.attemptNo, 2);
  assert.equal(reapplied.sfOrderId, 'HC_order-123_2');
});

test('当前记录阻止重复下单，且环境由独立查询范围隔离', () => {
  const applied = {
    _id: 'applied',
    isCurrent: true,
    status: 'applied',
    attemptNo: 1,
    sfOrderId: 'HC_order-123',
  };
  assert.equal(apply.planSfAttempt([applied], 'order-123').action, 'reject_applied');
  assert.equal(
    apply.buildSfRecordId('sandbox', 'order-123', 1)
      === apply.buildSfRecordId('production', 'order-123', 1),
    false,
  );
});

test('寄件人映射按订单 salesperson 匹配并忽略大小写', () => {
  const senderMap = {
    xx: { contact: 'XX' },
    yy: { contact: 'YY' },
  };
  assert.equal(apply.findSenderMapEntry(senderMap, 'XX').contact, 'XX');
  assert.equal(apply.findSenderMapEntry(senderMap, ' yY ').contact, 'YY');
  assert.throws(
    () => apply.findSenderMapEntry(senderMap, 'LL'),
    /未配置人员/,
  );
});

test('顺丰托寄物统一为电子产品并汇总数量', () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(apply.buildCargoDetails({
      products: [
        { productName: '相机', quantity: 2 },
        { productName: '镜头', quantity: 3 },
      ],
    }))),
    [{ name: '电子产品', count: 5, unit: '件' }],
  );
});

test('顺丰备注和快照备注包含客户下单型号数量', () => {
  const order = {
    shippingFee: 'cod',
    consignee: '张三',
    consigneePhone: '13800138000',
    consigneeAddress: '深圳市南山区',
    customerRemark: '客户备注',
    products: [
      { brand: 'Apple', productName: 'iPhone 15', specification: '256G', quantity: 2 },
      { brand: 'OPPO', productName: 'Reno12', specification: '默认', quantity: 1 },
    ],
  };
  const expected = '客户下单：Apple / iPhone 15 / 256G×2，OPPO / Reno12×1；客户备注';

  assert.equal(apply.buildOrderProductsRemark(order), '客户下单：Apple / iPhone 15 / 256G×2，OPPO / Reno12×1');
  assert.equal(apply.buildPrintProductsRemark(order), 'iPhone 15 / 256G×2，Reno12×1');
  assert.equal(apply.buildOrderRemark(order, 500), expected);
  assert.equal(apply.buildPrintOrderRemark(order), '订单1：iPhone 15 / 256G×2，Reno12×1；备注：客户备注');
  assert.equal(apply.buildOrderSnapshot(order).customerRemark, expected);
  assert.equal(apply.buildOrderSnapshot(order).rawCustomerRemark, '客户备注');
  assert.equal(
    apply.buildMsgData(
      order,
      'HC_order_1',
      { contact: '寄件人', tel: '075512345678', country: 'CN', address: '深圳市福田区' },
      { expressTypeId: 2, parcelQty: 1 },
    ).remark,
    '订单1：iPhone 15 / 256G×2，Reno12×1；备注：客户备注',
  );
});

test('合包备注按订单保存快照，追加和解除时重新汇总', () => {
  const primary = {
    _id: 'order-primary',
    onlineOrderNumber: 'ME-PRIMARY',
    customerRemark: '主单客户备注',
    products: [{ brand: 'Apple', productName: 'iPhone 15', quantity: 1 }],
  };
  const appended = {
    _id: 'order-appended',
    onlineOrderNumber: 'ME-APPENDED',
    customerRemark: '追加单客户备注',
    products: [{ brand: 'OPPO', productName: 'Find X8', quantity: 2 }],
  };
  const primaryEntry = apply.buildShipmentRemarkEntry(primary, 'primary', '2026-08-02T00:00:00.000Z');
  const appendedEntry = shipment.buildShipmentRemarkEntry(appended, 'appended', '2026-08-02T01:00:00.000Z');
  const record = {
    sourceOrderId: primary._id,
    sourceOnlineOrderNumber: primary.onlineOrderNumber,
    orderSnapshot: apply.buildOrderSnapshot(primary),
    shipmentRemarkEntries: [primaryEntry],
  };
  const merged = shipment.buildShipmentRemarkData(record, { appendEntry: appendedEntry });

  assert.equal(merged.shipmentRemarkEntries.length, 2);
  assert.match(merged.shipmentRemarkFull, /主单 ME-PRIMARY：客户下单：Apple \/ iPhone 15×1；主单客户备注/);
  assert.match(merged.shipmentRemarkFull, /追加单 ME-APPENDED：客户下单：OPPO \/ Find X8×2；追加单客户备注/);
  assert.equal(merged.shipmentPrintRemark, '订单1：iPhone 15×1；备注：主单客户备注\n订单2：Find X8×2；备注：追加单客户备注');

  const detached = shipment.buildShipmentRemarkData({ ...record, ...merged }, { removeOrderId: appended._id });
  assert.equal(detached.shipmentRemarkEntries.length, 1);
  assert.doesNotMatch(detached.shipmentRemarkFull, /追加单客户备注/);
  assert.equal(detached.shipmentPrintRemark, '订单1：iPhone 15×1；备注：主单客户备注');
});

test('解除后重新追加会补齐旧备注条目的新版打印字段', () => {
  const primary = {
    _id: 'order-primary',
    onlineOrderNumber: 'ME-PRIMARY',
    customerRemark: '主单客户备注',
    products: [{ brand: 'Apple', productName: 'iPhone 15', specification: '256G', quantity: 1 }],
  };
  const appended = {
    _id: 'order-appended',
    onlineOrderNumber: 'ME-APPENDED',
    customerRemark: '追加单客户备注',
    products: [{ brand: 'OPPO', productName: 'Find X8', quantity: 2 }],
  };
  const legacyPrimaryEntry = apply.buildShipmentRemarkEntry(primary, 'primary');
  delete legacyPrimaryEntry.printProductRemark;
  const record = {
    sourceOrderId: primary._id,
    shipmentRemarkEntries: [legacyPrimaryEntry],
  };
  const refreshed = shipment.buildShipmentRemarkData(record, {
    ensureEntries: shipment.buildMissingRemarkEntries([primary], primary._id, ''),
  });
  const reattached = shipment.buildShipmentRemarkData({ ...record, ...refreshed }, {
    ensureEntries: shipment.buildMissingRemarkEntries([primary], primary._id, ''),
    appendEntry: shipment.buildShipmentRemarkEntry(appended, 'appended'),
  });

  assert.equal(refreshed.shipmentRemarkEntries[0].printProductRemark, 'iPhone 15 / 256G×1');
  assert.equal(reattached.shipmentPrintRemark, '订单1：iPhone 15 / 256G×1；备注：主单客户备注\n订单2：Find X8×2；备注：追加单客户备注');
});

test('同型号不同数量按订单分行保留，不做包含去重', () => {
  const primary = {
    _id: 'order-liufei-primary',
    customerRemark: '壳 线',
    products: [{ productName: 'OPPOA72', quantity: 22 }],
  };
  const appended = {
    _id: 'order-liufei-appended',
    customerRemark: '壳 售后 和他的租赁订单一起发',
    products: [{ productName: 'OPPOA72', quantity: 2 }],
  };
  const entries = [
    apply.buildShipmentRemarkEntry(primary, 'primary'),
    apply.buildShipmentRemarkEntry(appended, 'appended'),
  ];

  assert.equal(
    apply.buildShipmentPrintRemark(entries),
    '订单1：OPPOA72×22；备注：壳 线\n订单2：OPPOA72×2；备注：壳 售后 和他的租赁订单一起发',
  );
});

test('出库完成时允许订单沿用相同顺丰单号并标记已发货', () => {
  const plan = outbound.planOrderShipmentUpdate(
    { status: 'unshipped', trackingNumber: 'SF123', expressProvider: 'sf' },
    'SF123',
    'prepaid',
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(plan)),
    {
      action: 'update',
      update: {
        trackingNumber: 'SF123',
        status: 'shipped',
        shippingFee: 'prepaid',
      },
    },
  );
});

test('出库完成时拒绝覆盖订单已有的其他运单号', () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(outbound.planOrderShipmentUpdate(
      { status: 'unshipped', trackingNumber: 'SF123' },
      'SF456',
      'prepaid',
    ))),
    {
      action: 'conflict',
      existingTrackingNumber: 'SF123',
    },
  );
  assert.equal(
    outbound.planOrderShipmentUpdate(
      { status: 'shipped', trackingNumber: 'SF123' },
      'SF123',
      'prepaid',
    ).action,
    'skip',
  );
});

test('生成出库记录时自动采用订单已有的唯一快递单号', () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(generateOutbound.planInitialOutboundTracking([
      { trackingNumber: '' },
      { trackingNumber: ' SF123 ' },
    ]))),
    {
      action: 'set',
      trackingNumber: 'SF123',
    },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(generateOutbound.planInitialOutboundTracking([
      { trackingNumber: 'SF123' },
      { trackingNumber: 'SF456' },
    ]))),
    {
      action: 'conflict',
      trackingNumbers: ['SF123', 'SF456'],
    },
  );
});

test('生成待出库单备注包含客户下单型号数量', () => {
  const phoneModels = [
    { model: 'Apple / iPhone 15 / 256G', quantity: 2 },
    { model: 'OPPO / Reno12', quantity: 1 },
  ];
  assert.equal(
    generateOutbound.buildPhoneModelsRemark(phoneModels),
    '客户下单：Apple / iPhone 15 / 256G×2，OPPO / Reno12×1',
  );
  assert.equal(
    generateOutbound.mergeRemarkParts([
      generateOutbound.buildPhoneModelsRemark(phoneModels),
      '客户备注',
    ]),
    '客户下单：Apple / iPhone 15 / 256G×2，OPPO / Reno12×1；客户备注',
  );
});

test('顺丰下单或查询成功后只补写待出库记录且不覆盖其他单号', () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(apply.planPendingOutboundTrackingSync(
      { outboundStatus: 'pending', trackingNumber: '' },
      'SF123',
    ))),
    {
      action: 'update',
      trackingNumber: 'SF123',
    },
  );
  assert.equal(
    querySfOrder.planPendingOutboundTrackingSync(
      { outboundStatus: 'completed', trackingNumber: 'SF123' },
      'SF123',
    ).action,
    'skipped_status',
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(apply.planPendingOutboundTrackingSync(
      { outboundStatus: 'pending', trackingNumber: 'YT456' },
      'SF123',
    ))),
    {
      action: 'conflict',
      existingTrackingNumber: 'YT456',
      targetTrackingNumber: 'SF123',
    },
  );
});

test('取消顺丰单只清除匹配的待出库单号', () => {
  assert.equal(
    cancelSfOrder.planPendingOutboundTrackingClear(
      { outboundStatus: 'pending', trackingNumber: 'SF123' },
      'SF123',
    ).action,
    'clear',
  );
  assert.equal(
    cancelSfOrder.planPendingOutboundTrackingClear(
      { outboundStatus: 'completed', trackingNumber: 'SF123' },
      'SF123',
    ).action,
    'skipped_status',
  );
  assert.equal(
    cancelSfOrder.planPendingOutboundTrackingClear(
      { outboundStatus: 'pending', trackingNumber: 'YT456' },
      'SF123',
    ).action,
    'unchanged',
  );
});

test('共享顺丰单禁止沿用单订单取消流程', () => {
  assert.equal(cancelSfOrder.isSharedShipment({ linkedOrderIds: ['order-1'] }), false);
  assert.equal(cancelSfOrder.isSharedShipment({
    linkedOrderIds: ['order-1', 'order-2', 'order-2'],
  }), true);
});

test('出库记录已有顺丰单号时无需再次提交或扫码', () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(outbound.planOutboundCompletionTracking(
      { trackingNumber: 'SF123' },
      '',
    ))),
    {
      action: 'complete',
      trackingNumber: 'SF123',
      source: 'outbound',
    },
  );
  assert.equal(
    outbound.planOutboundCompletionTracking({ trackingNumber: '' }, '').action,
    'missing',
  );
  assert.equal(
    outbound.planOutboundCompletionTracking({ trackingNumber: 'SF123' }, 'SF456').action,
    'conflict',
  );
});

test('全部关联出库完成后顺丰包裹自动封箱但不自动永久交接', () => {
  const record = {
    status: 'applied',
    isCurrent: true,
    shipmentStatus: 'packing',
    linkedOutboundIds: ['outbound-1', 'outbound-2'],
  };
  assert.equal(
    outbound.planSfShipmentAfterOutboundCompleted(
      record,
      'outbound-2',
      [
        { _id: 'outbound-1', outboundStatus: 'completed' },
        { _id: 'outbound-2', outboundStatus: 'pending' },
      ],
    ).action,
    'seal',
  );
  assert.equal(
    outbound.planSfShipmentAfterOutboundCompleted(
      record,
      'outbound-2',
      [
        { _id: 'outbound-1', outboundStatus: 'pending' },
        { _id: 'outbound-2', outboundStatus: 'pending' },
      ],
    ).action,
    'wait',
  );
});

test('只有开放过追加或已经共享的包裹需要确认交接', () => {
  assert.equal(shipment.requiresHandoverConfirmation({
    sourceOrderId: 'order-1',
    linkedOrderIds: ['order-1'],
    reuseEnabledAt: '',
  }), false);
  assert.equal(shipment.requiresHandoverConfirmation({
    sourceOrderId: 'order-1',
    linkedOrderIds: ['order-1'],
    reuseEnabledAt: '2026-07-28T12:00:00.000Z',
  }), true);
  assert.equal(shipment.requiresHandoverConfirmation({
    sourceOrderId: 'order-1',
    linkedOrderIds: ['order-1', 'order-2'],
    reuseEnabledAt: '',
  }), true);
});

test('待出库查询不再因已有快递单号排除订单出库记录', () => {
  assert.equal(
    records.isPendingOutboundRecord({
      source: 'order',
      outboundStatus: 'pending',
      trackingNumber: 'SF123',
    }),
    true,
  );
  assert.equal(
    records.isPendingOutboundRecord({
      source: 'order',
      outboundStatus: 'completed',
      trackingNumber: 'SF123',
    }),
    false,
  );
});

test('工作台状态只使用当前环境关联结果并识别切换日前历史', () => {
  const base = {
    date: '2026-07-24',
    status: 'unshipped',
    trackingNumber: '',
    expressProvider: '',
    shippingFee: 'prepaid',
  };
  assert.equal(workbench.deriveSfStatus(base, null, '2026-07-24'), 'not_created');
  assert.equal(
    workbench.deriveSfStatus({ ...base, date: '2026-07-23' }, null, '2026-07-24'),
    'legacy_unmanaged',
  );
  assert.equal(
    workbench.deriveSfStatus(base, { status: 'applied' }, '2026-07-24'),
    'applied',
  );
  assert.equal(
    workbench.deriveSfStatus({ ...base, trackingNumber: 'YT123', expressProvider: 'yto' }, null, '2026-07-24'),
    'other_express',
  );
});

test('同一导出批次与来源订单生成同一幂等日志 ID', () => {
  const first = exportLog.buildExportLogId('batch-1', 'order-1');
  assert.equal(first, exportLog.buildExportLogId('batch-1', 'order-1'));
  assert.notEqual(first, exportLog.buildExportLogId('batch-2', 'order-1'));
  assert.notEqual(first, exportLog.buildExportLogId('batch-1', 'order-2'));
});

test('落库摘要会移除 token 并脱敏电话', () => {
  const value = apply.sanitizeForStorage({
    accessToken: 'secret',
    consigneePhone: '13800138000',
  });
  assert.equal(value.accessToken, '[REDACTED]');
  assert.equal(value.consigneePhone, '138****8000');
});
