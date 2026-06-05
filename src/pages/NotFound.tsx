import { useNavigate } from 'react-router-dom';
import { Button } from 'tdesign-react';

export function NotFound() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-50">
      <div className="text-center px-6">
        {/* 装饰性图标 */}
        <div className="mb-8 flex justify-center">
          <div className="w-28 h-28 rounded-full bg-blue-100 flex items-center justify-center">
            <svg width="56" height="56" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14h2v2h-2v-2zm0-8h2v6h-2V8z" fill="#4F46E5" opacity="0.2"/>
              <path d="M12 4C7.58 4 4 7.58 4 12s3.58 8 8 8 8-3.58 8-8-3.58-8-8-8zm-1 13h2v2h-2v-2zm0-10h2v8h-2V7z" fill="#4F46E5"/>
            </svg>
          </div>
        </div>

        {/* 主标题 */}
        <h1 className="text-2xl font-semibold text-gray-800 mb-3">
          当前页面不存在
        </h1>

        {/* 副标题 */}
        <p className="text-gray-500 mb-8 max-w-sm mx-auto leading-relaxed">
          您访问的页面可能已被移除、名称已更改或暂时不可用
        </p>

        {/* 返回按钮 */}
        <Button
          theme="primary"
          size="large"
          onClick={() => navigate('/', { replace: true })}
          style={{ borderRadius: 8, paddingLeft: 32, paddingRight: 32 }}
        >
          返回主页
        </Button>
      </div>
    </div>
  );
}
