import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  ArrowUpRight,
  BriefcaseBusiness,
  CalendarDays,
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
import { CATEGORIES, CATEGORY_LABELS } from '../../shared/categories';
import { PROJECT_LABELS, type CalendarDay, type CalendarEvent, type RadarSummary } from '../../shared/dashboard';
import { CategoryIcon } from '../components/CategoryIcon';
import { api } from '../lib/api';
import { navigate, useSearchParam } from '../lib/router';

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}
const time = (value: string) => new Date(value).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
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
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects, refetchInterval: 60_000 });
  const allProjects = projects.data ?? today.data?.projects ?? [];
  const active = allProjects.filter((p) => p.state === 'active');
  const upcoming = allProjects.filter((p) => p.state === 'upcoming');
  const ideas = allProjects.filter((p) => p.state === 'idea');
  const calendarResult = useSearchParam('calendar');
  const events = calendar.data?.events ?? [];
  const next = events.find((e) => !e.allDay && Date.parse(e.end) > now.getTime());
  const ready = calendar.data?.state === 'ready' && !calendar.isError;
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
              {now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}
            </p>
            <h1>{now.getHours() < 18 ? 'Bonjour, Julien.' : 'Bonsoir, Julien.'}</h1>
            <p className="lead">Ta journée en perspective.</p>
          </div>
        </header>
        <section className="morning-brief" aria-labelledby="brief-title">
          <div className="brief-heading">
            <h2 id="brief-title">
              <Sparkles size={16} aria-hidden="true" />
              Le fil du jour
            </h2>
            <button
              className="brief-refresh"
              type="button"
              aria-label="Actualiser"
              onClick={() => {
                void qc.invalidateQueries({ queryKey: ['calendar'] });
                void qc.invalidateQueries({ queryKey: ['radars'] });
                void qc.invalidateQueries({ queryKey: ['captures', 'today'] });
                void qc.invalidateQueries({ queryKey: ['projects'] });
              }}
            >
              <RefreshCw size={14} aria-hidden="true" />
              Actualiser
            </button>
          </div>
          <div className="brief-appointment">
            <CalendarDays size={17} aria-hidden="true" />
            {ready ? (
              next ? (
                <>
                  <span className="brief-time">
                    {Date.parse(next.start) <= now.getTime() ? 'En cours' : time(next.start)}
                  </span>
                  <strong>{next.title}</strong>
                </>
              ) : (
                <span>Plus de rendez-vous aujourd’hui</span>
              )
            ) : (
              <span>
                {calendar.isPending
                  ? 'Lecture du calendrier…'
                  : calendar.data?.state === 'permission_required'
                    ? 'Reconnecte Google pour inclure tous tes calendriers'
                    : calendar.data?.state === 'partial'
                      ? 'Journée incomplète · un calendrier ne répond pas'
                      : calendar.isError || calendar.data?.state === 'error'
                        ? 'Calendrier indisponible'
                        : 'Calendrier à connecter'}
              </span>
            )}
          </div>
          <dl className="brief-metrics">
            <div data-axis="jobs">
              <dt>Offres à voir</dt>
              <dd>{jobsToReview ?? '—'}</dd>
            </div>
            <div data-axis="automata">
              <dt>Prospects à vérifier</dt>
              <dd>{leadsToReview ?? '—'}</dd>
            </div>
            <div>
              <dt>Captures hier</dt>
              <dd>{!today.isError ? (today.data?.yesterday.count ?? '—') : '—'}</dd>
            </div>
            <div>
              <dt>Projets en cours</dt>
              <dd>{projects.isSuccess ? active.length : '—'}</dd>
            </div>
          </dl>
        </section>
      </div>
      {calendarResult === 'failed' && (
        <p className="field-error" role="alert">
          La connexion Google n’a pas abouti. Tu peux réessayer ci-dessous.
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
          <p className="mono">Garder le cap</p>
          <h2>Mes radars</h2>
        </div>
        <span className="hint">Le volume, le mouvement, le suivi.</span>
      </div>
      <div className="radar-grid">
        <RadarCard
          title="Radar Emploi"
          kind="jobs"
          data={radars.isError ? undefined : radars.data?.jobs}
          loading={radars.isPending}
        />
        <RadarCard
          title="Radar Automata"
          kind="automata"
          data={radars.isError ? undefined : radars.data?.automata}
          loading={radars.isPending}
        />
      </div>
      <section className="today-projects" aria-labelledby="today-projects-title">
        <div className="today-section-head">
          <div>
            <p className="mono">Construire</p>
            <h2 id="today-projects-title">Mes projets</h2>
          </div>
          <button className="link-btn" type="button" onClick={() => navigate('/?view=workspace')}>
            Voir les projets <ArrowRight size={16} aria-hidden="true" />
          </button>
        </div>
        {projects.isError && <p className="field-error">Actualisation des projets impossible.</p>}
        <div className="project-summary">
          <span>
            <strong>{active.length}</strong>En cours
          </span>
          <span>
            <strong>{upcoming.length}</strong>À venir
          </span>
          <span>
            <strong>{ideas.length}</strong>Idées en réserve
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
                <span className="hint">{p.nextStep || p.intention || 'La prochaine étape reste à définir.'}</span>
              </span>
              <ChevronRight size={18} aria-hidden="true" />
            </button>
          ))}
        </div>
        {!active.length && !upcoming.length && projects.isSuccess && (
          <div className="project-invitation">
            <Lightbulb size={24} aria-hidden="true" />
            <div>
              <h3>Les idées ont leur place ici.</h3>
              <p>Crée un projet ou transforme une capture en point de départ.</p>
            </div>
            <button type="button" className="btn" onClick={() => navigate('/?view=workspace')}>
              Organiser mes projets
            </button>
          </div>
        )}
      </section>
      <section aria-labelledby="yesterday-title">
        <div className="today-section-head">
          <div>
            <p className="mono">Le fil d’hier</p>
            <h2 id="yesterday-title">Ce que tu as posé</h2>
          </div>
          {today.data && (
            <span className="hint">
              {today.data.yesterday.count} capture{today.data.yesterday.count > 1 ? 's' : ''}
            </span>
          )}
        </div>
        {today.isError && <p className="field-error">Les captures de la veille n’ont pas pu être chargées.</p>}
        {today.isPending && (
          <p className="hint" role="status">
            Chargement…
          </p>
        )}
        <div className="yesterday-grid">
          {CATEGORIES.map((category) => {
            const notes = today.data?.yesterday.captures.filter((c) => c.category === category) ?? [];
            if (!notes.length) return null;
            return (
              <div key={category} className="yesterday-group" data-cat={category}>
                <h3>
                  <CategoryIcon category={category} />
                  {CATEGORY_LABELS[category]}
                  <span className="mono">{notes.length}</span>
                </h3>
                {notes.map((c) => (
                  <button type="button" className="yesterday-note" key={c.id} onClick={() => onOpen(c.id)}>
                    <span>{c.title ?? c.text.slice(0, 100)}</span>
                    <span className="hint">
                      {c.status === 'done' ? 'Terminée' : c.status === 'archived' ? 'Archivée' : time(c.createdAt)}
                    </span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
        {today.data?.yesterday.count === 0 && (
          <p className="hint">Aucune capture hier. Tout reste accessible dans Everything.</p>
        )}
        {today.data && today.data.yesterday.count > today.data.yesterday.captures.length && (
          <p className="hint">
            Les {today.data.yesterday.captures.length} dernières captures sont affichées.{' '}
            <button type="button" className="link-btn" onClick={() => navigate('/?view=everything')}>
              Tout retrouver dans Everything
            </button>
          </p>
        )}
      </section>
    </div>
  );
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
    mutationFn: api.connectCalendar,
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
          Ma journée
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
              Déconnecter
            </button>
          )}
        </div>
      </div>
      {connected && calendars.length > 0 && (
        <div className="calendar-selection" role="group" aria-label="Calendriers inclus">
          <div className="calendar-selection-head">
            <span className="hint">
              {selectedIds.length} calendrier{selectedIds.length > 1 ? 's' : ''} inclus
            </span>
            <button
              type="button"
              className="link-btn"
              disabled={selection.isPending}
              onClick={() => selection.mutate(null)}
            >
              Tous mes calendriers
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
                {c.loadState === 'error' && <span className="field-error">Indisponible</span>}
              </label>
            ))}
          </div>
        </div>
      )}
      {selection.isError && (
        <p className="field-error" role="alert">
          Sélection non enregistrée. {selection.error.message}
        </p>
      )}
      {data?.state === 'partial' && (
        <p className="calendar-incomplete" role="status">
          Journée incomplète :{' '}
          {calendars
            .filter((c) => c.selected && c.loadState === 'error')
            .map((c) => c.name)
            .join(', ') || 'un calendrier sélectionné n’est plus accessible'}
          . Les disponibilités ne peuvent pas être calculées pour l’ensemble de la journée.
        </p>
      )}
      {loading ? (
        <p className="hint" role="status">
          Lecture du calendrier…
        </p>
      ) : connected ? (
        <>
          {complete ? (
            <>
              <div className="day-stats">
                <span>
                  <strong>{events.length}</strong> rendez-vous & événements
                </span>
                <span>
                  <strong>
                    {hours} h{minutes ? ` ${minutes}` : ''}
                  </strong>{' '}
                  sans rendez-vous de 8 h à 20 h
                </span>
              </div>
              <div
                className="day-timeline"
                style={{ height: Math.max(34, sourceLanes.length * 12 + 8) }}
                role="img"
                aria-label={`Disponibilités de 8 h à 20 h : ${rhythm.freeMinutes} minutes sans rendez-vous. Les horaires détaillés suivent.`}
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
                  <span key={h}>{h} h</span>
                ))}
              </div>
            </>
          ) : selectedIds.length === 0 && data?.state !== 'partial' ? (
            <p className="hint">Aucun calendrier sélectionné. Choisis les calendriers à inclure dans ta journée.</p>
          ) : (
            <p className="hint">
              {events.length} événement{events.length > 1 ? 's' : ''} chargé{events.length > 1 ? 's' : ''}, lecture
              partielle.
            </p>
          )}
          {allDay.length > 0 && (
            <div className="all-day-events">
              {allDay.map((e) => (
                <span key={e.id}>
                  {e.title}
                  <small>
                    {e.calendarName ? `${e.calendarName} · ` : ''}Toute la journée{!e.busy ? ' · disponible' : ''}
                  </small>
                </span>
              ))}
            </div>
          )}
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
                  {!e.busy && <span className="hint">Ne bloque pas ta disponibilité</span>}
                </div>
                {e.url && (
                  <a
                    className="link-btn"
                    href={e.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Ouvrir ${e.title} dans Google Calendar`}
                  >
                    <ArrowUpRight size={16} />
                  </a>
                )}
              </div>
            ))}
          </div>
          {!events.length && complete && (
            <p className="hint">Aucun événement aujourd’hui dans les calendriers sélectionnés.</p>
          )}
          {complete && rhythm.free.length > 0 && (
            <div className="free-windows">
              <span className="mono">Plages sans rendez-vous</span>
              {rhythm.free
                .filter(([a, b]) => b - a >= 30 * 60_000)
                .map(([a, b]) => (
                  <span key={a}>
                    {time(new Date(a).toISOString())} – {time(new Date(b).toISOString())}
                  </span>
                ))}
            </div>
          )}
          <p className="calendar-freshness">Google Calendar · lecture seule · actualisé à {time(data.checkedAt!)}</p>
        </>
      ) : (
        <div className="source-empty">
          <CalendarDays size={30} aria-hidden="true" />
          <div>
            <h3>
              {data?.state === 'permission_required'
                ? 'Inclure tous tes calendriers'
                : error || data?.state === 'error'
                  ? 'Calendrier momentanément indisponible'
                  : 'Donner un rythme à ta journée'}
            </h3>
            <p>
              {data?.state === 'permission_required'
                ? 'Reconnecte Google pour autoriser la lecture de la liste de tes calendriers. Tes calendriers personnels seront inclus ensemble, sans modifier tes événements.'
                : data?.state === 'unconfigured'
                  ? 'La connexion Google doit être configurée avant de pouvoir relier ton calendrier.'
                  : error || data?.state === 'error'
                    ? 'Les rendez-vous ne sont pas connus. Réessaie ou reconnecte Google Calendar.'
                    : 'Relie tes calendriers pour retrouver toute ta journée et tes plages disponibles.'}
            </p>
          </div>
          {data?.state !== 'unconfigured' && (
            <button className="btn" type="button" disabled={connect.isPending} onClick={() => connect.mutate()}>
              <Plug size={16} aria-hidden="true" />
              {connect.isPending
                ? 'Connexion…'
                : data?.state === 'permission_required'
                  ? 'Reconnecter mes calendriers'
                  : 'Connecter Google Calendar'}
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
            aria-label={`Ouvrir ${title}`}
          >
            <ArrowUpRight size={18} />
          </a>
        )}
      </div>
      {ready ? (
        <>
          <div className="radar-numbers">
            <div>
              <strong>{data.total?.toLocaleString('fr-FR')}</strong>
              <span>{kind === 'jobs' ? 'offres uniques au total' : 'entreprises hors agences'}</span>
            </div>
            <div className="radar-new">
              <strong>+{data.new24h}</strong>
              <span>sur 24 h</span>
            </div>
          </div>
          <div
            className="radar-stack"
            role="img"
            aria-label={data.segments.map((m) => `${m.label} : ${m.value}`).join(', ')}
          >
            {data.segments.map((m, i) =>
              m.value > 0 ? <span key={m.key} className={`segment-${i % 7}`} style={{ flex: m.value }} /> : null,
            )}
          </div>
          <dl className="radar-breakdown">
            {data.segments.map((m, i) => (
              <div key={m.key}>
                <dt>
                  <span className={`legend-dot segment-${i % 7}`} />
                  {m.label}
                </dt>
                <dd>{m.value.toLocaleString('fr-FR')}</dd>
              </div>
            ))}
          </dl>
          {data.extra.map((m) => (
            <p className="hint" key={m.key}>
              {m.label} : {m.value}
            </p>
          ))}
          <p className="calendar-freshness">Lecture seule · actualisé à {time(data.checkedAt!)}</p>
        </>
      ) : (
        <div className="radar-empty">
          <strong>—</strong>
          <p>
            {loading
              ? 'Lecture des compteurs…'
              : data?.state === 'unconfigured'
                ? 'Source à connecter'
                : 'Source indisponible'}
          </p>
          <span className="hint">
            {loading
              ? 'Les données arrivent.'
              : data?.state === 'unconfigured'
                ? 'Les chiffres apparaîtront après configuration de la connexion.'
                : 'Les compteurs ne sont pas connus. Ils ne sont pas à zéro.'}
          </span>
        </div>
      )}
    </section>
  );
}
