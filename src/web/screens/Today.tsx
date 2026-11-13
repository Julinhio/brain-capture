import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  ArrowUpRight,
  BriefcaseBusiness,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  FolderKanban,
  Lightbulb,
  Plug,
  Radar,
  RefreshCw,
  Sparkles,
  Unplug,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { PROJECT_LABELS, type CalendarDay, type CalendarEvent, type RadarSummary } from '../../shared/dashboard';
import { CategoryIcon } from '../components/CategoryIcon';
import { api } from '../lib/api';
import { catProps, useCategories } from '../lib/categories';
import { navigate, useSearchParam } from '../lib/router';

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}
const time = (value: string) => new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const dateKey = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

// Availability is explicitly limited to 08:00–20:00. Merge overlaps, respect events
// crossing midnight, declined/transparent events and full-day unavailability.
export function dayRhythm(events: CalendarEvent[], date: string) {
  const start = new Date(`${date}T08:00:00`).getTime();
  const end = new Date(`${date}T20:00:00`).getTime();
  const intervals = events
    .filter((e) => e.busy)
    .map((e) => (e.allDay ? [start, end] : [Math.max(start, Date.parse(e.start)), Math.min(end, Date.parse(e.end))]))
    .filter((a): a is [number, number] => Number.isFinite(a[0]) && Number.isFinite(a[1]) && a[1]! > a[0]!)
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [a, b] of intervals) {
    const last = merged.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const free: [number, number][] = [];
  let cursor = start;
  for (const [a, b] of merged) {
    if (a > cursor) free.push([cursor, a]);
    cursor = b;
  }
  if (cursor < end) free.push([cursor, end]);
  return { start, end, busy: merged, free, freeMinutes: Math.round(free.reduce((n, [a, b]) => n + b - a, 0) / 60_000) };
}

export function Today({ onOpen }: { onOpen: (id: string) => void }) {
  const now = useClock();
  const day = dateKey(now);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const qc = useQueryClient();
  const today = useQuery({
    queryKey: ['captures', 'today', timeZone, day],
    queryFn: () => api.today(timeZone),
    refetchInterval: 60_000,
  });
  const calendar = useQuery({
    queryKey: ['calendar', timeZone, day],
    queryFn: () => api.calendarDay(timeZone),
    staleTime: 240_000,
    refetchInterval: 300_000,
  });
  const radars = useQuery({ queryKey: ['radars'], queryFn: api.radars, refetchInterval: 60_000 });
  const categories = useCategories();
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects, refetchInterval: 60_000 });
  const allProjects = projects.data ?? today.data?.projects ?? [];
  const active = allProjects.filter((p) => p.state === 'active');
  const upcoming = allProjects.filter((p) => p.state === 'upcoming');
  const ideas = allProjects.filter((p) => p.state === 'idea');
  const calendarResult = useSearchParam('calendar');
  const events = calendar.data?.events ?? [];
  const next = events.find((e) => !e.allDay && Date.parse(e.end) > now.getTime());
  const hasCalendarSelection = calendar.data?.calendars ? calendar.data.calendars.some((c) => c.selected) : true;
  const ready = calendar.data?.state === 'ready' && !calendar.isError && hasCalendarSelection;
  const jobsToReview =
    !radars.isError && radars.data?.jobs.state === 'ready'
      ? radars.data.jobs.segments.find((m) => m.key === 'a_voir')?.value
      : undefined;
  const leadsToReview =
    !radars.isError && radars.data?.automata.state === 'ready'
      ? radars.data.automata.segments.find((m) => m.key === 'a_verifier')?.value
      : undefined;
  return (
    <div className="today-page">
      <div className="today-intro">
        <header className="today-heading today-welcome">
          <div>
            <p className="mono">
              {now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
            </p>
            <h1>{now.getHours() < 12 ? 'Good morning, Julien.' : now.getHours() < 18 ? 'Good afternoon, Julien.' : 'Good evening, Julien.'}</h1>
            <p className="lead">Your day at a glance.</p>
          </div>
        </header>
        <section className="morning-brief" aria-labelledby="brief-title">
          <div className="brief-heading">
            <h2 id="brief-title">
              <Sparkles size={16} aria-hidden="true" />
              Today's brief
            </h2>
            <button
              className="brief-refresh"
              type="button"
              aria-label="Refresh"
              onClick={() => {
                void qc.invalidateQueries({ queryKey: ['calendar'] });
                void qc.invalidateQueries({ queryKey: ['radars'] });
                void qc.invalidateQueries({ queryKey: ['captures', 'today'] });
                void qc.invalidateQueries({ queryKey: ['projects'] });
              }}
            >
              <RefreshCw size={14} aria-hidden="true" />
              Refresh
            </button>
          </div>
          <div className="brief-appointment">
            <CalendarDays size={17} aria-hidden="true" />
            {ready ? (
              next ? (
                <>
                  <span className="brief-time">
                    {Date.parse(next.start) <= now.getTime() ? 'Now' : time(next.start)}
                  </span>
                  <strong>{next.title}</strong>
                </>
              ) : (
                <span>No more appointments today</span>
              )
            ) : (
              <span>
                {calendar.isPending
                  ? 'Reading your calendar…'
                  : calendar.data?.state === 'ready' && !hasCalendarSelection
                    ? 'Choose the calendars to include'
                    : calendar.data?.state === 'permission_required'
                      ? 'Reconnect Google to include all your calendars'
                      : calendar.data?.state === 'partial'
                        ? 'Incomplete day · a calendar is not responding'
                        : calendar.isError || calendar.data?.state === 'error'
                          ? 'Calendar unavailable'
                          : 'Calendar not connected'}
              </span>
            )}
          </div>
          <dl className="brief-metrics">
            <div data-axis="jobs">
              <dt>Offers to review</dt>
              <dd>{jobsToReview ?? '—'}</dd>
            </div>
            <div data-axis="automata">
              <dt>Leads to check</dt>
              <dd>{leadsToReview ?? '—'}</dd>
            </div>
            <div>
              <dt>Captures yesterday</dt>
              <dd>{!today.isError ? (today.data?.yesterday.count ?? '—') : '—'}</dd>
            </div>
            <div>
              <dt>Active projects</dt>
              <dd>{projects.isSuccess ? active.length : '—'}</dd>
            </div>
          </dl>
        </section>
      </div>
      {calendarResult === 'failed' && (
        <p className="field-error" role="alert">
          The Google connection did not go through. You can try again below.
        </p>
      )}
      <CalendarPanel
        data={calendar.isError ? undefined : calendar.data}
        loading={calendar.isPending}
        error={calendar.isError}
        date={day}
        now={now}
      />
      <div className="today-section-head">
        <div>
          <p className="mono">Stay on course</p>
          <h2>My radars</h2>
        </div>
        <span className="hint">Volume, movement, follow-up.</span>
      </div>
      <div className="radar-grid">
        <RadarCard
          title="Job Radar"
          kind="jobs"
          data={radars.isError ? undefined : radars.data?.jobs}
          loading={radars.isPending}
        />
        <RadarCard
          title="Automata Radar"
          kind="automata"
          data={radars.isError ? undefined : radars.data?.automata}
          loading={radars.isPending}
        />
      </div>
      <section className="today-projects" aria-labelledby="today-projects-title">
        <div className="today-section-head">
          <div>
            <p className="mono">Build</p>
            <h2 id="today-projects-title">My projects</h2>
          </div>
          <button className="link-btn" type="button" onClick={() => navigate('/?view=workspace')}>
            See projects <ArrowRight size={16} aria-hidden="true" />
          </button>
        </div>
        {projects.isError && <p className="field-error">Projects could not be refreshed.</p>}
        <div className="project-summary">
          <span>
            <strong>{active.length}</strong>Active
          </span>
          <span>
            <strong>{upcoming.length}</strong>Upcoming
          </span>
          <span>
            <strong>{ideas.length}</strong>Ideas on hold
          </span>
        </div>
        <div className="today-project-list">
          {[...active, ...upcoming].slice(0, 4).map((p) => (
            <button
              type="button"
              className="today-project"
              key={p.id}
              data-state={p.state}
              onClick={() => navigate(`/?view=workspace&project=${p.id}`)}
            >
              <span className="project-symbol">
                <FolderKanban size={22} aria-hidden="true" />
              </span>
              <span className="grow">
                <span className="state-label">
                  <span className="state-dot" />
                  {PROJECT_LABELS[p.state]}
                </span>
                <strong>{p.name}</strong>
                <span className="hint">{p.nextStep || p.intention || 'Next step still to define.'}</span>
              </span>
              <ChevronRight size={18} aria-hidden="true" />
            </button>
          ))}
        </div>
        {!active.length && !upcoming.length && projects.isSuccess && (
          <div className="project-invitation">
            <Lightbulb size={24} aria-hidden="true" />
            <div>
              <h3>Ideas have a place here.</h3>
              <p>Create a project, or turn a capture into a starting point.</p>
            </div>
            <button type="button" className="btn" onClick={() => navigate('/?view=workspace')}>
              Organize my projects
            </button>
          </div>
        )}
      </section>
      <section aria-labelledby="yesterday-title">
        <div className="today-section-head">
          <div>
            <p className="mono">Yesterday</p>
            <h2 id="yesterday-title">What you captured</h2>
          </div>
          {today.data && (
            <span className="hint">
              {today.data.yesterday.count} capture{today.data.yesterday.count > 1 ? 's' : ''}
            </span>
          )}
        </div>
        {today.isError && <p className="field-error">Yesterday's captures could not be loaded.</p>}
        {today.isPending && (
          <p className="hint" role="status">
            Loading…
          </p>
        )}
        <div className="yesterday-grid">
          {categories.list.map(({ id: category }) => {
            const notes = today.data?.yesterday.captures.filter((c) => c.category === category) ?? [];
            if (!notes.length) return null;
            return (
              <div key={category} className="yesterday-group" {...catProps(categories.info(category))}>
                <h3>
                  <CategoryIcon category={category} />
                  {categories.info(category).name}
                  <span className="mono">{notes.length}</span>
                </h3>
                {notes.map((c) => (
                  <button type="button" className="yesterday-note" key={c.id} onClick={() => onOpen(c.id)}>
                    <span>{c.title ?? c.text.slice(0, 100)}</span>
                    <span className="hint">
                      {c.status === 'done' ? 'Done' : c.status === 'archived' ? 'Archived' : time(c.createdAt)}
                    </span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
        {today.data?.yesterday.count === 0 && (
          <p className="hint">No captures yesterday. Everything is still in Everything.</p>
        )}
        {today.data && today.data.yesterday.count > today.data.yesterday.captures.length && (
          <p className="hint">
            Showing the last {today.data.yesterday.captures.length} captures.{' '}
            <button type="button" className="link-btn" onClick={() => navigate('/?view=everything')}>
              See them all in Everything
            </button>
          </p>
        )}
      </section>
    </div>
  );
}

export const MY_DAY_EXPANDED_KEY = 'brain-capture.today.my-day-expanded';

/**
 * A per-device display preference: collapsed unless this browser last left it open. Storage
 * can be missing or refuse (private window, blocked site data): the card then just starts
 * collapsed again.
 */
function useRememberedFlag(key: string): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      return window.localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });
  const set = (next: boolean) => {
    setValue(next);
    try {
      if (next) window.localStorage.setItem(key, '1');
      else window.localStorage.removeItem(key);
    } catch {
      // Not remembered on this device; the choice still applies until the page is left.
    }
  };
  return [value, set];
}

function CalendarPanel({
  data,
  loading,
  error,
  date,
  now,
}: {
  data?: CalendarDay;
  loading: boolean;
  error: boolean;
  date: string;
  now: Date;
}) {
  const qc = useQueryClient();
  const connect = useMutation({
    mutationFn: () => api.connectCalendar(),
    onSuccess: ({ url }) => {
      window.location.assign(url);
    },
  });
  const disconnect = useMutation({
    mutationFn: api.disconnectCalendar,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['calendar'] });
    },
  });
  const [draftSelection, setDraftSelection] = useState<string[] | undefined>();
  const selection = useMutation({
    mutationFn: api.selectCalendars,
    onMutate: (ids) => setDraftSelection(ids ?? undefined),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['calendar'] }),
    onSettled: () => setDraftSelection(undefined),
  });
  const ready = data?.state === 'ready';
  const connected = ready || data?.state === 'partial';
  const calendars = data?.calendars ?? [];
  const selectedIds = calendars.filter((c) => c.selected).map((c) => c.id);
  const complete = ready && !selection.isPending && (data?.calendars ? selectedIds.length > 0 : true);
  const [expanded, setExpanded] = useRememberedFlag(MY_DAY_EXPANDED_KEY);
  // Nothing selected: the only way forward is the list of calendars, so it stays open.
  const mustChoose = connected && calendars.length > 0 && selectedIds.length === 0 && !draftSelection;
  const showDetails = expanded || mustChoose;
  const events = data?.events ?? [];
  const rhythm = dayRhythm(events, date);
  const timed = events.filter((e) => !e.allDay);
  const allDay = events.filter((e) => e.allDay);
  const hours = Math.floor(rhythm.freeMinutes / 60);
  const minutes = rhythm.freeMinutes % 60;
  const sourceLanes = [...new Set(events.filter((e) => e.busy).map((e) => e.calendarId ?? 'primary'))];
  const busySlots = events
    .filter((e) => e.busy)
    .map((e) => ({
      event: e,
      start: e.allDay ? rhythm.start : Math.max(rhythm.start, Date.parse(e.start)),
      end: e.allDay ? rhythm.end : Math.min(rhythm.end, Date.parse(e.end)),
      lane: sourceLanes.indexOf(e.calendarId ?? 'primary'),
    }))
    .filter((slot) => slot.end > slot.start);
  return (
    <section className="calendar-panel" aria-labelledby="calendar-title">
      <div className="today-section-head">
        <h2 id="calendar-title">
          <CalendarDays size={20} aria-hidden="true" />
          My day
        </h2>
        <div className="calendar-controls">
          <span className="hint">{Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
          {connected && (
            <button
              type="button"
              className="link-btn"
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate()}
            >
              <Unplug size={14} aria-hidden="true" />
              Disconnect
            </button>
          )}
        </div>
      </div>
      {selection.isError && (
        <p className="field-error" role="alert">
          Selection not saved. {selection.error.message}
        </p>
      )}
      {data?.state === 'partial' && (
        <p className="calendar-incomplete" role="status">
          Incomplete day:{' '}
          {calendars
            .filter((c) => c.selected && c.loadState === 'error')
            .map((c) => c.name)
            .join(', ') || 'a selected calendar is no longer accessible'}
          . Free time cannot be worked out for the whole day.
        </p>
      )}
      {loading ? (
        <p className="hint" role="status">
          Reading your calendar…
        </p>
      ) : connected ? (
        <>
          {complete ? (
            <>
              <div className="day-stats">
                <span>
                  <strong>{events.length}</strong> appointments & events
                </span>
                <span>
                  <strong>
                    {hours} h{minutes ? ` ${minutes} min` : ''}
                  </strong>{' '}
                  free between 8:00 and 20:00
                </span>
              </div>
              <div
                className="day-timeline"
                style={{ height: Math.max(34, sourceLanes.length * 12 + 8) }}
                role="img"
                aria-label={`Free time between 8:00 and 20:00: ${rhythm.freeMinutes} minutes without appointments.`}
              >
                {busySlots.map(({ event, start, end, lane }) => (
                  <span
                    className="busy-slot"
                    key={event.id}
                    style={{
                      left: `${((start - rhythm.start) / (rhythm.end - rhythm.start)) * 100}%`,
                      width: `${((end - start) / (rhythm.end - rhythm.start)) * 100}%`,
                      backgroundColor: event.calendarColor ?? 'var(--accent)',
                      top: 4 + lane * 12,
                      bottom: 'auto',
                      height: sourceLanes.length > 1 ? 9 : 26,
                    }}
                  />
                ))}
                {now.getTime() >= rhythm.start && now.getTime() <= rhythm.end && (
                  <span
                    className="now-marker"
                    style={{ left: `${((now.getTime() - rhythm.start) / (rhythm.end - rhythm.start)) * 100}%` }}
                  />
                )}
              </div>
              <div className="timeline-labels" aria-hidden="true">
                {[8, 10, 12, 14, 16, 18, 20].map((h) => (
                  <span key={h}>{h}:00</span>
                ))}
              </div>
            </>
          ) : selectedIds.length === 0 && data?.state !== 'partial' ? (
            <p className="hint">No calendar selected. Choose the calendars to include in your day.</p>
          ) : (
            <p className="hint">
              {events.length} event{events.length === 1 ? '' : 's'} loaded, partial reading.
            </p>
          )}
          <button
            type="button"
            className="my-day-toggle"
            aria-expanded={showDetails}
            aria-controls="my-day-details"
            disabled={mustChoose}
            onClick={() => setExpanded(!expanded)}
          >
            <span className="grow">{showDetails ? 'Hide calendars and appointments' : 'Calendars and appointments'}</span>
            <ChevronDown size={16} aria-hidden="true" />
          </button>
          {showDetails && (
            <div id="my-day-details" className="my-day-details">
              {calendars.length > 0 && (
                <div className="calendar-selection" role="group" aria-label="Included calendars">
                  <div className="calendar-selection-head">
                    <span className="hint">
                      {selectedIds.length} calendar{selectedIds.length === 1 ? '' : 's'} included
                    </span>
                    <button
                      type="button"
                      className="link-btn"
                      disabled={selection.isPending}
                      onClick={() => selection.mutate(null)}
                    >
                      All my calendars
                    </button>
                  </div>
                  <div className="calendar-options">
                    {calendars.map((c) => (
                      <label key={c.id} className={`calendar-option ${c.selected ? 'selected' : ''}`}>
                        <input
                          type="checkbox"
                          checked={draftSelection ? draftSelection.includes(c.id) : c.selected}
                          disabled={selection.isPending}
                          onChange={(e) =>
                            selection.mutate(
                              e.target.checked ? [...selectedIds, c.id] : selectedIds.filter((id) => id !== c.id),
                            )
                          }
                        />
                        <span className="calendar-color" style={{ backgroundColor: c.color }} aria-hidden="true" />
                        <span>{c.name}</span>
                        {c.loadState === 'error' && <span className="field-error">Unavailable</span>}
                      </label>
                    ))}
                  </div>
                </div>
              )}
              {allDay.length > 0 && (
                <div className="all-day-events">
                  {allDay.map((e) => (
                    <span key={e.id}>
                      {e.title}
                      <small>
                        {e.calendarName ? `${e.calendarName} · ` : ''}All day{!e.busy ? ' · free' : ''}
                      </small>
                    </span>
                  ))}
                </div>
              )}
              {timed.length > 0 && (
                <div className="day-agenda">
                  {timed.map((e) => (
                    <div key={e.id} className={`agenda-event ${Date.parse(e.end) <= now.getTime() ? 'past' : ''}`}>
                      <time>
                        {time(e.start)}
                        <span>{time(e.end)}</span>
                      </time>
                      <span className="agenda-dot" style={{ backgroundColor: e.calendarColor ?? 'var(--accent)' }} />
                      <div>
                        <strong>{e.title}</strong>
                        {e.calendarName && <span className="event-calendar">{e.calendarName}</span>}
                        {!e.busy && <span className="hint">Does not block your time</span>}
                      </div>
                      {e.url && (
                        <a
                          className="link-btn"
                          href={e.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`Open ${e.title} in Google Calendar`}
                        >
                          <ArrowUpRight size={16} />
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {!events.length && complete && <p className="hint">No events today in the selected calendars.</p>}
              {complete && rhythm.free.length > 0 && (
                <div className="free-windows">
                  <span className="mono">Free slots</span>
                  {rhythm.free
                    .filter(([a, b]) => b - a >= 30 * 60_000)
                    .map(([a, b]) => (
                      <span key={a}>
                        {time(new Date(a).toISOString())} – {time(new Date(b).toISOString())}
                      </span>
                    ))}
                </div>
              )}
            </div>
          )}
          <p className="calendar-freshness">Google Calendar · updated at {time(data.checkedAt!)}</p>
        </>
      ) : (
        <div className="source-empty">
          <CalendarDays size={30} aria-hidden="true" />
          <div>
            <h3>
              {data?.state === 'permission_required'
                ? 'Include all your calendars'
                : error || data?.state === 'error'
                  ? 'Calendar temporarily unavailable'
                  : 'Give your day a rhythm'}
            </h3>
            <p>
              {data?.state === 'permission_required'
                ? 'Reconnect Google to allow reading the list of your calendars. Your own calendars will then be included together.'
                : data?.state === 'unconfigured'
                  ? 'The Google connection must be configured before your calendar can be linked.'
                  : error || data?.state === 'error'
                    ? 'Your appointments are unknown right now. Try again or reconnect Google Calendar.'
                    : 'Link your calendars to see your whole day and your free slots.'}
            </p>
          </div>
          {data?.state !== 'unconfigured' && (
            <button className="btn" type="button" disabled={connect.isPending} onClick={() => connect.mutate()}>
              <Plug size={16} aria-hidden="true" />
              {connect.isPending
                ? 'Connecting…'
                : data?.state === 'permission_required'
                  ? 'Reconnect my calendars'
                  : 'Connect Google Calendar'}
            </button>
          )}
        </div>
      )}
      {(connect.isError || disconnect.isError) && (
        <p className="field-error" role="alert">
          {connect.error?.message ?? disconnect.error?.message}
        </p>
      )}
    </section>
  );
}

// The radars are French apps; their counters are named in English here, keyed by their
// stable keys. An unknown key keeps the label sent by the source.
const RADAR_LABELS: Record<'jobs' | 'automata', Record<string, string>> = {
  jobs: {
    a_voir: 'To review',
    a_tenter: 'Worth a try',
    interessante: 'Interesting',
    postule: 'Applied',
    a_relire: 'To re-check',
    ecartee: 'Dismissed',
  },
  automata: {
    a_verifier: 'To check',
    contactee: 'Contacted',
    audit_propose: 'Audit proposed',
    audit_fait: 'Audit done',
    mission: 'Missions',
    ecartee: 'Dismissed',
  },
};
/**
 * The rows the Job Radar card shows, in this order (Julien's choice, 13/11/2026). The other
 * segments the radar sends (not kept by the AI, awaiting sorting, sorting errors) still add
 * up to its total but stay off the card and out of its bar. Automata shows what it sends.
 */
export const JOB_RADAR_ROWS = ['a_voir', 'a_tenter', 'interessante', 'postule', 'a_relire', 'ecartee'] as const;
const count = (n: number) => n.toLocaleString('en-GB');

/** The rows a radar card lists. A kept job row the source did not send reads as unknown, never as zero. */
export function radarRows(kind: 'jobs' | 'automata', segments: RadarSummary['segments']) {
  if (kind === 'automata')
    return segments.map((m) => ({ key: m.key, label: RADAR_LABELS.automata[m.key] ?? m.label, value: m.value as number | null }));
  return JOB_RADAR_ROWS.map((key) => {
    const m = segments.find((s) => s.key === key);
    return { key, label: RADAR_LABELS.jobs[key]!, value: m ? m.value : null };
  });
}

/** The figure a radar card leads with: offers to review for jobs, the total for Automata. */
export function radarHeadline(kind: 'jobs' | 'automata', data: Pick<RadarSummary, 'total' | 'segments'>) {
  const toReview = kind === 'jobs' ? data.segments.find((m) => m.key === 'a_voir') : undefined;
  if (toReview) return { value: toReview.value, label: `offer${toReview.value === 1 ? '' : 's'} to review` };
  return { value: data.total, label: kind === 'jobs' ? 'unique offers in total' : 'companies (agencies excluded)' };
}

function RadarCard({
  title,
  kind,
  data,
  loading,
}: {
  title: string;
  kind: 'jobs' | 'automata';
  data?: RadarSummary;
  loading: boolean;
}) {
  const ready = data?.state === 'ready';
  const headline = ready ? radarHeadline(kind, data) : null;
  const rows = ready ? radarRows(kind, data.segments) : [];
  return (
    <section className="radar-card" data-radar={kind} aria-label={title}>
      <div className="radar-card-head">
        <span className="radar-symbol">{kind === 'jobs' ? <BriefcaseBusiness size={22} /> : <Radar size={22} />}</span>
        <h3>{title}</h3>
        {data?.url && (
          <a
            href={data.url}
            target="_blank"
            rel="noopener noreferrer"
            className="link-btn"
            aria-label={`Open ${title}`}
          >
            <ArrowUpRight size={18} />
          </a>
        )}
      </div>
      {ready && headline ? (
        <>
          <div className="radar-numbers">
            <div>
              <strong>{headline.value === null ? '—' : count(headline.value)}</strong>
              <span>{headline.label}</span>
            </div>
            <div className="radar-new">
              <strong>+{data.new24h}</strong>
              <span>in 24 h</span>
            </div>
          </div>
          <div
            className="radar-stack"
            role="img"
            aria-label={rows.map((m) => `${m.label}: ${m.value ?? 'unknown'}`).join(', ')}
          >
            {rows.map((m, i) =>
              m.value ? <span key={m.key} className={`segment-${i % 7}`} style={{ flex: m.value }} /> : null,
            )}
          </div>
          <dl className="radar-breakdown">
            {rows.map((m, i) => (
              <div key={m.key}>
                <dt>
                  <span className={`legend-dot segment-${i % 7}`} />
                  {m.label}
                </dt>
                <dd>{m.value === null ? '—' : count(m.value)}</dd>
              </div>
            ))}
          </dl>
          <p className="calendar-freshness radar-freshness">Read only · updated at {time(data.checkedAt!)}</p>
        </>
      ) : (
        <div className="radar-empty">
          <strong>—</strong>
          <p>
            {loading
              ? 'Reading the counters…'
              : data?.state === 'unconfigured'
                ? 'Source not connected'
                : 'Source unavailable'}
          </p>
          <span className="hint">
            {loading
              ? 'The figures are on their way.'
              : data?.state === 'unconfigured'
                ? 'The figures will appear once the connection is configured.'
                : 'The counters are unknown right now. They are not zero.'}
          </span>
        </div>
      )}
    </section>
  );
}
