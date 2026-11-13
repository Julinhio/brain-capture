// Categories are data: each owner has their own list, editable in the app (name and a short
// description of what goes in it). The classifier reads the descriptions, so a new category is
// sortable without touching the code. Other is fixed: it can be neither renamed nor deleted,
// because it is where everything the model cannot place ends up.

/** A category id: stable for its whole life, renaming never changes it. */
export type Category = string;

export const OTHER: Category = 'other';

export interface CategoryInfo {
  id: Category;
  name: string;
  /** What goes in it, in Julien's words. Read by the classifier. */
  description: string;
  /** Null for the original categories, which use their theme colour. */
  color: string | null;
  position: number;
}

export const MAX_CATEGORY_NAME = 40;
export const MAX_CATEGORY_DESCRIPTION = 400;
export const MAX_CATEGORIES = 30;

/**
 * The starting list. Migration 0004 seeds the same rows for every account (existing ones, and
 * new ones through a trigger): keep the two in step. Each description is what the classifier
 * prompt said of the category before categories became editable: its short subtitle, then its
 * guide. Both matter: with the guide alone, an introduction to a firm that still types its
 * invoices by hand went to Jobs instead of Automata (Groq, 13/11/2026).
 */
export const DEFAULT_CATEGORIES: readonly CategoryInfo[] = [
  {
    id: 'jobs',
    name: 'Jobs',
    description: 'Offers & applications. His own job search: job offers, job boards, recruiters, applications, interviews, CV, follow-ups with employers.',
    color: null,
    position: 0,
  },
  {
    id: 'automata',
    name: 'Automata',
    description:
      'Agency prospects & ideas. Automata, his automation and AI agency: prospects, client leads, sales pitches, offers and pricing for clients, agency website and marketing.',
    color: null,
    position: 1,
  },
  {
    id: 'projects',
    name: 'Projects',
    description: 'Tools, agents, small products. Things he builds for himself: personal tools, apps, agents, side projects, small products, technical ideas to implement.',
    color: null,
    position: 2,
  },
  {
    id: 'learning',
    name: 'Learning',
    description: 'Courses, concepts, resources. Learning material: courses, tutorials, articles, docs, concepts, books, talks, certifications to study.',
    color: null,
    position: 3,
  },
  {
    id: 'lifestyle',
    name: 'Lifestyle',
    description: 'Personal tasks & interests. Personal life: errands, sport, health, family, friends, home, travel, admin paperwork, hobbies.',
    color: null,
    position: 4,
  },
  {
    id: OTHER,
    name: 'Other',
    description: 'Not sure where these go. Anything ambiguous, too short to tell, or fitting none of the above. When in doubt, choose other.',
    color: null,
    position: 1000,
  },
];

/** Colours handed to new categories, the first one not already taken. */
export const NEW_CATEGORY_COLORS = ['#7fa8f5', '#b48cf2', '#5cc8c0', '#e8a25a', '#c3d36a', '#ef8fc5', '#8fd0f0', '#d9b38c'];

/**
 * Words a new category id may not take: they already mean something in the app's addresses
 * (`/?view=done`, the History "All" filter...).
 */
export const RESERVED_CATEGORY_IDS = new Set(['all', 'open', 'done', 'archived', 'everything', 'workspace', 'today', 'categories', OTHER]);

export const CATEGORY_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function isCategoryId(value: unknown): value is Category {
  return typeof value === 'string' && CATEGORY_ID_RE.test(value);
}

/** Other always comes last, the rest in their order. */
export function sortCategories<T extends Pick<CategoryInfo, 'id' | 'position' | 'name'>>(list: readonly T[]): T[] {
  return [...list].sort(
    (a, b) => Number(a.id === OTHER) - Number(b.id === OTHER) || a.position - b.position || a.name.localeCompare(b.name),
  );
}

/** An id built from a name ("Santé & sport" → "sante-sport"), unique among `taken`. */
export function categoryIdFor(name: string, taken: Iterable<string>): Category {
  const used = new Set(taken);
  const base =
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32)
      .replace(/-+$/, '') || 'category';
  const free = (id: string) => !used.has(id) && !RESERVED_CATEGORY_IDS.has(id);
  if (free(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (free(id)) return id;
  }
}

/**
 * Reads a per-category value from a plain object keyed by category id. Own keys only: an id such
 * as "constructor" must never reach Object.prototype.
 */
export function byCategory<T>(record: Record<string, T> | undefined, id: Category): T | undefined {
  return record && Object.hasOwn(record, id) ? record[id] : undefined;
}
