import { PRODUCT_DICT } from './dict';

export interface ProductSpecSeed {
  name: string;
  enabled: boolean;
  sort: number;
  systemItem: boolean;
}

export interface ProductItemSeed {
  name: string;
  enabled: boolean;
  sort: number;
  systemItem: boolean;
  specs: ProductSpecSeed[];
}

export interface ProductBrandSeed {
  brand: string;
  enabled: boolean;
  sort: number;
  systemBrand: boolean;
  products: ProductItemSeed[];
}

export function buildProductModelSeed(): ProductBrandSeed[] {
  return Object.entries(PRODUCT_DICT)
    .sort(([a], [b]) => a.localeCompare(b, 'zh-CN'))
    .map(([brand, productMap], brandIndex) => ({
      brand,
      enabled: true,
      sort: (brandIndex + 1) * 10,
      systemBrand: true,
      products: Object.entries(productMap)
        .sort(([a], [b]) => a.localeCompare(b, 'zh-CN'))
        .map(([name, specs], productIndex) => ({
          name,
          enabled: true,
          sort: (productIndex + 1) * 10,
          systemItem: true,
          specs: specs.map((spec, specIndex) => ({
            name: spec,
            enabled: true,
            sort: (specIndex + 1) * 10,
            systemItem: true,
          })),
        })),
    }));
}

export function flattenProductNames(seed: ProductBrandSeed[]): string[] {
  return Array.from(new Set(seed.flatMap(brand => brand.products.map(product => product.name))))
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
}
