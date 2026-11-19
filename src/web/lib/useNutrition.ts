import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { localDay, shiftDay, type NutritionData, type NutritionEntry } from '../../shared/nutrition';
import type { Capture } from '../../shared/types';
import { api, deviceTimeZone } from './api';

export const deviceZone = deviceTimeZone() ?? 'Europe/Paris';

/** The local day on this device, right now. */
export function todayHere(): string {
  return localDay(new Date(), deviceZone);
}

export function useNutritionDay(day: string) {
  return useQuery({ queryKey: ['nutrition', 'day', day], queryFn: () => api.nutritionDay(day, deviceZone) });
}

/** The last `days` days, today included. */
export function useNutritionHistory(days: number) {
  const to = todayHere();
  const from = shiftDay(to, -(days - 1));
  return useQuery({ queryKey: ['nutrition', 'history', from, to], queryFn: () => api.nutritionHistory(from, to) });
}

/** Everything showing Nutrition data: the day, the lists waiting for a tap, the charts. */
export function refreshNutrition(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['nutrition'] });
}

export interface EntryPatch {
  status?: 'confirmed';
  title?: string;
  day?: string;
  data?: NutritionData;
}

export function useUpdateEntry(onSaved?: (entry: NutritionEntry) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: EntryPatch }) => api.updateEntry(id, patch),
    onSuccess: (entry) => {
      onSaved?.(entry);
      refreshNutrition(queryClient);
    },
  });
}

export function useDeleteEntry(onDeleted?: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteEntry(id),
    onSuccess: () => {
      onDeleted?.();
      refreshNutrition(queryClient);
    },
  });
}

/** "It's a note": the entry becomes a capture, which then shows wherever notes do. */
export function useEntryToNote(onMoved?: (capture: Capture) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.entryToNote(id),
    onSuccess: (capture) => {
      queryClient.setQueryData(['capture', capture.id], capture);
      onMoved?.(capture);
      refreshNutrition(queryClient);
      void queryClient.invalidateQueries({ queryKey: ['captures'] });
    },
  });
}

/** The other way: a note logged in Nutrition. It leaves every list of notes. */
export function useCaptureToNutrition(onMoved?: (entry: NutritionEntry) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.captureToNutrition(id),
    onSuccess: (entry) => {
      queryClient.removeQueries({ queryKey: ['capture', entry.id] });
      queryClient.removeQueries({ queryKey: ['capture-event', entry.id] });
      onMoved?.(entry);
      refreshNutrition(queryClient);
      void queryClient.invalidateQueries({ queryKey: ['captures'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}
