import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RadarSummary } from '../../shared/dashboard.js';
import type { AppDeps } from '../app.js';

const metric = z.object({ key: z.string().max(50), label: z.string().max(100), value: z.number().int().nonnegative() });
export const radarPayload = z
  .object({
    version: z.literal(1),
    checkedAt: z.iso.datetime(),
    total: z.number().int().nonnegative(),
    new24h: z.number().int().nonnegative(),
    segments: z.array(metric).max(20),
    extra: z.array(metric).max(20),
  })
  .refine((p) => p.segments.reduce((sum, m) => sum + m.value, 0) === p.total, 'Inconsistent total');

export function registerRadarRoutes(app: FastifyInstance, { config }: AppDeps) {
  const readers = Object.fromEntries(
    (['jobs', 'automata'] as const).map((kind) => {
      const source = config.radars[kind];
      let cached: RadarSummary | null = null;
      let until = 0;
      let pending: Promise<RadarSummary> | null = null;
      const load = async (): Promise<RadarSummary> => {
        const empty = { checkedAt: null, url: source.url, total: null, new24h: null, segments: [], extra: [] };
        if (!source.url || !source.token) return { ...empty, state: 'unconfigured' };
        try {
          const url = new URL('/integrations/brain-summary.json', source.url);
          const response = await fetch(url, {
            headers: { Authorization: `Bearer ${source.token}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(10_000),
            redirect: 'error',
          });
          if (!response.ok) throw new Error('Source unavailable');
          const text = await response.text();
          if (text.length > 32_000) throw new Error('Unexpected source payload');
          const { version: _version, ...body } = radarPayload.parse(JSON.parse(text));
          return { ...body, state: 'ready', url: source.url };
        } catch {
          return { ...empty, state: 'error' };
        }
      };
      const read = async () => {
        if (cached && Date.now() < until) return cached;
        pending ??= load()
          .then((value) => {
            cached = value;
            until = Date.now() + (value.state === 'error' ? 15_000 : 60_000);
            return value;
          })
          .finally(() => {
            pending = null;
          });
        return pending;
      };
      return [kind, read];
    }),
  ) as Record<'jobs' | 'automata', () => Promise<RadarSummary>>;
  app.get('/api/radars', async (_req, reply) => {
    const [jobs, automata] = await Promise.all([readers.jobs(), readers.automata()]);
    reply.header('Cache-Control', 'no-store');
    return { jobs, automata };
  });
}
