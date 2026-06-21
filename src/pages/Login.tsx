import { useState, FormEvent } from 'react';
import { Input, Button, MessagePlugin } from 'tdesign-react';
import { Package } from 'lucide-react';
import { useNavigate, useLocation } from 'react-router-dom';
import { signIn, callFunction, getCurrentPermissionUserPayload } from '../lib/cloudbase';

/** 记录登录日志（成功/失败都记录） */
async function recordLogin(username: string, success: boolean, failReason?: string) {
  try {
    const currentUser = success ? await getCurrentPermissionUserPayload().catch(() => null) : null;
    await callFunction('manageLoginLogs', {
      data: {
        action: 'record',
        username,
        success,
        failReason,
        userAgent: navigator.userAgent || '',
        currentUser,
      },
    });
  } catch {
    // 记录日志失败不影响登录流程
  }
}

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
      void recordLogin(username, false, '用户名或密码错误');
      MessagePlugin.error('登录失败：用户名或密码错误');
      return;
    }
    void recordLogin(username, true);
    MessagePlugin.success('登录成功');
    const rawFrom = (location.state as any)?.from?.pathname || '/';
    // 避免跳回禁止访问页或登录页本身
    const from = ['/forbidden', '/login'].includes(rawFrom) ? '/' : rawFrom;
    navigate(from, { replace: true });
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-[linear-gradient(135deg,#0f172a_0%,#1d4ed8_48%,#14b8a6_100%)] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(255,255,255,0.24),transparent_28%),radial-gradient(circle_at_80%_10%,rgba(191,219,254,0.26),transparent_24%),radial-gradient(circle_at_50%_90%,rgba(20,184,166,0.2),transparent_30%)]" />
      <form onSubmit={handleLogin} className="relative z-10 w-full max-w-[400px] rounded-2xl border border-white/30 bg-white/95 p-8 shadow-2xl backdrop-blur">
        <div className="text-center mb-8">
          <div className="w-14 h-14 bg-primary rounded-xl flex items-center justify-center mx-auto mb-4">
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
