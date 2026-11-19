import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, ChevronRight, Dumbbell, Pencil, Scale, Utensils } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import {
  MAX_KCAL_GOAL,
  MEAL_SLOTS,
  MIN_KCAL_GOAL,
  SLOT_LABEL,
  entryKcal,
  shiftDay,
  sumMacros,
  type HistoryDay,
  type MealData,
  type NutritionDay,
  type NutritionEntry,
  type NutritionSettings,
  type WeightData,
  type WorkoutData,
} from '../../shared/nutrition';
import { NutritionCard, dayLabel } from '../components/NutritionCard';
import { CaloriesChart, MacroBar, WeightChart, balanceText, signed } from '../components/NutritionCharts';
import { api, deviceLabel } from '../lib/api';
import { navigate, useSearchParam } from '../lib/router';
import { clockTime } from '../lib/time';
import { deviceZone, refreshNutrition, todayHere, useNutritionDay, useNutritionHistory } from '../lib/useNutrition';
import { TopBar } from './CaptureHome';

const num = (n: number) => Math.round(n).toLocaleString('en-GB');
const RANGES = [7, 30, 90] as const;

function href(params: { day?: string | null; tab?: string | null; range?: number | null }): string {
  const qs = new URLSearchParams();
  if (params.tab === 'trends') qs.set('tab', 'trends');
  if (params.day && params.day !== todayHere()) qs.set('day', params.day);
  if (params.range && params.range !== 30) qs.set('range', String(params.range));
  const s = qs.toString();
  return s ? `/nutrition?${s}` : '/nutrition';
}

/**
 * The Nutrition section: what was eaten, done and weighed. `phone` gives it its own screen;
 * on the desktop it sits in the main column of the dashboard.
 */
export function Nutrition({ phone = false }: { phone?: boolean }) {
  const tab = useSearchParam('tab') === 'trends' ? 'trends' : 'day';
  const rawDay = useSearchParam('day');
  const today = todayHere();
  const day = rawDay && /^\d{4}-\d{2}-\d{2}$/.test(rawDay) && rawDay <= today ? rawDay : today;
  const rawRange = Number(useSearchParam('range'));
  const range = RANGES.find((r) => r === rawRange) ?? 30;

  const body = (
    <div className="nutrition-page">
      <header className="nutrition-head">
        <div>
          <p className="mono">Estimates, to keep your bearings</p>
          <h1>Nutrition</h1>
        </div>
        <div className="nut-tabs" role="tablist" aria-label="Nutrition views">
          <button type="button" role="tab" aria-selected={tab === 'day'} className="cat-option" aria-pressed={tab === 'day'} onClick={() => navigate(href({ day }))}>
            Day
          </button>
          <button type="button" role="tab" aria-selected={tab === 'trends'} className="cat-option" aria-pressed={tab === 'trends'} onClick={() => navigate(href({ tab: 'trends', range }))}>
            Trends
          </button>
        </div>
      </header>
      {tab === 'day' ? <DayView day={day} /> : <Trends range={range} />}
    </div>
  );

  if (!phone) return body;
  return (
    <main className="screen nutrition-screen">
      <TopBar />
      {body}
    </main>
  );
}

// ---------------------------------------------------------------------------------------
// Day
// ---------------------------------------------------------------------------------------

function DayView({ day }: { day: string }) {
  const today = todayHere();
  const query = useNutritionDay(day);
  const data = query.data;

  return (
    <>
      <nav className="nut-daynav" aria-label="Day">
        <button type="button" className="icon-btn" onClick={() => navigate(href({ day: shiftDay(day, -1) }))} aria-label="Previous day">
          <ChevronLeft size={20} aria-hidden="true" />
        </button>
        <div className="nut-daynav-label">
          <strong>{dayLabel(day)}</strong>
          {day !== today && (
            <button type="button" className="link-btn" onClick={() => navigate(href({}))}>
              Back to today
            </button>
          )}
        </div>
        <button type="button" className="icon-btn" onClick={() => navigate(href({ day: shiftDay(day, 1) }))} disabled={day >= today} aria-label="Next day">
          <ChevronRight size={20} aria-hidden="true" />
        </button>
      </nav>

      {query.isError && <p className="empty">Could not load this day. Check your connection.</p>}
      {data && (
        <>
          <Summary data={data} />
          <QuickLog day={day} />
          {data.pending.length > 0 && (
            <section className="nut-section" aria-labelledby="nut-pending">
              <h2 id="nut-pending" className="nut-section-title">
                To confirm <span className="mono">{data.pending.length}</span>
              </h2>
              <p className="hint nut-section-hint">Read from your captures. Nothing here counts until you add it.</p>
              <div className="nut-pending">
                {data.pending.map((entry) => (
                  <NutritionCard key={`${entry.id}:${entry.updatedAt}`} entry={entry} />
                ))}
              </div>
            </section>
          )}
          <Entries data={data} />
        </>
      )}
    </>
  );
}

function Summary({ data }: { data: NutritionDay }) {
  const { totals, settings, weight } = data;
  const [editingGoal, setEditingGoal] = useState(false);
  const budget = totals.goal + totals.burned;
  const over = totals.remaining < 0;
  const share = budget > 0 ? Math.min(1, totals.eaten.kcal / budget) : 0;

  return (
    <section className="nut-summary" aria-label="Day balance">
      <div className="nut-balance">
        <p className="nut-remaining" data-over={over || undefined}>
          <strong>{num(Math.abs(totals.remaining))}</strong>
          <span>kcal {over ? 'over your goal' : 'left today'}</span>
        </p>
        <div
          className="nut-meter"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={budget}
          aria-valuenow={Math.min(totals.eaten.kcal, budget)}
          aria-label={`${num(totals.eaten.kcal)} of ${num(budget)} kcal`}
          data-over={over || undefined}
        >
          <span style={{ width: `${share * 100}%` }} />
        </div>
        <dl className="nut-stats">
          <div>
            <dt>Eaten</dt>
            <dd>{num(totals.eaten.kcal)}</dd>
          </div>
          <div>
            <dt>Burned</dt>
            <dd>{num(totals.burned)}</dd>
          </div>
          <div>
            <dt>Goal</dt>
            <dd>
              {num(totals.goal)}
              <button type="button" className="nut-edit" onClick={() => setEditingGoal((v) => !v)} aria-label="Change the daily goal" aria-expanded={editingGoal}>
                <Pencil size={13} aria-hidden="true" />
              </button>
            </dd>
          </div>
          <div>
            <dt>Weight</dt>
            <dd>{weight ? `${weight.kg} kg` : '–'}</dd>
          </div>
        </dl>
        {!settings.goalSet && !editingGoal && (
          <p className="hint">
            {num(settings.kcalGoal)} kcal is a placeholder.{' '}
            <button type="button" className="link-btn" onClick={() => setEditingGoal(true)}>
              Set your daily goal
            </button>
          </p>
        )}
        {editingGoal && <GoalForm settings={settings} onDone={() => setEditingGoal(false)} />}
      </div>
      <div className="nut-macro-panel">
        <p className="mono">Macros today</p>
        <MacroBar macros={totals.eaten} />
      </div>
    </section>
  );
}

function GoalForm({ settings, onDone }: { settings: NutritionSettings; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(String(settings.kcalGoal));
  const goal = Number(value);
  const valid = Number.isInteger(goal) && goal >= MIN_KCAL_GOAL && goal <= MAX_KCAL_GOAL;
  const save = useMutation({
    mutationFn: () => api.setKcalGoal(goal),
    onSuccess: () => {
      refreshNutrition(queryClient);
      onDone();
    },
  });
  return (
    <form
      className="nut-goal-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !save.isPending) save.mutate();
      }}
    >
      <label htmlFor="kcal-goal">Daily goal (kcal)</label>
      <div className="nut-inline">
        <input id="kcal-goal" className="input" inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value.replace(/\D/g, ''))} autoFocus />
        <button type="submit" className="btn btn-sm btn-primary" disabled={!valid || save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
      {!valid && value !== '' && (
        <p className="field-error">
          Between {num(MIN_KCAL_GOAL)} and {num(MAX_KCAL_GOAL)} kcal.
        </p>
      )}
      {save.isError && (
        <p className="field-error" role="alert">
          Not saved. {save.error.message}
        </p>
      )}
    </form>
  );
}

/** Type a meal, a workout or a weight straight into the section, or log today's weight by hand. */
function QuickLog({ day }: { day: string }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [kg, setKg] = useState('');
  const base = () => ({ clientId: crypto.randomUUID(), capturedAt: Date.now(), timeZone: deviceZone, ...(day !== todayHere() ? { day } : {}) });
  const read = useMutation({
    mutationFn: (value: string) => api.logNutrition({ ...base(), text: value }),
    onSuccess: () => {
      setText('');
      refreshNutrition(queryClient);
    },
  });
  const weigh = useMutation({
    mutationFn: (value: number) => api.logNutrition({ ...base(), weightKg: value }),
    onSuccess: () => {
      setKg('');
      refreshNutrition(queryClient);
    },
  });
  const weight = Number(kg.replace(',', '.'));
  const weightOk = kg !== '' && Number.isFinite(weight) && weight >= 25 && weight <= 300;

  function submitText(e: FormEvent) {
    e.preventDefault();
    if (text.trim() && !read.isPending) read.mutate(text.trim());
  }

  return (
    <section className="nut-quick" aria-label="Log something">
      <form className="nut-quick-text" onSubmit={submitText}>
        <label htmlFor="nut-log" className="sr-only">
          Log a meal or a workout
        </label>
        <input
          id="nut-log"
          className="input"
          placeholder={deviceLabel() === 'desktop' ? 'Log a meal or a workout: poulet riz ce midi, 45 min de vélo…' : 'Log a meal or a workout'}
          value={text}
          maxLength={4000}
          autoComplete="off"
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className="btn btn-sm btn-primary" disabled={!text.trim() || read.isPending}>
          {read.isPending ? 'Reading…' : 'Log'}
        </button>
      </form>
      <form
        className="nut-quick-weight"
        onSubmit={(e) => {
          e.preventDefault();
          if (weightOk && !weigh.isPending) weigh.mutate(weight);
        }}
      >
        <label htmlFor="nut-weight">
          <Scale size={16} aria-hidden="true" /> Weight
        </label>
        <span className="nut-num-box">
          <input id="nut-weight" className="input" inputMode="decimal" placeholder="78.4" value={kg} autoComplete="off" onChange={(e) => setKg(e.target.value.replace(/[^0-9.,]/g, ''))} />
          <span className="nut-unit">kg</span>
        </span>
        <button type="submit" className="btn btn-sm" disabled={!weightOk || weigh.isPending}>
          {weigh.isPending ? 'Saving…' : 'Save'}
        </button>
      </form>
      {(read.isError || weigh.isError) && (
        <p className="field-error" role="alert">
          {(read.error ?? weigh.error)!.message}
        </p>
      )}
    </section>
  );
}

function Entries({ data }: { data: NutritionDay }) {
  const [open, setOpen] = useState<string | null>(null);
  const meals = data.entries.filter((e): e is Extract<NutritionEntry, { type: 'meal' }> => e.type === 'meal');
  const workouts = data.entries.filter((e) => e.type === 'workout');
  const weights = data.entries.filter((e) => e.type === 'weight');
  const groups = [
    ...MEAL_SLOTS.map((slot) => ({ key: slot, title: SLOT_LABEL[slot], icon: Utensils, entries: meals.filter((m) => m.data.slot === slot) as NutritionEntry[] })),
    { key: 'workouts', title: 'Workouts', icon: Dumbbell, entries: workouts },
    { key: 'weight', title: 'Weight', icon: Scale, entries: weights },
  ].filter((g) => g.entries.length > 0);

  if (groups.length === 0) {
    return (
      <p className="empty nut-empty">
        {data.pending.length > 0
          ? 'Nothing counted for this day yet.'
          : 'Nothing logged for this day. Say or type what you ate, take a photo of your plate, or log a workout: it shows up here to confirm.'}
      </p>
    );
  }

  return (
    <section className="nut-section" aria-label="Entries of the day">
      {groups.map((group) => {
        const kcal = group.entries.reduce((n, e) => n + entryKcal(e), 0);
        return (
          <div key={group.key} className="nut-group">
            <h2 className="nut-section-title">
              <group.icon size={16} aria-hidden="true" /> {group.title}
              {group.key !== 'weight' && (
                <span className="mono">
                  {group.key === 'workouts' ? '−' : ''}
                  {num(kcal)} kcal
                </span>
              )}
            </h2>
            <div className="list">
              {group.entries.map((entry) => (
                <div key={entry.id} className="nut-row-wrap">
                  <button type="button" className="list-item nut-row" aria-expanded={open === entry.id} onClick={() => setOpen(open === entry.id ? null : entry.id)}>
                    {entry.hasPhoto && <img className="nut-thumb" src={`/api/nutrition/entries/${entry.id}/photo`} alt="" loading="lazy" />}
                    <span className="grow">
                      <span className="nut-row-title">{entry.type === 'weight' ? 'Weigh-in' : entry.title}</span>
                      <span className="nut-row-sub">{rowDetail(entry)}</span>
                    </span>
                    <span className="nut-row-kcal">{rowValue(entry)}</span>
                    <ChevronDown size={16} aria-hidden="true" className="nut-row-chevron" />
                  </button>
                  {open === entry.id && (
                    <div className="nut-row-edit">
                      {/* Saved or deleted: the row closes, which is the confirmation. */}
                      <NutritionCard key={entry.updatedAt} entry={entry} onChange={() => setOpen(null)} onDeleted={() => setOpen(null)} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function rowDetail(entry: NutritionEntry): string {
  const time = clockTime(entry.occurredAt);
  if (entry.type === 'meal') {
    const m = sumMacros((entry.data as MealData).items);
    return `${time} · P ${Math.round(m.protein)} · C ${Math.round(m.carbs)} · F ${Math.round(m.fat)} g`;
  }
  if (entry.type === 'workout') return `${time} · ${(entry.data as WorkoutData).minutes} min`;
  return time;
}

function rowValue(entry: NutritionEntry): string {
  if (entry.type === 'weight') return `${(entry.data as WeightData).kg} kg`;
  return `${entry.type === 'workout' ? '−' : ''}${num(entryKcal(entry))} kcal`;
}

// ---------------------------------------------------------------------------------------
// Trends
// ---------------------------------------------------------------------------------------

function Trends({ range }: { range: (typeof RANGES)[number] }) {
  const query = useNutritionHistory(range);
  const data = query.data;
  const [showTable, setShowTable] = useState(false);

  const picker = (
    <div className="nut-ranges" role="group" aria-label="Period">
      {RANGES.map((r) => (
        <button key={r} type="button" className="cat-option" aria-pressed={r === range} onClick={() => navigate(href({ tab: 'trends', range: r }), { replace: true })}>
          {r} days
        </button>
      ))}
    </div>
  );

  if (query.isError) return <p className="empty">Could not load your history. Check your connection.</p>;
  if (!data) return picker;

  const byDay = new Map(data.days.map((d) => [d.day, d]));
  const days = Array.from({ length: range }, (_, i) => shiftDay(data.from, i));
  const logged = data.days.filter((d) => d.meals > 0);
  const weights = data.days.filter((d): d is HistoryDay & { weightKg: number } => d.weightKg !== null).map((d) => ({ day: d.day, kg: d.weightKg }));
  const goal = data.settings.kcalGoal;
  const average = logged.length ? logged.reduce((n, d) => n + d.kcal, 0) / logged.length : 0;
  const averageMacros = logged.length
    ? { kcal: average, protein: avg(logged, 'protein'), carbs: avg(logged, 'carbs'), fat: avg(logged, 'fat') }
    : { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  const workouts = data.days.reduce((n, d) => n + d.workouts, 0);
  const burned = data.days.reduce((n, d) => n + d.burned, 0);
  const weightChange = weights.length >= 2 ? weights[weights.length - 1]!.kg - weights[0]!.kg : null;

  return (
    <>
      {picker}
      <dl className="nut-tiles">
        <div>
          <dt>Average eaten</dt>
          <dd>{logged.length ? `${num(average)} kcal` : '–'}</dd>
          <p>{logged.length ? `per day, over ${logged.length} logged ${logged.length === 1 ? 'day' : 'days'}` : 'no meal logged yet'}</p>
        </div>
        <div>
          <dt>Against your goal</dt>
          <dd>{logged.length ? `${signed(Math.round(average - goal))} kcal` : '–'}</dd>
          <p>goal {num(goal)} kcal a day</p>
        </div>
        <div>
          <dt>Weight</dt>
          <dd>{weights.length ? `${weights[weights.length - 1]!.kg} kg` : '–'}</dd>
          <p>{weightChange === null ? (weights.length ? 'one weigh-in so far' : 'no weigh-in yet') : `${signed(weightChange)} kg over the period`}</p>
        </div>
        <div>
          <dt>Workouts</dt>
          <dd>{workouts}</dd>
          <p>{workouts ? `${num(burned)} kcal burned` : 'none logged'}</p>
        </div>
      </dl>

      <section className="nut-chart-card" aria-labelledby="chart-kcal">
        <h2 id="chart-kcal">Calories eaten per day</h2>
        <p className="hint">Against your daily goal. Days without a bar have nothing logged.</p>
        <CaloriesChart points={days.map((day) => ({ day, kcal: byDay.get(day)?.meals ? byDay.get(day)!.kcal : null, burned: byDay.get(day)?.burned ?? 0 }))} goal={goal} />
      </section>

      <div className="nut-chart-grid">
        <section className="nut-chart-card" aria-labelledby="chart-weight">
          <h2 id="chart-weight">Weight</h2>
          {weights.length >= 2 ? (
            <>
              <p className="hint">In kg. The scale frames your values; it does not start at zero.</p>
              <WeightChart points={weights} from={data.from} to={data.to} />
            </>
          ) : (
            <p className="empty">{weights.length === 1 ? `${weights[0]!.kg} kg on ${dayLabel(weights[0]!.day)}. The curve appears with a second weigh-in.` : 'No weigh-in over this period. Say “je pèse 78,4” or type it in the Day view.'}</p>
          )}
        </section>
        <section className="nut-chart-card" aria-labelledby="chart-macros">
          <h2 id="chart-macros">Macros</h2>
          <p className="hint">Daily average over the logged days, and the share of the energy each one brings.</p>
          <MacroBar macros={averageMacros} perDay />
        </section>
      </div>

      <section className="nut-section" aria-labelledby="days-table">
        <h2 id="days-table" className="nut-section-title">
          Day by day
          <button type="button" className="link-btn" onClick={() => setShowTable((v) => !v)} aria-expanded={showTable}>
            {showTable ? 'Hide the table' : 'Show the table'}
          </button>
        </h2>
        {showTable && (
          <div className="nut-table-wrap">
            <table className="nut-table">
              <thead>
                <tr>
                  <th scope="col">Day</th>
                  <th scope="col">Eaten</th>
                  <th scope="col">Burned</th>
                  <th scope="col">Balance</th>
                  <th scope="col">P / C / F (g)</th>
                  <th scope="col">Weight</th>
                </tr>
              </thead>
              <tbody>
                {[...data.days].reverse().map((d) => (
                  <tr key={d.day}>
                    <th scope="row">
                      <button type="button" className="link-btn" onClick={() => navigate(href({ day: d.day }))}>
                        {dayLabel(d.day)}
                      </button>
                    </th>
                    <td>{d.meals ? num(d.kcal) : '–'}</td>
                    <td>{d.burned ? num(d.burned) : '–'}</td>
                    <td>{d.meals ? balanceText(goal - d.kcal + d.burned).replace(' kcal', '').replace(' the goal', '') : '–'}</td>
                    <td>{d.meals ? `${Math.round(d.protein)} / ${Math.round(d.carbs)} / ${Math.round(d.fat)}` : '–'}</td>
                    <td>{d.weightKg ?? '–'}</td>
                  </tr>
                ))}
                {data.days.length === 0 && (
                  <tr>
                    <td colSpan={6}>Nothing logged over this period.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function avg(days: HistoryDay[], key: 'protein' | 'carbs' | 'fat'): number {
  return days.reduce((n, d) => n + d[key], 0) / days.length;
}
