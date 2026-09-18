const { NORMALIZATION_VERSION, clean, normalizeName, normalizePhone, normalizeAddress } = require('./normalizers');

function aliasData(payload) {
  const name = clean(payload.name);
  return {
    name,
    normalizedName: normalizeName(name),
    normalizationVersion: NORMALIZATION_VERSION,
    sourceType: ['manual', 'order', 'assist_import'].includes(payload.sourceType) ? payload.sourceType : 'manual',
    salesChannel: clean(payload.salesChannel),
    remark: clean(payload.remark),
    enabled: payload.enabled !== false,
  };
}

function recipientData(payload) {
  const consignee = clean(payload.consignee);
  const phone = clean(payload.phone);
  const address = clean(payload.address);
  return {
    label: clean(payload.label) || consignee || '默认收货档案',
    consignee,
    normalizedConsignee: normalizeName(consignee),
    phone,
    normalizedPhone: normalizePhone(phone),
    address,
    normalizedAddress: normalizeAddress(address),
    normalizationVersion: NORMALIZATION_VERSION,
    sourceType: ['manual', 'order', 'assist_import'].includes(payload.sourceType) ? payload.sourceType : 'manual',
    enabled: payload.enabled !== false,
  };
}

module.exports = { aliasData, recipientData };
