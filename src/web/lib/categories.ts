import { useQuery } from '@tanstack/react-query';
import type { CSSProperties } from 'react';
import { DEFAULT_CATEGORIES, OTHER, type Category, type CategoryInfo } from '../../shared/categories';
import { api } from './api';

/**
 * The owner's categories. Until the list has loaded (first launch offline), the starting list
 * stands in, so a capture screen never waits on it.
 */
export function useCategories() {
  const query = useQuery({ queryKey: ['categories'], queryFn: api.categories, staleTime: 5 * 60_000 });
  const list: readonly CategoryInfo[] = query.data ?? DEFAULT_CATEGORIES;
  const info = (id: Category): CategoryInfo => list.find((c) => c.id === id) ?? fallbackInfo(id);
  return { list, info, query };
}

function fallbackInfo(id: Category): CategoryInfo {
  if (id === OTHER) return DEFAULT_CATEGORIES.find((c) => c.id === OTHER)!;
  // A category deleted on another device, before this one refreshed its list.
  return { id, name: id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, ' '), description: '', color: null, position: 999 };
}

/**
 * The attributes that colour an element after its category: the original categories use their
 * theme colour through `data-cat`, newer ones carry their own.
 */
export function catProps(info: Pick<CategoryInfo, 'id' | 'color'>): { 'data-cat': string; style?: CSSProperties } {
  return info.color
    ? { 'data-cat': info.id, style: { '--cat-color': info.color } as CSSProperties }
    : { 'data-cat': info.id };
}
