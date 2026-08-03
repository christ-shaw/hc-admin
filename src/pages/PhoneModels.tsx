import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Dialog, Input, MessagePlugin, Switch, Textarea } from 'tdesign-react';
import { Plus, UploadCloud } from 'lucide-react';
import { usePhoneModels } from '../hooks/usePhoneModels';
import { PhoneBrand, PhoneModelSpec, PhoneProduct } from '../types';
import { buildProductModelSeed } from '../data/productDict';
import { usePermission } from '../contexts/PermissionContext';
import { useTabDirty } from '../contexts/TabWorkspaceContext';

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

// 状态胶囊配色（取自设计稿 Records Redesign）
const MODEL_STATUS_COLORS = {
  enabled: { fg: '#00854A', bg: '#E3F6EA' },
  disabled: { fg: '#B96A00', bg: '#FFF4E5' },
};

function StatusTag({ enabled }: { enabled?: boolean }) {
  const isEnabled = enabled !== false;
  const colors = isEnabled ? MODEL_STATUS_COLORS.enabled : MODEL_STATUS_COLORS.disabled;
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-px text-[11px] font-medium"
      style={{ backgroundColor: colors.bg, color: colors.fg }}
    >
      {isEnabled ? '启用' : '停用'}
    </span>
  );
}

/** 行内文字操作按钮（编辑=灰底深字，删除=红字红底） */
function RowActionButton({ variant, onClick, disabled, children }: {
  variant: 'edit' | 'delete';
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const isDelete = variant === 'delete';
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-md px-1.5 py-1 text-[12.5px] font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
        isDelete ? 'text-[#E34D59] hover:bg-[#FDECEE]' : 'text-[#8A94A6] hover:bg-[#F0F1F3] hover:text-[#374151]'
      }`}
    >
      {children}
    </button>
  );
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
  const [dialogInitial, setDialogInitial] = useState('');
  const dialogWasVisibleRef = useRef(false);

  useEffect(() => {
    if (dialog.visible && !dialogWasVisibleRef.current) {
      setDialogInitial(JSON.stringify(dialog));
    }
    if (!dialog.visible) setDialogInitial('');
    dialogWasVisibleRef.current = dialog.visible;
  }, [dialog]);

  useTabDirty(dialog.visible && !!dialogInitial && JSON.stringify(dialog) !== dialogInitial, '型号管理');

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
          <h1 className="text-xl font-semibold text-[#1F2733]">型号管理</h1>
          <div className="mt-1 flex flex-wrap gap-3 text-[13px] text-[#8A94A6]">
            <span>{orderedBrands.length} 个品牌</span>
            <span>{getProductCount(orderedBrands)} 个货品</span>
            <span>{getSpecCount(orderedBrands)} 个规格</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" loading={loading} onClick={refresh}>刷新</Button>
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
        <div className="rounded-2xl border border-dashed border-[#DDE1E7] bg-white p-8 text-center shadow-[0_1px_2px_rgba(16,24,40,0.03)]">
          <div className="text-sm font-medium text-[#374151]">暂无型号数据</div>
          <div className="mt-2 text-[13px] text-[#8A94A6]">种子包含 {seedBrands.length} 个品牌、{seedProductCount} 个货品、{seedSpecCount} 个规格</div>
          <Button className="mt-4" theme="primary" icon={<UploadCloud size={16} />} disabled={!canManage} onClick={handleInitialize}>
            初始化种子
          </Button>
        </div>
      )}

      {orderedBrands.length > 0 && (
        <div className="grid items-start gap-3.5 lg:grid-cols-[250px_minmax(0,1fr)_minmax(240px,320px)]">
          <section className="overflow-hidden rounded-2xl border border-[#EEF0F2] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.03)]">
            <div className="flex items-center justify-between border-b border-[#EEF0F2] px-4 py-3">
              <h2 className="text-sm font-semibold text-[#1F2733]">品牌</h2>
              <button
                type="button"
                aria-label="新增品牌"
                disabled={!canManage}
                onClick={openAddBrand}
                className="rounded px-1 text-base text-[#0052D9] transition hover:bg-[#F0F4FE] disabled:cursor-not-allowed disabled:opacity-40"
              >
                +
              </button>
            </div>
            <div className="flex max-h-[calc(100vh-250px)] flex-col gap-0.5 overflow-auto p-2">
              {orderedBrands.map(brand => {
                const selected = currentBrand?.brand === brand.brand;
                return (
                  <button
                    key={brand.brand}
                    onClick={() => {
                      setSelectedBrand(brand.brand);
                      setSelectedProduct('');
                    }}
                    className={`flex w-full flex-col gap-[5px] rounded-[10px] px-3 py-[9px] text-left transition ${
                      selected ? 'text-[#0052D9]' : 'text-gray-700 hover:bg-[#F0F4FE]'
                    }`}
                    style={selected ? { backgroundColor: '#EAF1FE' } : undefined}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[13px] font-medium">{brand.brand}</span>
                      <span className="text-[11px] text-[#9AA3B2]">{brand.products?.length || 0}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <StatusTag enabled={brand.enabled} />
                      {brand.systemBrand && <span className="text-[11px] text-[#C4CAD3]">内置</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="overflow-hidden rounded-2xl border border-[#EEF0F2] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.03)]">
            <div className="flex items-center justify-between border-b border-[#EEF0F2] px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold text-[#1F2733]">货品名称</h2>
                <p className="mt-px text-[11.5px] text-[#B5BBC5]">{currentBrand?.brand || '-'}</p>
              </div>
              <div className="flex items-center gap-1">
                {currentBrand && (
                  <>
                    <RowActionButton variant="edit" disabled={!canManage} onClick={() => openEditBrand(currentBrand)}>编辑</RowActionButton>
                    <RowActionButton variant="delete" disabled={!canManage} onClick={() => handleDeleteBrand(currentBrand)}>删除</RowActionButton>
                  </>
                )}
                <Button size="small" theme="primary" icon={<Plus size={15} />} disabled={!canManage || !currentBrand} onClick={openAddProduct}>货品</Button>
              </div>
            </div>
            <div className="max-h-[calc(100vh-250px)] overflow-auto">
              {products.length === 0 ? (
                <p className="p-8 text-center text-[13px] text-[#B5BBC5]">暂无货品</p>
              ) : products.map(product => {
                const selected = currentProduct?.name === product.name;
                return (
                  <div
                    key={product.name}
                    className="flex items-center justify-between gap-3 border-b border-[#F5F6F8] px-4 py-[11px] hover:bg-[#F8FAFF]"
                    style={{ backgroundColor: selected ? '#F5F9FF' : undefined }}
                  >
                    <button className="min-w-0 flex-1 text-left" onClick={() => setSelectedProduct(product.name)}>
                      <div className="truncate text-[13px] font-medium text-[#374151]">{product.name}</div>
                      <div className="mt-1 flex items-center gap-2 text-[11.5px] text-[#9AA3B2]">
                        <StatusTag enabled={product.enabled} />
                        <span>{product.specs?.length || 0} 个规格</span>
                      </div>
                    </button>
                    <div className="flex flex-shrink-0 gap-0.5">
                      <RowActionButton variant="edit" disabled={!canManage} onClick={() => openEditProduct(product)}>编辑</RowActionButton>
                      <RowActionButton variant="delete" disabled={!canManage} onClick={() => handleDeleteProduct(product)}>删除</RowActionButton>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="overflow-hidden rounded-2xl border border-[#EEF0F2] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.03)]">
            <div className="flex items-center justify-between border-b border-[#EEF0F2] px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold text-[#1F2733]">规格</h2>
                <p className="mt-px text-[11.5px] text-[#B5BBC5]">{currentProduct?.name || '-'}</p>
              </div>
              <Button size="small" theme="primary" icon={<Plus size={15} />} disabled={!canManage || !currentProduct} onClick={openAddSpec}>规格</Button>
            </div>
            <div className="max-h-[calc(100vh-250px)] overflow-auto">
              {specs.length === 0 ? (
                <p className="p-8 text-center text-[13px] text-[#B5BBC5]">暂无规格</p>
              ) : specs.map(spec => (
                <div key={spec.name} className="flex items-center justify-between gap-3 border-b border-[#F5F6F8] px-4 py-[11px] hover:bg-[#F8FAFF]">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium text-[#374151]">{spec.name}</div>
                    <div className="mt-1"><StatusTag enabled={spec.enabled} /></div>
                  </div>
                  <div className="flex flex-shrink-0 gap-0.5">
                    <RowActionButton variant="edit" disabled={!canManage} onClick={() => openEditSpec(spec)}>编辑</RowActionButton>
                    <RowActionButton variant="delete" disabled={!canManage} onClick={() => handleDeleteSpec(spec)}>删除</RowActionButton>
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
            <label className="mb-[5px] block text-xs text-[#8A94A6]">名称</label>
            <Input value={dialog.name} onChange={(value) => setDialog(prev => ({ ...prev, name: value as string }))} />
          </div>
          {dialog.mode === 'product' && !dialog.editing && (
            <div>
              <label className="mb-[5px] block text-xs text-[#8A94A6]">
                规格 <span className="font-normal text-[#B5BBC5]">（逗号或换行分隔，可批量）</span>
              </label>
              <Textarea
                value={dialog.specsInput}
                autosize={{ minRows: 3, maxRows: 5 }}
                onChange={(value) => setDialog(prev => ({ ...prev, specsInput: value as string }))}
              />
            </div>
          )}
          {dialog.editing && (
            <div className="flex items-center justify-between rounded-[10px] border border-[#EEF0F2] bg-[#FAFBFC] px-3 py-2.5 text-[13px] text-[#374151]">
              <span>启用</span>
              <Switch
                value={dialog.enabled}
                onChange={(val) => setDialog(prev => ({ ...prev, enabled: !!val }))}
              />
            </div>
          )}
        </div>
      </Dialog>
    </div>
  );
}
