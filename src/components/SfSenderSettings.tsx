import { useEffect, useRef, useState } from 'react';
import { Button, Input, MessagePlugin, Select } from 'tdesign-react';
import { callFunction } from '../lib/cloudbase';

type Sender = { contact: string; tel: string; company: string; country: string; province: string; city: string; county: string; address: string };
type SenderMap = Record<string, Sender>;
type Result = { success: boolean; senderMap: SenderMap; revision: number; initialized: boolean; errMsg?: string };
const fields: { key: keyof Sender; label: string; required?: boolean }[] = [
  { key: 'contact', label: '寄件人姓名', required: true }, { key: 'tel', label: '寄件电话', required: true },
  { key: 'company', label: '公司名称' }, { key: 'country', label: '国家代码' },
  { key: 'province', label: '省份' }, { key: 'city', label: '城市' }, { key: 'county', label: '区县' },
  { key: 'address', label: '详细地址', required: true },
];
export function SfSenderSettings({ canEdit, onDirtyChange }: { canEdit: boolean; onDirtyChange: (dirty: boolean) => void }) {
  const [profile, setProfile] = useState('hongcheng');
  const [env, setEnv] = useState('production');
  const [senders, setSenders] = useState<SenderMap>({});
  const [saved, setSaved] = useState('');
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const dirty = loaded && JSON.stringify(senders) !== saved;
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => { onDirtyChange(false); request.current++; }, [onDirtyChange]);
  async function load() {
    const token = ++request.current;
    setLoading(true); setError(''); setLoaded(false);
    try {
      const result = await callFunction<Result>('manageSfConfig', { data: { action: 'getSenders', profile, env } });
      if (token !== request.current) return;
      if (!result.success) throw new Error(result.errMsg || '加载寄件人配置失败');
      if (!result.initialized) throw new Error('该配置尚未导入寄件人资料，请联系管理员初始化');
      setSenders(result.senderMap); setSaved(JSON.stringify(result.senderMap)); setRevision(result.revision); setLoaded(true);
    } catch (err) { if (token === request.current) setError(err instanceof Error ? err.message : String(err)); }
    finally { if (token === request.current) setLoading(false); }
  }
  useEffect(() => { void load(); return () => { request.current++; }; }, [profile, env]);
  async function save() {
    for (const [person, sender] of Object.entries(senders)) {
      if (!sender.contact.trim() || !sender.address.trim() || !/^\d{6,20}$/.test(sender.tel.trim())) {
        MessagePlugin.warning(`${person.toUpperCase()} 请填写寄件人姓名、6–20 位数字电话和详细地址`); return;
      }
    }
    setSaving(true); setError('');
    try {
      const result = await callFunction<Result>('manageSfConfig', { data: { action: 'setSenders', profile, env, senderMap: senders, expectedRevision: revision } });
      if (!result.success) throw new Error(result.errMsg || '保存失败');
      setSenders(result.senderMap); setSaved(JSON.stringify(result.senderMap)); setRevision(result.revision);
      MessagePlugin.success(`已保存${profile === 'hongcheng' ? '鸿城' : '汇川'} / ${env === 'production' ? '生产' : '沙箱'}寄件人配置`);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setSaving(false); }
  }
  function switchScope(set: (value: string) => void, value: string) {
    if (dirty && !window.confirm('当前寄件人修改尚未保存，确认放弃修改并切换？')) return;
    set(value);
  }
  return <section className="rounded-lg border border-gray-100 p-5 space-y-4">
    <div><h3 className="text-base font-medium text-gray-800">顺丰寄件人配置</h3><p className="text-sm text-gray-500 mt-1">按订单人员匹配寄件人。保存后新申请的运单使用新信息，已有运单保留原信息。</p></div>
    <div className="flex flex-wrap gap-3">
      <Select aria-label="寄件人所属配置" value={profile} style={{ width: 160 }} disabled={loading || saving} options={[{ label: '鸿城', value: 'hongcheng' }, { label: '汇川', value: 'huichuan' }]} onChange={value => switchScope(setProfile, String(value))} />
      <Select aria-label="寄件人所属环境" value={env} style={{ width: 180 }} disabled={loading || saving} options={[{ label: '生产环境', value: 'production' }, { label: '沙箱测试环境', value: 'sandbox' }]} onChange={value => switchScope(setEnv, String(value))} />
      <Button loading={loading} disabled={saving} onClick={() => { if (!dirty || window.confirm('重新加载会放弃尚未保存的修改，确认继续？')) void load(); }}>重新加载</Button>
    </div>
    <p className="text-xs text-gray-500">此处选择仅用于查看和编辑寄件人，不会切换系统下单账户或环境。姓名、电话、详细地址为必填。</p>
    {error && <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-600">{error}</div>}
    {loading && <p role="status" className="text-sm text-gray-500">正在加载寄件人配置…</p>}
    {loaded && !loading && <div className="space-y-3">
      {Object.entries(senders).map(([person, sender]) => <details key={person} className="rounded-lg border border-gray-200 p-3">
        <summary className="cursor-pointer text-sm font-medium text-gray-800">{person.toUpperCase()} · {sender.contact} · {sender.tel}<span className="ml-3 text-xs font-normal text-gray-400">展开查看或修改</span></summary>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
          {fields.map(field => <label key={field.key} className={`block text-xs text-gray-500 ${field.key === 'address' ? 'md:col-span-2' : ''}`}>{field.label}{field.required && ' *'}
            <Input aria-label={`${person.toUpperCase()} ${field.label}`} value={sender[field.key] || ''} readonly={!canEdit || saving} onChange={value => setSenders(prev => ({ ...prev, [person]: { ...prev[person], [field.key]: String(value) } }))} />
          </label>)}
        </div>
      </details>)}
      <div className="flex items-center gap-3 pt-2"><Button theme="primary" disabled={!canEdit || !dirty} loading={saving} onClick={() => void save()}>保存寄件人配置</Button><span className="text-xs text-gray-500">{!canEdit ? '当前账号仅可查看' : dirty ? '有尚未保存的修改' : '配置已保存'}</span></div>
    </div>}
  </section>;
}
