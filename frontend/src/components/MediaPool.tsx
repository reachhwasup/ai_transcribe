import { useShallow } from 'zustand/react/shallow';
import { offerSplitIfLong } from '../utils/offerSplit';
import { SPLIT_SUGGEST_SECONDS } from '../utils/splitting';
import { useState, useRef, RefObject, useEffect, useMemo } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { addVideoClip, listAssets, uploadAssets, deleteAsset, setAssetFolders, assetToTimeline, type ProjectAsset } from '../api/client';
import { loadLogoSettings, saveLogoSettings } from './player/LogoTools';
import {
  Play,
  Pause,
  Film,
  Plus,
  Trash2,
  Loader2,
  FolderOpen,
  FolderPlus,
  Folder,
  Folders,
  Layers,
  CheckCircle2,
  X,
  Search,
  LayoutGrid,
  List,
  Scissors,
} from 'lucide-react';

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>;
  vocalsUrl: string | null;
  bgmUrl: string | null;
  audioSeparated: boolean;
}

/** A library asset as the cards show it — the server's ProjectAsset under the old names. */
export interface FolderAssetItem {
  id: string;
  name: string;
  folderName: string;
  url: string;
  type: 'video' | 'audio' | 'image';
  size?: number;
  duration?: number | null;
  thumbnailUrl?: string | null;
  addedAt: number;
}

const toItem = (a: ProjectAsset): FolderAssetItem => ({
  id: a.id,
  name: a.name,
  folderName: a.folder,
  url: a.url,
  type: a.type,
  size: a.size,
  duration: a.duration,
  thumbnailUrl: a.thumb_url,
  addedAt: a.added_at,
});

const MEDIA_RE = /\.(mp4|mov|webm|mkv|avi|m4v|ts|mp3|wav|m4a|aac|flac|ogg|png|jpe?g|webp|gif)$/i;



type AssetFilter = 'all' | 'video' | 'audio' | 'image';

export default function MediaPool({ videoRef, vocalsUrl, bgmUrl, audioSeparated }: Props) {
  const {
    currentProject,
    uploadVideo,
    setVideoClips,
    loadProject,
  } = useProjectStore(useShallow(state => ({ currentProject: state.currentProject, uploadVideo: state.uploadVideo, setVideoClips: state.setVideoClips, loadProject: state.loadProject })));

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const libraryInputRef = useRef<HTMLInputElement>(null);

  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isAppending, setIsAppending] = useState(false);
  const [activeFilter, setActiveFilter] = useState<AssetFilter>('all');
  const [activeFolder, setActiveFolder] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [playingAudioKey, setPlayingAudioKey] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [showNewFolderModal, setShowNewFolderModal] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [customFolders, setCustomFolders] = useState<string[]>([]);
  const [folderAssets, setFolderAssets] = useState<FolderAssetItem[]>([]);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [folderUploadProgress, setFolderUploadProgress] = useState<{ current: number; total: number; name: string } | null>(null);

  const audioPreviewRef = useRef<HTMLAudioElement | null>(null);

  // Clean up any active audio playback on component unmount
  useEffect(() => {
    return () => {
      if (audioPreviewRef.current) {
        audioPreviewRef.current.pause();
        audioPreviewRef.current = null;
      }
    };
  }, []);

  const hasVideo = !!currentProject?.video_path;

  // The library lives on the server with the project, so it survives a reload
  const refreshLibrary = async (projectId: string) => {
    try {
      const lib = await listAssets(projectId);
      setCustomFolders(lib.folders);
      setFolderAssets(lib.items.map(toItem));
    } catch {
      /* keep what is shown */
    }
  };
  useEffect(() => {
    if (!currentProject?.id) return;
    setCustomFolders([]);
    setFolderAssets([]);
    setActiveFolder('all');
    refreshLibrary(currentProject.id);
    // the old library only held in-memory links that were gone after every reload
    try {
      localStorage.removeItem(`meatika_assets_${currentProject.id}`);
      localStorage.removeItem(`meatika_folders_${currentProject.id}`);
    } catch {
      /* storage unavailable */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject?.id]);

  const saveFolders = (folders: string[]) => {
    setCustomFolders(folders);
    if (currentProject?.id) setAssetFolders(currentProject.id, folders).then(setCustomFolders).catch(() => {});
  };

  /** Upload files into a folder, with one progress bar for the batch. */
  const importFiles = async (files: File[], folder: string) => {
    if (!currentProject) return;
    const media = files.filter((f) => MEDIA_RE.test(f.name));
    if (!media.length) {
      showToast('No supported media files found');
      return;
    }
    setFolderUploadProgress({ current: 0, total: media.length, name: folder });
    try {
      const res = await uploadAssets(currentProject.id, media, folder, (frac) =>
        setFolderUploadProgress({ current: Math.round(frac * media.length), total: media.length, name: folder }),
      );
      setCustomFolders(res.folders);
      const added = res.added.map(toItem);
      setFolderAssets((cur) => [...cur, ...added]);
      setActiveFolder(folder);
      showToast(`Added ${res.added.length} file${res.added.length === 1 ? '' : 's'} to "${folder}"`);
      // A long video brought into a project that has nothing on its timeline yet is usually
      // the one to work on, so the split is offered here rather than only after placing it.
      const long = added.filter((a) => a.type === 'video' && (a.duration || 0) >= SPLIT_SUGGEST_SECONDS);
      const project = useProjectStore.getState().currentProject;
      if (long.length === 1 && useProjectStore.getState().videoClips.length === 0 && !project?.part_index) {
        const minutes = Math.round((long[0].duration || 0) / 60);
        if (confirm(`"${long[0].name}" is ${minutes} minutes long.\n\nSplit it into part projects now? Each part becomes its own project.`)) {
          void handleSplitAsset(long[0]);
        }
      }
    } catch (err: any) {
      alert(`Import failed: ${err?.response?.data?.detail || err?.message || err}`);
    } finally {
      setFolderUploadProgress(null);
    }
  };

  // Capture video thumbnail for master clip
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !hasVideo) {
      setThumbnailUrl(null);
      return;
    }

    const capture = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 180;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          setThumbnailUrl(canvas.toDataURL('image/jpeg', 0.8));
        }
      } catch {}
    };

    if (video.readyState >= 2) capture();
    else {
      video.addEventListener('loadeddata', capture, { once: true });
      return () => video.removeEventListener('loadeddata', capture);
    }
  }, [videoRef, hasVideo, currentProject?.video_path]);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 3000);
  };

  // Compute all available folders
  const allFolders = useMemo(() => {
    const set = new Set<string>();
    customFolders.forEach((f) => set.add(f));
    folderAssets.forEach((a) => {
      if (a.folderName && a.folderName !== 'root') set.add(a.folderName);
    });
    return Array.from(set).sort();
  }, [customFolders, folderAssets]);

  // Handle single master video upload
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentProject) return;
    if (fileInputRef.current) fileInputRef.current.value = '';
    showToast('Uploading master video...');
    try {
      await uploadVideo(file);
      await loadProject(currentProject.id);
      if (videoRef.current) {
        videoRef.current.load();
      }
      showToast('Master video uploaded successfully');
    } catch (err: any) {
      console.error('Upload failed:', err);
      alert(`Upload failed: ${err?.response?.data?.detail || err?.message || err}`);
    }
  };

  // Import a whole folder from the computer; it becomes a folder in the library
  const handleFolderUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (folderInputRef.current) folderInputRef.current.value = '';
    if (!files.length) return;
    const rel = (files[0] as any).webkitRelativePath || '';
    const folder = rel.includes('/') ? rel.split('/')[0] : 'Imported Folder';
    await importFiles(files, folder);
  };

  // Append every video in a folder to the end of the edit, in the order they were added
  const handleAppendAllFromFolder = async (folderName: string) => {
    if (!currentProject) return;
    const videos = folderAssets.filter((a) => (folderName === 'all' || a.folderName === folderName) && a.type === 'video');
    if (!videos.length) {
      showToast(`No videos to add in "${folderName}"`);
      return;
    }
    setIsAppending(true);
    const timelineWasEmpty = useProjectStore.getState().videoClips.length === 0;
    try {
      for (let i = 0; i < videos.length; i++) {
        setFolderUploadProgress({ current: i + 1, total: videos.length, name: videos[i].name });
        setVideoClips(await assetToTimeline(currentProject.id, videos[i].id));
      }
      await loadProject(currentProject.id);
      videoRef.current?.load();
      showToast(`Added ${videos.length} clip${videos.length === 1 ? '' : 's'} to the timeline`);
      offerSplitIfLong(timelineWasEmpty);
    } catch (err: any) {
      alert(`Could not add the clips: ${err?.response?.data?.detail || err?.message || err}`);
    } finally {
      setIsAppending(false);
      setFolderUploadProgress(null);
    }
  };

  const handleAddAssetToTimeline = async (asset: FolderAssetItem) => {
    if (!currentProject || asset.type !== 'video') return;
    setIsAppending(true);
    showToast(`Adding "${asset.name}" to the timeline…`);
    const timelineWasEmpty = useProjectStore.getState().videoClips.length === 0;
    try {
      setVideoClips(await assetToTimeline(currentProject.id, asset.id));
      await loadProject(currentProject.id);
      videoRef.current?.load();
      showToast(`"${asset.name}" added to the end of the timeline`);
      offerSplitIfLong(timelineWasEmpty);
    } catch (err: any) {
      alert(`Could not add the clip: ${err?.response?.data?.detail || err?.message || err}`);
    } finally {
      setIsAppending(false);
    }
  };

  /** Cut a library video into part projects. Splitting works on the project's own video, so
   *  the asset is placed on the (empty) timeline first and the usual split dialog takes over. */
  const handleSplitAsset = async (asset: FolderAssetItem) => {
    const project = useProjectStore.getState().currentProject;
    if (!project || asset.type !== 'video') return;
    if (project.part_index) {
      alert('This project is already one part of a split video.');
      return;
    }
    if (useProjectStore.getState().videoClips.length > 0) {
      alert(
        'The timeline already has video on it, and splitting cuts the whole timeline video.\n\n' +
          'To split that, use Split in the top bar. To split only this asset, remove the clips from the timeline first, ' +
          'or use Split Long Video on the dashboard.',
      );
      return;
    }
    setIsAppending(true);
    showToast(`Preparing "${asset.name}" to split…`);
    try {
      setVideoClips(await assetToTimeline(project.id, asset.id));
      await loadProject(project.id);
      videoRef.current?.load();
      useProjectStore.getState().setSplitPrompt(project.id);
    } catch (err: any) {
      alert(`Could not prepare the video: ${err?.response?.data?.detail || err?.message || err}`);
    } finally {
      setIsAppending(false);
    }
  };

  /** An image asset becomes the project logo, shown on the video and added to exports. */
  const handleUseAsLogo = (asset: FolderAssetItem) => {
    if (!currentProject) return;
    const cur = loadLogoSettings(currentProject.id);
    saveLogoSettings(currentProject.id, { ...cur, url: asset.url, enabled: true });
    showToast(`"${asset.name}" is now your logo — adjust it with the Logo button above the video`);
  };

  const handleDeleteAsset = async (id: string) => {
    if (!currentProject) return;
    const asset = folderAssets.find((a) => a.id === id);
    if (!confirm(`Delete "${asset?.name ?? 'this file'}" from the library?`)) return;
    if (playingAudioKey === id) {
      audioPreviewRef.current?.pause();
      setPlayingAudioKey(null);
    }
    try {
      await deleteAsset(currentProject.id, id);
      setFolderAssets((cur) => cur.filter((a) => a.id !== id));
      showToast('Removed from the library');
    } catch (err: any) {
      alert(`Could not delete: ${err?.message || err}`);
    }
  };

  // Create a new folder bin
  const handleCreateFolder = () => {
    const trimmed = newFolderName.trim();
    if (!trimmed) return;
    if (!customFolders.includes(trimmed)) {
      saveFolders([...customFolders, trimmed]);
      setActiveFolder(trimmed);
      showToast(`Created folder "${trimmed}"`);
    }
    setNewFolderName('');
    setShowNewFolderModal(false);
  };

  // Drag & drop files or folders
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const files = e.dataTransfer.files;
    if (!files || files.length === 0 || !currentProject) return;

    if (files.length === 1 && !hasVideo && (files[0].type.startsWith('video/') || files[0].type.startsWith('audio/'))) {
      showToast('Uploading master video...');
      try {
        await uploadVideo(files[0]);
        await loadProject(currentProject.id);
        if (videoRef.current) {
          videoRef.current.load();
        }
        showToast('Video uploaded successfully');
      } catch (err: any) {
        alert(`Upload failed: ${err?.message || err}`);
      }
      return;
    }

    // Other drops go into the library, in the open folder
    await importFiles(Array.from(files), activeFolder === 'all' ? 'Imported' : activeFolder);
  };

  const formatDuration = (sec?: number) => {
    if (!sec) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const formatFileSize = (bytes?: number) => {
    if (!bytes) return '';
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const handleTogglePlayAudio = (key: string, url: string) => {
    if (playingAudioKey === key) {
      audioPreviewRef.current?.pause();
      audioPreviewRef.current = null;
      setPlayingAudioKey(null);
      return;
    }
    if (audioPreviewRef.current) {
      audioPreviewRef.current.pause();
      audioPreviewRef.current = null;
    }
    const audio = new Audio(url);
    audioPreviewRef.current = audio;
    setPlayingAudioKey(key);
    audio.onended = () => setPlayingAudioKey(null);
    audio.onerror = () => setPlayingAudioKey(null);
    audio.play().catch(() => setPlayingAudioKey(null));
  };

  // Filtered assets
  const displayedAssets = useMemo(() => {
    return folderAssets.filter((a) => {
      if (activeFolder !== 'all' && a.folderName !== activeFolder) return false;
      if (activeFilter === 'video' && a.type !== 'video') return false;
      if (activeFilter === 'audio' && a.type !== 'audio') return false;
      if (activeFilter === 'image' && a.type !== 'image') return false;
      if (searchQuery.trim() && !a.name.toLowerCase().includes(searchQuery.trim().toLowerCase())) return false;
      return true;
    });
  }, [folderAssets, activeFolder, activeFilter, searchQuery]);

  const matchesMaster = (type: AssetFilter, name: string) => activeFolder === 'all' && (activeFilter === 'all' || activeFilter === type) && name.toLowerCase().includes(searchQuery.trim().toLowerCase());
  const showMaster = hasVideo && matchesMaster('video', currentProject?.video_filename || 'Master Video');
  const showVocals = audioSeparated && !!vocalsUrl && matchesMaster('audio', 'Vocal Stem Isolated Dialogue');
  const showBgm = audioSeparated && !!bgmUrl && matchesMaster('audio', 'Background Music Instrumental');
  const totalAssetsCount = (hasVideo ? 1 : 0) + (audioSeparated ? 2 : 0) + folderAssets.length;

  return (
    <div className="flex flex-col h-full bg-[var(--s2)] text-[#e1e3e6] select-none font-sans overflow-hidden relative">
      {/* Toast Notification */}
      {toastMsg && (
        <div className="absolute top-3 right-3 z-40 bg-blue-950/95 border border-blue-500/50 text-blue-200 px-3 py-1.5 rounded-xl shadow-xl text-xs flex items-center gap-1.5 animate-in fade-in slide-in-from-top-1 backdrop-blur-md">
          <CheckCircle2 className="w-3.5 h-3.5 text-blue-400" />
          <span>{toastMsg}</span>
        </div>
      )}

      {/* Progress Toast while batch uploading folder */}
      {folderUploadProgress && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-40 bg-zinc-900/95 border border-blue-500/60 text-white px-4 py-2 rounded-2xl shadow-2xl text-xs flex items-center gap-3 backdrop-blur-md">
          <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
          <div>
            <p className="font-bold text-[11px] text-blue-300">
              Adding Folder to Timeline ({folderUploadProgress.current}/{folderUploadProgress.total})
            </p>
            <p className="text-[10px] text-zinc-400 truncate max-w-[200px]">{folderUploadProgress.name}</p>
          </div>
        </div>
      )}

      {/* Hidden file inputs */}
      <input
        ref={fileInputRef}
        type="file"
        accept="video/*,audio/*,.mp4,.mov,.webm,.mkv,.avi,.m4v,.ts"
        className="hidden"
        onChange={handleFileUpload}
      />
      {/* Pick any number of files into the library */}
      <input
        ref={libraryInputRef}
        type="file"
        multiple
        accept="video/*,audio/*,image/*"
        className="hidden"
        onChange={async (e) => {
          const files = Array.from(e.target.files || []);
          e.target.value = '';
          if (files.length) await importFiles(files, activeFolder === 'all' ? 'Imported' : activeFolder);
        }}
      />
      {/* Folder Picker Input with webkitdirectory */}
      <input
        ref={folderInputRef}
        type="file"
        // @ts-ignore
        webkitdirectory=""
        directory=""
        multiple
        className="hidden"
        onChange={handleFolderUpload}
      />

      <div className="px-3.5 pt-3 pb-2 border-b border-white/5 shrink-0">
        <h2 className="text-sm font-semibold text-white">Project assets <span className="text-xs text-zinc-500 ml-1">{totalAssetsCount}</span></h2>
        <p className="text-[10px] text-zinc-400 mt-1">Files you import are kept with this project. Add videos to the timeline, use an image as your logo.</p>
      </div>
      {/* Top Action & Folder Filter Header */}
      <div className="px-3.5 py-2.5 border-b border-[var(--s4)] bg-[var(--s2)] flex flex-col gap-2.5 shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {/* Action Buttons: Import Folder, Add File & New Bin */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={() => folderInputRef.current?.click()}
              className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-blue-600 to-emerald-600 hover:from-blue-500 hover:to-emerald-500 text-white text-xs font-bold flex items-center gap-1.5 shadow-md shadow-blue-950/40 active:scale-95 transition-all cursor-pointer"
              title="Select an entire folder from your computer to import all media clips"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              <span>Select Folder</span>
            </button>

            <button
              onClick={() => libraryInputRef.current?.click()}
              className="px-2.5 py-1.5 rounded-xl bg-[var(--s4)] hover:bg-[var(--s5)] border border-[var(--s7)] text-zinc-200 hover:text-white text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
              title={`Import videos, audio or images into ${activeFolder === 'all' ? 'the library' : `"${activeFolder}"`}`}
            >
              <Plus className="w-3.5 h-3.5 text-blue-400" />
              <span>Import files</span>
            </button>
            {!hasVideo && (
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-2.5 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
                title="Upload the main video for this project"
              >
                <Film className="w-3.5 h-3.5" />
                <span>Upload video</span>
              </button>
            )}

            <button
              onClick={() => setShowNewFolderModal(true)}
              className="p-1.5 rounded-xl bg-[var(--s4)] hover:bg-[var(--s5)] border border-[var(--s7)] text-zinc-400 hover:text-blue-300 transition-colors cursor-pointer"
              title="Create a new folder bin"
            >
              <FolderPlus className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Right Controls: View Switcher & Search Box */}
          <div className="flex items-center gap-2">
            {/* Grid / List Mode */}
            <div className="flex items-center bg-[var(--s3)] p-0.5 rounded-xl border border-[var(--s6)]">
              <button
                onClick={() => setViewMode('grid')}
                className={`p-1 rounded-lg transition-colors cursor-pointer ${
                  viewMode === 'grid'
                    ? 'bg-blue-600 text-white shadow-xs'
                    : 'text-zinc-400 hover:text-white'
                }`}
                title="Grid View"
              >
                <LayoutGrid className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setViewMode('list')}
                className={`p-1 rounded-lg transition-colors cursor-pointer ${
                  viewMode === 'list'
                    ? 'bg-blue-600 text-white shadow-xs'
                    : 'text-zinc-400 hover:text-white'
                }`}
                title="List View"
              >
                <List className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Search Box */}
            <div className="relative w-32 sm:w-36">
              <Search className="w-3 h-3 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                aria-label="Search assets"
                placeholder="Search assets..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-[var(--s2)] border border-[var(--s5)] focus:border-blue-500/60 rounded-xl pl-7 pr-2 py-1 text-[11px] text-white placeholder-zinc-500 outline-none transition-colors"
              />
            </div>
          </div>
        </div>

        {/* Media Type Filter & Folder Bins Carousel */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-white/5">
          {/* Quick Media Type Pills */}
          <div className="flex items-center gap-1 shrink-0">
            {(['all', 'video', 'audio', 'image'] as const).map((filterType) => (
              <button
                key={filterType}
                aria-pressed={activeFilter === filterType}
                onClick={() => setActiveFilter(filterType)}
                className={`px-2 py-0.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all cursor-pointer ${
                  activeFilter === filterType
                    ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5'
                }`}
              >
                {filterType === 'all' ? 'All' : filterType === 'video' ? 'Videos' : filterType === 'image' ? 'Images' : 'Audio'}
              </button>
            ))}
          </div>

          {/* Folder Bins Carousel */}
          <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5 flex-1 justify-end">
            <button
              onClick={() => setActiveFolder('all')}
              className={`px-2.5 py-1 rounded-lg text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap transition-all cursor-pointer ${
                activeFolder === 'all'
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'bg-[var(--s3)] text-zinc-400 hover:text-zinc-200 border border-[var(--s5)]'
              }`}
            >
              <Folders className="w-3 h-3" />
              <span>All ({totalAssetsCount})</span>
            </button>

            {allFolders.map((fName) => {
              const count = folderAssets.filter((a) => a.folderName === fName).length;
              const isSelected = activeFolder === fName;
              return (
                <div
                  key={fName}
                  className={`flex items-center gap-1 pl-2.5 pr-1 py-0.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all border ${
                    isSelected
                      ? 'bg-blue-600 text-white border-blue-500 shadow-sm'
                      : 'bg-[var(--s3)] text-zinc-400 hover:text-zinc-200 border-[var(--s5)]'
                  }`}
                >
                  <button
                    onClick={() => setActiveFolder(fName)}
                    className="flex items-center gap-1.5 cursor-pointer"
                  >
                    <Folder className="w-3 h-3 text-amber-400" />
                    <span>{fName}</span>
                    <span className="text-[10px] opacity-75 font-mono">({count})</span>
                  </button>

                  {/* Append Folder to Timeline Button */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleAppendAllFromFolder(fName);
                    }}
                    disabled={isAppending}
                    className="p-1 rounded hover:bg-white/20 text-blue-200 hover:text-white transition-colors cursor-pointer"
                    title={`Append all video clips in "${fName}" to Timeline`}
                  >
                    <Plus className="w-3 h-3" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Main Assets Grid & Drop Area */}
      <div className="flex-1 overflow-y-auto p-3.5 space-y-4 bg-[var(--s1)]">
        {/* Drop zone: a full card while the library is empty, a slim strip once it has files */}
        {folderAssets.length > 0 || hasVideo ? (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            className={`rounded-xl border border-dashed px-3 py-2 flex items-center gap-2 text-[11px] transition-colors ${
              isDragging ? 'border-blue-400 bg-blue-500/10 text-blue-200' : 'border-[var(--s5)] text-zinc-500'
            }`}
          >
            {isAppending ? <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-400" /> : <FolderOpen className="w-3.5 h-3.5 text-blue-400" />}
            <span>
              {isDragging
                ? `Drop to add to ${activeFolder === 'all' ? 'the library' : `"${activeFolder}"`}`
                : 'Drop videos, audio or images here to add them'}
            </span>
          </div>
        ) : (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            className={`border-2 border-dashed rounded-2xl p-4 flex flex-col items-center justify-center text-center transition-all ${
              isDragging
                ? 'border-blue-400 bg-blue-500/10 shadow-lg shadow-blue-950/40 scale-[1.01]'
                : 'border-[var(--s5)] hover:border-blue-500/50 bg-[rgb(var(--s2-rgb)/0.8)]'
            }`}
          >
            <div className="w-9 h-9 rounded-2xl bg-[var(--s4)] border border-[var(--s7)] flex items-center justify-center mb-1.5 text-blue-400 shadow-sm">
              <FolderOpen className="w-4 h-4" />
            </div>
            <p className="text-xs font-bold text-white mb-0.5">Drop your video here to start</p>
            <p className="text-[10px] text-zinc-400 mb-2.5">MP4, MOV, WebM, MKV — or pick a whole folder of clips</p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-3.5 py-1.5 rounded-xl bg-blue-600/90 hover:bg-blue-500 text-white text-xs font-bold flex items-center gap-1.5 shadow-sm transition-all cursor-pointer"
              >
                <Film className="w-3.5 h-3.5" />
                <span>Upload video</span>
              </button>
              <button
                onClick={() => folderInputRef.current?.click()}
                className="px-3.5 py-1.5 rounded-xl bg-[var(--s4)] hover:bg-[var(--s6)] border border-[var(--s7)] text-zinc-300 hover:text-white text-xs font-semibold transition-colors cursor-pointer"
              >
                Select folder
              </button>
            </div>
          </div>
        )}

        {/* Project Master & Stems (Shown when 'all' or no custom folder selected) */}
        {(showMaster || showVocals || showBgm) && (
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5 font-mono">
                <Layers className="w-3.5 h-3.5 text-blue-400" />
                Master Timeline Stems
              </span>
            </div>

            <div className={viewMode === 'grid' ? 'grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-2.5' : 'flex flex-col gap-2'}>
              {/* Master Video Card */}
              {showMaster && <div
                className={`bg-[var(--s2)] border border-[var(--s5)] hover:border-blue-500/70 rounded-2xl p-2.5 group relative shadow-md shadow-black/30 transition-all cursor-pointer overflow-hidden ${
                  viewMode === 'list' ? 'flex items-center justify-between gap-3' : 'space-y-2'
                }`}
                onClick={async () => {
                  if (!currentProject) return;
                  try {
                    const updated = await addVideoClip(currentProject.id, 0, currentProject.duration || 10);
                    setVideoClips(updated);
                    showToast('Placed master clip on Timeline (V1)');
                  } catch (err) {
                    console.error('Failed to add clip:', err);
                  }
                }}
                title="Click to place master video clip on Timeline"
              >
                <div className={`${viewMode === 'list' ? 'w-24 shrink-0' : 'w-full'} aspect-video bg-black rounded-xl overflow-hidden relative flex items-center justify-center border border-[var(--s4)]`}>
                  {thumbnailUrl ? (
                    <img src={thumbnailUrl} alt="Thumbnail" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                  ) : (
                    <Film className="w-5 h-5 text-zinc-600" />
                  )}
                  <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-md bg-blue-600/90 text-white font-mono text-[9px] font-bold shadow-sm">
                    V1 Master
                  </span>
                  <span className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded-md bg-black/80 backdrop-blur-sm text-[9px] font-mono text-zinc-200 font-bold border border-white/10">
                    {formatDuration(currentProject?.duration)}
                  </span>
                  <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                    <span className="px-2.5 py-1 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-bold flex items-center gap-1 shadow-lg active:scale-95 transition-transform">
                      <Plus className="w-3 h-3" />
                      <span>Place</span>
                    </span>
                  </div>
                </div>
                <div className={`flex-1 min-w-0 flex gap-2 ${viewMode === 'list' ? 'items-center justify-between' : 'flex-col'}`}>
                  <div>
                    <p className="text-xs font-bold text-white truncate">
                      {currentProject?.video_filename || 'Master Video'}
                    </p>
                    <span className="text-[10px] text-blue-400 font-semibold font-mono">Master Video</span>
                  </div>
                  <button className="px-2.5 py-1 rounded-lg bg-blue-600/20 text-blue-300 border border-blue-500/30 text-[10px] font-bold hover:bg-blue-600 hover:text-white transition-colors">
                    + Timeline
                  </button>
                </div>
              </div>

              }
              {/* Separated Vocals */}
              {showVocals && vocalsUrl && (
                <div
                  className={`bg-[var(--s2)] border border-[var(--s5)] hover:border-white/10 rounded-2xl p-2.5 group relative shadow-md shadow-black/30 transition-all ${
                    viewMode === 'list' ? 'flex items-center justify-between gap-3' : 'space-y-2'
                  }`}
                >
                  <div className={`${viewMode === 'list' ? 'w-24 shrink-0' : 'w-full'} aspect-video bg-white/10 to-[var(--s2)] border border-white/10 rounded-xl flex flex-col items-center justify-center relative overflow-hidden`}>
                    {playingAudioKey === 'vocals' ? (
                      <div className="flex items-end gap-1 mb-1.5 h-5">
                        <div className="w-1 bg-white/10 rounded animate-bounce [animation-delay:-0.3s] h-4" />
                        <div className="w-1 bg-white/10 rounded animate-bounce [animation-delay:-0.1s] h-5" />
                        <div className="w-1 bg-white/10 rounded animate-bounce [animation-delay:-0.4s] h-3" />
                      </div>
                    ) : null}
                    <button
                      onClick={() => handleTogglePlayAudio('vocals', vocalsUrl)}
                      className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/10 text-white flex items-center justify-center shadow-lg transition-all active:scale-95 cursor-pointer"
                    >
                      {playingAudioKey === 'vocals' ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 ml-0.5" />}
                    </button>
                    <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-md bg-white/10 text-white font-mono text-[9px] font-bold">
                      A1 Vocals
                    </span>
                  </div>
                  <div className="flex-1 min-w-0 flex flex-wrap items-center justify-between gap-1.5">
                    <div>
                      <p className="text-xs font-bold text-zinc-200 truncate">Vocal Stem</p>
                      <span className="text-[10px] text-zinc-400 font-mono">Isolated Dialogue</span>
                    </div>
                    <span className="text-[10px] px-2 py-0.5 rounded bg-white/10 text-zinc-200 border border-white/10 font-mono font-bold">
                      A1 Track
                    </span>
                  </div>
                </div>
              )}

              {/* Separated BGM */}
              {showBgm && bgmUrl && (
                <div
                  className={`bg-[var(--s2)] border border-[var(--s5)] hover:border-amber-500/60 rounded-2xl p-2.5 group relative shadow-md shadow-black/30 transition-all ${
                    viewMode === 'list' ? 'flex items-center justify-between gap-3' : 'space-y-2'
                  }`}
                >
                  <div className={`${viewMode === 'list' ? 'w-24 shrink-0' : 'w-full'} aspect-video bg-gradient-to-br from-amber-950/60 to-[var(--s2)] border border-amber-500/20 rounded-xl flex flex-col items-center justify-center relative overflow-hidden`}>
                    {playingAudioKey === 'bgm' ? (
                      <div className="flex items-end gap-1 mb-1.5 h-5">
                        <div className="w-1 bg-amber-400 rounded animate-bounce [animation-delay:-0.2s] h-4" />
                        <div className="w-1 bg-amber-300 rounded animate-bounce [animation-delay:-0.4s] h-5" />
                        <div className="w-1 bg-amber-400 rounded animate-bounce [animation-delay:-0.1s] h-3" />
                      </div>
                    ) : null}
                    <button
                      onClick={() => handleTogglePlayAudio('bgm', bgmUrl)}
                      className="w-8 h-8 rounded-full bg-amber-600 hover:bg-amber-500 text-white flex items-center justify-center shadow-lg transition-all active:scale-95 cursor-pointer"
                    >
                      {playingAudioKey === 'bgm' ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 ml-0.5" />}
                    </button>
                    <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-md bg-amber-600/90 text-white font-mono text-[9px] font-bold">
                      BGM Music
                    </span>
                  </div>
                  <div className="flex-1 min-w-0 flex flex-wrap items-center justify-between gap-1.5">
                    <div>
                      <p className="text-xs font-bold text-amber-300 truncate">Background Music</p>
                      <span className="text-[10px] text-amber-400 font-mono">Instrumental</span>
                    </div>
                    <span className="text-[10px] px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 font-mono font-bold">
                      B1 Track
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Folder Assets Section */}
        {displayedAssets.length > 0 && (
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5 font-mono">
                <Folder className="w-3.5 h-3.5 text-amber-400" />
                {activeFolder === 'all' ? `Folder Bins (${displayedAssets.length})` : `${activeFolder} (${displayedAssets.length})`}
              </span>

              {activeFolder !== 'all' && (
                <button
                  onClick={() => handleAppendAllFromFolder(activeFolder)}
                  disabled={isAppending}
                  className="px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-bold flex items-center gap-1 transition-colors cursor-pointer"
                >
                  <Plus className="w-3 h-3" />
                  <span>Append All to Timeline</span>
                </button>
              )}
            </div>

            <div className={viewMode === 'grid' ? 'grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-2.5' : 'flex flex-col gap-2'}>
              {displayedAssets.map((asset) => (
                <div
                  key={asset.id}
                  className={`bg-[var(--s2)] border border-[var(--s5)] hover:border-blue-500/60 rounded-2xl p-2.5 group relative shadow-md shadow-black/30 transition-all overflow-hidden ${
                    viewMode === 'list' ? 'flex items-center justify-between gap-3' : 'space-y-2'
                  }`}
                >
                  <div className={`${viewMode === 'list' ? 'w-24 shrink-0' : 'w-full'} aspect-video bg-black/70 border border-[var(--s4)] rounded-xl flex items-center justify-center relative overflow-hidden`}>
                    {asset.type === 'video' ? (
                      asset.thumbnailUrl ? (
                        <img src={asset.thumbnailUrl} alt={asset.name} className="w-full h-full object-cover" loading="lazy" />
                      ) : (
                        <div className="flex flex-col items-center justify-center text-blue-400">
                          <Film className="w-5 h-5 mb-0.5" />
                          <span className="text-[9px] font-mono text-zinc-400 uppercase">Video</span>
                        </div>
                      )
                    ) : asset.type === 'audio' ? (
                      <div className="flex flex-col items-center justify-center text-zinc-400">
                        <button
                          onClick={() => handleTogglePlayAudio(asset.id, asset.url)}
                          className="w-7 h-7 rounded-full bg-white/10 hover:bg-white/10 text-white flex items-center justify-center shadow-lg transition-all active:scale-95 cursor-pointer"
                        >
                          {playingAudioKey === asset.id ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3 ml-0.5" />}
                        </button>
                        <span className="text-[9px] font-mono text-zinc-400 mt-0.5">Audio</span>
                      </div>
                    ) : (
                      <img src={asset.thumbnailUrl || asset.url} alt={asset.name} className="w-full h-full object-contain" loading="lazy" />
                    )}

                    {/* Length, for video and audio */}
                    {asset.duration ? (
                      <span className="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded-md bg-black/80 text-[9px] font-mono text-zinc-200">
                        {formatDuration(asset.duration)}
                      </span>
                    ) : null}

                    {/* Folder Badge */}
                    <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-md bg-zinc-800/90 text-amber-300 font-mono text-[9px] font-bold border border-amber-500/20">
                      {asset.folderName}
                    </span>

                    {/* Size badge */}
                    {asset.size && (
                      <span className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded-md bg-black/80 text-[9px] font-mono text-zinc-400">
                        {formatFileSize(asset.size)}
                      </span>
                    )}

                    {/* Quick Add to Timeline Overlay */}
                    {asset.type === 'video' && (
                      <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                        <button
                          onClick={() => handleAddAssetToTimeline(asset)}
                          disabled={isAppending}
                          className="px-2.5 py-1 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-bold flex items-center gap-1 shadow-lg active:scale-95 transition-transform cursor-pointer"
                        >
                          <Plus className="w-3 h-3" />
                          <span>Add</span>
                        </button>
                      </div>
                    )}
                  </div>

                  <div className={`flex-1 min-w-0 flex gap-2 ${viewMode === 'list' ? 'items-center justify-between' : 'flex-col'}`}>
                    <div>
                      <p className="text-xs font-bold text-white truncate" title={asset.name}>
                        {asset.name}
                      </p>
                      <span className="text-[9px] text-zinc-500 font-mono">
                        {asset.type.toUpperCase()} · {asset.folderName}
                      </span>
                    </div>

                    <div className="flex items-center gap-1">
                      {asset.type === 'video' && (
                        <button
                          onClick={() => handleAddAssetToTimeline(asset)}
                          disabled={isAppending}
                          title="Add to the end of the timeline"
                          className="px-2 py-1 rounded-lg bg-blue-600/20 text-blue-300 hover:bg-blue-600 hover:text-white text-[10px] font-bold transition-colors cursor-pointer"
                        >
                          + Add
                        </button>
                      )}
                      {asset.type === 'video' && (asset.duration || 0) >= 120 && (
                        <button
                          onClick={() => void handleSplitAsset(asset)}
                          disabled={isAppending}
                          title="Split this video into part projects"
                          className="px-2 py-1 rounded-lg bg-[var(--s4)] text-zinc-300 hover:bg-[var(--s6)] hover:text-white text-[10px] font-bold transition-colors cursor-pointer flex items-center gap-1"
                        >
                          <Scissors className="w-3 h-3" />
                          Split
                        </button>
                      )}
                      {asset.type === 'image' && (
                        <button
                          onClick={() => handleUseAsLogo(asset)}
                          title="Use this image as the project logo"
                          className="px-2 py-1 rounded-lg bg-sky-600/20 text-sky-300 hover:bg-sky-600 hover:text-white text-[10px] font-bold transition-colors cursor-pointer"
                        >
                          Use as logo
                        </button>
                      )}
                      <button
                        onClick={() => handleDeleteAsset(asset.id)}
                        className="p-1 rounded hover:bg-red-500/20 text-zinc-500 hover:text-red-400 transition-colors opacity-60 hover:opacity-100 focus-visible:opacity-100 cursor-pointer"
                        title="Remove asset from bin"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Empty state when no assets found */}
        {displayedAssets.length === 0 && !showMaster && !showVocals && !showBgm && (
          <div className="text-center py-10 space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-[var(--s3)] border border-[var(--s5)] flex items-center justify-center text-zinc-500 mx-auto shadow-inner">
              <FolderOpen className="w-6 h-6 text-blue-400" />
            </div>
            <h4 className="text-xs font-bold text-white">{searchQuery || activeFilter !== 'all' || activeFolder !== 'all' ? 'No matching assets' : 'Your media library starts here'}</h4>
            <p className="text-[11px] text-zinc-400 max-w-xs mx-auto">
              Import a folder or drop media files here. Try another search or filter to find your assets.
              </p>
              <button onClick={() => { setSearchQuery(''); setActiveFilter('all'); setActiveFolder('all'); }} className="text-xs text-blue-400 hover:text-blue-300">Clear search and filters</button>

          </div>
        )}
      </div>

      {/* New Folder Modal */}
      {showNewFolderModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          onClick={() => setShowNewFolderModal(false)}
        >
          <div
            className="bg-[var(--s2)] border border-[var(--s6)] rounded-2xl shadow-2xl w-full max-w-sm p-5 space-y-4 animate-in fade-in zoom-in-95"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <FolderPlus className="w-4 h-4 text-blue-400" />
                Create New Folder Bin
              </h3>
              <button
                onClick={() => setShowNewFolderModal(false)}
                className="p-1 rounded-lg text-zinc-400 hover:text-white hover:bg-white/10"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-1.5">
              <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wide">
                Folder / Bin Name
              </label>
              <input
                type="text"
                placeholder="e.g. B-Roll, Scene 1, Sound Effects"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreateFolder()}
                autoFocus
                className="w-full bg-[var(--s2)] border border-[var(--s6)] focus:border-blue-500 rounded-xl px-3 py-2 text-xs text-white placeholder-zinc-500 outline-none"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={() => setShowNewFolderModal(false)}
                className="px-3.5 py-1.5 rounded-xl text-xs font-semibold text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateFolder}
                disabled={!newFolderName.trim()}
                className="px-4 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-bold transition-all shadow-md shadow-blue-950/40"
              >
                Create Folder
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
