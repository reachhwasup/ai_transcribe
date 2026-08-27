import React, { useState, useEffect } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { generateMovieTitles, generateSocialMediaScript } from '../api/client';
import {
  Sparkles,
  Flame,
  Zap,
  Copy,
  Check,
  CheckCheck,
  Hash,
  MessageSquare,
  FileText,
  Loader2,
  RefreshCw,
  Monitor,
} from 'lucide-react';

interface Props {
  onOpenExport?: () => void;
}

export default function ViralPublishingStudio({ onOpenExport }: Props) {
  const { currentProject } = useProjectStore();
  const [titlesList, setTitlesList] = useState<
    Array<{ category: string; category_label: string; title: string; description: string }>
  >([]);
  const [socialScriptData, setSocialScriptData] = useState<{
    platform?: string;
    hook?: string;
    viral_titles?: string[];
    captions?: {
      tiktok?: string;
      youtube_shorts?: string;
      facebook_reels?: string;
      full_description?: string;
    };
    hashtags?: string[];
    pinned_comment?: string;
    call_to_action?: string;
    suggested_sound?: string;
    cover_text_hook?: string;
    seo_keywords?: string[];
  } | null>(null);
  const [generatingMetadata, setGeneratingMetadata] = useState(false);
  const [metadataTone, setMetadataTone] = useState<'viral' | 'suspense' | 'comedy' | 'action' | 'emotional'>('viral');
  const [metadataPlatform, setMetadataPlatform] = useState<'all' | 'tiktok' | 'youtube' | 'facebook'>('all');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const copyToClipboard = (text: string, key: string) => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2500);
  };

  const handleGenerate = async () => {
    if (!currentProject) return;
    setGeneratingMetadata(true);
    try {
      const [titles, social] = await Promise.all([
        generateMovieTitles(currentProject.id, currentProject.name, currentProject.language || 'km').catch(() => []),
        generateSocialMediaScript(currentProject.id, {
          originalTitle: currentProject.name,
          language: currentProject.language || 'km',
          platform: metadataPlatform === 'all' ? 'tiktok' : metadataPlatform,
          tone: metadataTone,
        }).catch(() => null),
      ]);
      setTitlesList(titles || []);
      setSocialScriptData(social as any);
    } catch (err) {
      console.error('Generate metadata failed:', err);
    } finally {
      setGeneratingMetadata(false);
    }
  };

  useEffect(() => {
    if (currentProject && titlesList.length === 0 && !generatingMetadata) {
      handleGenerate();
    }
  }, [currentProject?.id]);

  return (
    <div className="h-full flex flex-col bg-[#121316] text-[#e1e3e6] overflow-y-auto p-4 md:p-6 space-y-6 select-none font-sans">
      {/* Header Banner */}
      <div className="p-5 rounded-2xl bg-gradient-to-br from-[#1c1a29] via-[#161822] to-[#12131a] border border-purple-500/20 shadow-xl space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-pink-500 to-purple-600 flex items-center justify-center text-white shadow-lg shadow-purple-900/50">
              <Sparkles className="w-5 h-5 text-yellow-300 animate-pulse" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                Viral Titles, Hooks & Tags Studio
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30">
                  Pre-Export AI
                </span>
              </h2>
              <p className="text-xs text-zinc-400">
                Craft high-CTR viral titles, 3-second opening hooks, descriptions & hashtags before exporting
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleGenerate}
              disabled={generatingMetadata}
              className="px-4 py-2 rounded-xl bg-gradient-to-r from-pink-600 via-purple-600 to-indigo-600 hover:from-pink-500 hover:to-indigo-500 text-white text-xs font-bold shadow-lg shadow-purple-950/50 flex items-center gap-2 transition-all active:scale-95 disabled:opacity-50 cursor-pointer"
            >
              {generatingMetadata ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>AI Generating Package...</span>
                </>
              ) : (
                <>
                  <RefreshCw className="w-4 h-4 text-yellow-300" />
                  <span>{titlesList.length > 0 ? 'Regenerate Titles & Tags' : 'Generate Viral Package'}</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Tone & Target Filter Bar */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2 border-t border-white/5">
          <div className="space-y-1.5">
            <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-1">
              <Flame className="w-3 h-3 text-pink-400" />
              Content Vibe / Tone
            </label>
            <div className="flex items-center gap-1 overflow-x-auto pb-1 no-scrollbar">
              {[
                { id: 'viral', label: '🔥 Viral Hook' },
                { id: 'suspense', label: '🎭 Suspense & Drama' },
                { id: 'comedy', label: '😂 Comedy' },
                { id: 'action', label: '⚡ Action Battle' },
                { id: 'emotional', label: '❤️ Emotional' },
              ].map((t) => (
                <button
                  key={t.id}
                  onClick={() => setMetadataTone(t.id as any)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-semibold whitespace-nowrap transition-all cursor-pointer ${
                    metadataTone === t.id
                      ? 'bg-purple-600 text-white shadow-xs ring-1 ring-white/20'
                      : 'bg-[#1e2029] text-zinc-400 hover:text-zinc-200 border border-white/5'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-1">
              <Monitor className="w-3 h-3 text-blue-400" />
              Target Social Platform
            </label>
            <div className="flex items-center gap-1 overflow-x-auto pb-1 no-scrollbar">
              {[
                { id: 'all', label: 'All Platforms' },
                { id: 'tiktok', label: 'TikTok / Shorts' },
                { id: 'youtube', label: 'YouTube' },
                { id: 'facebook', label: 'Facebook Reels' },
              ].map((p) => (
                <button
                  key={p.id}
                  onClick={() => setMetadataPlatform(p.id as any)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-semibold whitespace-nowrap transition-all cursor-pointer ${
                    metadataPlatform === p.id
                      ? 'bg-pink-600 text-white shadow-xs ring-1 ring-white/20'
                      : 'bg-[#1e2029] text-zinc-400 hover:text-zinc-200 border border-white/5'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* 1. Catchy Titles Section */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
            <Flame className="w-4 h-4 text-pink-400" />
            Catchy Video Titles (ចំណងជើងទាក់ទាញ)
          </h3>
          <span className="text-[10px] text-zinc-400 font-mono">
            {titlesList.length} Variations Generated
          </span>
        </div>

        {titlesList.length === 0 && !generatingMetadata ? (
          <div className="p-8 rounded-2xl bg-[#181a1f] border border-[#26282e] text-center space-y-2">
            <Sparkles className="w-6 h-6 text-pink-400 mx-auto animate-bounce" />
            <p className="text-xs text-zinc-300 font-medium">No titles generated yet</p>
            <p className="text-[11px] text-zinc-500">
              Click "Generate Viral Package" to create 5+ high-CTR titles based on this video's dialogue
            </p>
          </div>
        ) : generatingMetadata && titlesList.length === 0 ? (
          <div className="p-8 rounded-2xl bg-[#181a1f] border border-[#26282e] text-center space-y-2">
            <Loader2 className="w-6 h-6 text-purple-400 animate-spin mx-auto" />
            <p className="text-xs text-zinc-300">Crafting high-CTR viral titles from your transcript...</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2.5">
            {titlesList.map((rawItem, idx) => {
              const item = typeof rawItem === 'string'
                ? { category: 'viral_hook', category_label: 'ចំណងជើងទាក់ទាញ (Viral Hook)', title: rawItem, description: '' }
                : {
                    category: (rawItem as any).category || 'viral_hook',
                    category_label: (rawItem as any).category_label || (rawItem as any).category || 'ចំណងជើងទាក់ទាញ',
                    title: (rawItem as any).title || (rawItem as any).text || String(rawItem || ''),
                    description: (rawItem as any).description || '',
                  };
              const isCopied = copiedKey === `title-${idx}`;
              return (
                <div
                  key={idx}
                  className="p-3.5 rounded-xl bg-[#181a1f] hover:bg-[#1f2229] border border-[#26282e] hover:border-purple-500/40 transition-all flex items-center justify-between gap-3 group"
                >
                  <div className="space-y-1 flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-purple-500/15 text-purple-300 border border-purple-500/25">
                        {item.category_label || item.category}
                      </span>
                    </div>
                    <p className="text-xs font-bold text-white leading-relaxed select-text">
                      {item.title}
                    </p>
                    {item.description && (
                      <p className="text-[10px] text-zinc-400 leading-normal">
                        {item.description}
                      </p>
                    )}
                  </div>

                  <button
                    onClick={() => copyToClipboard(item.title, `title-${idx}`)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 shrink-0 transition-all cursor-pointer ${
                      isCopied
                        ? 'bg-emerald-600 text-white shadow-sm'
                        : 'bg-[#252833] hover:bg-[#323645] text-zinc-200 hover:text-white border border-white/10'
                    }`}
                  >
                    {isCopied ? (
                      <>
                        <CheckCheck className="w-3.5 h-3.5 text-white" />
                        <span>Copied!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>Copy</span>
                      </>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 2. First 3-Seconds Hook / On-Screen Text */}
      {socialScriptData?.hook && (
        <div className="p-4 rounded-2xl bg-[#181a1f] border border-pink-500/20 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-pink-400 uppercase tracking-wider flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5 text-yellow-300" />
              First 3-Seconds Video Hook (ឃ្លាទាក់ទាញ 3 វិនាទីដំបូង)
            </span>
            <button
              onClick={() => copyToClipboard(socialScriptData.hook || '', 'hook')}
              className="text-[11px] text-zinc-400 hover:text-pink-300 font-semibold flex items-center gap-1 cursor-pointer"
            >
              {copiedKey === 'hook' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
              <span>{copiedKey === 'hook' ? 'Copied' : 'Copy Hook'}</span>
            </button>
          </div>
          <p className="text-xs text-zinc-200 font-medium bg-black/40 p-2.5 rounded-xl border border-white/5 select-text">
            "{socialScriptData.hook}"
          </p>
        </div>
      )}

      {/* 3. Social Media Descriptions & Captions */}
      {socialScriptData?.captions && (
        <div className="space-y-3">
          <h3 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
            <FileText className="w-4 h-4 text-blue-400" />
            Video Description & Caption (ការពិពណ៌នាវីដេអូ)
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {socialScriptData.captions.tiktok && (
              <div className="p-3.5 rounded-xl bg-[#181a1f] border border-[#26282e] space-y-2 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[10px] font-bold text-pink-300 uppercase tracking-wider">
                      📱 TikTok / Reels Caption
                    </span>
                    <button
                      onClick={() => copyToClipboard(socialScriptData?.captions?.tiktok || '', 'desc-tiktok')}
                      className="text-[10px] text-zinc-400 hover:text-white font-semibold flex items-center gap-1 cursor-pointer"
                    >
                      {copiedKey === 'desc-tiktok' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                      <span>{copiedKey === 'desc-tiktok' ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                  <p className="text-[11px] text-zinc-300 whitespace-pre-line select-text line-clamp-6">
                    {socialScriptData.captions.tiktok}
                  </p>
                </div>
              </div>
            )}

            {(socialScriptData.captions.youtube_shorts || (socialScriptData.captions as any).full_description) && (
              <div className="p-3.5 rounded-xl bg-[#181a1f] border border-[#26282e] space-y-2 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[10px] font-bold text-red-300 uppercase tracking-wider">
                      ▶️ YouTube / Full Description
                    </span>
                    <button
                      onClick={() => copyToClipboard(socialScriptData?.captions?.youtube_shorts || (socialScriptData?.captions as any)?.full_description || '', 'desc-yt')}
                      className="text-[10px] text-zinc-400 hover:text-white font-semibold flex items-center gap-1 cursor-pointer"
                    >
                      {copiedKey === 'desc-yt' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                      <span>{copiedKey === 'desc-yt' ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                  <p className="text-[11px] text-zinc-300 whitespace-pre-line select-text line-clamp-6">
                    {socialScriptData.captions.youtube_shorts || (socialScriptData.captions as any).full_description}
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 4. Trending Hashtags Cloud */}
      {socialScriptData?.hashtags && socialScriptData.hashtags.length > 0 && (
        <div className="p-4 rounded-2xl bg-[#181a1f] border border-[#26282e] space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
              <Hash className="w-3.5 h-3.5 text-indigo-400" />
              Trending Hashtags ({socialScriptData.hashtags.length} Tags)
            </span>
            <button
              onClick={() => {
                const allFormatted = (socialScriptData.hashtags || []).map((t) => {
                  const clean = String(t || '').trim().replace(/^#+/, '').replace(/\s+/g, '');
                  return clean ? `#${clean}` : '';
                }).filter(Boolean);
                copyToClipboard(allFormatted.join(' '), 'tags-all');
              }}
              className="px-2.5 py-1 rounded-lg bg-indigo-600/30 hover:bg-indigo-600 text-indigo-200 hover:text-white text-[11px] font-bold border border-indigo-500/30 flex items-center gap-1 transition-all cursor-pointer"
            >
              {copiedKey === 'tags-all' ? <Check className="w-3 h-3 text-emerald-300" /> : <Copy className="w-3 h-3" />}
              <span>{copiedKey === 'tags-all' ? 'All Copied!' : 'Copy All Hashtags'}</span>
            </button>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {socialScriptData.hashtags.map((tag, idx) => {
              const cleanTag = String(tag || '').trim().replace(/^#+/, '').replace(/\s+/g, '');
              const formattedTag = cleanTag ? `#${cleanTag}` : tag;
              const isTagCopied = copiedKey === `tag-${idx}`;
              return (
                <button
                  key={idx}
                  onClick={() => copyToClipboard(formattedTag, `tag-${idx}`)}
                  className="px-2 py-0.5 rounded-lg bg-[#222633] hover:bg-purple-900/40 text-zinc-300 hover:text-purple-200 text-[11px] font-mono border border-white/5 hover:border-purple-500/30 transition-colors flex items-center gap-1 cursor-pointer"
                  title="Click to copy single hashtag"
                >
                  <span>{formattedTag}</span>
                  {isTagCopied && <Check className="w-2.5 h-2.5 text-emerald-400" />}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 5. Pinned Comment & Engagement CTA */}
      {socialScriptData?.pinned_comment && (
        <div className="p-3.5 rounded-xl bg-[#181a1f] border border-[#26282e] space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold text-yellow-400 uppercase tracking-wider flex items-center gap-1">
              <MessageSquare className="w-3 h-3 text-yellow-400" />
              Pinned Comment Hook (ខមមិនទាក់ទាញអ្នកទស្សនា)
            </span>
            <button
              onClick={() => copyToClipboard(socialScriptData.pinned_comment || '', 'comment')}
              className="text-[10px] text-zinc-400 hover:text-white font-semibold flex items-center gap-1 cursor-pointer"
            >
              {copiedKey === 'comment' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
              <span>{copiedKey === 'comment' ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
          <p className="text-xs text-zinc-300 select-text bg-black/30 p-2 rounded-lg border border-white/5">
            {socialScriptData.pinned_comment}
          </p>
        </div>
      )}
    </div>
  );
}
