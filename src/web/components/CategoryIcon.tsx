import { Blocks, BriefcaseBusiness, GraduationCap, Inbox, Orbit, Tag, Workflow } from 'lucide-react';
import type { Category } from '../../shared/categories';

// The original categories keep their icons; any category added later gets a tag.
const icons: Record<string, typeof Inbox> = {
  jobs: BriefcaseBusiness,
  automata: Workflow,
  projects: Blocks,
  learning: GraduationCap,
  lifestyle: Orbit,
  other: Inbox,
};

export function CategoryIcon({ category }: { category: Category }) {
  // Own keys only: an id such as "constructor" must not reach Object.prototype.
  const Icon = Object.hasOwn(icons, category) ? icons[category]! : Tag;
  return <Icon className="category-icon" size={18} strokeWidth={1.7} aria-hidden="true" />;
}
