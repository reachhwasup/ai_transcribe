import { useState, useRef, useEffect } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { askAiAgent } from '../api/client';
import {
  Sparkles,
  Send,
  Loader2,
  Copy,
  Check,
  ChevronDown,
  Bot,
  Trash2,
  MessageSquare,
  Wand2,
  Film,
  Type,
  TrendingUp,
  Languages,
} from 'lucide-react';

interface AIStyleTemplate {
  id: string;
  title: string;
  desc: string;
  prompt: string;
  tag: string;
  icon: string;
  category: 'motion' | 'script' | 'viral';
}

const TEMPLATES: AIStyleTemplate[] = [
  {
    id: 't1',
    title: 'Animated Bar Chart',
    desc: 'Infographic animation for stats and metrics',
    prompt: 'Generate an animated infographic bar chart motion graphic idea for key statistics in this video.',
    tag: 'CHART',
    icon: '📊',
    category: 'motion',
  },
  {
    id: 't2',
    title: 'Fluid Ribbon Intro',
    desc: 'Sleek S-curve title animation for intros',
    prompt: 'Design a smooth, fluid ribbon motion graphic title reveal with modern typography for this video.',
    tag: 'INTRO',
    icon: '🌊',
    category: 'motion',
  },
  {
    id: 't3',
    title: 'Glassmorphism Lower Third',
    desc: 'Gradient slide-up speaker label',
    prompt: 'Create a sleek glassmorphic lower third graphic description for speaker name and context.',
    tag: 'LABEL',
    icon: '🏷️',
    category: 'motion',
  },
  {
    id: 't4',
    title: 'Khmer Dialogue Polisher',
    desc: 'Enhance natural Khmer dialogue flow',
    prompt: 'Review and polish the current subtitle dialogue to make it sound natural, punchy, and cinematic in Khmer.',
    tag: 'KHMER',
    icon: '✍️',
    category: 'script',
  },
  {
    id: 't5',
    title: 'Viral 3s Hook Opener',
    desc: 'Create attention-grabbing hook scripts',
    prompt: 'Write 3 high-retention viral hook opening lines for TikTok / Reels / Shorts based on this video.',
    tag: 'VIRAL',
    icon: '🔥',
    category: 'viral',
  },
  {
    id: 't6',
    title: 'YouTube Titles & SEO Tags',
    desc: 'Click-worthy titles and descriptions',
    prompt: 'Generate 5 catchy YouTube titles, 10 SEO hashtags, and a compelling video description for this content.',
    tag: 'SEO',
    icon: '🚀',
    category: 'viral',
  },
];

const AGENT_PERSONAS = [
  { id: 'all', name: 'Studio AI (Full Agent)', icon: Bot, desc: 'All-around assistant for video, script, and styling' },
  { id: 'motion', name: 'Motion Graphic Designer', icon: Film, desc: 'Specialized in visual titles, animations, and overlays' },
  { id: 'script', name: 'Khmer Script & Dialogue Writer', icon: Type, desc: 'Specialized in natural Khmer storytelling and dialogue' },
  { id: 'viral', name: 'Viral Hook & SEO Specialist', icon: TrendingUp, desc: 'Specialized in hooks, click-through titles, and hashtags' },
  { id: 'translate', name: 'Subtitle & Translation Pro', icon: Languages, desc: 'Specialized in translation nuance and subtitle formatting' },
];

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export default function AIAssistantPanel() {
  const { currentProject } = useProjectStore();
  const currentProjectId = currentProject?.id;

  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showAgentMenu, setShowAgentMenu] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState(AGENT_PERSONAS[0]);
  const [activeCategory, setActiveCategory] = useState<'all' | 'motion' | 'script' | 'viral'>('all');

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const agentMenuRef = useRef<HTMLDivElement | null>(null);

  // Load chat history per project from localStorage
  useEffect(() => {
    if (!currentProjectId) {
      setMessages([]);
      return;
    }
    try {
      const raw = localStorage.getItem(`ai-chat-${currentProjectId}`);
      if (raw) {
        setMessages(JSON.parse(raw));
      } else {
        setMessages([]);
      }
    } catch {
      setMessages([]);
    }
  }, [currentProjectId]);

  // Persist chat history per project
  useEffect(() => {
    if (currentProjectId && messages.length > 0) {
      try {
        localStorage.setItem(`ai-chat-${currentProjectId}`, JSON.stringify(messages));
      } catch {}
    }
  }, [messages, currentProjectId]);

  useEffect(() => {
    if (messages.length > 0 || loading) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length, loading]);

  // Outside click for agent dropdown
  useEffect(() => {
    if (!showAgentMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (agentMenuRef.current && !agentMenuRef.current.contains(e.target as Node)) {
        setShowAgentMenu(false);
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClick);
    }, 10);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClick);
    };
  }, [showAgentMenu]);

  const handleSend = async (customPrompt?: string) => {
    const textToSend = customPrompt || prompt;
    if (!currentProject?.id || !textToSend.trim() || loading) return;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: textToSend.trim(),
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages((prev) => [...prev, userMsg]);
    if (!customPrompt) setPrompt('');
    setLoading(true);

    try {
      const res = await askAiAgent(currentProject.id, 'custom_chat', textToSend.trim());
      const aiMsg: ChatMessage = {
        id: `ai-${Date.now()}`,
        role: 'assistant',
        content: res.content || 'I completed processing your request.',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      setMessages((prev) => [...prev, aiMsg]);
    } catch (err: any) {
      const errorMsg: ChatMessage = {
        id: `err-${Date.now()}`,
        role: 'assistant',
        content: `Error: ${err?.response?.data?.detail || err?.message || 'Failed to query AI Assistant'}`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = (msgId: string, content: string) => {
    navigator.clipboard.writeText(content);
    setCopiedId(msgId);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleClearHistory = () => {
    setMessages([]);
    if (currentProjectId) {
      localStorage.removeItem(`ai-chat-${currentProjectId}`);
    }
  };

  const filteredTemplates = TEMPLATES.filter(
    (t) => activeCategory === 'all' || t.category === activeCategory
  );

  return (
    <div className="h-full flex flex-col bg-[#121316] text-[#e1e3e6] overflow-hidden select-none font-sans">
      {/* Top Header */}
      <div className="px-4 py-2.5 flex items-center justify-between shrink-0 border-b border-[#1c1e24] bg-[#121316]">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-xl bg-gradient-to-tr from-amber-500 via-pink-500 to-purple-600 flex items-center justify-center text-white shadow-md shadow-amber-950/40">
            <Sparkles className="w-3.5 h-3.5" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <h2 className="text-xs font-bold text-white tracking-wide">Meatika AI Studio</h2>
              <span className="text-[9px] px-1.5 py-0.2 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 font-bold font-mono">
                Gemini 2.5 Flash
              </span>
            </div>
            <p className="text-[10px] text-zinc-400 font-medium truncate max-w-[200px] flex items-center gap-1 mt-0.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span>{selectedAgent.name}</span>
            </p>
          </div>
        </div>

        {/* Clear Chat Button */}
        {messages.length > 0 && (
          <button
            onClick={handleClearHistory}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-red-400 hover:bg-[#181a1f] transition-colors border border-transparent hover:border-red-500/20"
            title="Clear Chat History"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Main Scroll Area: Templates & Chat Feed */}
      <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-4">
        {messages.length === 0 && (
          <div className="space-y-3 animate-in fade-in">
            {/* Quick Categories Switcher */}
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold tracking-wider text-zinc-500 uppercase">
                Quick AI Templates
              </span>
              <div className="flex items-center gap-1 bg-[#181a1f] p-0.5 rounded-lg border border-[#24272f]">
                {(['all', 'motion', 'script', 'viral'] as const).map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setActiveCategory(cat)}
                    className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                      activeCategory === cat
                        ? 'bg-[#252830] text-white font-bold'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {cat === 'all' ? 'All' : cat === 'motion' ? 'Motion' : cat === 'script' ? 'Script' : 'Viral'}
                  </button>
                ))}
              </div>
            </div>

            {/* Template Cards Grid */}
            <div className="grid grid-cols-2 gap-2">
              {filteredTemplates.map((tmpl) => (
                <div
                  key={tmpl.id}
                  onClick={() => handleSend(tmpl.prompt)}
                  className="p-3 rounded-xl border border-[#22252c] bg-[#16181d] hover:border-amber-500/40 hover:bg-[#1a1c22] cursor-pointer transition-all flex flex-col justify-between group shadow-sm"
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-base">{tmpl.icon}</span>
                    <span className="text-[8px] font-mono px-1.5 py-0.2 rounded bg-[#20232a] text-zinc-400 border border-[#2c303a]">
                      {tmpl.tag}
                    </span>
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-white group-hover:text-amber-400 transition-colors line-clamp-1">
                      {tmpl.title}
                    </h4>
                    <p className="text-[10px] text-zinc-400 line-clamp-2 mt-0.5 leading-tight">
                      {tmpl.desc}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Chat Messages Feed */}
        {messages.map((msg) => {
          const isUser = msg.role === 'user';

          return (
            <div
              key={msg.id}
              className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} space-y-1`}
            >
              <div className="flex items-center gap-1.5 text-[10px] font-mono text-zinc-500 px-1">
                <span>{isUser ? 'You' : 'Meatika AI'}</span>
                <span>·</span>
                <span>{msg.timestamp}</span>
              </div>

              <div
                className={`p-3.5 rounded-2xl text-xs leading-relaxed max-w-[92%] select-text font-sans ${
                  isUser
                    ? 'bg-gradient-to-r from-purple-600 to-pink-600 text-white rounded-br-none shadow-md shadow-purple-950/30'
                    : 'bg-[#181a1f] border border-[#24272f] text-zinc-200 rounded-bl-none shadow-sm space-y-2'
                }`}
              >
                <div className="whitespace-pre-wrap font-khmer">{msg.content}</div>

                {!isUser && (
                  <div className="flex items-center justify-end gap-1.5 pt-1.5 border-t border-[#24272f]/80">
                    <button
                      onClick={() => handleCopy(msg.id, msg.content)}
                      className="flex items-center gap-1 px-2 py-0.5 rounded bg-[#22252c] hover:bg-[#2c3038] text-[10px] text-zinc-400 hover:text-white transition-colors"
                      title="Copy response"
                    >
                      {copiedId === msg.id ? (
                        <Check className="w-3 h-3 text-emerald-400" />
                      ) : (
                        <Copy className="w-3 h-3" />
                      )}
                      <span>{copiedId === msg.id ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {/* Loading Bubble */}
        {loading && (
          <div className="flex flex-col items-start space-y-1 animate-in fade-in">
            <div className="flex items-center gap-1.5 text-[10px] font-mono text-zinc-500 px-1">
              <span>Meatika AI</span>
              <span>·</span>
              <span>Thinking...</span>
            </div>
            <div className="p-3.5 rounded-2xl bg-[#181a1f] border border-amber-500/40 text-zinc-300 text-xs rounded-bl-none flex items-center gap-2 shadow-sm">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400" />
              <span>Generating ideas and scripts with Gemini AI...</span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Bottom Floating Prompt Card */}
      <div className="p-3 border-t border-[#1c1e24] bg-[#121316] shrink-0">
        <div className="bg-[#181a1f] border border-[#24272f] focus-within:border-amber-500/60 rounded-xl p-2.5 space-y-2 shadow-md transition-colors">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Ask AI to design motion graphics, polish Khmer dialogue, generate hooks..."
            rows={2}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            className="w-full bg-transparent border-none text-xs text-white placeholder-zinc-500 focus:outline-none resize-none leading-relaxed font-sans"
          />

          <div className="pt-1.5 border-t border-[#20232a] flex items-center justify-between">
            {/* Agent Persona Dropdown */}
            <div className="relative" ref={agentMenuRef}>
              <button
                onClick={() => setShowAgentMenu(!showAgentMenu)}
                className="flex items-center gap-1.5 text-xs text-zinc-300 hover:text-white transition-colors font-medium px-2 py-1 rounded-lg bg-[#20232a] border border-[#2c303a] hover:border-amber-500/40"
              >
                <Sparkles className="w-3 h-3 text-amber-400" />
                <span className="truncate max-w-[140px]">{selectedAgent.name.split(' ')[0]}</span>
                <ChevronDown className="w-3 h-3 text-zinc-500" />
              </button>

              {showAgentMenu && (
                <div className="absolute bottom-full left-0 mb-1.5 w-64 bg-[#1e2025] border border-[#31353e] rounded-xl shadow-2xl p-1 z-50 animate-in fade-in">
                  <div className="px-2 py-1 text-[10px] font-bold text-zinc-400 uppercase tracking-wider border-b border-zinc-800 pb-1 mb-1">
                    AI Specialist Persona
                  </div>
                  {AGENT_PERSONAS.map((agent) => {
                    const Icon = agent.icon;
                    return (
                      <button
                        key={agent.id}
                        onClick={() => {
                          setSelectedAgent(agent);
                          setShowAgentMenu(false);
                        }}
                        className={`w-full p-2 text-left text-xs rounded-lg transition-colors flex items-center gap-2 ${
                          selectedAgent.id === agent.id
                            ? 'bg-amber-500/20 text-amber-300 font-bold border border-amber-500/30'
                            : 'hover:bg-[#282c34] text-zinc-300'
                        }`}
                      >
                        <Icon className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                        <div className="truncate">
                          <span className="block truncate font-bold text-[11px]">{agent.name}</span>
                          <span className="block truncate text-[9px] text-zinc-400 font-normal">{agent.desc}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Send Button */}
            <button
              onClick={() => handleSend()}
              disabled={loading || !prompt.trim()}
              className="px-3 py-1.5 rounded-lg bg-gradient-to-r from-amber-500 via-pink-500 to-purple-600 hover:from-amber-400 hover:to-purple-500 text-white font-bold text-xs flex items-center gap-1.5 shadow-md active:scale-95 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              title="Send Prompt (Enter)"
            >
              {loading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Send className="w-3.5 h-3.5" />
              )}
              <span>Ask</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
