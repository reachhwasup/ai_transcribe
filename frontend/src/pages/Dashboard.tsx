import { useShallow } from 'zustand/react/shallow';
import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useProjectStore } from '../stores/projectStore';
import { ProjectListItem } from '../types';
import NewProjectsModal from '../components/NewProjectsModal';
import { APP_NAME, nameParts } from '../utils/names';
import { latestJob, STEP_SHORT, usePipelineStore, usePipelineWatch } from '../utils/pipelineWatch';
import type { PipelineJob } from '../api/client';
import {
  Plus,
  Trash2,
  Clock,
  FileText,
  Scissors,
  CheckSquare,
  Square,
  Check,
  Layers,
  Minus,
  ChevronUp,
  ChevronDown,
  Search,
  Film,
  FolderOpen,
  Calendar,
  AlertTriangle,
  Loader2,
  X,
  Mic,
} from 'lucide-react';

type Sort = 'recent' | 'name';
const VIEW_KEY = 'dashboard.view';

export default function Dashboard() {
  const navigate = useNavigate();
  const { projects, isLoading, loadProjects, createProject, deleteProject } = useProjectStore(useShallow(state => ({ projects: state.projects, isLoading: state.isLoading, loadProjects: state.loadProjects, createProject: state.createProject, deleteProject: state.deleteProject })));
  const [showCreate, setShowCreate] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState<ProjectListItem | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newLang, setNewLang] = useState('km');
  const [searchQuery, setSearchQuery] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  // One project per video in a folder
  const [showFolderImport, setShowFolderImport] = useState(false);
  // Splitting a long video into part projects
  const [showSplitUpload, setShowSplitUpload] = useState(false);
  // How the grid is ordered, remembered between visits
  const [sort, setSort] = useState<Sort>(() => {
    try { return (JSON.parse(localStorage.getItem(VIEW_KEY) || '{}').sort as Sort) || 'recent'; } catch { return 'recent'; }
  });
  useEffect(() => {
    try { localStorage.setItem(VIEW_KEY, JSON.stringify({ sort })); } catch { /* not remembered */ }
  }, [sort]);

  // Picking several projects to delete at once — useful after splitting a video into parts
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);
  // A series or a split is one card until it is opened; 80 episodes would otherwise bury
  // every other project in the grid.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);

  // the server's work on each project, shown on its card while it runs
  usePipelineWatch();
  const jobs = usePipelineStore((s) => s.jobs);
  const activeJob = (id: string): PipelineJob | undefined => {
    const job = latestJob(jobs, id);
    return job && (job.status === 'running' || job.status === 'queued' || job.status === 'review') ? job : undefined;
  };

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);
  // keep the cards' numbers moving while the server works
  const working = jobs.some((j) => j.status === 'running');
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void loadProjects(), 8000);
    return () => clearInterval(timer);
  }, [working, loadProjects]);

  const handleCreate = async () => {
    if (!newName.trim() || isCreating) return;
    setIsCreating(true);
    try {
      const project = await createProject(newName.trim(), newDesc.trim(), newLang);
      setShowCreate(false);
      setNewName('');
      setNewDesc('');
      navigate(`/project/${project.id}`, { state: { initialCenterTab: 'assets' } });
    } catch (e) {
      console.error(e);
    } finally {
      setIsCreating(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!projectToDelete || isDeleting) return;
    setIsDeleting(true);
    try {
      await deleteProject(projectToDelete.id);
      setProjectToDelete(null);
    } catch (e) {
      console.error('Delete project failed:', e);
    } finally {
      setIsDeleting(false);
    }
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const leaveSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  const selectedProjects = useMemo(
    () => projects.filter((p) => selectedIds.has(p.id)),
    [projects, selectedIds],
  );

  const handleBulkDelete = async () => {
    if (!selectedProjects.length || bulkProgress) return;
    setBulkProgress({ done: 0, total: selectedProjects.length });
    let failed = 0;
    for (const [i, project] of selectedProjects.entries()) {
      try {
        await deleteProject(project.id);
      } catch (e) {
        failed += 1;
        console.error(`Delete failed for ${project.name}:`, e);
      }
      setBulkProgress({ done: i + 1, total: selectedProjects.length });
    }
    setBulkProgress(null);
    setConfirmBulk(false);
    leaveSelectMode();
    if (failed) console.error(`${failed} project(s) could not be deleted`);
    await loadProjects();
  };

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const formatDuration = (s: number) => {
    if (!s) return '0:00';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '';
    try {
      // the server stores UTC without saying so; read it as UTC, not as local time
      const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(dateStr) ? dateStr : `${dateStr}Z`);
      const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
      if (days <= 0) return `Today ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      if (days === 1) return 'Yesterday';
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
    } catch {
      return '';
    }
  };

  /** Where a project has got to: its job on the server if it has one, else its captions and voices. */
  const projectStage = (p: ProjectListItem) => {
    const job = activeJob(p.id);
    if (job?.status === 'running') {
      return { label: `${STEP_SHORT[job.step] || 'Working'}${job.percent ? ` ${job.percent}%` : '…'}`, tone: 'blue', progress: (job.percent || 0) / 100, live: true };
    }
    if (job?.status === 'queued') return { label: 'In the queue', tone: 'zinc', progress: 0, live: true };
    if (job?.status === 'review') return { label: 'Needs a look', tone: 'amber', progress: 1, live: false };
    const subs = p.segment_count || 0;
    const dubbed = Math.min(p.dubbed_count || 0, subs);
    if (!p.video_filename && !p.duration) return { label: 'Empty', tone: 'zinc', progress: 0, live: false };
    if (!subs) return { label: 'Needs captions', tone: 'amber', progress: 0, live: false };
    if (dubbed >= subs) return { label: 'Dubbed', tone: 'emerald', progress: 1, live: false };
    // floored, so a project with one line left never reads "100%"
    if (dubbed > 0) return { label: `Dubbing ${Math.max(1, Math.floor((dubbed / subs) * 100))}%`, tone: 'blue', progress: dubbed / subs, live: false };
    return { label: 'Captioned', tone: 'violet', progress: 0, live: false };
  };
  const isDubbed = (p: ProjectListItem) => (p.segment_count || 0) > 0 && (p.dubbed_count || 0) >= (p.segment_count || 0);

  // Full class strings so Tailwind keeps them
  const TONES: Record<string, { pill: string; bar: string; glow: string; dot: string }> = {
    zinc: { pill: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20', bar: 'bg-zinc-500', glow: 'from-zinc-500/10', dot: 'bg-zinc-500' },
    amber: { pill: 'bg-amber-500/10 text-amber-300 border-amber-500/25', bar: 'bg-amber-500', glow: 'from-amber-500/10', dot: 'bg-amber-400' },
    violet: { pill: 'bg-violet-500/10 text-violet-300 border-violet-500/25', bar: 'bg-violet-500', glow: 'from-violet-500/10', dot: 'bg-violet-400' },
    blue: { pill: 'bg-blue-500/10 text-blue-300 border-blue-500/25', bar: 'bg-blue-500', glow: 'from-blue-500/10', dot: 'bg-blue-400' },
    emerald: { pill: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/25', bar: 'bg-emerald-500', glow: 'from-emerald-500/10', dot: 'bg-emerald-400' },
  };

  const filteredProjects = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const shown = projects.filter((p) => {
      if (q && !(
        p.name.toLowerCase().includes(q) ||
        (p.description || '').toLowerCase().includes(q) ||
        (p.video_filename || '').toLowerCase().includes(q)
      )) return false;
      return true;
    });
    // the server already keeps each series together and in order; by name keeps them so too
    return sort === 'name'
      ? [...shown].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      : shown;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, searchQuery, sort]);

  /** The grid is a mix of single projects and groups: the parts of a split, the videos of a
   *  folder, or episodes that share a series name. A group is one card until it is opened. */
  type GridItem =
    | { kind: 'project'; project: ProjectListItem }
    | { kind: 'group'; key: string; type: 'split' | 'series'; name: string; members: ProjectListItem[] };

  const gridItems = useMemo<GridItem[]>(() => {
    // a folder batch groups its videos; one that brought a single video joins the other
    // episodes of its series by name instead (the same series is often added a folder at a time)
    const batchSize = new Map<string, number>();
    for (const p of filteredProjects) if (p.batch_id) batchSize.set(p.batch_id, (batchSize.get(p.batch_id) || 0) + 1);
    const keyOf = (p: ProjectListItem): string => {
      if (p.part_count) return `split:${p.source_project_id || p.id}`;
      if (p.batch_id && (batchSize.get(p.batch_id) || 0) > 1) return `batch:${p.batch_id}`;
      const { head } = nameParts(p.name);
      return head ? `name:${head}` : '';
    };
    const families = new Map<string, ProjectListItem[]>();
    for (const p of filteredProjects) {
      const key = keyOf(p);
      if (key) families.set(key, [...(families.get(key) || []), p]);
    }
    const items: GridItem[] = [];
    const emitted = new Set<string>();
    for (const p of filteredProjects) {
      const key = keyOf(p);
      const family = key ? families.get(key) : undefined;
      // a lone member (the rest filtered out by a search) is better shown as itself
      if (!family || family.length < 2) {
        items.push({ kind: 'project', project: p });
        continue;
      }
      if (emitted.has(key)) continue;
      emitted.add(key);
      if (key.startsWith('split:')) {
        const original = family.find((x) => !x.part_index);
        const parts = family.filter((x) => x.part_index).sort((a, b) => (a.part_index || 0) - (b.part_index || 0));
        items.push({
          kind: 'group', key, type: 'split',
          // the parent may be gone; fall back to the shared start of the part names
          name: original?.name || parts[0]?.name.replace(/\s+—\s+Part\s+\d+$/, '') || 'Split video',
          // only the parts: the original is what the group card itself stands for
          members: parts.length ? parts : family,
        });
      } else {
        const members = [...family].sort((a, b) =>
          (a.batch_index || 0) - (b.batch_index || 0) || a.name.localeCompare(b.name, undefined, { numeric: true }));
        items.push({
          kind: 'group', key, type: 'series',
          name: members[0].batch_name || nameParts(members[0].name).head || members[0].name,
          members,
        });
      }
    }
    return items;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredProjects]);

  /** One project card. Shared by the plain grid and by the members of an opened group. */
  const renderProjectCard = (project: ProjectListItem, selected: boolean, inGroup = false) => {
    const stage = projectStage(project);
    const tone = TONES[stage.tone];
    const { head, tail } = nameParts(project.name);
    const subs = project.segment_count || 0;
    const voiced = Math.min(project.dubbed_count || 0, subs);
    return (
      <div
        key={project.id}
        onClick={() => (selectMode ? toggleSelected(project.id) : navigate(`/project/${project.id}`))}
        className={`group relative flex flex-col rounded-2xl border p-4 cursor-pointer overflow-hidden transition-all duration-200 ${
          inGroup ? 'bg-[var(--s2)]/70' : 'bg-[var(--s2)]'
        } ${
          selected
            ? 'border-blue-500 ring-1 ring-blue-500/40 bg-[var(--s3)]'
            : 'border-[var(--s4)] hover:border-[var(--s8)] hover:bg-[var(--s3)] hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/30'
        }`}
        title={project.name}
      >
        {/* a wash of the status colour, so a glance across the grid reads as progress */}
        <span className={`pointer-events-none absolute -top-16 -right-16 h-40 w-40 rounded-full bg-gradient-to-br ${tone.glow} to-transparent blur-2xl`} aria-hidden="true" />

        <div className="relative flex items-start justify-between gap-3">
          {selectMode ? (
            <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border transition-colors ${
              selected ? 'border-blue-500 bg-blue-600 text-white' : 'border-[var(--s6)] bg-[var(--s3)] text-zinc-600'
            }`}>
              {selected ? <Check className="h-5 w-5" /> : <Square className="h-4 w-4" />}
            </span>
          ) : (
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-zinc-300">
              {project.part_index ? <span className="text-[11px] font-bold tabular-nums">{project.part_index}</span> : <Film className="h-4 w-4" />}
            </span>
          )}
          <span className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${tone.pill}`}>
            {stage.live && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
            {stage.label}
          </span>
        </div>

        {/* the part that tells episodes apart comes first, whole */}
        <h3 className="relative mt-3 truncate text-sm font-bold tracking-tight text-white">
          {project.part_index && inGroup ? `Part ${project.part_index}` : tail}
        </h3>
        <p className="relative mt-0.5 truncate text-[11px] text-zinc-500">
          {inGroup ? (project.part_index ? tail : '') || ' ' : head || (project.language === 'km' ? 'Khmer' : (project.language || '').toUpperCase())}
        </p>

        {!inGroup && (project.part_count || 0) > 0 && (
          <span className="relative mt-2 inline-flex w-fit items-center gap-1 rounded-full border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-[10px] font-semibold text-blue-300">
            <Scissors className="h-2.5 w-2.5" />
            {project.part_index ? `Part ${project.part_index} of ${project.part_count}` : `Split into ${project.part_count} parts`}
          </span>
        )}

        <div className="relative mt-auto pt-4">
          <div className="h-1 w-full overflow-hidden rounded-full bg-white/5">
            <span
              className={`block h-full rounded-full transition-all duration-500 ${tone.bar}`}
              style={{ width: `${Math.max(stage.progress > 0 ? 6 : 0, stage.progress * 100)}%` }}
            />
          </div>
          <div className="mt-2.5 flex items-center justify-between gap-2 text-[11px] text-zinc-400">
            <span className="flex items-center gap-3 min-w-0">
              <span className="flex items-center gap-1" title="Length">
                <Clock className="h-3.5 w-3.5 text-zinc-600" />
                {formatDuration(project.duration)}
              </span>
              <span className="flex items-center gap-1" title={subs ? `${voiced} of ${subs} lines voiced` : 'No captions yet'}>
                <Mic className="h-3.5 w-3.5 text-zinc-600" />
                {subs ? `${voiced}/${subs}` : '—'}
              </span>
            </span>
            <span className="flex items-center gap-1 text-[10px] text-zinc-600 shrink-0">
              <Calendar className="h-3 w-3" />
              {formatDate(project.updated_at || project.created_at)}
            </span>
          </div>
        </div>

        {!selectMode && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setProjectToDelete(project);
            }}
            className="absolute right-3 top-12 rounded-lg p-1.5 text-zinc-600 opacity-0 transition-all hover:bg-red-950/60 hover:text-red-400 group-hover:opacity-100 focus:opacity-100"
            title="Delete project"
            aria-label={`Delete ${project.name}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    );
  };

  return (
    // html/body are locked to the viewport for the editor's panes, so the dashboard scrolls
    // its own content instead of the page — otherwise anything past the first screen is
    // unreachable once there are enough projects to overflow.
    <div className="h-screen overflow-hidden flex flex-col bg-[var(--s1)] text-[#e1e3e6] font-sans select-none">
      {/* Top Navigation Header */}
      <header className="h-14 border-b border-[var(--s3)] bg-[var(--s2)] px-4 sm:px-6 flex items-center justify-between gap-3 shrink-0 z-30 sticky top-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 rounded-xl bg-blue-600 flex items-center justify-center shadow-lg shadow-blue-950/50 shrink-0">
            <Mic className="w-4 h-4 text-white" />
          </div>
          <div className="min-w-0">
            <h1 className="text-sm font-bold text-white tracking-tight">{APP_NAME}</h1>
            <p className="text-[11px] text-zinc-400 truncate hidden sm:block">Khmer AI video dubbing & captions</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowFolderImport(true)}
            title="Create one project for every video in a folder"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--s6)] hover:bg-white/10 text-zinc-200 font-semibold text-xs active:scale-95 transition-all"
          >
            <FolderOpen className="w-4 h-4" />
            <span className="hidden md:inline">From Folder</span>
          </button>
          <button
            onClick={() => setShowSplitUpload(true)}
            title="Upload a long video and cut it into part projects"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--s6)] hover:bg-white/10 text-zinc-200 font-semibold text-xs active:scale-95 transition-all"
          >
            <Scissors className="w-4 h-4" />
            <span className="hidden md:inline">Split Long Video</span>
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs shadow-md shadow-blue-950/50 active:scale-95 transition-all"
          >
            <Plus className="w-4 h-4" />
            <span>New Project</span>
          </button>
        </div>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-7xl w-full mx-auto px-4 sm:px-6 md:px-8 py-6 space-y-5">
          {/* Title, search, sort */}
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-3">
            <div>
              <h2 className="text-xl font-bold text-white tracking-tight">Projects</h2>
              <p className="text-xs text-zinc-400 mt-1">Transcribe, translate, dub and export — one video, a folder, or a whole series.</p>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative flex-1 md:w-72">
                <Search className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search projects…"
                  aria-label="Search projects"
                  className="w-full bg-[var(--s2)] border border-[var(--s5)] rounded-xl pl-9 pr-8 py-2 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-blue-500 transition-colors"
                />
                {searchQuery && (
                  <button onClick={() => setSearchQuery('')} aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-zinc-500 hover:text-white">
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as Sort)}
                aria-label="Sort projects"
                className="bg-[var(--s2)] border border-[var(--s5)] rounded-xl px-2.5 py-2 text-xs text-zinc-200 focus:outline-none focus:border-blue-500"
              >
                <option value="recent">Recent</option>
                <option value="name">Name</option>
              </select>
              {projects.length > 0 && (
                <button
                  onClick={() => (selectMode ? leaveSelectMode() : setSelectMode(true))}
                  className={`shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold border transition-colors ${
                    selectMode ? 'bg-blue-600 border-blue-500 text-white' : 'bg-[var(--s2)] border-[var(--s5)] text-zinc-300 hover:text-white hover:border-[var(--s8)]'
                  }`}
                  title={selectMode ? 'Leave selection mode' : 'Select several projects to delete'}
                >
                  <CheckSquare className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">{selectMode ? 'Cancel' : 'Select'}</span>
                </button>
              )}
            </div>
          </div>

          {/* Bulk actions, only while selecting */}
          {selectMode && (
            <div className="flex flex-wrap items-center justify-between gap-3 bg-[var(--s2)] border border-blue-500/25 rounded-2xl px-5 py-3">
              <span className="text-xs text-zinc-300 font-semibold">
                {selectedIds.size === 0 ? 'Tap projects to select them' : `${selectedIds.size} selected`}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => setSelectedIds(new Set(filteredProjects.map((p) => p.id)))}
                  className="px-3 py-1.5 rounded-lg text-[11px] font-medium bg-white/5 hover:bg-white/10 text-zinc-300 hover:text-white transition-colors"
                >
                  Select all{searchQuery ? ' shown' : ''} ({filteredProjects.length})
                </button>
                {selectedIds.size > 0 && (
                  <button
                    onClick={() => setSelectedIds(new Set())}
                    className="px-3 py-1.5 rounded-lg text-[11px] font-medium bg-white/5 hover:bg-white/10 text-zinc-300 hover:text-white transition-colors"
                  >
                    Clear
                  </button>
                )}
                <button
                  onClick={() => setConfirmBulk(true)}
                  disabled={selectedIds.size === 0}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold bg-red-600/90 hover:bg-red-600 disabled:opacity-30 disabled:cursor-not-allowed text-white transition-colors"
                >
                  <Trash2 className="w-3 h-3" />
                  Delete {selectedIds.size || ''}
                </button>
              </div>
            </div>
          )}

          {/* Project Grid */}
          {isLoading && projects.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-72 gap-3">
              <Loader2 className="w-6 h-6 animate-spin text-zinc-500" />
              <p className="text-xs text-zinc-500">Loading your projects…</p>
            </div>
          ) : projects.length === 0 ? (
            /* first run: the three ways in, side by side */
            <div className="rounded-2xl border border-dashed border-[var(--s5)] p-8 text-center">
              <h3 className="text-base font-bold text-white">Start your first dub</h3>
              <p className="text-xs text-zinc-400 mt-1 mb-6">Pick how your video arrives. Everything after that is the same.</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-3xl mx-auto">
                {[
                  { icon: Plus, title: 'One video', hint: 'Upload a video and work on it in the editor.', on: () => setShowCreate(true) },
                  { icon: FolderOpen, title: 'A folder of episodes', hint: 'One project per video, with its subtitle file if there is one.', on: () => setShowFolderImport(true) },
                  { icon: Scissors, title: 'A long video', hint: 'Cut a film into parts, each its own project.', on: () => setShowSplitUpload(true) },
                ].map(({ icon: Icon, title, hint, on }) => (
                  <button key={title} onClick={on} className="rounded-xl border border-[var(--s5)] bg-[var(--s2)] hover:border-blue-500 hover:bg-blue-600/5 p-4 text-left transition-colors">
                    <span className="w-9 h-9 rounded-lg bg-blue-600/15 text-blue-300 flex items-center justify-center mb-3"><Icon className="w-4 h-4" /></span>
                    <span className="block text-sm font-bold text-white">{title}</span>
                    <span className="block text-[11px] text-zinc-400 mt-1 leading-snug">{hint}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : filteredProjects.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-56 border border-dashed border-[var(--s4)] rounded-2xl p-8 text-center">
              <h3 className="text-sm font-bold text-white">Nothing here</h3>
              <p className="text-xs text-zinc-400 mt-1 mb-4">
                No project matches “{searchQuery}”.
              </p>
              <button
                onClick={() => setSearchQuery('')}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white/5 hover:bg-white/10 text-zinc-200"
              >
                Show all projects
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {gridItems.map((item) => {
                if (item.kind === 'project') {
                  return renderProjectCard(item.project, selectedIds.has(item.project.id));
                }
                const expanded = expandedGroups.has(item.key);
                const allSelected = item.members.every((p) => selectedIds.has(p.id));
                const someSelected = !allSelected && item.members.some((p) => selectedIds.has(p.id));
                const totalSeconds = item.members.reduce((t, p) => t + (p.duration || 0), 0);
                const dubbedCount = item.members.filter(isDubbed).length;
                const busy = item.members.filter((p) => activeJob(p.id)).length;
                const unit = item.type === 'split' ? 'part' : 'episode';
                return (
                  <div key={item.key} className={expanded ? 'col-span-full' : 'contents'}>
                    <div
                      onClick={() =>
                        selectMode
                          ? setSelectedIds((prev) => {
                              const next = new Set(prev);
                              item.members.forEach((p) => (allSelected ? next.delete(p.id) : next.add(p.id)));
                              return next;
                            })
                          : toggleGroup(item.key)
                      }
                      className={`relative rounded-2xl border p-4 cursor-pointer transition-all duration-200 overflow-hidden ${
                        allSelected || someSelected
                          ? 'border-blue-500 ring-1 ring-blue-500/40 bg-[var(--s3)]'
                          : expanded
                            ? 'border-blue-500/40 bg-[var(--s2)]'
                            : 'border-[var(--s4)] bg-[var(--s2)] hover:border-[var(--s8)] hover:bg-[var(--s3)] hover:-translate-y-0.5'
                      } ${expanded ? '' : 'flex flex-col'}`}
                      aria-expanded={expanded}
                    >
                      {/* a stack, so a series reads as many videos at a glance */}
                      {!expanded && <span aria-hidden className="pointer-events-none absolute inset-x-3 -bottom-1 h-2 rounded-b-2xl border border-t-0 border-[var(--s4)] bg-[var(--s2)]" />}
                      <div className={`flex items-start gap-3 ${expanded ? 'justify-between' : ''}`}>
                        <div className="flex items-start gap-3 min-w-0 flex-1">
                          {selectMode ? (
                            <span className={`w-9 h-9 rounded-xl border flex items-center justify-center shrink-0 ${
                              allSelected ? 'bg-blue-600 border-blue-500 text-white' : someSelected ? 'bg-blue-600/30 border-blue-500/50 text-blue-200' : 'bg-[var(--s3)] border-[var(--s6)] text-zinc-600'
                            }`}>
                              {allSelected ? <Check className="w-5 h-5" /> : someSelected ? <Minus className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                            </span>
                          ) : (
                            <span className="w-9 h-9 rounded-xl bg-blue-600/15 border border-blue-500/25 flex items-center justify-center text-blue-300 shrink-0">
                              {item.type === 'split' ? <Scissors className="w-4 h-4" /> : <Layers className="w-4 h-4" />}
                            </span>
                          )}
                          <div className="min-w-0 flex-1">
                            <h3 className="text-sm font-bold text-white tracking-tight truncate" title={item.name}>{item.name}</h3>
                            <p className="text-[11px] text-zinc-400 mt-0.5">
                              {item.members.length} {unit}s · {formatDuration(totalSeconds)}
                            </p>
                          </div>
                        </div>
                        {/* where the whole series stands, the way a single card says it */}
                        <span className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold shrink-0 ${
                          busy ? TONES.blue.pill : dubbedCount === item.members.length ? TONES.emerald.pill : TONES.zinc.pill
                        }`}>
                          {busy > 0 && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
                          {busy ? `${busy} working` : dubbedCount === item.members.length ? 'All dubbed' : `${dubbedCount}/${item.members.length} dubbed`}
                        </span>
                        {expanded && (
                          <span className="flex items-center gap-1 text-[11px] font-semibold text-zinc-300 shrink-0">
                            Close <ChevronUp className="w-3.5 h-3.5" />
                          </span>
                        )}
                      </div>

                      {/* one segment per member, coloured by where it has got to */}
                      <div className="mt-4 flex gap-0.5" aria-label={`${dubbedCount} of ${item.members.length} dubbed`}>
                        {item.members.map((p) => (
                          <span key={p.id} title={`${p.part_index ? `Part ${p.part_index}` : nameParts(p.name).tail}: ${projectStage(p).label}`}
                            className={`h-1.5 flex-1 rounded-full ${TONES[projectStage(p).tone].bar} ${projectStage(p).tone === 'zinc' ? 'opacity-40' : ''}`} />
                        ))}
                      </div>

                      {!expanded && (
                        <div className="mt-auto pt-3 flex items-center justify-between text-[11px] text-zinc-400">
                          <span className="flex items-center gap-1 text-[10px] text-zinc-600">
                            <Calendar className="h-3 w-3" />
                            {formatDate(item.members.reduce((a, p) => ((p.updated_at || '') > a ? p.updated_at : a), ''))}
                          </span>
                          <span className="flex items-center gap-1 font-semibold text-zinc-300">
                            Show {item.members.length} <ChevronDown className="w-3.5 h-3.5" />
                          </span>
                        </div>
                      )}

                      {expanded && (
                        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3" onClick={(e) => e.stopPropagation()}>
                          {item.members.map((project) => renderProjectCard(project, selectedIds.has(project.id), true))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </main>

      {/* One window for both: every video in a folder, or every part of one long video */}
      {(showFolderImport || showSplitUpload) && (
        <NewProjectsModal
          source={showFolderImport ? 'folder' : 'video'}
          onClose={() => {
            // Confirmed, the work goes on in the background and the editor opens; cancelled,
            // an uploaded long video stays as a project either way
            setShowFolderImport(false);
            setShowSplitUpload(false);
            loadProjects();
          }}
        />
      )}

      {/* Create Project Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-[var(--s2)] border border-[var(--s5)] rounded-2xl p-6 w-full max-w-md shadow-2xl animate-in zoom-in-95 duration-150">
            <div className="flex items-center gap-2.5 mb-4">
              <div className="w-8 h-8 rounded-lg bg-white/10 border border-white/10 flex items-center justify-center text-zinc-400">
                <Plus className="w-4 h-4" />
              </div>
              <h2 className="text-base font-bold text-white">Create New Project</h2>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-zinc-400 mb-1.5">Project Name</label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                  placeholder="e.g. Khmer Drama Recap Episode 1"
                  className="w-full px-3.5 py-2 bg-[var(--s3)] border border-[var(--s6)] rounded-xl text-white text-xs placeholder-zinc-500 focus:outline-none focus:border-white/10 transition-colors"
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-400 mb-1.5">Language</label>
                <select
                  value={newLang}
                  onChange={(e) => setNewLang(e.target.value)}
                  className="w-full px-3.5 py-2 bg-[var(--s3)] border border-[var(--s6)] rounded-xl text-white text-xs focus:outline-none focus:border-white/10 transition-colors"
                >
                  <option value="km">🇰🇭 ខ្មែរ (Khmer)</option>
                  <option value="en">🇺🇸 English</option>
                  <option value="zh">🇨🇳 中文 (Chinese)</option>
                  <option value="ja">🇯🇵 日本語 (Japanese)</option>
                  <option value="ko">🇰🇷 한국어 (Korean)</option>
                  <option value="th">🇹🇭 ไทย (Thai)</option>
                  <option value="vi">🇻🇳 Tiếng Việt</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-400 mb-1.5">Description (optional)</label>
                <textarea
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder="Notes about video topic, speaker, or script style..."
                  rows={2}
                  className="w-full px-3.5 py-2 bg-[var(--s3)] border border-[var(--s6)] rounded-xl text-white text-xs placeholder-zinc-500 focus:outline-none focus:border-white/10 resize-none transition-colors"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2.5 mt-6">
              <button
                onClick={() => {
                  setShowCreate(false);
                  setNewName('');
                  setNewDesc('');
                }}
                className="px-4 py-2 rounded-xl text-xs text-zinc-400 hover:text-white hover:bg-[var(--s4)] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!newName.trim() || isCreating}
                className="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold text-xs shadow-lg transition-all active:scale-95"
              >
                {isCreating ? 'Creating...' : 'Create Project'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Custom Delete Project Alert Modal */}
      {/* Bulk delete confirmation */}
      {confirmBulk && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center z-50 p-4 animate-in fade-in duration-150">
          <div className="bg-[var(--s3)] border border-red-500/30 rounded-2xl p-6 w-full max-w-md shadow-2xl shadow-red-950/40 animate-in zoom-in-95 duration-150">
            <div className="flex items-start gap-3 mb-4">
              <span className="p-2 rounded-xl bg-red-500/10 text-red-400 shrink-0">
                <Trash2 className="w-5 h-5" />
              </span>
              <div className="min-w-0">
                <h3 className="text-base font-bold text-white">
                  Delete {selectedProjects.length} project
                  {selectedProjects.length === 1 ? '' : 's'}?
                </h3>
                <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
                  Their videos, subtitles and generated voices are removed from disk. This cannot
                  be undone.
                </p>
              </div>
            </div>

            <ul className="max-h-48 overflow-y-auto rounded-xl border border-[var(--s5)] bg-[var(--s1)] divide-y divide-[var(--s3)] mb-4">
              {selectedProjects.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-[11px]"
                >
                  <span className="truncate text-zinc-300">{p.name}</span>
                  <span className="text-zinc-500 tabular-nums shrink-0">
                    {p.segment_count || 0} subs · {formatDuration(p.duration)}
                  </span>
                </li>
              ))}
            </ul>

            {bulkProgress && (
              <div className="mb-4">
                <div className="flex items-center justify-between text-[11px] text-zinc-400 mb-1.5">
                  <span>Deleting…</span>
                  <span className="tabular-nums">
                    {bulkProgress.done} / {bulkProgress.total}
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-[var(--s3)] overflow-hidden">
                  <div
                    className="h-full bg-red-500 transition-all duration-200"
                    style={{ width: `${(bulkProgress.done / bulkProgress.total) * 100}%` }}
                  />
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setConfirmBulk(false)}
                disabled={!!bulkProgress}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-zinc-400 hover:text-white hover:bg-white/5 disabled:opacity-40 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleBulkDelete}
                disabled={!!bulkProgress}
                className="px-4 py-2 rounded-xl text-xs font-bold bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white transition-colors"
              >
                {bulkProgress ? 'Deleting…' : `Delete ${selectedProjects.length}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {projectToDelete && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center z-50 p-4 animate-in fade-in duration-150">
          <div className="bg-[var(--s3)] border border-red-500/30 rounded-2xl p-6 w-full max-w-md shadow-2xl shadow-red-950/40 animate-in zoom-in-95 duration-150 relative overflow-hidden">
            {/* Ambient Red Warning Glow */}
            <div className="absolute -top-12 -right-12 w-36 h-36 bg-red-600/15 rounded-full blur-3xl pointer-events-none" />

            {/* Header with Danger Icon */}
            <div className="flex items-start justify-between gap-3 mb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-red-500/15 border border-red-500/30 flex items-center justify-center text-red-400 shrink-0 shadow-inner">
                  <AlertTriangle className="w-5 h-5 animate-pulse" />
                </div>
                <div>
                  <h2 className="text-base font-bold text-white tracking-tight font-khmer">
                    លុបគម្រោងវីដេអូ
                  </h2>
                  <p className="text-[11px] text-zinc-400 font-medium">Delete Project Confirmation</p>
                </div>
              </div>
              <button
                onClick={() => !isDeleting && setProjectToDelete(null)}
                disabled={isDeleting}
                className="p-1.5 text-zinc-500 hover:text-zinc-300 hover:bg-white/5 rounded-lg transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Project Summary Card */}
            <div className="p-3.5 rounded-xl bg-[var(--s4)] border border-white/5 mb-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Project to delete</span>
                <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-[var(--s5)] text-zinc-300 border border-white/5">
                  {projectToDelete.language === 'km' ? '🇰🇭 Khmer' : projectToDelete.language?.toUpperCase()}
                </span>
              </div>
              <p className="text-sm font-bold text-white truncate">{projectToDelete.name}</p>
              <div className="flex items-center gap-4 text-[11px] text-zinc-400">
                <span className="flex items-center gap-1">
                  <Clock className="w-3 h-3 text-zinc-500" />
                  {projectToDelete.duration > 0 ? formatDuration(projectToDelete.duration) : '0:00'}
                </span>
                <span className="flex items-center gap-1">
                  <FileText className="w-3 h-3 text-zinc-500" />
                  {projectToDelete.segment_count || 0} Subtitles
                </span>
              </div>
            </div>

            {/* Warning Message */}
            <div className="p-3 rounded-xl bg-red-950/30 border border-red-500/20 mb-5">
              <p className="text-xs text-red-200/90 font-khmer leading-relaxed">
                ⚠️ <span className="font-bold text-red-300">ការព្រមាន៖</span> សកម្មភាពនេះមិនអាចត្រឡប់ក្រោយវិញបានទេ! រាល់ទិន្នន័យចំណងជើងរង (Subtitles) សំឡេងកាត់ត (Dubbing) និងការកំណត់ទាំងអស់ក្នុងគម្រោងនេះនឹងត្រូវលុបជាអចិន្ត្រៃយ៍។
              </p>
            </div>

            {/* Action Buttons */}
            <div className="flex items-center justify-end gap-2.5">
              <button
                onClick={() => !isDeleting && setProjectToDelete(null)}
                disabled={isDeleting}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-zinc-300 hover:text-white bg-[var(--s4)] hover:bg-[var(--s6)] border border-white/5 transition-all cursor-pointer"
              >
                បោះបង់ (Cancel)
              </button>
              <button
                onClick={handleConfirmDelete}
                disabled={isDeleting}
                className="px-5 py-2 rounded-xl bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-500 hover:to-rose-500 text-white font-bold text-xs shadow-lg shadow-red-950/60 border border-red-400/30 flex items-center gap-1.5 transition-all active:scale-95 cursor-pointer disabled:opacity-50"
              >
                {isDeleting ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>កំពុងលុប...</span>
                  </>
                ) : (
                  <>
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>លុបគម្រោងចោល (Delete)</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
