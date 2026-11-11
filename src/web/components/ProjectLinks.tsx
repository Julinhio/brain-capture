import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderPlus } from 'lucide-react';
import { api } from '../lib/api';
import { navigate } from '../lib/router';

export function ProjectLinks({ captureId }: { captureId: string }) {
  const qc = useQueryClient();
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const links = useQuery({
    queryKey: ['projects', 'capture', captureId],
    queryFn: () => api.captureProjects(captureId),
  });
  const mutation = useMutation({
    mutationFn: ({ id, linked }: { id: string; linked: boolean }) => api.linkProject(id, captureId, linked),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['projects'] });
      void qc.invalidateQueries({ queryKey: ['captures', 'today'] });
    },
  });
  return (
    <section className="block" aria-label="Linked projects">
      <div className="block-head">
        <span className="mono">Linked projects</span>
        <button type="button" className="btn btn-sm" onClick={() => navigate(`/?view=workspace&from=${captureId}`)}>
          <FolderPlus size={15} aria-hidden="true" />
          Create a project
        </button>
      </div>
      {projects.isPending || links.isPending ? (
        <p className="hint">Loading…</p>
      ) : projects.isError || links.isError ? (
        <p className="field-error">Projects could not be loaded.</p>
      ) : projects.data?.length ? (
        <div className="project-link-options">
          {projects.data.map((p) => (
            <label key={p.id}>
              <input
                type="checkbox"
                checked={links.data?.includes(p.id) ?? false}
                disabled={mutation.isPending}
                onChange={(e) => mutation.mutate({ id: p.id, linked: e.target.checked })}
              />
              {p.name}
            </label>
          ))}
        </div>
      ) : (
        <p className="hint">Group several captures around one project.</p>
      )}
      {mutation.isError && (
        <p className="field-error" role="alert">
          Link not changed. {mutation.error.message}
        </p>
      )}
    </section>
  );
}
