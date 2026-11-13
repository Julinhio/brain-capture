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
export function useCapturePages(status: CaptureStatus | 'all', category: Category | 'all', q = '') {
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

/**
 * Set once a capture no longer exists because it became a calendar event: the screens showing
 * it keep the confirmation and drop everything that would act on the capture.
 */
export function useRemovedCapture(id: string): boolean {
  const query = useQuery({ queryKey: ['capture-removed', id], queryFn: () => false, enabled: false, staleTime: Infinity });
  return query.data === true;
}

/** Everything that may still list or count a capture that is gone. */
export function forgetCapture(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: ['captures'] });
  void queryClient.invalidateQueries({ queryKey: ['projects'] });
}

export function useDeleteCapture(onDeleted?: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteCapture(id),
    onSuccess: (_result, id) => {
      onDeleted?.();
      queryClient.removeQueries({ queryKey: ['capture', id] });
      queryClient.removeQueries({ queryKey: ['capture-event', id] });
      forgetCapture(queryClient);
    },
  });
}

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
