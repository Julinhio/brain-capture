import { useMutation } from '@tanstack/react-query';
import { Check, Dumbbell, Plus, Scale, StickyNote, Trash2, Utensils, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  MAX_ITEMS,
  MEAL_SLOTS,
  SLOT_LABEL,
  SOURCE_LABEL,
  dataProblem,
  sumMacros,
  withGrams,
  withValue,
  workoutKcal,
  type FoodItem,
  type Macros,
  type MealData,
  type NutritionData,
  type NutritionEntry,
  type WeightData,
  type WorkoutData,
} from '../../shared/nutrition';
import type { Capture } from '../../shared/types';
import { api } from '../lib/api';
import { todayHere, useDeleteEntry, useEntryToNote, useUpdateEntry } from '../lib/useNutrition';

const TYPE_LABEL = { meal: 'Meal', workout: 'Workout', weight: 'Weight' } as const;
const TYPE_ICON = { meal: Utensils, workout: Dumbbell, weight: Scale } as const;

export function dayLabel(day: string, today = todayHere()): string {
  if (day === today) return 'Today';
  const date = new Date(`${day}T12:00:00Z`);
  const label = date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  return Date.parse(`${today}T12:00:00Z`) - date.getTime() === 86_400_000 ? `Yesterday, ${label}` : label;
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/**
 * A number being typed keeps its own text ("78," or "" mid-edit) and only hands a value up
 * when it is one. Without this, the field would snap back to the last valid number at every
 * keystroke.
 */
function NumberField({
  value,
  onChange,
  label,
  unit,
  step = 1,
  max,
  id,
}: {
  value: number;
  onChange: (value: number) => void;
  label: string;
  unit?: string;
  step?: number;
  max?: number;
  id?: string;
}) {
  const [text, setText] = useState(fmt(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(fmt(value));
  }, [value, focused]);
  return (
    <label className="nut-num">
      <span>{label}</span>
      <span className="nut-num-box">
        <input
          id={id}
          className="input"
          inputMode="decimal"
          autoComplete="off"
          value={text}
          onFocus={(e) => {
            setFocused(true);
            e.currentTarget.select();
          }}
          onBlur={() => setFocused(false)}
          onChange={(e) => {
            const raw = e.target.value.replace(/[^0-9.,]/g, '');
            setText(raw);
            const n = Number(raw.replace(',', '.'));
            // Past the bound, the bound: what is saved is never something other than what the field ends up showing.
            if (raw !== '' && Number.isFinite(n) && n >= 0) onChange(Math.min(step >= 1 ? Math.round(n) : n, max ?? Infinity));
          }}
        />
        {unit && <span className="nut-unit">{unit}</span>}
      </span>
    </label>
  );
}

function MacroLine({ m }: { m: Macros }) {
  return (
    <span className="nut-macros">
      <span>
        <i className="macro-dot" data-macro="protein" aria-hidden="true" /> P {fmt(m.protein)} g
      </span>
      <span>
        <i className="macro-dot" data-macro="carbs" aria-hidden="true" /> C {fmt(m.carbs)} g
      </span>
      <span>
        <i className="macro-dot" data-macro="fat" aria-hidden="true" /> F {fmt(m.fat)} g
      </span>
    </span>
  );
}

/**
 * What was understood from a capture (foods, quantities, calories, macros; or a workout; or a
 * weight), editable, and counted in the day with one tap. Same card once confirmed, to correct
 * or delete an entry later. Nothing is counted while it says "To confirm".
 */
export function NutritionCard({
  entry,
  onChange,
  onDeleted,
  onNote,
  stickyActions = false,
}: {
  entry: NutritionEntry;
  onChange?: (entry: NutritionEntry) => void;
  onDeleted?: () => void;
  /** The entry was turned into a note: it no longer exists here. */
  onNote?: (capture: Capture) => void;
  /** Phone, right after a capture: the buttons stay at the bottom of the screen, one tap away. */
  stickyActions?: boolean;
}) {
  const [data, setData] = useState<NutritionData>(entry.data);
  const [title, setTitle] = useState(entry.title);
  const [day, setDay] = useState(entry.day);
  const [editMacros, setEditMacros] = useState(false);
  const [askDelete, setAskDelete] = useState(false);
  const [adding, setAdding] = useState('');

  const update = useUpdateEntry(onChange);
  const remove = useDeleteEntry(onDeleted);
  const toNote = useEntryToNote(onNote);
  const estimate = useMutation({
    mutationFn: (text: string) => api.estimateFoods(text),
    onSuccess: (items) => {
      setData((d) => ({ ...(d as MealData), items: [...(d as MealData).items, ...items].slice(0, MAX_ITEMS) }));
      setAdding('');
    },
  });

  const proposed = entry.status === 'proposed';
  const dirty = JSON.stringify(data) !== JSON.stringify(entry.data) || title.trim() !== entry.title || day !== entry.day;
  const problem = dataProblem(entry.type, data) ?? (title.trim() ? null : 'Give it a name.');
  // A food being read counts as busy: saving now would store the meal without it.
  const busy = update.isPending || remove.isPending || toNote.isPending || estimate.isPending;
  const error = update.error ?? remove.error ?? toNote.error;
  const Icon = TYPE_ICON[entry.type];

  function save(confirm: boolean) {
    if (problem || busy) return;
    update.mutate({
      id: entry.id,
      patch: {
        ...(confirm ? { status: 'confirmed' as const } : {}),
        ...(JSON.stringify(data) !== JSON.stringify(entry.data) ? { data } : {}),
        ...(entry.type !== 'weight' && title.trim() !== entry.title ? { title: title.trim() } : {}),
        ...(day !== entry.day ? { day } : {}),
      },
    });
  }

  const meal = entry.type === 'meal' ? (data as MealData) : null;
  const setItem = (index: number, next: FoodItem) => setData((d) => ({ ...(d as MealData), items: (d as MealData).items.map((it, i) => (i === index ? next : it)) }));
  const workout = entry.type === 'workout' ? (data as WorkoutData) : null;

  return (
    <section className="nut-card" data-state={entry.status} data-type={entry.type} aria-label={`${TYPE_LABEL[entry.type]}: ${entry.title}`}>
      <header className="nut-card-head">
        <span className="nut-card-type">
          <Icon size={18} aria-hidden="true" /> {TYPE_LABEL[entry.type]}
        </span>
        <span className="nut-chip" data-state={entry.status}>
          {proposed ? 'To confirm' : `Counted · ${dayLabel(entry.day)}`}
        </span>
      </header>

      {entry.hasPhoto && <img className="nut-photo" src={`/api/nutrition/entries/${entry.id}/photo`} alt="" loading="lazy" />}

      <form
        className="nut-form"
        onSubmit={(e) => {
          e.preventDefault();
          save(proposed);
        }}
      >
        {entry.type !== 'weight' && (
          <label className="event-field">
            <span>Name</span>
            <input className="input" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
          </label>
        )}

        {meal && (
          <>
            <div className="nut-slots" role="group" aria-label="Meal">
              {MEAL_SLOTS.map((slot) => (
                <button key={slot} type="button" className="cat-option" aria-pressed={meal.slot === slot} onClick={() => setData({ ...meal, slot })}>
                  {SLOT_LABEL[slot]}
                </button>
              ))}
            </div>

            <ul className="nut-items">
              {meal.items.map((item, i) => (
                <li key={i} className="nut-item">
                  <div className="nut-item-name">
                    <input
                      className="input"
                      aria-label={`Food ${i + 1}`}
                      value={item.name}
                      maxLength={120}
                      onChange={(e) => setItem(i, { ...item, name: e.target.value })}
                    />
                    <button
                      type="button"
                      className="nut-remove"
                      aria-label={`Remove ${item.name || 'this food'}`}
                      onClick={() => setData({ ...meal, items: meal.items.filter((_, j) => j !== i) })}
                    >
                      <X size={16} aria-hidden="true" />
                    </button>
                  </div>
                  <div className="nut-item-values">
                    <NumberField label="Quantity" unit="g" value={item.grams} max={5000} onChange={(grams) => setItem(i, withGrams(item, grams))} />
                    <NumberField label="Energy" unit="kcal" value={item.kcal} max={10000} onChange={(kcal) => setItem(i, withValue(item, 'kcal', kcal))} />
                  </div>
                  {editMacros ? (
                    <div className="nut-item-values nut-item-macros">
                      <NumberField label="Protein" unit="g" step={0.1} value={item.protein} max={1000} onChange={(v) => setItem(i, withValue(item, 'protein', v))} />
                      <NumberField label="Carbs" unit="g" step={0.1} value={item.carbs} max={1000} onChange={(v) => setItem(i, withValue(item, 'carbs', v))} />
                      <NumberField label="Fat" unit="g" step={0.1} value={item.fat} max={1000} onChange={(v) => setItem(i, withValue(item, 'fat', v))} />
                    </div>
                  ) : (
                    <MacroLine m={item} />
                  )}
                  <p className="nut-source" data-source={item.source}>
                    {SOURCE_LABEL[item.source]}
                    {item.ref ? ` · ${item.ref}` : item.source === 'estimate' ? ' · no match in the food tables' : ''}
                  </p>
                </li>
              ))}
            </ul>

            <div className="nut-add">
              <label htmlFor={`add-${entry.id}`} className="sr-only">
                Add a food
              </label>
              <input
                id={`add-${entry.id}`}
                className="input"
                placeholder="Add a food: 1 yaourt nature"
                value={adding}
                maxLength={500}
                onChange={(e) => setAdding(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  if (adding.trim() && !estimate.isPending) estimate.mutate(adding.trim());
                }}
              />
              <button type="button" className="btn btn-sm" disabled={!adding.trim() || estimate.isPending || meal.items.length >= MAX_ITEMS} onClick={() => estimate.mutate(adding.trim())}>
                <Plus size={16} aria-hidden="true" /> {estimate.isPending ? 'Reading…' : 'Add'}
              </button>
            </div>
            {estimate.isError && (
              <p className="field-error" role="alert">
                {estimate.error.message}{' '}
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    setData({ ...meal, items: [...meal.items, { name: adding.trim(), grams: 100, kcal: 0, protein: 0, carbs: 0, fat: 0, per100: null, source: 'manual', ref: null }] });
                    setAdding('');
                    setEditMacros(true);
                    estimate.reset();
                  }}
                >
                  Add it by hand
                </button>
              </p>
            )}

            <div className="nut-total" aria-live="polite">
              <strong>{sumMacros(meal.items).kcal} kcal</strong>
              <MacroLine m={sumMacros(meal.items)} />
              <button type="button" className="link-btn" onClick={() => setEditMacros((v) => !v)}>
                {editMacros ? 'Hide macros' : 'Edit macros'}
              </button>
            </div>
          </>
        )}

        {workout && (
          <>
            <label className="event-field">
              <span>Activity</span>
              <input className="input" value={workout.activity} maxLength={120} onChange={(e) => setData({ ...workout, activity: e.target.value })} />
            </label>
            <div className="nut-item-values">
              <NumberField
                label="Duration"
                unit="min"
                value={workout.minutes}
                max={1440}
                onChange={(minutes) => setData({ ...workout, minutes, kcal: workout.met > 0 ? workoutKcal(workout.met, workout.weightKg, minutes) : workout.kcal })}
              />
              <NumberField label="Burned" unit="kcal" value={workout.kcal} max={10000} onChange={(kcal) => setData({ ...workout, kcal, met: 0 })} />
            </div>
            <p className="nut-source" data-source={workout.met > 0 ? 'estimate' : 'manual'}>
              {workout.met > 0 ? `Estimate · MET ${fmt(workout.met)} × ${fmt(workout.weightKg)} kg × ${workout.minutes} min` : 'Calories set by hand or given in the capture'}
            </p>
          </>
        )}

        {entry.type === 'weight' && (
          <div className="nut-item-values">
            <NumberField label="Weight" unit="kg" step={0.1} value={(data as WeightData).kg} max={300} onChange={(kg) => setData({ kg })} />
          </div>
        )}

        <label className="event-field nut-day">
          <span>Day</span>
          <input className="input" type="date" value={day} max={todayHere()} onChange={(e) => e.target.value && setDay(e.target.value)} />
        </label>

        {entry.originalText && entry.source !== 'manual' && (
          <p className="nut-said">
            <span className="mono">{entry.source === 'photo' ? 'Photo' : entry.source === 'voice' ? 'You said' : 'You wrote'}</span> {entry.originalText}
          </p>
        )}

        {(problem || error) && (
          <p className="field-error" role={error ? 'alert' : undefined}>
            {error ? `Not saved. ${error.message}` : problem}
          </p>
        )}

        {askDelete ? (
          <div className={`delete-confirm${stickyActions ? ' nut-actions-sticky' : ''}`} role="group" aria-label="Confirm deletion">
            <span className="delete-question">Delete this entry for good?</span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAskDelete(false)} disabled={busy} autoFocus>
              Cancel
            </button>
            <button type="button" className="btn btn-sm btn-danger" onClick={() => remove.mutate(entry.id)} disabled={busy}>
              <Trash2 size={16} aria-hidden="true" /> {remove.isPending ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        ) : (
          <div className={`nut-actions${stickyActions ? ' nut-actions-sticky' : ''}`}>
            <button type="button" className="btn btn-sm btn-ghost btn-delete nut-delete" onClick={() => setAskDelete(true)} disabled={busy} aria-label="Delete this entry" title="Delete">
              <Trash2 size={18} aria-hidden="true" />
            </button>
            {proposed && entry.source !== 'manual' && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => toNote.mutate(entry.id)} disabled={busy} title="This is not for Nutrition: keep it as a note">
                <StickyNote size={16} aria-hidden="true" /> {toNote.isPending ? 'Moving…' : 'It’s a note'}
              </button>
            )}
            {proposed ? (
              <button type="submit" className="btn btn-sm btn-primary" disabled={busy || Boolean(problem)}>
                <Check size={16} aria-hidden="true" /> {update.isPending ? 'Adding…' : day === todayHere() ? 'Add to my day' : `Add to ${dayLabel(day)}`}
              </button>
            ) : (
              <button type="submit" className="btn btn-sm btn-primary" disabled={busy || Boolean(problem) || !dirty}>
                {update.isPending ? 'Saving…' : 'Save changes'}
              </button>
            )}
          </div>
        )}
      </form>
    </section>
  );
}
