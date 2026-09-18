const { createHash } = require('node:crypto');

const NORMALIZATION_VERSION = 'customer-identity-v2';

function clean(value) {
  return String(value ?? '').trim();
}

function normalizeName(value) {
  // Separators become a boundary, never disappear: "A B" must differ from "AB".
  return clean(value).normalize('NFKC').toLowerCase()
    .replace(/[\s\-_·•.。\u2010-\u2015]+/gu, ' ').trim();
}

function normalizePhone(value) {
  return clean(value).normalize('NFKC').replace(/[^0-9]/g, '');
}

function normalizeAddress(value) {
  // Keep -, / and parentheses: they may distinguish building/unit/room numbers.
  return clean(value).normalize('NFKC').toLowerCase().replace(/[\s,，。;；:：、]+/gu, '');
}

function isCompletePhone(value) {
  const raw = clean(value).normalize('NFKC');
  // First version supports mainland mobile numbers, optionally with an explicit +86/86.
  // Other formats remain displayable; masking or letters must not turn into a valid phone.
  if (!/^\+?[\d\s()\-]+$/.test(raw)) return false;
  const digits = normalizePhone(raw);
  if (raw.startsWith('+') && !digits.startsWith('86')) return false;
  return /^(?:86)?1[3-9]\d{9}$/.test(digits);
}

function normalizeIdentity(identity = {}) {
  return {
    customerName: normalizeName(identity.customerName),
    consignee: normalizeName(identity.consignee),
    phone: normalizePhone(identity.phone ?? identity.consigneePhone),
    address: normalizeAddress(identity.address ?? identity.consigneeAddress),
  };
}

function isCompleteIdentity(identity = {}) {
  const normalized = normalizeIdentity(identity);
  return Boolean(normalized.customerName && normalized.consignee && normalized.address
    && isCompletePhone(identity.phone ?? identity.consigneePhone));
}

function identityFingerprint(identity = {}) {
  const normalized = normalizeIdentity(identity);
  if (!Object.values(normalized).some(Boolean)) return null;
  return createHash('sha256').update(JSON.stringify([
    NORMALIZATION_VERSION, normalized.customerName, normalized.consignee, normalized.phone, normalized.address,
  ])).digest('hex');
}

module.exports = {
  NORMALIZATION_VERSION, clean, normalizeName, normalizePhone, normalizeAddress,
  isCompletePhone, normalizeIdentity, isCompleteIdentity, identityFingerprint,
};
