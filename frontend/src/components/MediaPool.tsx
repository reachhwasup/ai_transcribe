import { useState, useRef, RefObject, useEffect, useMemo } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { appendVideoFileToTimeline, addVideoClip } from '../api/client';
import {
  Upload,
  Play,
  Pause,
  Film,
  Music,
  Plus,
  Trash2,
  FileVideo,
  FileAudio,
  FileImage,
  Clock,
  Loader2,
  FolderOpen,
  FolderPlus,
  Folder,
  Folders,
  Sparkles,
  Layers,
  CheckCircle2,
  Radio,
  Image as ImageIcon,
  HardDrive,
  Download,
  Filter,
  Volume2,
  Sliders,
  Scissors,
  X,
  Search,
  Check,
  ChevronRight,
} from 'lucide-react';

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>;
  vocalsUrl: string | null;
  bgmUrl: string | null;
  audioSeparated: boolean;
}

export interface FolderAssetItem {
  id: string;
  name: string;
  folderName: string;
  file?: File;
  url: string;
  type: 'video' | 'audio' | 'image';
  size?: number;
  duration?: number;
  thumbnailUrl?: string;
  addedAt: number;
}

type AssetFilter = 'all' | 'video' | 'audio' | 'clips';

export default function MediaPool({ videoRef, vocalsUrl, bgmUrl, audioSeparated }: Props) {
  const {
    currentProject,
    uploadVideo,
    setVideoClips,
    videoClips,
    currentTime,
    setCurrentTime,
    loadProject,
  } = useProjectStore();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const appendInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

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
  const [folderUploadProgress, setFolderUploadProgress] = useState<{ current: number; total: number; name: string } | null>(null);

  const audioPreviewRef = useRef<HTMLAudioElement | null>(null);

  const hasVideo = !!currentProject?.video_path;

  // Load custom folder structure and assets from localStorage for this project
  useEffect(() => {
    if (!currentProject?.id) return;
    try {
      const storedFolders = localStorage.getItem(`meatika_folders_${currentProject.id}`);
      if (storedFolders) {
        setCustomFolders(JSON.parse(storedFolders));
      }
      const storedAssets = localStorage.getItem(`meatika_assets_${currentProject.id}`);
      if (storedAssets) {
        setFolderAssets(JSON.parse(storedAssets));
      }
    } catch {}
  }, [currentProject?.id]);

  // Persist folders and assets to localStorage
  const saveFolders = (folders: string[]) => {
    setCustomFolders(folders);
    if (currentProject?.id) {
      try {
        localStorage.setItem(`meatika_folders_${currentProject.id}`, JSON.stringify(folders));
      } catch {}
    }
  };

  const saveAssets = (assets: FolderAssetItem[]) => {
    setFolderAssets(assets);
    if (currentProject?.id) {
      try {
        localStorage.setItem(`meatika_assets_${currentProject.id}`, JSON.stringify(assets));
      } catch {}
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

  // Handle appending a single video file to timeline
  const handleAppendFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentProject) return;
    if (appendInputRef.current) appendInputRef.current.value = '';
    setIsAppending(true);
    showToast(`Adding "${file.name}" to timeline...`);
    try {
      const updated = await appendVideoFileToTimeline(currentProject.id, file);
      setVideoClips(updated);
      await loadProject(currentProject.id);
      if (videoRef.current) {
        videoRef.current.load();
      }
      showToast('New clip added to timeline');
    } catch (err: any) {
      console.error('Failed to append video to timeline:', err);
      alert(`Failed to add video: ${err?.response?.data?.detail || err?.message || err}`);
    } finally {
      setIsAppending(false);
    }
  };

  // Handle selecting an ENTIRE FOLDER from local machine
  const handleFolderUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !currentProject) return;

    const fileList = Array.from(files);
    if (folderInputRef.current) folderInputRef.current.value = '';

    // Filter media files
    const mediaFiles = fileList.filter((f) => {
      const name = f.name.toLowerCase();
      return (
        name.endsWith('.mp4') ||
        name.endsWith('.mov') ||
        name.endsWith('.webm') ||
        name.endsWith('.mkv') ||
        name.endsWith('.avi') ||
        name.endsWith('.m4v') ||
        name.endsWith('.ts') ||
        name.endsWith('.mp3') ||
        name.endsWith('.wav') ||
        name.endsWith('.m4a') ||
        name.endsWith('.aac') ||
        name.endsWith('.flac') ||
        name.endsWith('.ogg') ||
        name.endsWith('.png') ||
        name.endsWith('.jpg') ||
        name.endsWith('.jpeg') ||
        name.endsWith('.webp')
      );
    });

    if (mediaFiles.length === 0) {
      showToast('No video or audio files found in selected folder');
      return;
    }

    // Extract folder name from the relative path
    let detectedFolderName = 'Imported Folder';
    const firstRel = (mediaFiles[0] as any).webkitRelativePath || '';
    if (firstRel) {
      const parts = firstRel.split('/');
      if (parts.length > 1) {
        detectedFolderName = parts[0];
      }
    }

    // Add folder to customFolders list if not already present
    if (!customFolders.includes(detectedFolderName)) {
      saveFolders([...customFolders, detectedFolderName]);
    }

    // Convert into FolderAssetItems
    const newItems: FolderAssetItem[] = mediaFiles.map((file) => {
      const rel = (file as any).webkitRelativePath || '';
      let fName = detectedFolderName;
      if (rel) {
        const parts = rel.split('/');
        if (parts.length > 2) {
          fName = `${parts[0]}/${parts[1]}`;
        }
      }

      const isVideo = file.type.startsWith('video/') || /\.(mp4|mov|webm|mkv|avi|m4v|ts)$/i.test(file.name);
      const isAudio = file.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(file.name);

      return {
        id: `asset_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        name: file.name,
        folderName: fName,
        file: file,
        url: URL.createObjectURL(file),
        type: isVideo ? 'video' : isAudio ? 'audio' : 'image',
        size: file.size,
        addedAt: Date.now(),
      };
    });

    saveAssets([...folderAssets, ...newItems]);
    setActiveFolder(detectedFolderName);
    showToast(`Imported ${newItems.length} assets into folder "${detectedFolderName}"`);
  };

  // One-click: Append all video clips from a specific folder onto the timeline
  const handleAppendAllFromFolder = async (folderName: string) => {
    if (!currentProject) return;
    const targetAssets = folderAssets.filter(
      (a) => (folderName === 'all' || a.folderName === folderName) && a.type === 'video' && a.file
    );

    if (targetAssets.length === 0) {
      showToast(`No video files to append in "${folderName}"`);
      return;
    }

    setIsAppending(true);
    setFolderUploadProgress({ current: 0, total: targetAssets.length, name: folderName });

    try {
      for (let i = 0; i < targetAssets.length; i++) {
        const asset = targetAssets[i];
        if (asset.file) {
          setFolderUploadProgress({ current: i + 1, total: targetAssets.length, name: asset.name });
          const updated = await appendVideoFileToTimeline(currentProject.id, asset.file);
          setVideoClips(updated);
        }
      }
      await loadProject(currentProject.id);
      if (videoRef.current) {
        videoRef.current.load();
      }
      showToast(`Successfully added ${targetAssets.length} clips to timeline!`);
    } catch (err: any) {
      console.error('Failed to append folder clips:', err);
      alert(`Error appending clips: ${err?.message || err}`);
    } finally {
      setIsAppending(false);
      setFolderUploadProgress(null);
    }
  };

  // Add individual asset item from folder to timeline
  const handleAddAssetToTimeline = async (asset: FolderAssetItem) => {
    if (!currentProject) return;
    if (asset.file) {
      setIsAppending(true);
      showToast(`Adding "${asset.name}" to timeline...`);
      try {
        const updated = await appendVideoFileToTimeline(currentProject.id, asset.file);
        setVideoClips(updated);
        await loadProject(currentProject.id);
        if (videoRef.current) {
          videoRef.current.load();
        }
        showToast(`Clip "${asset.name}" added to timeline`);
      } catch (err: any) {
        alert(`Failed to add clip: ${err?.message || err}`);
      } finally {
        setIsAppending(false);
      }
    } else {
      showToast(`Asset is already in library`);
    }
  };

  // Remove asset from folder
  const handleDeleteAsset = (id: string) => {
    const updated = folderAssets.filter((a) => a.id !== id);
    saveAssets(updated);
    showToast('Asset removed from folder');
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

    if (files.length === 1 && !hasVideo) {
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

    // Multiple files dropped -> add to active folder bin
    const folderTarget = activeFolder === 'all' ? 'Imported Files' : activeFolder;
    if (!customFolders.includes(folderTarget)) {
      saveFolders([...customFolders, folderTarget]);
    }

    const newItems: FolderAssetItem[] = Array.from(files).map((file) => {
      const isVideo = file.type.startsWith('video/') || /\.(mp4|mov|webm|mkv|avi|m4v|ts)$/i.test(file.name);
      const isAudio = file.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(file.name);
      return {
        id: `asset_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        name: file.name,
        folderName: folderTarget,
        file: file,
        url: URL.createObjectURL(file),
        type: isVideo ? 'video' : isAudio ? 'audio' : 'image',
        size: file.size,
        addedAt: Date.now(),
      };
    });

    saveAssets([...folderAssets, ...newItems]);
    setActiveFolder(folderTarget);
    showToast(`Added ${newItems.length} files to folder "${folderTarget}"`);
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
      if (searchQuery.trim() && !a.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
      return true;
    });
  }, [folderAssets, activeFolder, activeFilter, searchQuery]);

  const totalAssetsCount = (hasVideo ? 1 : 0) + (audioSeparated ? 2 : 0) + folderAssets.length;

  return (
    <div className="flex flex-col h-full bg-[#111317] text-[#e1e3e6] select-none font-sans overflow-hidden relative">
      {/* Toast Notification */}
      {toastMsg && (
        <div className="absolute top-3 right-3 z-40 bg-teal-950/95 border border-teal-500/50 text-teal-200 px-3 py-1.5 rounded-xl shadow-xl text-xs flex items-center gap-1.5 animate-in fade-in slide-in-from-top-1 backdrop-blur-md">
          <CheckCircle2 className="w-3.5 h-3.5 text-teal-400" />
          <span>{toastMsg}</span>
        </div>
      )}

      {/* Progress Toast while batch uploading folder */}
      {folderUploadProgress && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-40 bg-zinc-900/95 border border-teal-500/60 text-white px-4 py-2 rounded-2xl shadow-2xl text-xs flex items-center gap-3 backdrop-blur-md">
          <Loader2 className="w-4 h-4 text-teal-400 animate-spin" />
          <div>
            <p className="font-bold text-[11px] text-teal-300">
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
      <input
        ref={appendInputRef}
        type="file"
        accept="video/*,audio/*,.mp4,.mov,.webm,.mkv,.avi,.m4v,.ts"
        className="hidden"
        onChange={handleAppendFile}
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

      {/* Top Action & Folder Filter Header */}
      <div className="px-3.5 py-2.5 border-b border-[#1f222b] bg-[#14161d] flex flex-col gap-2 shrink-0">
        <div className="flex items-center justify-between gap-2">
          {/* Action Buttons: Import Folder & Add File */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => folderInputRef.current?.click()}
              className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-teal-600 to-emerald-600 hover:from-teal-500 hover:to-emerald-500 text-white text-xs font-bold flex items-center gap-1.5 shadow-md shadow-teal-950/40 active:scale-95 transition-all"
              title="Select an entire folder from your computer to import all media clips"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              <span>Select Folder</span>
            </button>

            <button
              onClick={() => {
                if (hasVideo) appendInputRef.current?.click();
                else fileInputRef.current?.click();
              }}
              className="px-2.5 py-1.5 rounded-xl bg-[#1d212c] hover:bg-[#282e3c] border border-[#2e3546] text-zinc-300 hover:text-white text-xs font-semibold flex items-center gap-1.5 transition-colors"
              title="Add individual video/audio file"
            >
              <Plus className="w-3.5 h-3.5 text-teal-400" />
              <span>Add File</span>
            </button>

            <button
              onClick={() => setShowNewFolderModal(true)}
              className="p-1.5 rounded-xl bg-[#1d212c] hover:bg-[#282e3c] border border-[#2e3546] text-zinc-400 hover:text-teal-300 transition-colors"
              title="Create a new folder bin"
            >
              <FolderPlus className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Search Box */}
          <div className="relative max-w-[140px]">
            <Search className="w-3 h-3 text-zinc-500 absolute left-2 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search assets..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-[#101217] border border-[#232736] focus:border-teal-500/60 rounded-xl pl-6 pr-2 py-1 text-[11px] text-white placeholder-zinc-500 outline-none"
            />
          </div>
        </div>

        {/* Folder Bins Tab Carousel */}
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5">
          <button
            onClick={() => setActiveFolder('all')}
            className={`px-2.5 py-1 rounded-lg text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap transition-all ${
              activeFolder === 'all'
                ? 'bg-teal-600/90 text-white shadow-sm'
                : 'bg-[#181a24] text-zinc-400 hover:text-zinc-200 border border-[#232736]'
            }`}
          >
            <Folders className="w-3 h-3" />
            <span>All Assets ({totalAssetsCount})</span>
          </button>

          {allFolders.map((fName) => {
            const count = folderAssets.filter((a) => a.folderName === fName).length;
            const isSelected = activeFolder === fName;
            return (
              <div
                key={fName}
                className={`flex items-center gap-1 pl-2.5 pr-1.5 py-0.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all border ${
                  isSelected
                    ? 'bg-teal-600/90 text-white border-teal-500 shadow-sm'
                    : 'bg-[#181a24] text-zinc-400 hover:text-zinc-200 border-[#232736]'
                }`}
              >
                <button
                  onClick={() => setActiveFolder(fName)}
                  className="flex items-center gap-1.5"
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
                  className="p-1 rounded hover:bg-white/20 text-teal-200 hover:text-white transition-colors"
                  title={`Append all video clips in "${fName}" to Timeline`}
                >
                  <Plus className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Main Assets Grid & Drop Area */}
      <div className="flex-1 overflow-y-auto p-3.5 space-y-3.5 bg-[#0f1115]">
        {/* Drag and Drop Zone */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          className={`border-2 border-dashed rounded-2xl p-3.5 flex flex-col items-center justify-center text-center transition-all ${
            isDragging
              ? 'border-teal-400 bg-teal-500/10 shadow-lg shadow-teal-950/40 scale-[1.01]'
              : 'border-[#232838] hover:border-teal-500/50 bg-[#141720]'
          }`}
        >
          <div className="w-9 h-9 rounded-2xl bg-[#1d212e] border border-[#2d3448] flex items-center justify-center mb-1.5 text-teal-400 shadow-sm">
            {isAppending ? (
              <Loader2 className="w-4 h-4 animate-spin text-teal-400" />
            ) : (
              <FolderOpen className="w-4 h-4" />
            )}
          </div>
          <p className="text-xs font-bold text-white mb-0.5">
            {hasVideo ? 'Drop video folders or media clips here' : 'Drop video file or folder here'}
          </p>
          <p className="text-[10px] text-zinc-400 mb-2">
            Import by Folder, MP4, MOV, WebM, MKV, MP3, WAV
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => folderInputRef.current?.click()}
              className="px-3 py-1 rounded-xl bg-teal-600/90 hover:bg-teal-500 text-white text-xs font-bold flex items-center gap-1 shadow-sm transition-all"
            >
              <FolderOpen className="w-3 h-3" />
              <span>Select Folder</span>
            </button>
            <button
              onClick={() => {
                if (hasVideo) appendInputRef.current?.click();
                else fileInputRef.current?.click();
              }}
              className="px-3 py-1 rounded-xl bg-[#1d212c] hover:bg-[#282e3c] border border-[#2e3546] text-zinc-300 hover:text-white text-xs font-semibold transition-colors"
            >
              Browse Files
            </button>
          </div>
        </div>

        {/* Project Master & Stems (Shown when 'all' or no custom folder selected) */}
        {hasVideo && activeFolder === 'all' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-teal-400" />
                Master Timeline Stems
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              {/* Master Video Card */}
              <div
                className="bg-[#141720] border border-[#242938] hover:border-teal-500/70 rounded-2xl p-2.5 space-y-2 group relative shadow-md shadow-black/30 transition-all cursor-pointer overflow-hidden"
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
                <div className="aspect-video bg-black rounded-xl overflow-hidden relative flex items-center justify-center border border-[#1e2332]">
                  {thumbnailUrl ? (
                    <img src={thumbnailUrl} alt="Thumbnail" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                  ) : (
                    <Film className="w-6 h-6 text-zinc-600" />
                  )}
                  <span className="absolute top-1.5 left-1.5 px-2 py-0.5 rounded-md bg-teal-600/90 text-white font-mono text-[9px] font-bold shadow-sm">
                    V1 Master
                  </span>
                  <span className="absolute bottom-1.5 right-1.5 px-2 py-0.5 rounded-md bg-black/80 backdrop-blur-sm text-[10px] font-mono text-zinc-200 font-bold border border-white/10">
                    {formatDuration(currentProject?.duration)}
                  </span>
                  <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                    <span className="px-3 py-1.5 rounded-xl bg-teal-600 hover:bg-teal-500 text-white text-xs font-bold flex items-center gap-1.5 shadow-lg active:scale-95 transition-transform">
                      <Plus className="w-3.5 h-3.5" />
                      <span>Place on Timeline</span>
                    </span>
                  </div>
                </div>
                <div className="flex items-center justify-between pt-0.5">
                  <p className="text-xs font-bold text-white truncate max-w-[120px]">
                    {currentProject?.video_filename || 'Master Video'}
                  </p>
                  <span className="text-[10px] text-teal-400 font-semibold font-mono">Master</span>
                </div>
              </div>

              {/* Separated Vocals */}
              {audioSeparated && vocalsUrl && (
                <div className="bg-[#141720] border border-[#242938] hover:border-purple-500/60 rounded-2xl p-2.5 space-y-2 group relative shadow-md shadow-black/30 transition-all">
                  <div className="aspect-video bg-gradient-to-br from-purple-950/60 to-[#141720] border border-purple-500/20 rounded-xl flex flex-col items-center justify-center relative overflow-hidden">
                    {playingAudioKey === 'vocals' ? (
                      <div className="flex items-end gap-1 mb-2 h-6">
                        <div className="w-1 bg-purple-400 rounded animate-bounce [animation-delay:-0.3s] h-5" />
                        <div className="w-1 bg-purple-300 rounded animate-bounce [animation-delay:-0.1s] h-6" />
                        <div className="w-1 bg-purple-400 rounded animate-bounce [animation-delay:-0.4s] h-3" />
                        <div className="w-1 bg-purple-200 rounded animate-bounce [animation-delay:-0.2s] h-6" />
                      </div>
                    ) : null}
                    <button
                      onClick={() => handleTogglePlayAudio('vocals', vocalsUrl)}
                      className="w-9 h-9 rounded-full bg-purple-600 hover:bg-purple-500 text-white flex items-center justify-center shadow-lg transition-all active:scale-95"
                    >
                      {playingAudioKey === 'vocals' ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 ml-0.5" />}
                    </button>
                    <span className="absolute top-1.5 left-1.5 px-2 py-0.5 rounded-md bg-purple-600/90 text-white font-mono text-[9px] font-bold">
                      A1 Vocals
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-bold text-purple-300 truncate">Vocal Stem</p>
                    <span className="text-[10px] text-purple-400 font-mono">Isolated</span>
                  </div>
                </div>
              )}

              {/* Separated BGM */}
              {audioSeparated && bgmUrl && (
                <div className="bg-[#141720] border border-[#242938] hover:border-blue-500/60 rounded-2xl p-2.5 space-y-2 group relative shadow-md shadow-black/30 transition-all">
                  <div className="aspect-video bg-gradient-to-br from-blue-950/60 to-[#141720] border border-blue-500/20 rounded-xl flex flex-col items-center justify-center relative overflow-hidden">
                    {playingAudioKey === 'bgm' ? (
                      <div className="flex items-end gap-1 mb-2 h-6">
                        <div className="w-1 bg-blue-400 rounded animate-bounce [animation-delay:-0.2s] h-5" />
                        <div className="w-1 bg-blue-300 rounded animate-bounce [animation-delay:-0.4s] h-6" />
                        <div className="w-1 bg-blue-400 rounded animate-bounce [animation-delay:-0.1s] h-4" />
                      </div>
                    ) : null}
                    <button
                      onClick={() => handleTogglePlayAudio('bgm', bgmUrl)}
                      className="w-9 h-9 rounded-full bg-blue-600 hover:bg-blue-500 text-white flex items-center justify-center shadow-lg transition-all active:scale-95"
                    >
                      {playingAudioKey === 'bgm' ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 ml-0.5" />}
                    </button>
                    <span className="absolute top-1.5 left-1.5 px-2 py-0.5 rounded-md bg-blue-600/90 text-white font-mono text-[9px] font-bold">
                      A2 Music
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-bold text-blue-300 truncate">Background Music</p>
                    <span className="text-[10px] text-blue-400 font-mono">BGM Stem</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Folder Assets Section */}
        {displayedAssets.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5">
                <Folder className="w-3.5 h-3.5 text-amber-400" />
                {activeFolder === 'all' ? `All Folder Assets (${displayedAssets.length})` : `${activeFolder} (${displayedAssets.length})`}
              </span>

              {activeFolder !== 'all' && (
                <button
                  onClick={() => handleAppendAllFromFolder(activeFolder)}
                  disabled={isAppending}
                  className="px-2 py-1 rounded-lg bg-teal-600 hover:bg-teal-500 text-white text-[10px] font-bold flex items-center gap-1 transition-colors"
                >
                  <Plus className="w-3 h-3" />
                  <span>Append All to Timeline</span>
                </button>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              {displayedAssets.map((asset) => (
                <div
                  key={asset.id}
                  className="bg-[#141720] border border-[#242938] hover:border-teal-500/60 rounded-2xl p-2.5 space-y-2 group relative shadow-md shadow-black/30 transition-all overflow-hidden"
                >
                  <div className="aspect-video bg-black/70 border border-[#1e2332] rounded-xl flex items-center justify-center relative overflow-hidden">
                    {asset.type === 'video' ? (
                      <div className="flex flex-col items-center justify-center text-teal-400">
                        <Film className="w-6 h-6 mb-1" />
                        <span className="text-[9px] font-mono text-zinc-400">Video Clip</span>
                      </div>
                    ) : asset.type === 'audio' ? (
                      <div className="flex flex-col items-center justify-center text-purple-400">
                        <button
                          onClick={() => handleTogglePlayAudio(asset.id, asset.url)}
                          className="w-8 h-8 rounded-full bg-purple-600 hover:bg-purple-500 text-white flex items-center justify-center shadow-lg transition-all active:scale-95"
                        >
                          {playingAudioKey === asset.id ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 ml-0.5" />}
                        </button>
                        <span className="text-[9px] font-mono text-zinc-400 mt-1">Audio</span>
                      </div>
                    ) : (
                      <ImageIcon className="w-6 h-6 text-blue-400" />
                    )}

                    {/* Folder Badge */}
                    <span className="absolute top-1.5 left-1.5 px-2 py-0.5 rounded-md bg-zinc-800/90 text-amber-300 font-mono text-[8px] font-bold border border-amber-500/20">
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
                          className="px-2.5 py-1 rounded-xl bg-teal-600 hover:bg-teal-500 text-white text-[11px] font-bold flex items-center gap-1 shadow-lg active:scale-95 transition-transform"
                        >
                          <Plus className="w-3 h-3" />
                          <span>Add to Timeline</span>
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center justify-between pt-0.5">
                    <p className="text-xs font-bold text-white truncate max-w-[120px]" title={asset.name}>
                      {asset.name}
                    </p>
                    <button
                      onClick={() => handleDeleteAsset(asset.id)}
                      className="p-1 rounded hover:bg-red-500/20 text-zinc-500 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
                      title="Remove asset from bin"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Empty state when no assets found */}
        {displayedAssets.length === 0 && !hasVideo && (
          <div className="text-center py-8 space-y-2.5">
            <div className="w-12 h-12 rounded-2xl bg-[#161922] border border-[#242938] flex items-center justify-center text-zinc-500 mx-auto">
              <FolderOpen className="w-6 h-6 text-teal-400" />
            </div>
            <h4 className="text-xs font-bold text-white">Media Pool is Empty</h4>
            <p className="text-[11px] text-zinc-400 max-w-xs mx-auto">
              Click <b>"Select Folder"</b> to import an entire directory of clips, or drag & drop media files here.
            </p>
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
            className="bg-[#14161f] border border-[#2b3144] rounded-2xl shadow-2xl w-full max-w-sm p-5 space-y-4 animate-in fade-in zoom-in-95"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <FolderPlus className="w-4 h-4 text-teal-400" />
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
                className="w-full bg-[#101217] border border-[#2a3042] focus:border-teal-500 rounded-xl px-3 py-2 text-xs text-white placeholder-zinc-500 outline-none"
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
                className="px-4 py-1.5 rounded-xl bg-teal-600 hover:bg-teal-500 disabled:opacity-50 text-white text-xs font-bold transition-all shadow-md shadow-teal-950/40"
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
