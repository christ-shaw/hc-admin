import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from 'tdesign-react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

const WORKSPACE_STORAGE_PREFIX = 'hc_admin_workspace_tabs_v1:';

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('应用框架渲染失败', error, info);
  }

  private resetWorkspace = () => {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(WORKSPACE_STORAGE_PREFIX)) localStorage.removeItem(key);
    }
    window.location.hash = '#/';
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-6">
        <div className="w-full max-w-lg rounded-2xl border border-gray-100 bg-white p-8 text-center shadow-lg">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-red-50 text-red-500">
            <AlertTriangle size={24} />
          </div>
          <h1 className="mt-4 text-xl font-semibold text-gray-800">页面加载失败</h1>
          <p className="mt-2 text-sm leading-6 text-gray-500">系统遇到临时异常，请先重新加载；若仍无法恢复，可重置已保存的标签页。</p>
          <div className="mt-6 flex justify-center gap-3">
            <Button theme="primary" icon={<RotateCcw size={16} />} onClick={() => window.location.reload()}>重新加载</Button>
            <Button variant="outline" onClick={this.resetWorkspace}>重置标签工作区</Button>
          </div>
        </div>
      </div>
    );
  }
}
