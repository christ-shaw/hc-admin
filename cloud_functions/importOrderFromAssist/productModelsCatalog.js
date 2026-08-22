function normalizeAliases(values) {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(
    values
      .filter(value => typeof value === 'string')
      .map(value => value.trim())
      .filter(Boolean)
  ));
}

function copyAttributes(attributes) {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return undefined;
  return { ...attributes };
}

function mapProductModelDocs(docs) {
  return (docs || []).map(doc => {
    const sourceProducts = Array.isArray(doc.products) && doc.products.length > 0
      ? doc.products
      : (Array.isArray(doc.models) ? doc.models.map((name, index) => ({
          name,
          enabled: true,
          sort: (index + 1) * 10,
          specs: [{ name: '默认', enabled: true, sort: 10 }],
        })) : []);
    const products = sourceProducts
      .filter(product => product && product.enabled !== false)
      .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0))
      .map(product => ({
        productId: String(product.productId || ''),
        name: String(product.name || ''),
        aliases: normalizeAliases(product.aliases),
        specs: (product.specs || [])
          .filter(spec => spec && spec.enabled !== false)
          .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0))
          .map(spec => {
            const attributes = copyAttributes(spec.attributes);
            return {
              skuId: String(spec.skuId || ''),
              name: String(spec.name || ''),
              aliases: normalizeAliases(spec.aliases),
              enabled: true,
              ...(attributes ? { attributes } : {}),
            };
          })
          .filter(spec => spec.name),
      }))
      .filter(product => product.name && product.specs.length > 0);

    return {
      brandId: String(doc.brandId || ''),
      brand: String(doc.brand || ''),
      aliases: normalizeAliases(doc.aliases),
      products,
    };
  }).filter(brand => brand.brand && brand.products.length > 0);
}

module.exports = {
  mapProductModelDocs,
};
