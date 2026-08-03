import { useState, useEffect } from 'react';
import { Button, Input, MessagePlugin, Select, Switch, Tabs } from 'tdesign-react';
import { Settings, Save, RotateCcw, Cpu, ShieldCheck, Truck } from 'lucide-react';
import {
  callFunction,
  AI_MODEL_OPTIONS,
  getAIModelConfig,
  setAIModelConfig,
  getCurrentPermissionUserPayload,
  type AIModelConfig,
} from '../lib/cloudbase';
import { usePermission } from '../hooks/usePermission';
import { SF_EXPRESS_UI_ENABLED } from '../utils/constants';
import { RoleManageTab } from '../components/RoleManageTab';
import { UserRoleTab } from '../components/UserRoleTab';
import { LoginLogTab } from '../components/LoginLogTab';
import { DictionaryManageTab } from '../components/DictionaryManageTab';
import { SupplierManageTab } from '../components/SupplierManageTab';
import { AnnouncementManageTab } from '../components/AnnouncementManageTab';
import { useTabDirty } from '../contexts/TabWorkspaceContext';

interface InitializePermissionResult {
  success: boolean;
  errMsg?: string;
}

type SfEnv = 'sandbox' | 'production';

interface SfConfigResult {
  success: boolean;
  env?: SfEnv;
  source?: 'database' | 'env';
  updatedAt?: string;
  updatedBy?: string;
  pluginPrintEnabledByEnv?: Record<SfEnv, boolean>;
  errMsg?: string;
}

export function SettingsPage() {
  const { status: permissionStatus, canInitialize, can, refreshPermissions } = usePermission();
  const [counterValue, setCounterValue] = useState<number>(0);
  const [savedValue, setSavedValue] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sfEnv, setSfEnv] = useState<SfEnv>('sandbox');
  const [savedSfEnv, setSavedSfEnv] = useState<SfEnv>('sandbox');
  const [sfEnvSource, setSfEnvSource] = useState<'database' | 'env'>('env');
  const [sfConfigLoading, setSfConfigLoading] = useState(false);
  const [savingSfEnv, setSavingSfEnv] = useState(false);
  const [sfPluginEnabledByEnv, setSfPluginEnabledByEnv] = useState<Record<SfEnv, boolean>>({
    sandbox: false,
    production: false,
  });
  const [savingSfPluginEnv, setSavingSfPluginEnv] = useState<SfEnv | null>(null);
  const [initializingPermission, setInitializingPermission] = useState(false);
  const [aiModel, setAiModel] = useState<AIModelConfig>(getAIModelConfig);
  const [activeTab, setActiveTab] = useState('general');

  const AI_MODEL_SELECT_OPTIONS = [
    { label: '─ DeepSeek 系列 ─', value: '__header_ds__' },
    ...AI_MODEL_OPTIONS.filter(o => o.label.includes('DeepSeek')).map(o => ({
      label: o.label, value: `${o.group}|${o.model}`,
    })),
    { label: '─ 混元系列 ─', value: '__header_hy__' },
    ...AI_MODEL_OPTIONS.filter(o => o.label.includes('混元')).map(o => ({
      label: o.label, value: `${o.group}|${o.model}`,
    })),
    { label: '─ GLM 系列 ─', value: '__header_glm__' },
    ...AI_MODEL_OPTIONS.filter(o => o.label.includes('GLM')).map(o => ({
      label: o.label, value: `${o.group}|${o.model}`,
    })),
    { label: '─ Kimi 系列 ─', value: '__header_kimi__' },
    ...AI_MODEL_OPTIONS.filter(o => o.label.includes('Kimi')).map(o => ({
      label: o.label, value: `${o.group}|${o.model}`,
    })),
  ];

  const currentAiModelValue = `${aiModel.group}|${aiModel.model}`;
  const SF_ENV_OPTIONS = [
    { label: '沙箱测试环境', value: 'sandbox' },
    { label: '生产环境', value: 'production' },
  ];

  const handleAiModelChange = (val: unknown) => {
    const selectedValue = String(val);
    if (selectedValue.startsWith('__')) return; // 跳过分组标题
    const [group, model] = selectedValue.split('|');
    const match = AI_MODEL_OPTIONS.find(o => o.group === group && o.model === model);
    if (match) {
      setAiModel(match);
      setAIModelConfig(match);
      MessagePlugin.success(`AI 模型已切换为 ${match.label}`);
    }
  };

  const normalizeSfEnv = (value: unknown): SfEnv => String(value) === 'production' ? 'production' : 'sandbox';

  /** 加载计数器当前值 */
  const fetchCounter = async () => {
    setLoading(true);
    try {
      const result = await callFunction<{ success: boolean; value: number }>('manageCounter', {
        data: { action: 'get', counterName: 'orderSerialNumber' },
      });
      if (result.success) {
        setCounterValue(result.value);
        setSavedValue(result.value);
      }
    } catch (err) {
      MessagePlugin.error('获取计数器失败: ' + String(err));
    } finally {
      setLoading(false);
    }
  };

  /** 加载顺丰环境配置 */
  const fetchSfConfig = async () => {
    setSfConfigLoading(true);
    try {
      const result = await callFunction<SfConfigResult>('manageSfConfig', {
        data: { action: 'get' },
      });
      if (result.success && result.env) {
        const nextEnv = normalizeSfEnv(result.env);
        setSfEnv(nextEnv);
        setSavedSfEnv(nextEnv);
        setSfEnvSource(result.source || 'env');
        setSfPluginEnabledByEnv({
          sandbox: result.pluginPrintEnabledByEnv?.sandbox === true,
          production: result.pluginPrintEnabledByEnv?.production === true,
        });
      } else {
        MessagePlugin.error('获取顺丰环境失败: ' + (result.errMsg || '未知错误'));
      }
    } catch (err) {
      MessagePlugin.error('获取顺丰环境失败: ' + String(err));
    } finally {
      setSfConfigLoading(false);
    }
  };

  useEffect(() => {
    fetchCounter();
    if (SF_EXPRESS_UI_ENABLED) fetchSfConfig();
  }, []);

  /** 保存计数器值 */
  const handleSave = async () => {
    if (counterValue < 0) {
      MessagePlugin.warning('计数器值不能为负数');
      return;
    }
    if (!Number.isInteger(counterValue)) {
      MessagePlugin.warning('计数器值必须为整数');
      return;
    }
    setSaving(true);
    try {
      const result = await callFunction<{ success: boolean; value: number; errMsg?: string }>('manageCounter', {
        data: { action: 'set', counterName: 'orderSerialNumber', value: counterValue },
      });
      if (result.success) {
        setSavedValue(counterValue);
        MessagePlugin.success(`计数器已更新为 ${counterValue}，下一个订单序号将为 ${counterValue + 1}`);
      } else {
        MessagePlugin.error('保存失败: ' + (result.errMsg || '未知错误'));
      }
    } catch (err) {
      MessagePlugin.error('保存失败: ' + String(err));
    } finally {
      setSaving(false);
    }
  };

  /** 保存顺丰环境 */
  const handleSaveSfEnv = async () => {
    setSavingSfEnv(true);
    try {
      const result = await callFunction<SfConfigResult>('manageSfConfig', {
        data: { action: 'set', env: sfEnv },
      });
      if (result.success && result.env) {
        const nextEnv = normalizeSfEnv(result.env);
        setSfEnv(nextEnv);
        setSavedSfEnv(nextEnv);
        setSfEnvSource(result.source || 'database');
        MessagePlugin.success(`顺丰下单环境已切换为${nextEnv === 'production' ? '生产环境' : '沙箱测试环境'}`);
      } else {
        MessagePlugin.error('保存失败: ' + (result.errMsg || '未知错误'));
      }
    } catch (err) {
      MessagePlugin.error('保存失败: ' + String(err));
    } finally {
      setSavingSfEnv(false);
    }
  };

  /** 按环境启停 Windows 顺丰云打印插件 */
  const handleSfPluginPrintChange = async (env: SfEnv, enabled: boolean) => {
    if (env === 'production' && enabled && !window.confirm('确认开启生产环境顺丰插件打印？开启后会打印真实运单面单。')) {
      return;
    }

    setSavingSfPluginEnv(env);
    try {
      const result = await callFunction<SfConfigResult>('manageSfConfig', {
        data: { action: 'setPluginPrint', env, enabled },
      });
      if (!result.success || !result.pluginPrintEnabledByEnv) {
        MessagePlugin.error('保存失败: ' + (result.errMsg || '未知错误'));
        return;
      }
      setSfPluginEnabledByEnv({
        sandbox: result.pluginPrintEnabledByEnv.sandbox === true,
        production: result.pluginPrintEnabledByEnv.production === true,
      });
      MessagePlugin.success(`${env === 'production' ? '生产环境' : '沙箱环境'}插件打印已${enabled ? '开启' : '关闭'}`);
    } catch (err) {
      MessagePlugin.error('保存失败: ' + String(err));
    } finally {
      setSavingSfPluginEnv(null);
    }
  };

  const hasChanged = counterValue !== savedValue;
  const sfEnvChanged = sfEnv !== savedSfEnv;
  useTabDirty(hasChanged || sfEnvChanged, '系统设置');
  const showPermissionBootstrap = permissionStatus === 'uninitialized' && canInitialize;
  const canUpdateSettings = can('settings:update');
  const canManageRoles = can('settings:role_manage');
  const canManageUserRoles = can('settings:user_role_manage');
  const canViewLoginLogs = can('settings:read');
  const canManageDictionaries = can('settings:dict_manage') || can('settings:update');
  const canManageSuppliers = can('settings:supplier_manage') || can('settings:update');
  const canViewSuppliers = can('settings:read') || canManageSuppliers;
  const canManageAnnouncements = can('announcements:manage') || can('settings:update');
  const tabList = [
    { value: 'general', label: '全部设置' },
    ...(canManageAnnouncements ? [{ value: 'announcements', label: '新功能通知' }] : []),
    ...(canViewSuppliers ? [{ value: 'suppliers', label: '供应商配置' }] : []),
    ...(canViewLoginLogs ? [{ value: 'dictionaries', label: '数据字典' }] : []),
    ...(canManageRoles ? [{ value: 'roles', label: '角色管理' }] : []),
    ...(canManageUserRoles ? [{ value: 'users', label: '用户角色' }] : []),
    ...(canViewLoginLogs ? [{ value: 'loginLogs', label: '登录日志' }] : []),
  ];

  const handleInitializePermission = async () => {
    setInitializingPermission(true);
    try {
      const currentUser = await getCurrentPermissionUserPayload().catch(() => null);
      const result = await callFunction<InitializePermissionResult>('initializePermissionSystem', { currentUser });
      if (!result.success) {
        MessagePlugin.error(result.errMsg || '初始化权限系统失败');
        return;
      }
      MessagePlugin.success('权限系统初始化成功');
      await refreshPermissions();
    } catch (err) {
      MessagePlugin.error('初始化权限系统失败: ' + String(err));
    } finally {
      setInitializingPermission(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-800">系统设置</h1>
        <p className="text-gray-500 mt-1">管理系统的全局配置</p>
      </div>

      {showPermissionBootstrap && (
        <div className="glass-card p-6 border border-blue-100 bg-blue-50/60">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center flex-shrink-0">
                <ShieldCheck size={21} className="text-blue-600" />
              </div>
              <div>
                <h3 className="text-base font-medium text-gray-800">初始化权限系统</h3>
                <p className="text-sm text-gray-500 mt-1">
                  当前系统尚未启用权限管理。初始化后会创建管理员角色，并将 CloudBase 内置账号 administrator 设为管理员。
                </p>
              </div>
            </div>
            <Button
              theme="primary"
              loading={initializingPermission}
              icon={<ShieldCheck size={16} />}
              onClick={handleInitializePermission}
            >
              初始化权限
            </Button>
          </div>
        </div>
      )}

      <div className="glass-card overflow-hidden">
        <Tabs value={activeTab} onChange={val => setActiveTab(val as string)} list={tabList} />
        <div className="p-6">
          {activeTab === 'general' && (
            <div className="space-y-6">
              {/* AI 模型设置 */}
              <div className="rounded-lg border border-gray-100 p-5">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 bg-purple-100 rounded-lg flex items-center justify-center">
                    <Cpu size={20} className="text-purple-600" />
                  </div>
                  <div>
                    <h3 className="text-base font-medium text-gray-800">AI 模型设置</h3>
                    <p className="text-sm text-gray-500">切换智能识别（收件人/开票信息解析）使用的 AI 模型</p>
                  </div>
                </div>

                <div className="bg-gray-50 rounded-lg p-4 space-y-4">
                  <div className="flex items-center gap-4">
                    <div className="flex-1 max-w-xs">
                      <label className="block text-sm text-gray-600 mb-1">当前 AI 模型</label>
                      <Select
                        value={currentAiModelValue}
                        onChange={handleAiModelChange}
                        options={AI_MODEL_SELECT_OPTIONS}
                      />
                    </div>
                  </div>

                  <div className="flex items-center gap-6 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="text-gray-500">模型组:</span>
                      <span className="font-mono font-medium text-gray-800">{aiModel.group}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-gray-500">模型 ID:</span>
                      <span className="font-mono font-medium text-blue-600">{aiModel.model}</span>
                    </div>
                  </div>

                  <div className="text-xs text-gray-400 space-y-1">
                    <p>• 切换模型后立即生效，无需刷新页面</p>
                    <p>• 如遇 429 限流错误，可尝试切换到其他模型</p>
                    <p>• CloudBase 托管模型需要在控制台先启用，自定义模型组需要配置 API Key</p>
                  </div>
                </div>
              </div>

              {/* 顺丰下单环境（SF_EXPRESS_UI_ENABLED 控制显隐） */}
              {SF_EXPRESS_UI_ENABLED && (
              <div className="rounded-lg border border-gray-100 p-5">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 bg-emerald-100 rounded-lg flex items-center justify-center">
                    <Truck size={20} className="text-emerald-600" />
                  </div>
                  <div>
                    <h3 className="text-base font-medium text-gray-800">顺丰下单环境</h3>
                    <p className="text-sm text-gray-500">控制申请快递、查询下单结果、取消发货使用的顺丰接口环境</p>
                  </div>
                </div>

                <div className="bg-gray-50 rounded-lg p-4 space-y-4">
                  <div className="flex flex-col gap-4 md:flex-row md:items-end">
                    <div className="flex-1 max-w-xs">
                      <label className="block text-sm text-gray-600 mb-1">当前顺丰环境</label>
                      <Select
                        value={sfEnv}
                        loading={sfConfigLoading}
                        onChange={val => setSfEnv(normalizeSfEnv(val))}
                        options={SF_ENV_OPTIONS}
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button
                        theme="primary"
                        icon={<Save size={16} />}
                        loading={savingSfEnv}
                        disabled={!canUpdateSettings || !sfEnvChanged}
                        onClick={handleSaveSfEnv}
                      >
                        保存
                      </Button>
                      <Button
                        variant="outline"
                        icon={<RotateCcw size={16} />}
                        disabled={!sfEnvChanged}
                        onClick={() => setSfEnv(savedSfEnv)}
                      >
                        还原
                      </Button>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-6 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="text-gray-500">生效环境:</span>
                      <span className={savedSfEnv === 'production' ? 'font-medium text-rose-600' : 'font-medium text-emerald-600'}>
                        {savedSfEnv === 'production' ? '生产环境' : '沙箱测试环境'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-gray-500">配置来源:</span>
                      <span className="font-medium text-gray-800">{sfEnvSource === 'database' ? '系统配置' : '环境变量回退'}</span>
                    </div>
                  </div>

                  <div className="grid gap-3 md:grid-cols-2">
                    {(['sandbox', 'production'] as SfEnv[]).map(env => (
                      <div key={env} className="flex items-center justify-between rounded-lg border border-gray-200 bg-white px-4 py-3">
                        <div>
                          <div className="text-sm font-medium text-gray-800">
                            {env === 'production' ? '生产环境插件打印' : '沙箱环境插件打印'}
                          </div>
                          <div className="mt-1 text-xs text-gray-400">
                            仅影响 Windows 顺丰云打印插件，PDF 打印不受影响
                          </div>
                        </div>
                        <Switch
                          value={sfPluginEnabledByEnv[env]}
                          loading={savingSfPluginEnv === env}
                          disabled={!canUpdateSettings || sfConfigLoading}
                          onChange={value => handleSfPluginPrintChange(env, value)}
                        />
                      </div>
                    ))}
                  </div>

                  <div className="text-xs text-gray-400 space-y-1">
                    <p>• 保存后云函数每次调用都会读取最新环境，无需重新部署</p>
                    <p>• 切换到生产环境前，请确认生产客户编码、校验码、月结卡号和寄件人配置已在云函数环境变量中配置完成</p>
                    <p>• 生产环境会调用顺丰正式接口并生成真实运单</p>
                    <p>• 插件打印开关按沙箱、生产环境分别保存；切换环境后如已加载插件 SDK，请刷新页面</p>
                  </div>
                </div>
              </div>
              )}

              {/* 订单序号计数器 */}
              <div className="rounded-lg border border-gray-100 p-5">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                    <Settings size={20} className="text-blue-600" />
                  </div>
                  <div>
                    <h3 className="text-base font-medium text-gray-800">订单序号计数器</h3>
                    <p className="text-sm text-gray-500">控制新建订单的序号自增值，下一个订单将使用 当前值+1 作为序号</p>
                  </div>
                </div>

                <div className="bg-gray-50 rounded-lg p-4 space-y-4">
                  <div className="flex items-center gap-4">
                    <div className="flex-1 max-w-xs">
                      <label className="block text-sm text-gray-600 mb-1">当前计数器值</label>
                      <Input
                        type="number"
                        value={String(counterValue)}
                        onChange={val => setCounterValue(Number(val))}
                        placeholder="请输入计数值"
                      />
                    </div>
                    <div className="pt-5 flex gap-2">
                      <Button
                        theme="primary"
                        icon={<Save size={16} />}
                        loading={saving}
                        disabled={!hasChanged}
                        onClick={handleSave}
                      >
                        保存
                      </Button>
                      <Button
                        variant="outline"
                        icon={<RotateCcw size={16} />}
                        disabled={!hasChanged}
                        onClick={() => setCounterValue(savedValue)}
                      >
                        还原
                      </Button>
                    </div>
                  </div>

                  <div className="flex items-center gap-6 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="text-gray-500">当前值:</span>
                      <span className="font-mono font-medium text-gray-800">{savedValue}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-gray-500">下一个订单序号:</span>
                      <span className="font-mono font-medium text-blue-600">{savedValue + 1}</span>
                    </div>
                  </div>

                  <div className="text-xs text-gray-400 space-y-1">
                    <p>• 修改计数器值后，下次新建订单将使用 <span className="font-mono text-gray-600">新值+1</span> 作为序号</p>
                    <p>• 如果序号出现冲突（如手动导入已有序号的数据），可在此调整计数器到最大序号值</p>
                    <p>• 建议将计数器值设置为历史订单中的最大序号，避免序号重复</p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'roles' && canManageRoles && (
            <RoleManageTab onChanged={refreshPermissions} />
          )}

          {activeTab === 'announcements' && canManageAnnouncements && (
            <AnnouncementManageTab />
          )}

          {activeTab === 'dictionaries' && canViewLoginLogs && (
            <DictionaryManageTab canManage={canManageDictionaries} />
          )}

          {activeTab === 'suppliers' && canViewSuppliers && (
            <SupplierManageTab canManage={canManageSuppliers} />
          )}

          {activeTab === 'users' && canManageUserRoles && (
            <UserRoleTab onChanged={refreshPermissions} />
          )}

          {activeTab === 'loginLogs' && canViewLoginLogs && (
            <LoginLogTab />
          )}
        </div>
      </div>
    </div>
  );
}
