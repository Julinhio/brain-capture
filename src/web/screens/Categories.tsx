import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Lock, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { byCategory, MAX_CATEGORY_DESCRIPTION, MAX_CATEGORY_NAME, OTHER, type CategoryInfo } from '../../shared/categories';
import { CategoryIcon } from '../components/CategoryIcon';
import { api } from '../lib/api';
import { catProps, useCategories } from '../lib/categories';
import { useOverview } from '../lib/useCaptures';

/**
 * Rename, describe, add and delete categories. The sorting reads the descriptions, so a new
 * category is used for the next captures without any code change. Renaming moves nothing;
 * deleting archives the category's captures under Other. Other itself is fixed.
 */
export function Categories() {
  const categories = useCategories();
  const overview = useOverview();
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['categories'] });
    void qc.invalidateQueries({ queryKey: ['captures'] });
  };

  return (
    <div className="categories-page">
      <header className="desk-hello">
        <p className="mono">Sorting</p>
        <h1 className="list-title">Categories</h1>
        <p className="lead">
          Each capture is sorted into one of these. The sorting reads the descriptions: say what goes in each, in your own words.
        </p>
      </header>
      {categories.query.isError && <p className="field-error">Your categories could not be loaded. Showing the starting list.</p>}
      <div className="category-editor-list">
        {categories.list.map((c) =>
          c.id === OTHER ? (
            <OtherCard key={c.id} category={c} count={byCategory(overview.data?.counts, c.id)} />
          ) : (
            <CategoryCard
              key={`${c.id}:${c.name}:${c.description}`}
              category={c}
              count={byCategory(overview.data?.counts, c.id)}
              onChanged={refresh}
              disabled={!categories.query.isSuccess}
            />
          ),
        )}
      </div>
      <NewCategory onCreated={refresh} disabled={!categories.query.isSuccess} />
    </div>
  );
}

function OtherCard({ category, count }: { category: CategoryInfo; count?: number }) {
  return (
    <section className="category-editor" {...catProps(category)} aria-label={category.name}>
      <div className="category-editor-head">
        <span className="section-icon">
          <CategoryIcon category={category.id} />
        </span>
        <h2>{category.name}</h2>
        {count !== undefined && <span className="mono section-count">{count}</span>}
        <span className="hint category-fixed">
          <Lock size={13} aria-hidden="true" /> Fixed
        </span>
      </div>
      <p className="hint">{category.description}</p>
      <p className="hint">Everything the sorting cannot place lands here, so it can be neither renamed nor deleted.</p>
    </section>
  );
}

function CategoryCard({
  category,
  count,
  onChanged,
  disabled,
}: {
  category: CategoryInfo;
  count?: number;
  onChanged: () => void;
  disabled: boolean;
}) {
  const [name, setName] = useState(category.name);
  const [description, setDescription] = useState(category.description);
  const [confirming, setConfirming] = useState(false);
  const save = useMutation({
    mutationFn: () => api.updateCategory(category.id, { name: name.trim(), description: description.trim() }),
    onSuccess: onChanged,
  });
  const remove = useMutation({ mutationFn: () => api.deleteCategory(category.id), onSuccess: onChanged });
  const changed = name.trim() !== category.name || description.trim() !== category.description;
  const busy = save.isPending || remove.isPending || disabled;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (changed && name.trim() && !busy) save.mutate();
  };

  return (
    <section className="category-editor" {...catProps(category)} aria-label={category.name}>
      <form onSubmit={submit}>
        <div className="category-editor-head">
          <span className="section-icon">
            <CategoryIcon category={category.id} />
          </span>
          <label className="category-name">
            <span className="sr-only">Name</span>
            <input
              className="input"
              value={name}
              maxLength={MAX_CATEGORY_NAME}
              onChange={(e) => setName(e.target.value)}
              aria-label={`Name of ${category.name}`}
            />
          </label>
          {count !== undefined && (
            <span className="mono section-count" title="Open captures">
              {count}
            </span>
          )}
        </div>
        <label className="category-description">
          <span className="mono">What goes here</span>
          <textarea
            className="textarea"
            rows={3}
            value={description}
            maxLength={MAX_CATEGORY_DESCRIPTION}
            onChange={(e) => setDescription(e.target.value)}
            aria-label={`What goes in ${category.name}`}
          />
        </label>
        {(save.isError || remove.isError) && (
          <p className="field-error" role="alert">
            {(save.error ?? remove.error)?.message}
          </p>
        )}
        <div className="category-actions">
          {confirming ? (
            <span className="delete-confirm" role="group" aria-label={`Confirm deleting ${category.name}`}>
              <span className="delete-question">
                Delete {category.name}? Its captures{count ? ` (${count} open)` : ''} are archived and moved to Other.
              </span>
              <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => remove.mutate()}>
                {remove.isPending ? 'Deleting…' : 'Delete category'}
              </button>
              <button type="button" className="btn btn-sm btn-ghost" disabled={remove.isPending} onClick={() => setConfirming(false)} autoFocus>
                Cancel
              </button>
            </span>
          ) : (
            <>
              <button type="button" className="btn btn-sm btn-ghost btn-delete" disabled={busy} onClick={() => setConfirming(true)}>
                <Trash2 size={15} aria-hidden="true" /> Delete
              </button>
              {changed && (
                <>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    disabled={busy}
                    onClick={() => {
                      setName(category.name);
                      setDescription(category.description);
                    }}
                  >
                    Undo
                  </button>
                  <button type="submit" className="btn btn-sm btn-primary" disabled={!name.trim() || busy}>
                    {save.isPending ? 'Saving…' : 'Save'}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </form>
    </section>
  );
}

function NewCategory({ onCreated, disabled }: { onCreated: () => void; disabled: boolean }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const create = useMutation({
    mutationFn: () => api.createCategory({ name: name.trim(), description: description.trim() }),
    onSuccess: () => {
      setName('');
      setDescription('');
      onCreated();
    },
  });
  return (
    <section className="category-editor category-new" aria-labelledby="new-category-title">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && !create.isPending && !disabled) create.mutate();
        }}
      >
        <h2 id="new-category-title" className="category-new-title">
          <Plus size={18} aria-hidden="true" /> New category
        </h2>
        <label className="category-description">
          <span className="mono">Name</span>
          <input className="input" value={name} maxLength={MAX_CATEGORY_NAME} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="category-description">
          <span className="mono">What goes here</span>
          <textarea
            className="textarea"
            rows={3}
            value={description}
            maxLength={MAX_CATEGORY_DESCRIPTION}
            placeholder="For example: health, sport, doctors, sleep, nutrition."
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        {create.isError && (
          <p className="field-error" role="alert">
            {create.error.message}
          </p>
        )}
        <div className="category-actions">
          <span className="hint">Used for the next captures. Existing ones stay where they are.</span>
          <button type="submit" className="btn btn-sm btn-primary" disabled={!name.trim() || create.isPending || disabled}>
            {create.isPending ? 'Adding…' : 'Add category'}
          </button>
        </div>
      </form>
    </section>
  );
}
