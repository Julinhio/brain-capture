import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, CalendarCheck, CalendarPlus, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import {
  DATE_TIME_RE,
  defaultEnd,
  draftProblem,
  isValidTimeZone,
  wallClock,
  zonedToUtc,
  type CaptureEvent,
  type CaptureEventResponse,
  type EventDraft,
} from '../../shared/event';
import { api, deviceTimeZone, RequestError } from '../lib/api';
import { useSearchParam } from '../lib/router';

const deviceZone = deviceTimeZone() ?? 'Europe/Paris';

function dayLabel(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('fr-FR', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}
const city = (zone: string) => zone.split('/').pop()!.replace(/_/g, ' ');

/** "mar. 17 nov. · 15:00 → 16:00": the weekday is spelled out so a wrong day stands out. */
export function describeWhen(d: EventDraft): string {
  if (!d.start || !d.end) return 'Date à préciser';
  if (d.allDay) return d.start === d.end ? `${dayLabel(d.start)} · toute la journée` : `${dayLabel(d.start)} → ${dayLabel(d.end)}`;
  const [sd, st] = d.start.split('T') as [string, string];
  const [ed, et] = d.end.split('T') as [string, string];
  const end = ed === sd ? et : `${dayLabel(ed)} ${et}`;
  // Flights: each end in its own city. Otherwise the zone shows only when it is not the phone's.
  if (d.startTimeZone !== d.endTimeZone) return `${dayLabel(sd)} · ${st} (${city(d.startTimeZone)}) → ${end} (${city(d.endTimeZone)})`;
  return `${dayLabel(sd)} · ${st} → ${end}${d.startTimeZone === deviceZone ? '' : ` (${city(d.startTimeZone)})`}`;
}

// Zones are typed by hand: a half-typed one ("Europe/Pari") must leave the form usable,
// with the validation message, rather than throw inside a state update.
const zonesOk = (d: EventDraft) => isValidTimeZone(d.startTimeZone) && isValidTimeZone(d.endTimeZone);
const timed = (value: string | null): value is string => Boolean(value && DATE_TIME_RE.test(value));
const endAfter = (start: string, zone: string) => (isValidTimeZone(zone) ? defaultEnd(start, zone) : null);

/** New start from the form. Moving the start keeps the duration when both ends share a zone. */
export function withStart(d: EventDraft, start: string): EventDraft {
  if (!start) return { ...d, start: null };
  if (d.allDay) return { ...d, start, end: !d.end || d.end < start ? start : d.end };
  if (!timed(start)) return { ...d, start };
  if (timed(d.start) && timed(d.end) && d.startTimeZone === d.endTimeZone && zonesOk(d)) {
    const duration = zonedToUtc(d.end, d.endTimeZone).getTime() - zonedToUtc(d.start, d.startTimeZone).getTime();
    if (duration > 0)
      return { ...d, start, end: wallClock(new Date(zonedToUtc(start, d.startTimeZone).getTime() + duration), d.endTimeZone) };
  }
  return { ...d, start, end: d.end ?? endAfter(start, d.startTimeZone) };
}

export function withAllDay(d: EventDraft, allDay: boolean): EventDraft {
  if (allDay) {
    const start = d.start?.slice(0, 10) ?? null;
    return { ...d, allDay, start, end: start ? (d.end?.slice(0, 10) ?? start) : null, endTimeZone: d.startTimeZone };
  }
  const start = d.start ? `${d.start.slice(0, 10)}T09:00` : null;
  return { ...d, allDay, start, end: start ? endAfter(start, d.startTimeZone) : null, endTimeZone: d.startTimeZone };
}

/** Path the Google consent screen returns to: this capture, on any screen. */
function returnPath(captureId: string): string {
  const params = new URLSearchParams(window.location.search);
  if (params.get('id') === captureId) {
    params.delete('calendar');
    return `${window.location.pathname}?${params}`;
  }
  return `/history?id=${captureId}`;
}

const TIME_ZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
})();

/**
 * Shown on a capture that asked for something to be put in the calendar. Nothing reaches
 * Google until the button is pressed; the button is locked while the request runs, and the
 * server creates at most one event per capture whatever happens to that request.
 */
export function EventCard({ captureId }: { captureId: string }) {
  const queryKey = ['capture-event', captureId];
  const query = useQuery({ queryKey, queryFn: () => api.captureEvent(captureId), staleTime: 30_000 });
  const data = query.data;
  if (!data?.event) return null;
  return <EventCardBody key={JSON.stringify(data.event.draft)} captureId={captureId} data={data} event={data.event} />;
}

function EventCardBody({ captureId, data, event }: { captureId: string; data: CaptureEventResponse; event: CaptureEvent }) {
  const qc = useQueryClient();
  const queryKey = ['capture-event', captureId];
  const [draft, setDraft] = useState<EventDraft>(event.draft);
  const [editingZones, setEditingZones] = useState(false);
  const calendarResult = useSearchParam('calendar');
  const update = (next: CaptureEventResponse) => qc.setQueryData(queryKey, next);

  const confirm = useMutation({ mutationFn: () => api.confirmEvent(captureId, draft), onSuccess: update });
  const setState = useMutation({ mutationFn: (s: 'proposed' | 'dismissed') => api.setEventState(captureId, s), onSuccess: update });
  const reread = useMutation({ mutationFn: () => api.rereadEvent(captureId), onSuccess: update });
  const reconnect = useMutation({
    // The edits made so far must survive the trip through Google's consent screen.
    mutationFn: async () => {
      await api.saveEventDraft(captureId, draft);
      return api.connectCalendar(returnPath(captureId));
    },
    onSuccess: ({ url }) => window.location.assign(url),
  });

  if (event.state === 'created') {
    const d = event.draft;
    return (
      <section className="event-card" data-state="created" aria-labelledby="event-card-title">
        <p id="event-card-title" className="event-card-head" role="status">
          <CalendarCheck size={18} aria-hidden="true" /> Dans ton agenda
        </p>
        <p className="event-summary">
          <strong>{d.title}</strong>
          <span>{describeWhen(d)}</span>
          {d.location && <span>{d.location}</span>}
        </p>
        {event.eventUrl && (
          <a className="btn btn-sm" href={event.eventUrl} target="_blank" rel="noopener noreferrer">
            Ouvrir dans Google Agenda <ArrowUpRight size={16} aria-hidden="true" />
            <span className="sr-only">(nouvel onglet)</span>
          </a>
        )}
      </section>
    );
  }

  if (event.state === 'dismissed') {
    return (
      <p className="hint event-dismissed">
        Proposition d’agenda ignorée.{' '}
        <button type="button" className="link-btn" disabled={setState.isPending} onClick={() => setState.mutate('proposed')}>
          Afficher
        </button>
      </p>
    );
  }

  const problem = draftProblem(draft);
  const error = (confirm.error ?? setState.error ?? reread.error ?? reconnect.error) as RequestError | Error | null;
  const errorCode = error instanceof RequestError ? error.code : null;
  const needsReconnect =
    data.access === 'reconnect' ||
    data.access === 'disconnected' ||
    errorCode === 'calendar_reconnect' ||
    (!confirm.isError && event.lastError?.code === 'calendar_reconnect');
  const shownError = error?.message ?? event.lastError?.message ?? null;
  const busy = confirm.isPending || setState.isPending || reread.isPending || reconnect.isPending;

  const set = (patch: Partial<EventDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const setStart = (start: string) => setDraft((d) => withStart(d, start));
  const setAllDay = (allDay: boolean) => setDraft((d) => withAllDay(d, allDay));

  const twoZones = draft.startTimeZone !== draft.endTimeZone;
  const showZones = !draft.allDay && (editingZones || twoZones || draft.startTimeZone !== deviceZone);
  const inputType = draft.allDay ? 'date' : 'datetime-local';

  return (
    <section className="event-card" data-state="proposed" aria-labelledby="event-card-title">
      <p id="event-card-title" className="event-card-head">
        <CalendarPlus size={18} aria-hidden="true" /> Ajouter à l’agenda
      </p>
      {calendarResult === 'connected' && !needsReconnect && (
        <p className="hint event-ok" role="status">
          Google est reconnecté. Tu peux ajouter l’événement.
        </p>
      )}
      {calendarResult === 'failed' && (
        <p className="field-error" role="alert">
          La connexion Google n’a pas abouti. Tu peux réessayer.
        </p>
      )}
      {event.extraction === 'failed' && (
        <p className="hint">
          Je n’ai pas pu lire les détails automatiquement. Complète-les ou{' '}
          <button type="button" className="link-btn" disabled={busy} onClick={() => reread.mutate()}>
            <RefreshCw size={12} aria-hidden="true" /> relance la lecture
          </button>
          .
        </p>
      )}

      <form
        className="event-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!problem && !busy && !needsReconnect) confirm.mutate();
        }}
      >
        <label className="event-field">
          <span>Titre</span>
          <input className="input" value={draft.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} />
        </label>
        <label className="event-check">
          <input type="checkbox" checked={draft.allDay} onChange={(e) => setAllDay(e.target.checked)} /> Toute la journée
        </label>
        <div className="event-row">
          <label className="event-field">
            <span>{draft.allDay ? 'Du' : 'Début'}</span>
            <input className="input" type={inputType} value={draft.start ?? ''} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className="event-field">
            <span>{draft.allDay ? 'Au' : 'Fin'}</span>
            <input
              className="input"
              type={inputType}
              value={draft.end ?? ''}
              min={draft.allDay ? (draft.start ?? undefined) : undefined}
              onChange={(e) => set({ end: e.target.value || null })}
            />
          </label>
        </div>
        {showZones ? (
          <div className="event-row">
            <label className="event-field">
              <span>{twoZones ? 'Fuseau du départ' : 'Fuseau'}</span>
              <input
                className="input"
                list="event-zones"
                value={draft.startTimeZone}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    startTimeZone: e.target.value,
                    endTimeZone: d.startTimeZone === d.endTimeZone ? e.target.value : d.endTimeZone,
                  }))
                }
              />
            </label>
            <label className="event-field">
              <span>Fuseau de la fin</span>
              <input className="input" list="event-zones" value={draft.endTimeZone} onChange={(e) => set({ endTimeZone: e.target.value })} />
            </label>
            <datalist id="event-zones">
              {TIME_ZONES.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
          </div>
        ) : (
          !draft.allDay && (
            <p className="hint">
              Heure locale ({draft.startTimeZone}).{' '}
              <button type="button" className="link-btn" onClick={() => setEditingZones(true)}>
                Changer de fuseau
              </button>
            </p>
          )
        )}
        <label className="event-field">
          <span>Lieu</span>
          <input
            className="input"
            value={draft.location ?? ''}
            maxLength={300}
            placeholder="Facultatif"
            onChange={(e) => set({ location: e.target.value || null })}
          />
        </label>

        <p className="event-preview" aria-live="polite">
          {problem ?? describeWhen(draft)}
        </p>
        {shownError && (
          <p className="field-error" role="alert">
            {shownError}
          </p>
        )}
        {data.access === 'unconfigured' ? (
          <p className="hint">La connexion Google n’est pas configurée sur le serveur.</p>
        ) : (
          <div className="sheet-actions">
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={busy}
              onClick={() => setState.mutate('dismissed')}
            >
              Ignorer
            </button>
            {needsReconnect ? (
              <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => reconnect.mutate()}>
                {data.access === 'disconnected' ? 'Connecter Google' : 'Reconnecter Google'}
              </button>
            ) : (
              <button type="submit" className="btn btn-sm btn-primary" disabled={busy || Boolean(problem)}>
                {confirm.isPending ? 'Ajout…' : confirm.isError ? 'Réessayer' : 'Ajouter à l’agenda'}
              </button>
            )}
          </div>
        )}
      </form>
    </section>
  );
}

