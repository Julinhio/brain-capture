import type { Category } from '../../shared/categories';
import { catProps, useCategories } from '../lib/categories';
import { CategoryIcon } from './CategoryIcon';

export function CategoryOptions({ value, onChange }: { value: Category; onChange: (c: Category) => void }) {
  const { list } = useCategories();
  return (
    <div className="cat-options" role="group" aria-label="Category">
      {list.map((c) => (
        <button
          key={c.id}
          type="button"
          className="cat-option"
          {...catProps(c)}
          aria-pressed={c.id === value}
          onClick={() => onChange(c.id)}
        >
          <CategoryIcon category={c.id} />
          {c.name}
        </button>
      ))}
    </div>
  );
}
