import { useState, useCallback } from 'react';
import { callFunction } from '../lib/cloudbase';
import { PhoneBrand } from '../types';
import { ProductBrandSeed } from '../data/productDict';

const PRODUCT_MODEL_FUNCTION = 'manageProductModels';
const LEGACY_PHONE_MODEL_FUNCTION = 'phoneModels';

interface PhoneModelsResult<T = unknown> {
  success: boolean;
  data?: T;
  errMsg?: string;
  addedCount?: number;
}

function normalizeBrands(data: PhoneBrand[] = []): PhoneBrand[] {
  return data.map(brand => ({
    ...brand,
    products: brand.products || (brand.models || []).map((name, index) => ({
      name,
      enabled: true,
      sort: (index + 1) * 10,
      systemItem: false,
      specs: [{ name: '默认', enabled: true, sort: 10, systemItem: false }],
    })),
  }));
}

export function usePhoneModels() {
  const [brands, setBrands] = useState<PhoneBrand[]>([]);
  const [allModels, setAllModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');

  const loadBrands = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const result = await callFunction<{ success: boolean; data?: PhoneBrand[]; errMsg?: string }>(PRODUCT_MODEL_FUNCTION, {
        action: 'getBrands',
      });
      if (result.success) {
        setBrands(normalizeBrands(result.data || []));
      } else {
        setBrands([]);
        setLoadError(result.errMsg || '加载型号字典失败');
      }
    } catch (err) {
      console.error('加载手机品牌失败:', err);
      setBrands([]);
      setLoadError(err instanceof Error ? err.message : '加载型号字典失败');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAllModels = useCallback(async () => {
    setLoading(true);
    try {
      const result = await callFunction<{ success: boolean; data: string[] }>(LEGACY_PHONE_MODEL_FUNCTION, {
        action: 'getAllModels',
      });
      if (result.success) {
        setAllModels(result.data || []);
      }
      return result.data || [];
    } catch (err) {
      console.error('加载手机型号失败:', err);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const loadModelsByBrand = useCallback(async (brand: string) => {
    try {
      const result = await callFunction<{ success: boolean; data: string[] }>(LEGACY_PHONE_MODEL_FUNCTION, {
        action: 'getModelsByBrand',
        brand,
      });
      if (result.success) return result.data || [];
      return [];
    } catch (err) {
      console.error('加载品牌型号失败:', err);
      return [];
    }
  }, []);

  const addBrand = useCallback(async (brandName: string) => {
    try {
      const result = await callFunction<{ success: boolean; errMsg?: string }>(PRODUCT_MODEL_FUNCTION, {
        action: 'addBrand',
        brand: brandName,
      });
      return { success: result?.success || false, errMsg: result?.errMsg || '添加失败' };
    } catch (err) {
      console.error('添加品牌失败:', err);
      return { success: false, errMsg: '添加失败' };
    }
  }, []);

  const initializeFromSeed = useCallback(async (seed: ProductBrandSeed[]) => {
    try {
      const result = await callFunction<PhoneModelsResult<{ inserted: number; merged: number }>>(PRODUCT_MODEL_FUNCTION, {
        action: 'initializeDefault',
        seed,
      });
      return {
        success: !!result?.success,
        errMsg: result?.errMsg || '初始化失败',
        data: result?.data,
      };
    } catch (err) {
      console.error('初始化型号字典失败:', err);
      return { success: false, errMsg: '初始化失败' };
    }
  }, []);

  const updateBrand = useCallback(async (brand: string, nextBrand: string, enabled = true) => {
    try {
      const result = await callFunction<PhoneModelsResult>(PRODUCT_MODEL_FUNCTION, {
        action: 'updateBrand',
        brand,
        nextBrand,
        enabled,
      });
      return { success: !!result?.success, errMsg: result?.errMsg || '保存失败' };
    } catch (err) {
      console.error('更新品牌失败:', err);
      return { success: false, errMsg: '保存失败' };
    }
  }, []);

  const deleteBrand = useCallback(async (brand: string) => {
    try {
      const result = await callFunction<PhoneModelsResult>(PRODUCT_MODEL_FUNCTION, {
        action: 'deleteBrand',
        brand,
      });
      return { success: !!result?.success, errMsg: result?.errMsg || '删除失败' };
    } catch (err) {
      console.error('删除品牌失败:', err);
      return { success: false, errMsg: '删除失败' };
    }
  }, []);

  const addModels = useCallback(async (brand: string, models: string[]) => {
    try {
      const result = await callFunction<{ success: boolean; errMsg?: string; addedCount?: number }>(LEGACY_PHONE_MODEL_FUNCTION, {
        action: 'addModels',
        brand,
        models,
      });
      return {
        success: result?.success || false,
        errMsg: result?.errMsg || '添加失败',
        addedCount: result?.addedCount || 0,
      };
    } catch (err) {
      console.error('添加型号失败:', err);
      return { success: false, errMsg: '添加失败', addedCount: 0 };
    }
  }, []);

  const addProduct = useCallback(async (brand: string, productName: string, specs: string[] = ['默认']) => {
    try {
      const result = await callFunction<PhoneModelsResult>(PRODUCT_MODEL_FUNCTION, {
        action: 'addProduct',
        brand,
        productName,
        specs,
      });
      return { success: !!result?.success, errMsg: result?.errMsg || '添加失败' };
    } catch (err) {
      console.error('添加货品失败:', err);
      return { success: false, errMsg: '添加失败' };
    }
  }, []);

  const updateProduct = useCallback(async (brand: string, productName: string, nextProductName: string, enabled = true) => {
    try {
      const result = await callFunction<PhoneModelsResult>(PRODUCT_MODEL_FUNCTION, {
        action: 'updateProduct',
        brand,
        productName,
        nextProductName,
        enabled,
      });
      return { success: !!result?.success, errMsg: result?.errMsg || '保存失败' };
    } catch (err) {
      console.error('更新货品失败:', err);
      return { success: false, errMsg: '保存失败' };
    }
  }, []);

  const deleteProduct = useCallback(async (brand: string, productName: string) => {
    try {
      const result = await callFunction<PhoneModelsResult>(PRODUCT_MODEL_FUNCTION, {
        action: 'deleteProduct',
        brand,
        productName,
      });
      return { success: !!result?.success, errMsg: result?.errMsg || '删除失败' };
    } catch (err) {
      console.error('删除货品失败:', err);
      return { success: false, errMsg: '删除失败' };
    }
  }, []);

  const addSpec = useCallback(async (brand: string, productName: string, specName: string) => {
    try {
      const result = await callFunction<PhoneModelsResult>(PRODUCT_MODEL_FUNCTION, {
        action: 'addSpec',
        brand,
        productName,
        specName,
      });
      return { success: !!result?.success, errMsg: result?.errMsg || '添加失败' };
    } catch (err) {
      console.error('添加规格失败:', err);
      return { success: false, errMsg: '添加失败' };
    }
  }, []);

  const updateSpec = useCallback(async (brand: string, productName: string, specName: string, nextSpecName: string, enabled = true) => {
    try {
      const result = await callFunction<PhoneModelsResult>(PRODUCT_MODEL_FUNCTION, {
        action: 'updateSpec',
        brand,
        productName,
        specName,
        nextSpecName,
        enabled,
      });
      return { success: !!result?.success, errMsg: result?.errMsg || '保存失败' };
    } catch (err) {
      console.error('更新规格失败:', err);
      return { success: false, errMsg: '保存失败' };
    }
  }, []);

  const deleteSpec = useCallback(async (brand: string, productName: string, specName: string) => {
    try {
      const result = await callFunction<PhoneModelsResult>(PRODUCT_MODEL_FUNCTION, {
        action: 'deleteSpec',
        brand,
        productName,
        specName,
      });
      return { success: !!result?.success, errMsg: result?.errMsg || '删除失败' };
    } catch (err) {
      console.error('删除规格失败:', err);
      return { success: false, errMsg: '删除失败' };
    }
  }, []);

  const loadShopsByType = useCallback(async (type: string) => {
    try {
      const result = await callFunction<{ success: boolean; data: Array<{ name: string }> }>('getShops', {
        action: 'getShopsByType',
        type,
      });
      if (result.success) return result.data || [];
      return [];
    } catch (err) {
      console.error('加载渠道列表失败:', err);
      return [];
    }
  }, []);

  return {
    brands,
    allModels,
    loading,
    loadError,
    loadBrands,
    loadAllModels,
    loadModelsByBrand,
    initializeFromSeed,
    addBrand,
    updateBrand,
    deleteBrand,
    addModels,
    addProduct,
    updateProduct,
    deleteProduct,
    addSpec,
    updateSpec,
    deleteSpec,
    loadShopsByType,
  };
}
