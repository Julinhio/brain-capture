import { Blocks, BriefcaseBusiness, GraduationCap, Inbox, Orbit, Workflow } from 'lucide-react';
import type { Category } from '../../shared/categories';

const icons = {
  jobs: BriefcaseBusiness,
  automata: Workflow,
  projects: Blocks,
  learning: GraduationCap,
  lifestyle: Orbit,
  other: Inbox,
} satisfies Record<Category, typeof Inbox>;

export function CategoryIcon({ category }: { category: Category }) {
  const Icon = icons[category];
  return <Icon className="category-icon" size={18} strokeWidth={1.7} aria-hidden="true" />;
}
