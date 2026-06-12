import { useEffect, useState } from 'react';
import { Button, Input, MessagePlugin, Dialog } from 'tdesign-react';
import { Plus, ChevronDown, ChevronRight } from 'lucide-react';
import { PhoneBrand } from '../types';
import { usePhoneModels } from '../hooks/usePhoneModels';

export function PhoneModels() {
  const { brands, loading, loadBrands, addBrand, addModels } = usePhoneModels();
  const [expandedBrand, setExpandedBrand] = useState<string | null>(null);
  const [addBrandVisible, setAddBrandVisible] = useState(false);
  const [addModelVisible, setAddModelVisible] = useState(false);
  const [newBrandName, setNewBrandName] = useState('');
  const [selectedBrand, setSelectedBrand] = useState('');
  const [newModelsInput, setNewModelsInput] = useState('');

  useEffect(() => {
    loadBrands();
  }, [loadBrands]);

  const toggleBrand = (brandName: string) => {
    setExpandedBrand(prev => prev === brandName ? null : brandName);
  };

  const handleAddBrand = async () => {
    if (!newBrandName.trim()) { MessagePlugin.warning('请输入品牌名称'); return; }
    const result = await addBrand(newBrandName.trim());
    if (result.success) {
      MessagePlugin.success('添加品牌成功');
      setNewBrandName('');
      setAddBrandVisible(false);
      loadBrands();
    } else {
      MessagePlugin.error(result.errMsg || '添加失败');
    }
  };

  const handleAddModels = async () => {
    if (!selectedBrand) { MessagePlugin.warning('请选择品牌'); return; }
    if (!newModelsInput.trim()) { MessagePlugin.warning('请输入手机型号'); return; }

    const models = newModelsInput.split(/[,，]/).map(m => m.trim()).filter(m => m);
    if (models.length === 0) { MessagePlugin.warning('请输入至少一个型号'); return; }

    const result = await addModels(selectedBrand, models);
    if (result.success) {
      MessagePlugin.success(`成功添加 ${result.addedCount} 个型号`);
      setNewModelsInput('');
      setAddModelVisible(false);
      loadBrands();
    } else {
      MessagePlugin.error(result.errMsg || '添加失败');
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-gray-800">型号管理</h1>
        <p className="text-gray-500 mt-1">管理手机品牌和型号</p>
      </div>

      {/* 操作按钮 */}
      <div className="glass-card p-4">
        <div className="flex gap-3">
          <Button theme="primary" icon={<Plus size={16} />} onClick={() => { setAddBrandVisible(true); setAddModelVisible(false); }}>
            添加品牌
          </Button>
          <Button variant="outline" icon={<Plus size={16} />} onClick={() => { setAddModelVisible(true); setAddBrandVisible(false); }}>
            添加型号
          </Button>
        </div>
      </div>

      {/* 添加品牌表单 */}
      {addBrandVisible && (
        <div className="glass-card p-4">
          <h3 className="text-base font-semibold text-gray-700 mb-3">添加新品牌</h3>
          <div className="flex gap-3">
            <Input value={newBrandName} onChange={(val) => setNewBrandName(val as string)} placeholder="输入品牌名称" className="flex-1" />
            <Button theme="primary" onClick={handleAddBrand}>确认添加</Button>
            <Button variant="outline" onClick={() => { setAddBrandVisible(false); setNewBrandName(''); }}>取消</Button>
          </div>
        </div>
      )}

      {/* 添加型号表单 */}
      {addModelVisible && (
        <div className="glass-card p-4">
          <h3 className="text-base font-semibold text-gray-700 mb-3">添加手机型号</h3>
          <div className="space-y-3">
            <Select
              value={selectedBrand}
              onChange={(val) => setSelectedBrand(val as string)}
              options={brands.map(b => ({ label: b.brand, value: b.brand }))}
              placeholder="请选择品牌"
            />
            <Input
              value={newModelsInput}
              onChange={(val) => setNewModelsInput(val as string)}
              placeholder="输入型号（多个用逗号分隔，例如：iPhone 15, iPhone 15 Pro）"
            />
            <div className="flex gap-3">
              <Button theme="primary" onClick={handleAddModels}>确认添加</Button>
              <Button variant="outline" onClick={() => { setAddModelVisible(false); setNewModelsInput(''); setSelectedBrand(''); }}>取消</Button>
            </div>
          </div>
        </div>
      )}

      {/* 品牌列表 */}
      <div className="glass-card">
        <div className="p-4">
          {loading ? (
            <p className="text-center text-gray-400 py-8">加载中...</p>
          ) : brands.length === 0 ? (
            <p className="text-center text-gray-400 py-8">暂无手机型号数据</p>
          ) : (
            <div className="space-y-2">
              {brands.map((brand: PhoneBrand) => (
                <div key={brand.brand} className="border border-gray-200 rounded-lg overflow-hidden">
                  <button
                    onClick={() => toggleBrand(brand.brand)}
                    className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100"
                  >
                    <div className="flex items-center gap-2">
                      {expandedBrand === brand.brand ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      <span className="font-medium text-gray-700">{brand.brand}</span>
                    </div>
                    <span className="text-sm text-gray-400">{brand.models?.length || 0} 个型号</span>
                  </button>

                  {expandedBrand === brand.brand && (
                    <div className="border-t border-gray-200">
                      {brand.models && brand.models.length > 0 ? (
                        brand.models.map((model, i) => (
                          <div key={i} className="px-4 py-2.5 pl-10 border-b border-gray-50 text-sm text-gray-600 hover:bg-gray-50">
                            {model}
                          </div>
                        ))
                      ) : (
                        <p className="px-4 py-3 text-sm text-gray-400">暂无型号</p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Select({ value, onChange, options, placeholder }: {
  value: string;
  onChange: (val: string) => void;
  options: Array<{ label: string; value: string }>;
  placeholder: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-primary"
    >
      <option value="">{placeholder}</option>
      {options.map(opt => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  );
}
