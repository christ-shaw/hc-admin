import { useEffect, useMemo, useState } from 'react';
import { Button, Dialog, Input, MessagePlugin, Tag, Textarea } from 'tdesign-react';
import { CheckCircle2, Edit2, Plus, RefreshCw, Trash2, UploadCloud } from 'lucide-react';
import { usePhoneModels } from '../hooks/usePhoneModels';
import { PhoneBrand, PhoneModelSpec, PhoneProduct } from '../types';
import { buildProductModelSeed } from '../data/productDict';
import { usePermission } from '../contexts/PermissionContext';

type DialogMode = 'brand' | 'product' | 'spec';

interface DialogState {
  visible: boolean;
  mode: DialogMode;
  editing: boolean;
  brand: string;
  productName: string;
  specName: string;
  name: string;
  specsInput: string;
  enabled: boolean;
}

const EMPTY_DIALOG: DialogState = {
  visible: false,
  mode: 'brand',
  editing: false,
  brand: '',
  productName: '',
  specName: '',
  name: '',
  specsInput: '默认',
  enabled: true,
};

function sortBySort<T extends { sort?: number; name?: string; brand?: string }>(items: T[] = []) {
  return [...items].sort((a, b) => {
    const sortDiff = (a.sort || 0) - (b.sort || 0);
    if (sortDiff !== 0) return sortDiff;
    return (a.brand || a.name || '').localeCompare(b.brand || b.name || '', 'zh-CN');
  });
}

function splitNames(value: string) {
  return value.split(/[,，\n]/).map(item => item.trim()).filter(Boolean);
}

function getProductCount(brands: PhoneBrand[]) {
  return brands.reduce((sum, brand) => sum + (brand.products?.length || 0), 0);
}

function getSpecCount(brands: PhoneBrand[]) {
  return brands.reduce((sum, brand) => (
    sum + (brand.products || []).reduce((productSum, product) => productSum + (product.specs?.length || 0), 0)
  ), 0);
}

function StatusTag({ enabled }: { enabled?: boolean }) {
  return enabled === false ? <Tag theme="warning" variant="light">停用</Tag> : <Tag theme="success" variant="light">启用</Tag>;
}

export function PhoneModels() {
  const {
    brands,
    loading,
    loadBrands,
    initializeFromSeed,
    addBrand,
    updateBrand,
    deleteBrand,
    addProduct,
    updateProduct,
    deleteProduct,
    addSpec,
    updateSpec,
    deleteSpec,
  } = usePhoneModels();
  const { can } = usePermission();
  const canManage = can('models:write');
  const seedBrands = useMemo(() => buildProductModelSeed(), []);
  const [selectedBrand, setSelectedBrand] = useState('');
  const [selectedProduct, setSelectedProduct] = useState('');
  const [dialog, setDialog] = useState<DialogState>(EMPTY_DIALOG);

  useEffect(() => {
    loadBrands();
  }, [loadBrands]);

  const orderedBrands = useMemo(() => sortBySort(brands), [brands]);
  const currentBrand = orderedBrands.find(item => item.brand === selectedBrand) || orderedBrands[0];
  const products = useMemo(() => sortBySort(currentBrand?.products || []), [currentBrand]);
  const currentProduct = products.find(item => item.name === selectedProduct) || products[0];
  const specs = useMemo(() => sortBySort(currentProduct?.specs || []), [currentProduct]);

  useEffect(() => {
    if (!currentBrand) {
      setSelectedBrand('');
      setSelectedProduct('');
      return;
    }
    if (selectedBrand !== currentBrand.brand) {
      setSelectedBrand(currentBrand.brand);
    }
  }, [currentBrand, selectedBrand]);

  useEffect(() => {
    if (!currentProduct) {
      setSelectedProduct('');
      return;
    }
    if (selectedProduct !== currentProduct.name) {
      setSelectedProduct(currentProduct.name);
    }
  }, [currentProduct, selectedProduct]);

  const refresh = async () => {
    await loadBrands();
  };

  const handleInitialize = async () => {
    const result = await initializeFromSeed(seedBrands);
    if (!result.success) {
      MessagePlugin.error(result.errMsg || '初始化失败');
      return;
    }
    MessagePlugin.success('初始化完成');
    await loadBrands();
  };

  const openAddBrand = () => {
    setDialog({ ...EMPTY_DIALOG, visible: true, mode: 'brand', name: '', enabled: true });
  };

  const openEditBrand = (brand: PhoneBrand) => {
    setDialog({
      ...EMPTY_DIALOG,
      visible: true,
      mode: 'brand',
      editing: true,
      brand: brand.brand,
      name: brand.brand,
      enabled: brand.enabled !== false,
    });
  };

  const openAddProduct = () => {
    if (!currentBrand) return;
    setDialog({
      ...EMPTY_DIALOG,
      visible: true,
      mode: 'product',
      brand: currentBrand.brand,
      name: '',
      specsInput: '默认',
      enabled: true,
    });
  };

  const openEditProduct = (product: PhoneProduct) => {
    if (!currentBrand) return;
    setDialog({
      ...EMPTY_DIALOG,
      visible: true,
      mode: 'product',
      editing: true,
      brand: currentBrand.brand,
      productName: product.name,
      name: product.name,
      enabled: product.enabled !== false,
    });
  };

  const openAddSpec = () => {
    if (!currentBrand || !currentProduct) return;
    setDialog({
      ...EMPTY_DIALOG,
      visible: true,
      mode: 'spec',
      brand: currentBrand.brand,
      productName: currentProduct.name,
      name: '',
      enabled: true,
    });
  };

  const openEditSpec = (spec: PhoneModelSpec) => {
    if (!currentBrand || !currentProduct) return;
    setDialog({
      ...EMPTY_DIALOG,
      visible: true,
      mode: 'spec',
      editing: true,
      brand: currentBrand.brand,
      productName: currentProduct.name,
      specName: spec.name,
      name: spec.name,
      enabled: spec.enabled !== false,
    });
  };

  const closeDialog = () => setDialog(EMPTY_DIALOG);

  const handleSubmit = async () => {
    const name = dialog.name.trim();
    if (!name) {
      MessagePlugin.warning('请输入名称');
      return;
    }

    let result: { success: boolean; errMsg?: string };
    if (dialog.mode === 'brand') {
      result = dialog.editing
        ? await updateBrand(dialog.brand, name, dialog.enabled)
        : await addBrand(name);
    } else if (dialog.mode === 'product') {
      result = dialog.editing
        ? await updateProduct(dialog.brand, dialog.productName, name, dialog.enabled)
        : await addProduct(dialog.brand, name, splitNames(dialog.specsInput));
    } else {
      result = dialog.editing
        ? await updateSpec(dialog.brand, dialog.productName, dialog.specName, name, dialog.enabled)
        : await addSpec(dialog.brand, dialog.productName, name);
    }

    if (!result.success) {
      MessagePlugin.error(result.errMsg || '保存失败');
      return;
    }

    MessagePlugin.success('已保存');
    closeDialog();
    await loadBrands();
    if (dialog.mode === 'brand') setSelectedBrand(name);
    if (dialog.mode === 'product') setSelectedProduct(name);
  };

  const handleDeleteBrand = async (brand: PhoneBrand) => {
    if (!window.confirm(`确认删除或停用品牌「${brand.brand}」？`)) return;
    const result = await deleteBrand(brand.brand);
    if (!result.success) {
      MessagePlugin.error(result.errMsg || '删除失败');
      return;
    }
    MessagePlugin.success('已处理');
    await loadBrands();
  };

  const handleDeleteProduct = async (product: PhoneProduct) => {
    if (!currentBrand || !window.confirm(`确认删除或停用货品「${product.name}」？`)) return;
    const result = await deleteProduct(currentBrand.brand, product.name);
    if (!result.success) {
      MessagePlugin.error(result.errMsg || '删除失败');
      return;
    }
    MessagePlugin.success('已处理');
    await loadBrands();
  };

  const handleDeleteSpec = async (spec: PhoneModelSpec) => {
    if (!currentBrand || !currentProduct || !window.confirm(`确认删除或停用规格「${spec.name}」？`)) return;
    const result = await deleteSpec(currentBrand.brand, currentProduct.name, spec.name);
    if (!result.success) {
      MessagePlugin.error(result.errMsg || '删除失败');
      return;
    }
    MessagePlugin.success('已处理');
    await loadBrands();
  };

  const seedProductCount = getProductCount(seedBrands);
  const seedSpecCount = getSpecCount(seedBrands);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-800">型号管理</h1>
          <div className="mt-2 flex flex-wrap gap-2 text-sm text-gray-500">
            <span>{orderedBrands.length} 个品牌</span>
            <span>{getProductCount(orderedBrands)} 个货品</span>
            <span>{getSpecCount(orderedBrands)} 个规格</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" icon={<RefreshCw size={16} />} loading={loading} onClick={refresh}>刷新</Button>
          <Button
            variant="outline"
            icon={<UploadCloud size={16} />}
            disabled={!canManage}
            onClick={handleInitialize}
          >
            初始化种子
          </Button>
          <Button theme="primary" icon={<Plus size={16} />} disabled={!canManage} onClick={openAddBrand}>品牌</Button>
        </div>
      </div>

      {orderedBrands.length === 0 && (
        <div className="rounded border border-dashed border-gray-300 bg-white p-8 text-center">
          <div className="text-base font-medium text-gray-700">暂无型号数据</div>
          <div className="mt-2 text-sm text-gray-500">种子包含 {seedBrands.length} 个品牌、{seedProductCount} 个货品、{seedSpecCount} 个规格</div>
          <Button className="mt-4" theme="primary" icon={<UploadCloud size={16} />} disabled={!canManage} onClick={handleInitialize}>
            初始化种子
          </Button>
        </div>
      )}

      {orderedBrands.length > 0 && (
        <div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)_minmax(260px,360px)]">
          <section className="rounded border border-gray-200 bg-white">
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
              <h2 className="text-base font-semibold text-gray-700">品牌</h2>
              <Button size="small" variant="text" icon={<Plus size={15} />} disabled={!canManage} onClick={openAddBrand} />
            </div>
            <div className="max-h-[calc(100vh-250px)] overflow-auto p-2">
              {orderedBrands.map(brand => (
                <button
                  key={brand.brand}
                  onClick={() => {
                    setSelectedBrand(brand.brand);
                    setSelectedProduct('');
                  }}
                  className={`mb-1 w-full rounded px-3 py-2 text-left transition ${currentBrand?.brand === brand.brand ? 'bg-primary/10 text-primary' : 'hover:bg-gray-50 text-gray-700'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{brand.brand}</span>
                    <span className="text-xs text-gray-400">{brand.products?.length || 0}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between">
                    <StatusTag enabled={brand.enabled} />
                    {brand.systemBrand && <CheckCircle2 size={14} className="text-gray-300" />}
                  </div>
                </button>
              ))}
            </div>
          </section>

          <section className="rounded border border-gray-200 bg-white">
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
              <div>
                <h2 className="text-base font-semibold text-gray-700">货品名称</h2>
                <p className="text-xs text-gray-400">{currentBrand?.brand || '-'}</p>
              </div>
              <div className="flex gap-1">
                {currentBrand && (
                  <>
                    <Button size="small" variant="text" icon={<Edit2 size={15} />} disabled={!canManage} onClick={() => openEditBrand(currentBrand)} />
                    <Button size="small" variant="text" icon={<Trash2 size={15} />} disabled={!canManage} onClick={() => handleDeleteBrand(currentBrand)} />
                  </>
                )}
                <Button size="small" theme="primary" icon={<Plus size={15} />} disabled={!canManage || !currentBrand} onClick={openAddProduct}>货品</Button>
              </div>
            </div>
            <div className="max-h-[calc(100vh-250px)] overflow-auto divide-y divide-gray-100">
              {products.length === 0 ? (
                <p className="p-6 text-center text-sm text-gray-400">暂无货品</p>
              ) : products.map(product => (
                <div
                  key={product.name}
                  className={`flex items-center justify-between gap-3 px-4 py-3 ${currentProduct?.name === product.name ? 'bg-primary/5' : 'hover:bg-gray-50'}`}
                >
                  <button className="min-w-0 flex-1 text-left" onClick={() => setSelectedProduct(product.name)}>
                    <div className="truncate text-sm font-medium text-gray-700">{product.name}</div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-gray-400">
                      <StatusTag enabled={product.enabled} />
                      <span>{product.specs?.length || 0} 个规格</span>
                    </div>
                  </button>
                  <div className="flex flex-shrink-0 gap-1">
                    <Button size="small" variant="text" icon={<Edit2 size={15} />} disabled={!canManage} onClick={() => openEditProduct(product)} />
                    <Button size="small" variant="text" icon={<Trash2 size={15} />} disabled={!canManage} onClick={() => handleDeleteProduct(product)} />
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded border border-gray-200 bg-white">
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
              <div>
                <h2 className="text-base font-semibold text-gray-700">规格</h2>
                <p className="text-xs text-gray-400">{currentProduct?.name || '-'}</p>
              </div>
              <Button size="small" theme="primary" icon={<Plus size={15} />} disabled={!canManage || !currentProduct} onClick={openAddSpec}>规格</Button>
            </div>
            <div className="max-h-[calc(100vh-250px)] overflow-auto divide-y divide-gray-100">
              {specs.length === 0 ? (
                <p className="p-6 text-center text-sm text-gray-400">暂无规格</p>
              ) : specs.map(spec => (
                <div key={spec.name} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-gray-50">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-gray-700">{spec.name}</div>
                    <div className="mt-1"><StatusTag enabled={spec.enabled} /></div>
                  </div>
                  <div className="flex flex-shrink-0 gap-1">
                    <Button size="small" variant="text" icon={<Edit2 size={15} />} disabled={!canManage} onClick={() => openEditSpec(spec)} />
                    <Button size="small" variant="text" icon={<Trash2 size={15} />} disabled={!canManage} onClick={() => handleDeleteSpec(spec)} />
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      <Dialog
        header={`${dialog.editing ? '编辑' : '新增'}${dialog.mode === 'brand' ? '品牌' : dialog.mode === 'product' ? '货品' : '规格'}`}
        visible={dialog.visible}
        onClose={closeDialog}
        width="520px"
        footer={(
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={closeDialog}>取消</Button>
            <Button theme="primary" onClick={handleSubmit}>保存</Button>
          </div>
        )}
      >
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-600">名称</label>
            <Input value={dialog.name} onChange={(value) => setDialog(prev => ({ ...prev, name: value as string }))} />
          </div>
          {dialog.mode === 'product' && !dialog.editing && (
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-600">规格</label>
              <Textarea
                value={dialog.specsInput}
                autosize={{ minRows: 3, maxRows: 5 }}
                onChange={(value) => setDialog(prev => ({ ...prev, specsInput: value as string }))}
              />
            </div>
          )}
          {dialog.editing && (
            <label className="flex items-center gap-2 text-sm text-gray-600">
              <input
                type="checkbox"
                checked={dialog.enabled}
                onChange={(event) => setDialog(prev => ({ ...prev, enabled: event.target.checked }))}
              />
              启用
            </label>
          )}
        </div>
      </Dialog>
    </div>
  );
}
