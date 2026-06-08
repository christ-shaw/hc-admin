import { useState, FormEvent } from 'react';
import { Input, Button, MessagePlugin } from 'tdesign-react';
import { Package } from 'lucide-react';
import { useNavigate, useLocation } from 'react-router-dom';
import { signIn } from '../lib/cloudbase';

export function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!username) { MessagePlugin.warning('请输入用户名'); return; }
    if (!password) { MessagePlugin.warning('请输入密码'); return; }

    setLoading(true);
    const { error } = await signIn(username, password);
    setLoading(false);

    if (error) {
      MessagePlugin.error('登录失败：用户名或密码错误');
      return;
    }
    MessagePlugin.success('登录成功');
    const from = (location.state as any)?.from?.pathname || '/';
    navigate(from, { replace: true });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-slate-800 to-gray-900 flex items-center justify-center p-4">
      <form onSubmit={handleLogin} className="w-full max-w-[400px] bg-white rounded-2xl shadow-2xl p-8">
        <div className="text-center mb-8">
          <div className="w-14 h-14 bg-gradient-to-br from-primary to-primary-light rounded-xl flex items-center justify-center mx-auto mb-4">
            <Package size={28} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-800">租赁综合管理系统</h1>
          <p className="text-gray-400 text-sm mt-2">请使用账号密码登录</p>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1.5">用户名</label>
            <Input
              value={username}
              onChange={(val) => setUsername(val as string)}
              placeholder="请输入用户名"
              size="large"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1.5">密码</label>
            <Input
              type="password"
              value={password}
              onChange={(val) => setPassword(val as string)}
              placeholder="请输入密码"
              size="large"
            />
          </div>
          <Button
            theme="primary"
            block
            size="large"
            loading={loading}
            onClick={() => handleLogin()}
            className="!rounded-xl !h-12 !text-base !font-medium"
          >
            登 录
          </Button>
        </div>
      </form>
    </div>
  );
}
