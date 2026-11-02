export const CATEGORIES = ['jobs', 'automata', 'projects', 'learning', 'lifestyle', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  jobs: 'Jobs',
  automata: 'Automata',
  projects: 'Projects',
  learning: 'Learning',
  lifestyle: 'Lifestyle',
  other: 'Other',
};

// Shown on the desktop section headers, and reused verbatim in the classifier prompt
// so what Julien reads and what the model is told never drift apart.
export const CATEGORY_HINTS: Record<Category, string> = {
  jobs: 'Offers & applications',
  automata: 'Agency prospects & ideas',
  projects: 'Tools, agents, small products',
  learning: 'Courses, concepts, resources',
  lifestyle: 'Personal tasks & interests',
  other: 'Not sure where these go',
};

export function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value);
}
