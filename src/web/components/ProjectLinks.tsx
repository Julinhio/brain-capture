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
    <section className="block" aria-label="Projets liés">
      <div className="block-head">
        <span className="mono">Projets liés</span>
        <button type="button" className="btn btn-sm" onClick={() => navigate(`/?view=workspace&from=${captureId}`)}>
          <FolderPlus size={15} aria-hidden="true" />
          Créer un projet
        </button>
      </div>
      {projects.isPending || links.isPending ? (
        <p className="hint">Chargement…</p>
      ) : projects.isError || links.isError ? (
        <p className="field-error">Impossible de charger les projets.</p>
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
        <p className="hint">Rassemble plusieurs captures autour d’un même projet.</p>
      )}
      {mutation.isError && (
        <p className="field-error" role="alert">
          Lien non modifié. {mutation.error.message}
        </p>
      )}
    </section>
  );
}
