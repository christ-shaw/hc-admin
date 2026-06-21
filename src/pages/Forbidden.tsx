import { Button } from 'tdesign-react';
import { ShieldAlert, Home, RefreshCw } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { usePermission } from '../contexts/PermissionContext';

export function Forbidden() {
  const navigate = useNavigate();
  const { status, errorMessage, refreshPermissions } = usePermission();
  const title = status === 'error' ? '权限加载失败' : '访问被拒绝';
  const description = errorMessage || '您没有权限访问此页面，请联系管理员';

  return (
    <div className="min-h-[calc(100vh-7rem)] flex items-center justify-center">
      <div className="glass-card w-full max-w-md p-8 text-center">
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-red-50 text-red-500">
          <ShieldAlert size={34} />
        </div>
        <h1 className="text-2xl font-semibold text-gray-900">{title}</h1>
        <p className="mt-3 text-sm leading-6 text-gray-500">{description}</p>
        <div className="mt-7 flex justify-center gap-3">
          <Button
            variant="outline"
            icon={<RefreshCw size={16} />}
            onClick={refreshPermissions}
          >
            重新加载
          </Button>
          <Button
            theme="primary"
            icon={<Home size={16} />}
            onClick={() => navigate('/', { replace: true })}
          >
            返回首页
          </Button>
        </div>
      </div>
    </div>
  );
}
