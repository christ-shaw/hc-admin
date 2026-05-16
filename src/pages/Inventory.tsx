import { useState, useRef } from 'react';
import { Table, Button, Input, MessagePlugin, Tabs } from 'tdesign-react';
import { Upload, Search, RotateCcw, Download, Trash2, FileSpreadsheet } from 'lucide-react';
import * as XLSX from 'xlsx';

/** 库存条目 */
export interface InventoryItem {
  _id: string;
  productCode: string;   // 货品编号
  productName: string;   // 货品名称
  specification: string; // 规格
  originalStock: number; // 原始库存
  currentStock: number;  // 现有库存
}

/** 工作表名称映射 */
const SHEET_TAB_MAP: Record<string, string> = {
  '半成品库存': 'semiFinished',
  '成品库存': 'finished',
  '维修仓': 'repair',
};

const SHEET_NAMES = Object.keys(SHEET_TAB_MAP);

/** 列名映射 */
const COLUMN_MAP: Record<string, string> = {
  '货品编号': 'productCode',
  '货品名称': 'productName',
  '规格': 'specification',
  '原始库存': 'originalStock',
  '现有库存': 'currentStock',
};

export function Inventory() {
  const [inventoryData, setInventoryData] = useState<Record<string, InventoryItem[]>>({
    semiFinished: [],
    finished: [],
    repair: [],
  });
  const [activeTab, setActiveTab] = useState('semiFinished');
  const [filters, setFilters] = useState({ keyword: '' });
  const [fileName, setFileName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** 解析 Excel 文件 */
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = evt.target?.result;
        const workbook = XLSX.read(data, { type: 'binary' });

        const newInventoryData: Record<string, InventoryItem[]> = {
          semiFinished: [],
          finished: [],
          repair: [],
        };

        for (const sheetName of SHEET_NAMES) {
          const worksheet = workbook.Sheets[sheetName];
          if (!worksheet) {
            MessagePlugin.warning(`未找到工作表「${sheetName}」`);
            continue;
          }

          const jsonData = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet);

          const items: InventoryItem[] = jsonData
            .map((row, index) => {
              const item: InventoryItem = {
                _id: `${SHEET_TAB_MAP[sheetName]}-${index}`,
                productCode: '',
                productName: '',
                specification: '',
                originalStock: 0,
                currentStock: 0,
              };

              for (const [cnName, enKey] of Object.entries(COLUMN_MAP)) {
                const value = row[cnName];
                if (value !== undefined && value !== null) {
                  if (enKey === 'originalStock' || enKey === 'currentStock') {
                    (item as unknown as Record<string, unknown>)[enKey] = Number(value) || 0;
                  } else {
                    (item as unknown as Record<string, unknown>)[enKey] = String(value).trim();
                  }
                }
              }

              return item;
            })
            .filter(item => item.productCode || item.productName);

          newInventoryData[SHEET_TAB_MAP[sheetName]] = items;
        }

        setInventoryData(newInventoryData);

        const totalItems = Object.values(newInventoryData).reduce((sum, arr) => sum + arr.length, 0);
        MessagePlugin.success(`导入成功，共 ${totalItems} 条记录`);
      } catch (err) {
        console.error('解析 Excel 失败:', err);
        MessagePlugin.error('解析 Excel 文件失败，请检查文件格式');
      }
    };

    reader.readAsBinaryString(file);
    // 重置 input 以支持重复选择同一文件
    e.target.value = '';
  };

  /** 获取当前 tab 的数据（含筛选） */
  const getFilteredData = (): InventoryItem[] => {
    const data = inventoryData[activeTab] || [];
    if (!filters.keyword) return data;
    const kw = filters.keyword.toLowerCase();
    return data.filter(
      item =>
        item.productCode.toLowerCase().includes(kw) ||
        item.productName.toLowerCase().includes(kw) ||
        item.specification.toLowerCase().includes(kw)
    );
  };

  /** 搜索 */
  const handleSearch = () => {
    // 筛选是响应式的，直接触发重渲染即可
  };

  /** 重置筛选 */
  const handleReset = () => {
    setFilters({ keyword: '' });
  };

  /** 清空数据 */
  const handleClear = () => {
    setInventoryData({ semiFinished: [], finished: [], repair: [] });
    setFileName('');
    MessagePlugin.success('已清空所有数据');
  };

  /** 导出当前 tab 数据为 Excel */
  const handleExport = () => {
    const data = getFilteredData();
    if (data.length === 0) {
      MessagePlugin.warning('没有数据可导出');
      return;
    }

    const tabNameMap: Record<string, string> = {
      semiFinished: '半成品库存',
      finished: '成品库存',
      repair: '维修仓',
    };

    const exportData = data.map(item => ({
      货品编号: item.productCode,
      货品名称: item.productName,
      规格: item.specification,
      原始库存: item.originalStock,
      现有库存: item.currentStock,
    }));

    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, tabNameMap[activeTab]);
    XLSX.writeFile(wb, `${tabNameMap[activeTab]}_${new Date().toISOString().slice(0, 10)}.xlsx`);
    MessagePlugin.success('导出成功');
  };

  const columns = [
    { colKey: 'productCode', title: '货品编号', width: 160, ellipsis: true },
    { colKey: 'productName', title: '货品名称', width: 200, ellipsis: true },
    { colKey: 'specification', title: '规格', width: 160, ellipsis: true },
    { colKey: 'originalStock', title: '原始库存', width: 120, cell: ({ row }: { row: InventoryItem }) => (
      <span className={row.originalStock < 0 ? 'text-danger font-medium' : ''}>{row.originalStock}</span>
    )},
    { colKey: 'currentStock', title: '现有库存', width: 120, cell: ({ row }: { row: InventoryItem }) => (
      <span className={row.currentStock <= 0 ? 'text-danger font-medium' : row.currentStock < row.originalStock * 0.2 ? 'text-warning font-medium' : ''}>
        {row.currentStock}
      </span>
    )},
    { colKey: 'diff', title: '库存变动', width: 100, cell: ({ row }: { row: InventoryItem }) => {
      const diff = row.currentStock - row.originalStock;
      if (diff > 0) return <span className="text-success font-medium">+{diff}</span>;
      if (diff < 0) return <span className="text-danger font-medium">{diff}</span>;
      return <span className="text-gray-400">0</span>;
    }},
  ];

  const tabNameMap: Record<string, string> = {
    semiFinished: '半成品库存',
    finished: '成品库存',
    repair: '维修仓',
  };

  const filteredData = getFilteredData();
  const totalCount = Object.values(inventoryData).reduce((sum, arr) => sum + arr.length, 0);

  return (
    <div className="space-y-4">
      {/* 标题 */}
      <div>
        <h1 className="text-2xl font-semibold text-gray-800">库存管理</h1>
        <p className="text-gray-500 mt-1">导入 Excel 文件查看库存信息</p>
      </div>

      {/* 操作栏 */}
      <div className="glass-card p-4">
        <div className="flex flex-wrap items-center gap-3">
          {/* 导入按钮 */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={handleFileUpload}
          />
          <Button
            theme="primary"
            icon={<Upload size={16} />}
            onClick={() => fileInputRef.current?.click()}
          >
            导入 Excel
          </Button>

          {/* 导出按钮 */}
          <Button
            variant="outline"
            icon={<Download size={16} />}
            onClick={handleExport}
            disabled={totalCount === 0}
          >
            导出当前表
          </Button>

          {/* 清空按钮 */}
          <Button
            variant="outline"
            theme="danger"
            icon={<Trash2 size={16} />}
            onClick={handleClear}
            disabled={totalCount === 0}
          >
            清空数据
          </Button>

          {/* 文件名显示 */}
          {fileName && (
            <div className="flex items-center gap-2 text-sm text-gray-500 bg-gray-50 px-3 py-1.5 rounded-lg">
              <FileSpreadsheet size={14} className="text-primary" />
              <span>{fileName}</span>
            </div>
          )}

          {/* 筛选 */}
          <div className="ml-auto flex items-center gap-2">
            <Input
              placeholder="搜索编号/名称/规格"
              value={filters.keyword}
              onChange={(val) => setFilters(prev => ({ ...prev, keyword: val as string }))}
              style={{ width: 220 }}
              onEnter={handleSearch}
            />
            <Button theme="primary" icon={<Search size={16} />} onClick={handleSearch}>查询</Button>
            <Button variant="outline" icon={<RotateCcw size={16} />} onClick={handleReset}>重置</Button>
          </div>
        </div>
      </div>

      {/* 库存汇总 */}
      {totalCount > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {Object.entries(tabNameMap).map(([key, name]) => (
            <div key={key} className="stat-card">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500">{name}</p>
                  <p className="text-2xl font-bold mt-1 text-gray-800">
                    {inventoryData[key]?.length || 0}
                    <span className="text-sm font-normal text-gray-400 ml-1">种货品</span>
                  </p>
                </div>
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                  key === 'semiFinished' ? 'bg-primary/10 text-primary' :
                  key === 'finished' ? 'bg-success/10 text-success' :
                  'bg-warning/10 text-warning'
                }`}>
                  <FileSpreadsheet size={20} />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 数据表格 */}
      <div className="glass-card">
        <Tabs
          value={activeTab}
          onChange={(val) => setActiveTab(val as string)}
          list={Object.entries(tabNameMap).map(([key, name]) => ({
            value: key,
            label: `${name} (${inventoryData[key]?.length || 0})`,
          }))}
        />
        <Table
          data={filteredData}
          columns={columns}
          rowKey="_id"
          tableLayout="fixed"
          hover
          stripe
          empty={
            <div className="py-12 text-center">
              <FileSpreadsheet size={48} className="mx-auto text-gray-300 mb-3" />
              <p className="text-gray-400">
                {totalCount === 0 ? '请点击「导入 Excel」上传库存文件' : '当前表无匹配数据'}
              </p>
              {totalCount === 0 && (
                <p className="text-gray-300 text-sm mt-1">
                  支持读取工作表：半成品库存、成品库存、维修仓
                </p>
              )}
            </div>
          }
        />
        {filteredData.length > 0 && (
          <div className="flex justify-between items-center py-3 px-4 border-t border-gray-100">
            <span className="text-sm text-gray-500">
              共 {filteredData.length} 条记录
              {filters.keyword && ` (筛选自 ${inventoryData[activeTab]?.length || 0} 条)`}
            </span>
            <span className="text-sm text-gray-400">
              现有库存合计：{filteredData.reduce((sum, item) => sum + item.currentStock, 0)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
