import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Category } from '../../shared/categories';
import type { Capture, CaptureStatus } from '../../shared/types';
import { api } from './api';

export function useCaptures(status: CaptureStatus | 'all' = 'open') {
  return useQuery({ queryKey: ['captures', status], queryFn: () => api.listCaptures(status) });
}

export type CapturePatch = { title?: string; text?: string; category?: Category; status?: CaptureStatus };

export function useUpdateCapture(onSaved?: (capture: Capture) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: CapturePatch }) => api.updateCapture(id, patch),
    onSuccess: (capture) => {
      onSaved?.(capture);
      void queryClient.invalidateQueries({ queryKey: ['captures'] });
    },
  });
}
