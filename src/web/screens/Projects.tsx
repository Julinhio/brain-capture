import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, FolderKanban, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { PROJECT_LABELS, PROJECT_STATES, type Project, type ProjectState } from '../../shared/dashboard';
import { api } from '../lib/api';
import { navigate, useSearchParam } from '../lib/router';

export function Projects({ onOpen }: { onOpen: (id: string) => void }) {
  const query = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const from = useSearchParam('from');
  const selected = useSearchParam('project');
  const [creating, setCreating] = useState(false);
  const source = useQuery({
    queryKey: ['capture', from],
    queryFn: () => api.getCapture(from!),
    enabled: Boolean(from),
  });
  const project = query.data?.find((p) => p.id === selected);
  return (
    <div className="projects-page">
      <header className="today-heading">
        <div>
          <p className="mono">De l’idée au produit</p>
          <h1>Mes projets</h1>
          <p className="lead">Une place pour construire. Une réserve pour imaginer.</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
          <Plus size={18} aria-hidden="true" />
          Nouveau projet
        </button>
      </header>
      {query.isPending && <p role="status">Chargement des projets…</p>}
      {query.isError && (
        <p className="field-error" role="alert">
          Les projets n’ont pas pu être chargés.
        </p>
      )}
      {from && source.isPending && <p role="status">Chargement de la capture d’origine…</p>}
      {from && source.isError && (
        <p className="field-error" role="alert">
          La capture d’origine n’est pas disponible.{' '}
          <button type="button" className="link-btn" onClick={() => navigate('/?view=workspace')}>
            Revenir aux projets
          </button>
        </p>
      )}
      {(creating || (from && source.isSuccess) || project) && (
        <ProjectEditor
          key={project?.id ?? from ?? 'new'}
          project={project}
          captureId={from ?? undefined}
          initialName={source.data?.title ?? ''}
          onClose={() => {
            setCreating(false);
            navigate('/?view=workspace', { replace: true });
          }}
          onOpen={onOpen}
        />
      )}
      <div className="project-board">
        {PROJECT_STATES.map((state) => {
          const items = query.data?.filter((p) => p.state === state) ?? [];
          return (
            <section key={state} className="project-lane" data-state={state}>
              <h2>
                <span className="state-dot" />
                {PROJECT_LABELS[state]}
                <span className="mono">{items.length}</span>
              </h2>
              {items.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  className="project-tile"
                  onClick={() => {
                    setCreating(false);
                    navigate(`/?view=workspace&project=${p.id}`);
                  }}
                >
                  <strong>{p.name}</strong>
                  {p.intention && <span>{p.intention}</span>}
                  {p.nextStep && (
                    <span className="project-next">
                      <ArrowRight size={14} aria-hidden="true" />
                      {p.nextStep}
                    </span>
                  )}
                  <small>
                    {p.captureCount} capture{p.captureCount > 1 ? 's' : ''} liée{p.captureCount > 1 ? 's' : ''}
                  </small>
                </button>
              ))}
              {!items.length && query.isSuccess && (
                <p className="hint">{state === 'idea' ? 'Les idées peuvent attendre ici.' : 'Aucun projet.'}</p>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function ProjectEditor({
  project,
  captureId,
  initialName,
  onClose,
  onOpen,
}: {
  project?: Project;
  captureId?: string;
  initialName: string;
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(project?.name ?? initialName);
  const [intention, setIntention] = useState(project?.intention ?? '');
  const [state, setState] = useState<ProjectState>(project?.state ?? 'idea');
  const [nextStep, setNextStep] = useState(project?.nextStep ?? '');
  const [search, setSearch] = useState('');
  const linked = useQuery({
    queryKey: ['projects', project?.id, 'captures'],
    queryFn: () => api.projectCaptures(project!.id),
    enabled: Boolean(project),
  });
  const candidates = useQuery({
    queryKey: ['captures', 'project-search', search],
    queryFn: () => api.listCaptures({ q: search, status: 'all', limit: 20 }),
    enabled: Boolean(project && search.trim()),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['projects'] });
    void qc.invalidateQueries({ queryKey: ['captures', 'today'] });
  };
  const save = useMutation({
    mutationFn: () =>
      project
        ? api.updateProject(project.id, { name, intention, state, nextStep })
        : api.createProject({ name, intention, state, nextStep, ...(captureId ? { captureId } : {}) }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  const link = useMutation({
    mutationFn: ({ id, linked }: { id: string; linked: boolean }) => api.linkProject(project!.id, id, linked),
    onSuccess: refresh,
  });
  return (
    <section className="project-editor" aria-label={project ? 'Modifier le projet' : 'Créer un projet'}>
      <div className="block-head">
        <h2>
          <FolderKanban size={20} aria-hidden="true" />
          {project ? 'Le projet' : 'Nouveau projet'}
        </h2>
        <button className="btn btn-sm" type="button" onClick={onClose} aria-label="Fermer le formulaire">
          <X size={16} />
        </button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!save.isPending) save.mutate();
        }}
      >
        <div className="project-form-grid">
          <label>
            Nom
            <input className="input" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            État
            <select
              aria-label="État"
              className="input"
              value={state}
              onChange={(e) => setState(e.target.value as ProjectState)}
            >
              {PROJECT_STATES.map((s) => (
                <option key={s} value={s}>
                  {PROJECT_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Intention
          <textarea
            className="textarea"
            maxLength={2000}
            value={intention}
            onChange={(e) => setIntention(e.target.value)}
            placeholder="Quel besoin ce projet va-t-il résoudre ?"
          />
        </label>
        <label>
          Prochaine étape <span className="hint">facultative</span>
          <input
            className="input"
            maxLength={500}
            value={nextStep}
            onChange={(e) => setNextStep(e.target.value)}
            placeholder="Un prochain pas concret, quand tu seras prêt."
          />
        </label>
        {captureId && <p className="hint">La capture d’origine sera liée à ce projet.</p>}
        {save.isError && (
          <p className="field-error" role="alert">
            Non enregistré. {save.error.message}
          </p>
        )}
        <div className="sheet-actions">
          <button type="button" className="btn" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" className="btn btn-primary" disabled={save.isPending || !name.trim()}>
            {save.isPending ? 'Enregistrement…' : 'Enregistrer le projet'}
          </button>
        </div>
      </form>
      {project && (
        <div className="project-notes">
          <h3>Captures liées</h3>
          {linked.isError && <p className="field-error">Impossible de charger les captures.</p>}
          {linked.data?.map((c) => (
            <div className="project-note" key={c.id}>
              <button type="button" className="link-btn" onClick={() => onOpen(c.id)}>
                {c.title ?? c.text.slice(0, 80)}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={link.isPending}
                onClick={() => link.mutate({ id: c.id, linked: false })}
              >
                Détacher
              </button>
            </div>
          ))}
          {!linked.data?.length && linked.isSuccess && <p className="hint">Aucune capture liée.</p>}
          <label>
            Ajouter une capture
            <input
              className="input"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Rechercher dans toutes les captures"
            />
          </label>
          {candidates.isError && <p className="field-error">Recherche indisponible.</p>}
          {candidates.data?.captures
            .filter((c) => !linked.data?.some((l) => l.id === c.id))
            .map((c) => (
              <div className="project-note" key={c.id}>
                <span>{c.title ?? c.text.slice(0, 80)}</span>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={link.isPending}
                  onClick={() => link.mutate({ id: c.id, linked: true })}
                >
                  <Plus size={14} aria-hidden="true" />
                  Lier
                </button>
              </div>
            ))}
          {link.isError && (
            <p className="field-error" role="alert">
              Lien non modifié. {link.error.message}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
