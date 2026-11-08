import { useNavigate } from 'react-router-dom';
export { DICT_CODES } from '../../src/data/dict';
export const usePermission = () => ({ can: () => true });
const dictionaries = { getItems: () => [{ label: '本地管理员', value: '本地管理员' }] };
export const useDictionaries = () => dictionaries;
export function useTabWorkspace() {
  const navigate = useNavigate();
  return { openTab: (path: string, options?: { state?: unknown }) => navigate(path, options) };
}
export async function callFunction<T = unknown>(name: string, payload?: Record<string, unknown>): Promise<T> {
  const response = await fetch('/__sf-local', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, data: payload?.data || {} }),
  });
  if (!response.ok) throw new Error('本地调试服务请求失败');
  return response.json();
}
