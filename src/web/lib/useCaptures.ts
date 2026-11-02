import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Category } from '../../shared/categories';
import type { Capture, CaptureStatus } from '../../shared/types';
import { api } from './api';

export function useRecentCaptures(limit = 5) {
  return useQuery({
    queryKey: ['captures', 'recent', limit],
    queryFn: () => api.listCaptures({ status: 'open', limit }).then((r) => r.captures),
  });
}

export function useOverview() {
  return useQuery({ queryKey: ['captures', 'overview'], queryFn: api.overview, refetchInterval: 60_000 });
}

/** History pages, newest first; filtering happens on the server so paging stays exact. */
export function useCapturePages(status: CaptureStatus, category: Category | 'all', q = '') {
  return useInfiniteQuery({
    queryKey: ['captures', 'pages', status, category, q],
    queryFn: ({ pageParam }) =>
      api.listCaptures({ status, category: category === 'all' ? undefined : category, q: q || undefined, limit: 50, before: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useCapture(id: string) {
  return useQuery({ queryKey: ['capture', id], queryFn: () => api.getCapture(id) });
}

export type CapturePatch = { title?: string; text?: string; category?: Category; status?: CaptureStatus };

export function useUpdateCapture(onSaved?: (capture: Capture) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: CapturePatch }) => api.updateCapture(id, patch),
    onSuccess: (capture) => {
      queryClient.setQueryData(['capture', capture.id], capture);
      onSaved?.(capture);
      void queryClient.invalidateQueries({ queryKey: ['captures'] });
    },
  });
}
