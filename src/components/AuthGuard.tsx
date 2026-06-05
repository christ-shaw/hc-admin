import { useState, useEffect, useRef } from 'react';
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Loading, MessagePlugin } from 'tdesign-react';
import { getSession, onAuthExpired, offAuthExpired } from '../lib/cloudbase';

export function AuthGuard() {
  const [checking, setChecking] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const expiredHandled = useRef(false);

  // 路由变化时检查登录状态
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const session = await getSession();
        if (!cancelled) {
          // 排除匿名会话
          const isValid = !!session && !session.user?.is_anonymous;
          setAuthenticated(isValid);
        }
      } catch {
        if (!cancelled) setAuthenticated(false);
      }
      if (!cancelled) setChecking(false);
    })();
    return () => { cancelled = true; };
  }, [location.pathname]);

  // 监听认证过期事件
  useEffect(() => {
    const handleAuthExpired = () => {
      if (expiredHandled.current) return;
      expiredHandled.current = true;
      setAuthenticated(false);
      MessagePlugin.warning('登录状态已失效，请重新登录');
      setTimeout(() => {
        navigate('/login', { replace: true, state: { from: location } });
        // 重置标志位，允许下次登录后再触发
        setTimeout(() => { expiredHandled.current = false; }, 2000);
      }, 1000);
    };

    onAuthExpired(handleAuthExpired);
    return () => { offAuthExpired(handleAuthExpired); };
  }, [location, navigate]);

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loading loading text="验证登录状态..." />
      </div>
    );
  }

  if (!authenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <Outlet />;
}
