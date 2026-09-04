function clean(value) {
  return String(value || '').trim();
}

function normalizeName(value) {
  return clean(value).normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[\s\-_·•.。]+/g, '');
}

function normalizePhone(value) {
  return clean(value).normalize('NFKC').replace(/[^0-9]/g, '');
}

function normalizeAddress(value) {
  return clean(value).normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[\s,，。;；]+/g, '');
}

module.exports = { clean, normalizeName, normalizePhone, normalizeAddress };
