import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { callFunction } from '../lib/cloudbase';
import {
  DEFAULT_DICTIONARY_GROUPS,
  DICT_CODES,
  type DictGroupCode,
  type DictionarySeedGroup,
  type DictionarySeedItem,
} from '../data/dict';

export interface DictionaryItem {
  _id?: string;
  groupCode: string;
  value: string;
  label: string;
  enabled: boolean;
  sort: number;
  systemItem?: boolean;
}

export interface DictionaryGroup {
  _id?: string;
  code: string;
  name: string;
  category?: string;
  editable?: boolean;
  enabled: boolean;
  sort: number;
}

interface GetDictionariesResult {
  success?: boolean;
  groups?: DictionaryGroup[];
  data?: Record<string, DictionaryItem[]>;
  errMsg?: string;
}

interface DictionaryContextType {
  groups: DictionaryGroup[];
  itemsByGroup: Record<string, DictionaryItem[]>;
  loading: boolean;
  initialized: boolean;
  errorMessage: string;
  refreshDictionaries: () => Promise<void>;
  getItems: (groupCode: string, includeDisabled?: boolean) => DictionaryItem[];
  getMap: (groupCode: string) => Record<string, string>;
  getLabel: (groupCode: string, value?: string) => string;
  getOptions: (groupCode: string, placeholder?: { label: string; value: string }) => Array<{ label: string; value: string }>;
}

const DictionaryContext = createContext<DictionaryContextType | null>(null);

const SEED_GROUP_CODES = DEFAULT_DICTIONARY_GROUPS.map(group => group.code);

function seedGroupToRuntime(group: DictionarySeedGroup): DictionaryGroup {
  return {
    _id: group.code,
    code: group.code,
    name: group.name,
    category: group.category,
    editable: group.editable,
    enabled: true,
    sort: group.sort,
  };
}

function seedItemToRuntime(groupCode: string, item: DictionarySeedItem): DictionaryItem {
  return {
    groupCode,
    value: item.value,
    label: item.label,
    enabled: item.enabled !== false,
    sort: item.sort || 0,
    systemItem: item.systemItem !== false,
  };
}

function buildSeedGroups() {
  return DEFAULT_DICTIONARY_GROUPS.map(seedGroupToRuntime);
}

function buildSeedItems() {
  return Object.fromEntries(
    DEFAULT_DICTIONARY_GROUPS.map(group => [
      group.code,
      group.items.map(item => seedItemToRuntime(group.code, item)),
    ])
  ) as Record<string, DictionaryItem[]>;
}

function sortGroups(groups: DictionaryGroup[]) {
  return [...groups]
    .filter(group => group.enabled !== false)
    .sort((a, b) => (a.sort || 0) - (b.sort || 0) || String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
}

function sortItems(items: DictionaryItem[]) {
  return [...items].sort((a, b) => (a.sort || 0) - (b.sort || 0) || String(a.label).localeCompare(String(b.label), 'zh-Hans-CN'));
}

function normalizeRemoteItems(data?: Record<string, DictionaryItem[]>) {
  const result: Record<string, DictionaryItem[]> = {};
  Object.entries(data || {}).forEach(([groupCode, items]) => {
    result[groupCode] = sortItems((items || []).map(item => ({
      ...item,
      groupCode,
      value: String(item.value || ''),
      label: String(item.label || item.value || ''),
      enabled: item.enabled !== false,
      sort: Number(item.sort || 0),
    })));
  });
  return result;
}

export function DictionaryProvider({ children }: { children: React.ReactNode }) {
  const [groups, setGroups] = useState<DictionaryGroup[]>(buildSeedGroups);
  const [itemsByGroup, setItemsByGroup] = useState<Record<string, DictionaryItem[]>>(buildSeedItems);
  const [loading, setLoading] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const refreshDictionaries = useCallback(async () => {
    setLoading(true);
    try {
      const result = await callFunction<GetDictionariesResult>('getDictionaries', {
        data: { groupCodes: SEED_GROUP_CODES },
      });

      if (!result.success) {
        setInitialized(false);
        setErrorMessage(result.errMsg || '数据字典加载失败，已使用本地默认值');
        return;
      }

      const seedGroups = buildSeedGroups();
      const seedItems = buildSeedItems();
      const remoteGroups = Array.isArray(result.groups) ? result.groups : [];
      const remoteItems = normalizeRemoteItems(result.data);
      const remoteCodes = new Set(remoteGroups.map(group => group.code));

      setGroups(sortGroups(
        seedGroups.map(seedGroup => remoteGroups.find(group => group.code === seedGroup.code) || seedGroup)
      ));

      setItemsByGroup(Object.fromEntries(
        seedGroups.map(group => {
          const code = group.code;
          return [code, remoteCodes.has(code) ? sortItems(remoteItems[code] || []) : seedItems[code]];
        })
      ));

      setInitialized(remoteGroups.length > 0);
      setErrorMessage('');
    } catch (error) {
      setInitialized(false);
      setErrorMessage(error instanceof Error ? error.message : '数据字典加载失败，已使用本地默认值');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshDictionaries();
  }, [refreshDictionaries]);

  const getItems = useCallback((groupCode: string, includeDisabled = false) => {
    const items = itemsByGroup[groupCode] || [];
    return includeDisabled ? sortItems(items) : sortItems(items.filter(item => item.enabled !== false));
  }, [itemsByGroup]);

  const getMap = useCallback((groupCode: string) => {
    return Object.fromEntries(getItems(groupCode).map(item => [item.value, item.label]));
  }, [getItems]);

  const getLabel = useCallback((groupCode: string, value?: string) => {
    if (!value) return '';
    return getMap(groupCode)[value] || value;
  }, [getMap]);

  const getOptions = useCallback((groupCode: string, placeholder?: { label: string; value: string }) => {
    const options = getItems(groupCode).map(item => ({ label: item.label, value: item.value }));
    return placeholder ? [placeholder, ...options] : options;
  }, [getItems]);

  const value = useMemo<DictionaryContextType>(() => ({
    groups,
    itemsByGroup,
    loading,
    initialized,
    errorMessage,
    refreshDictionaries,
    getItems,
    getMap,
    getLabel,
    getOptions,
  }), [
    groups,
    itemsByGroup,
    loading,
    initialized,
    errorMessage,
    refreshDictionaries,
    getItems,
    getMap,
    getLabel,
    getOptions,
  ]);

  return (
    <DictionaryContext.Provider value={value}>
      {children}
    </DictionaryContext.Provider>
  );
}

export function useDictionaries() {
  const context = useContext(DictionaryContext);
  if (!context) {
    throw new Error('useDictionaries must be used within DictionaryProvider');
  }
  return context;
}

export { DICT_CODES };
