import { useState, useCallback } from 'react';
import { callFunction } from '../lib/cloudbase';
import { PhoneBrand } from '../types';

export function usePhoneModels() {
  const [brands, setBrands] = useState<PhoneBrand[]>([]);
  const [allModels, setAllModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const loadBrands = useCallback(async () => {
    setLoading(true);
    try {
      const result = await callFunction<{ success: boolean; data: PhoneBrand[] }>('phoneModels', {
        action: 'getBrands',
      });
      if (result.success) {
        setBrands(result.data || []);
      }
    } catch (err) {
      console.error('加载手机品牌失败:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAllModels = useCallback(async () => {
    setLoading(true);
    try {
      const result = await callFunction<{ success: boolean; data: string[] }>('phoneModels', {
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
      const result = await callFunction<{ success: boolean; data: string[] }>('phoneModels', {
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
      const result = await callFunction<{ success: boolean; errMsg?: string }>('phoneModels', {
        action: 'addBrand',
        brand: brandName,
      });
      return { success: result?.success || false, errMsg: result?.errMsg || '添加失败' };
    } catch (err) {
      console.error('添加品牌失败:', err);
      return { success: false, errMsg: '添加失败' };
    }
  }, []);

  const addModels = useCallback(async (brand: string, models: string[]) => {
    try {
      const result = await callFunction<{ success: boolean; errMsg?: string; addedCount?: number }>('phoneModels', {
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
    loadBrands,
    loadAllModels,
    loadModelsByBrand,
    addBrand,
    addModels,
    loadShopsByType,
  };
}
