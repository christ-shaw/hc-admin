function normalizeAliases(values) {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(
    values
      .filter(value => typeof value === 'string')
      .map(value => value.trim())
      .filter(Boolean)
  ));
}

function normalizeAttributes(attributes) {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return undefined;
  return { ...attributes };
}

function shouldIncrementCatalogVersion(action, payload, result) {
  if (!result || result.success !== true) return false;
  if (action === 'initializeDefault') {
    return Number(result.data && result.data.inserted || 0) + Number(result.data && result.data.merged || 0) > 0;
  }
  if (action === 'addModels') return Number(result.addedCount || 0) > 0;
  if (action === 'backfillSkuIds') {
    return payload && payload.dryRun === false && Number(result.data && result.data.updatedDocuments || 0) > 0;
  }
  return true;
}

module.exports = {
  normalizeAliases,
  normalizeAttributes,
  shouldIncrementCatalogVersion,
};
