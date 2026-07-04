import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useProjectStore } from '../stores/projectStore';
import {
  Plus,
  Video,
  Trash2,
  Clock,
  FileText,
  Sparkles,
  Moon,
  Sun,
} from 'lucide-react';
import { useThemeStore } from '../stores/themeStore';

export default function Dashboard() {
  const navigate = useNavigate();
  const { projects, isLoading, loadProjects, createProject, deleteProject } =
    useProjectStore();
  const { mode, toggle: toggleTheme } = useThemeStore();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');

  useEffect(() => {
    loadProjects();
  }, []);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    try {
      const project = await createProject(newName.trim(), newDesc.trim());
      setShowCreate(false);
      setNewName('');
      setNewDesc('');
      navigate(`/project/${project.id}`);
    } catch {}
  };

  const formatDuration = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const statusBadge = (status: string) => {
    const colors: Record<string, string> = {
      created: 'bg-zinc-700 text-zinc-300',
      uploaded: 'bg-blue-900/50 text-blue-300',
      transcribing: 'bg-yellow-900/50 text-yellow-300',
      completed: 'bg-green-900/50 text-green-300',
      error: 'bg-red-900/50 text-red-300',
    };
    return (
      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] || colors.created}`}>
        {status}
      </span>
    );
  };

  return (
    <div className="h-screen flex flex-col" style={{ backgroundColor: 'var(--bg-base)' }}>
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: 'var(--border-color)', backgroundColor: 'var(--bg-panel)' }}>
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-khmer-600 flex items-center justify-center">
            <Sparkles className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-semibold" style={{ color: 'var(--text-bright)' }}>AI Video Transcript</h1>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Khmer Transcription powered by Gemini</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={toggleTheme}
            className="p-2 rounded-lg transition-colors"
            style={{ color: 'var(--text-secondary)' }}
            title={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {mode === 'dark' ? (
              <Moon className="w-4 h-4" />
            ) : (
              <Sun className="w-4 h-4 text-amber-500" />
            )}
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 px-4 py-2 bg-khmer-600 hover:bg-khmer-700 text-white rounded-lg text-sm font-medium transition-colors"
          >
            <Plus className="w-4 h-4" />
            New Project
          </button>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 overflow-auto p-6">
        {isLoading && projects.length === 0 ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin w-8 h-8 border-2 border-khmer-500 border-t-transparent rounded-full" />
          </div>
        ) : projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-zinc-500">
            <Video className="w-16 h-16 mb-4 opacity-30" />
            <p className="text-lg mb-2">No projects yet</p>
            <p className="text-sm">Create a new project to start transcribing videos to Khmer</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {projects.map((project) => (
              <div
                key={project.id}
                onClick={() => navigate(`/project/${project.id}`)}
                className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 cursor-pointer hover:border-zinc-600 hover:bg-zinc-900 transition-all group"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex-1 min-w-0">
                    <h3 className="text-white font-medium truncate">{project.name}</h3>
                    {project.description && (
                      <p className="text-xs text-zinc-500 mt-1 truncate">{project.description}</p>
                    )}
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm('Delete this project?')) deleteProject(project.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 p-1 hover:bg-red-900/30 rounded transition-all"
                  >
                    <Trash2 className="w-4 h-4 text-red-400" />
                  </button>
                </div>

                <div className="flex items-center gap-3 text-xs text-zinc-500">
                  {project.video_filename && (
                    <span className="flex items-center gap-1">
                      <Video className="w-3 h-3" />
                      {project.video_filename.length > 20
                        ? project.video_filename.slice(0, 20) + '...'
                        : project.video_filename}
                    </span>
                  )}
                  {project.duration > 0 && (
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {formatDuration(project.duration)}
                    </span>
                  )}
                  {project.segment_count > 0 && (
                    <span className="flex items-center gap-1">
                      <FileText className="w-3 h-3" />
                      {project.segment_count} segments
                    </span>
                  )}
                </div>

                <div className="mt-3">{statusBadge(project.status)}</div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Create Dialog */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 w-full max-w-md mx-4">
            <h2 className="text-lg font-semibold text-white mb-4">New Project</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-zinc-400 mb-1">Project Name</label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                  placeholder="e.g., Khmer Documentary Episode 1"
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white text-sm focus:outline-none focus:border-khmer-500"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">Description (optional)</label>
                <textarea
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder="Brief description..."
                  rows={2}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white text-sm focus:outline-none focus:border-khmer-500 resize-none"
                />
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => { setShowCreate(false); setNewName(''); setNewDesc(''); }}
                className="px-4 py-2 text-sm text-zinc-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!newName.trim()}
                className="px-4 py-2 bg-khmer-600 hover:bg-khmer-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
              >
                Create Project
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
