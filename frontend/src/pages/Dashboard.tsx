import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useProjectStore } from '../stores/projectStore';
import {
  Plus,
  Video,
  Trash2,
  Clock,
  FileText,
  Sparkles,
  Search,
  Film,
  Play,
  Calendar,
  Mic,
  Languages,
  FolderOpen,
  ArrowRight,
  Layers,
  CheckCircle2,
} from 'lucide-react';

export default function Dashboard() {
  const navigate = useNavigate();
  const { projects, isLoading, loadProjects, createProject, deleteProject } = useProjectStore();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newLang, setNewLang] = useState('km');
  const [searchQuery, setSearchQuery] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  const handleCreate = async () => {
    if (!newName.trim() || isCreating) return;
    setIsCreating(true);
    try {
      const project = await createProject(newName.trim(), newDesc.trim(), newLang);
      setShowCreate(false);
      setNewName('');
      setNewDesc('');
      navigate(`/project/${project.id}`);
    } catch (e) {
      console.error(e);
    } finally {
      setIsCreating(false);
    }
  };

  const formatDuration = (s: number) => {
    if (!s) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '';
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch {
      return '';
    }
  };

  const filteredProjects = useMemo(() => {
    if (!searchQuery.trim()) return projects;
    const q = searchQuery.toLowerCase();
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description && p.description.toLowerCase().includes(q)) ||
        (p.video_filename && p.video_filename.toLowerCase().includes(q))
    );
  }, [projects, searchQuery]);

  return (
    <div className="min-h-screen flex flex-col bg-[#0d0e11] text-[#e1e3e6] font-sans select-none">
      {/* Top Navigation Header */}
      <header className="h-14 border-b border-[#1c1e24] bg-[#121316] px-6 flex items-center justify-between shrink-0 z-30 sticky top-0">
        <div className="flex items-center gap-3.5">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 flex items-center justify-center shadow-lg shadow-purple-500/20">
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-bold text-white tracking-tight">Meatika Studio</h1>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-500/20 text-purple-300 border border-purple-500/30">
                PRO
              </span>
            </div>
            <p className="text-[11px] text-zinc-400">Khmer AI Video Dubbing & Transcription</p>
          </div>
        </div>

        {/* Right Header Actions */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-bold text-xs shadow-md shadow-purple-900/30 active:scale-95 transition-all"
          >
            <Plus className="w-4 h-4" />
            <span>New Project</span>
          </button>
        </div>
      </header>

      {/* Main Content Dashboard */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 md:p-8 space-y-6">
        {/* Top Hero / Search Bar */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-[#14161b] border border-[#21242c] rounded-2xl p-5 sm:p-6 shadow-sm">
          <div>
            <h2 className="text-lg sm:text-xl font-bold text-white tracking-tight">My Video Projects</h2>
            <p className="text-xs text-zinc-400 mt-1">
              Create, transcribe, dub, and export videos with authentic Khmer neural voices.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <div className="relative w-full sm:w-72">
              <Search className="w-4 h-4 text-zinc-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search projects..."
                className="w-full bg-[#1b1e25] border border-[#2c303a] rounded-xl pl-10 pr-4 py-2 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-purple-500 transition-colors"
              />
            </div>
          </div>
        </div>

        {/* Project Grid */}
        {isLoading && projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-72 gap-3">
            <div className="w-8 h-8 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-xs text-zinc-500">Loading your projects...</p>
          </div>
        ) : filteredProjects.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-80 border-2 border-dashed border-[#232630] rounded-2xl p-8 text-center bg-[#121316]/50">
            <div className="w-14 h-14 rounded-2xl bg-[#1b1e25] flex items-center justify-center mb-4 text-zinc-500">
              <Film className="w-7 h-7" />
            </div>
            <h3 className="text-base font-bold text-white">
              {searchQuery ? 'No matching projects found' : 'No projects created yet'}
            </h3>
            <p className="text-xs text-zinc-400 max-w-sm mt-1 mb-5">
              {searchQuery
                ? 'Try searching with a different keyword or clear your search query.'
                : 'Upload a video to transcribe subtitles, generate AI dubbing, or create viral movie recaps.'}
            </p>
            {!searchQuery && (
              <button
                onClick={() => setShowCreate(true)}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-bold text-xs shadow-lg shadow-purple-600/30 transition-all active:scale-95"
              >
                <Plus className="w-4 h-4" />
                <span>Create Your First Project</span>
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 sm:gap-5">
            {/* New Project Quick Card */}
            <div
              onClick={() => setShowCreate(true)}
              className="border-2 border-dashed border-[#262933] hover:border-purple-500/50 bg-[#121316]/40 hover:bg-purple-950/10 rounded-2xl p-6 cursor-pointer flex flex-col items-center justify-center min-h-[220px] transition-all group text-center"
            >
              <div className="w-12 h-12 rounded-full bg-[#1b1e26] group-hover:bg-purple-600/20 text-zinc-400 group-hover:text-purple-300 flex items-center justify-center mb-3 transition-colors">
                <Plus className="w-6 h-6" />
              </div>
              <span className="text-xs font-bold text-white group-hover:text-purple-200">
                Create New Project
              </span>
              <span className="text-[11px] text-zinc-500 mt-1">Upload & start dubbing</span>
            </div>

            {/* Existing Project Cards */}
            {filteredProjects.map((project) => (
              <div
                key={project.id}
                onClick={() => navigate(`/project/${project.id}`)}
                className="bg-[#15171d] border border-[#232731] hover:border-[#3d4454] hover:bg-[#181b22] rounded-2xl p-5 cursor-pointer transition-all duration-200 shadow-sm flex flex-col justify-between group relative overflow-hidden"
              >
                {/* Top Row: Video Icon / Badge & Delete */}
                <div>
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500/20 to-purple-500/20 border border-purple-500/20 flex items-center justify-center text-purple-300 shrink-0">
                      <Film className="w-5 h-5" />
                    </div>

                    <div className="flex items-center gap-1.5">
                      <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-[#21242d] text-zinc-300 border border-[#2c303c]">
                        {project.language === 'km' ? '🇰🇭 Khmer' : project.language.toUpperCase()}
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`Delete project "${project.name}"?`)) {
                            deleteProject(project.id);
                          }
                        }}
                        className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-red-950/60 text-zinc-500 hover:text-red-400 rounded-lg transition-all"
                        title="Delete project"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Project Name & Description */}
                  <h3 className="text-sm font-bold text-white tracking-tight truncate group-hover:text-purple-300 transition-colors">
                    {project.name}
                  </h3>
                  {project.description ? (
                    <p className="text-[11px] text-zinc-400 mt-1 line-clamp-2 leading-relaxed">
                      {project.description}
                    </p>
                  ) : (
                    <p className="text-[11px] text-zinc-500 mt-1 italic">No description</p>
                  )}
                </div>

                {/* Bottom Meta & Stats */}
                <div className="pt-4 mt-4 border-t border-[#1f222b]">
                  <div className="grid grid-cols-2 gap-2 text-[11px] text-zinc-400 mb-3">
                    <div className="flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5 text-zinc-500" />
                      <span>{project.duration > 0 ? formatDuration(project.duration) : '0:00'}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <FileText className="w-3.5 h-3.5 text-zinc-500" />
                      <span>{project.segment_count || 0} Subtitles</span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between text-[10px] text-zinc-500 pt-1">
                    <span className="flex items-center gap-1">
                      <Calendar className="w-3 h-3" />
                      <span>{formatDate(project.updated_at || project.created_at)}</span>
                    </span>
                    <span className="flex items-center gap-1 text-purple-400 font-semibold group-hover:translate-x-0.5 transition-transform">
                      Open <ArrowRight className="w-3 h-3" />
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Create Project Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-[#16181f] border border-[#292c37] rounded-2xl p-6 w-full max-w-md shadow-2xl animate-in zoom-in-95 duration-150">
            <div className="flex items-center gap-2.5 mb-4">
              <div className="w-8 h-8 rounded-lg bg-purple-600/20 border border-purple-500/30 flex items-center justify-center text-purple-400">
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
                  className="w-full px-3.5 py-2 bg-[#1c1f28] border border-[#2d313e] rounded-xl text-white text-xs placeholder-zinc-500 focus:outline-none focus:border-purple-500 transition-colors"
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-400 mb-1.5">Language</label>
                <select
                  value={newLang}
                  onChange={(e) => setNewLang(e.target.value)}
                  className="w-full px-3.5 py-2 bg-[#1c1f28] border border-[#2d313e] rounded-xl text-white text-xs focus:outline-none focus:border-purple-500 transition-colors"
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
                  className="w-full px-3.5 py-2 bg-[#1c1f28] border border-[#2d313e] rounded-xl text-white text-xs placeholder-zinc-500 focus:outline-none focus:border-purple-500 resize-none transition-colors"
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
                className="px-4 py-2 rounded-xl text-xs text-zinc-400 hover:text-white hover:bg-[#20232c] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!newName.trim() || isCreating}
                className="px-5 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white font-bold text-xs shadow-lg shadow-purple-900/40 transition-all active:scale-95"
              >
                {isCreating ? 'Creating...' : 'Create Project'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
