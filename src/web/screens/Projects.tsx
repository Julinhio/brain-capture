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
          <p className="mono">From idea to product</p>
          <h1>My projects</h1>
          <p className="lead">A place to build. A reserve to imagine.</p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            navigate('/?view=workspace');
            setCreating(true);
          }}
        >
          <Plus size={18} aria-hidden="true" />
          New project
        </button>
      </header>
      {query.isPending && <p role="status">Loading projects…</p>}
      {query.isError && (
        <p className="field-error" role="alert">
          Projects could not be loaded.
        </p>
      )}
      {from && source.isPending && <p role="status">Loading the original capture…</p>}
      {from && source.isError && (
        <p className="field-error" role="alert">
          The original capture is not available.{' '}
          <button type="button" className="link-btn" onClick={() => navigate('/?view=workspace')}>
            Back to projects
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
                    {p.captureCount} linked capture{p.captureCount === 1 ? '' : 's'}
                  </small>
                </button>
              ))}
              {!items.length && query.isSuccess && (
                <p className="hint">{state === 'idea' ? 'Ideas can wait here.' : 'No projects.'}</p>
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
    <section className="project-editor" aria-label={project ? 'Edit the project' : 'Create a project'}>
      <div className="block-head">
        <h2>
          <FolderKanban size={20} aria-hidden="true" />
          {project ? 'Project' : 'New project'}
        </h2>
        <button className="btn btn-sm" type="button" onClick={onClose} aria-label="Close the form">
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
            Name
            <input className="input" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            State
            <select
              aria-label="State"
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
            placeholder="What need will this project meet?"
          />
        </label>
        <label>
          Next step <span className="hint">optional</span>
          <input
            className="input"
            maxLength={500}
            value={nextStep}
            onChange={(e) => setNextStep(e.target.value)}
            placeholder="A concrete next step, when you are ready."
          />
        </label>
        {captureId && <p className="hint">The original capture will be linked to this project.</p>}
        {save.isError && (
          <p className="field-error" role="alert">
            Not saved. {save.error.message}
          </p>
        )}
        <div className="sheet-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={save.isPending || !name.trim()}>
            {save.isPending ? 'Saving…' : 'Save project'}
          </button>
        </div>
      </form>
      {project && (
        <div className="project-notes">
          <h3>Linked captures</h3>
          {linked.isError && <p className="field-error">Captures could not be loaded.</p>}
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
                Unlink
              </button>
            </div>
          ))}
          {!linked.data?.length && linked.isSuccess && <p className="hint">No linked captures.</p>}
          <label>
            Add a capture
            <input
              className="input"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search all captures"
            />
          </label>
          {candidates.isError && <p className="field-error">Search unavailable.</p>}
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
                  Link
                </button>
              </div>
            ))}
          {link.isError && (
            <p className="field-error" role="alert">
              Link not changed. {link.error.message}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
