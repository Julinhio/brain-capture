import { CATEGORIES, CATEGORY_LABELS, type Category } from '../../shared/categories';

export function CategoryOptions({ value, onChange }: { value: Category; onChange: (c: Category) => void }) {
  return (
    <div className="cat-options" role="group" aria-label="Category">
      {CATEGORIES.map((c) => (
        <button
          key={c}
          type="button"
          className="cat-option"
          data-cat={c}
          aria-pressed={c === value}
          onClick={() => onChange(c)}
        >
          <span className="cat-dot" aria-hidden="true" />
          {CATEGORY_LABELS[c]}
        </button>
      ))}
    </div>
  );
}
