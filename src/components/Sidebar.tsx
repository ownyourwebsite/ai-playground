"use client";

import React from "react";
import {
  Settings,
  Plus,
  PanelLeftClose,
  MessageSquare,
  Code,
  Database,
  Trash2,
  Sparkles,
  FolderTree,
  Bug,
  Check,
  type LucideIcon,
} from "lucide-react";
import { useWorkspace } from "@/context/WorkspaceContext";
import { deleteSession, getSkills, saveSkill, deleteSkill } from "@/lib/db";
import { Skill, Session } from "@/lib/types";

// Lucide icon components available for skills (keyed by skill.icon)
const SKILL_ICONS: Record<string, LucideIcon> = {
  "folder-tree": FolderTree,
  "code": Code,
  "bug": Bug,
  "database": Database,
  "sparkles": Sparkles,
};

const DEFAULT_SKILLS: Skill[] = [
  {
    id: "skill-repo-explorer",
    name: "Repo Explorer",
    icon: "folder-tree",
    description: "Explore a repo structure, files and tech stack.",
    instructions:
      "Explore the repository structure: map the main directories and files, explain what each key module does, identify the tech stack and frameworks used, and summarize how the project is organized. If the GitHub MCP is connected, use get_file_contents to read the README and key source files so your analysis is grounded in the actual code.",
    useGithubMcp: true,
    createdAt: 0,
  },
  {
    id: "skill-code-reviewer",
    name: "Code Reviewer",
    icon: "code",
    description: "Review a specific file or PR for bugs and style.",
    instructions:
      "Conduct a thorough code review of the specified file or PR: check for bugs, security issues, performance problems, and style violations. Provide a prioritized list of findings, each with a concrete fix suggestion. If the GitHub MCP is connected, use it to read the relevant files before reviewing.",
    useGithubMcp: true,
    createdAt: 0,
  },
  {
    id: "skill-debugger",
    name: "Debugger",
    icon: "bug",
    description: "Structure a bug: symptoms → hypothesis → check → fix.",
    instructions:
      "Help me debug this issue using this structure:\n1. Symptoms — describe exactly what happens.\n2. Hypothesis — propose the most likely root causes.\n3. Check — verify each hypothesis with logs or tests.\n4. Fix — implement and verify the solution.",
    createdAt: 0,
  },
  {
    id: "skill-data-analyst",
    name: "Data Analyst",
    icon: "database",
    description: "Analyze a dataset with inputs, goal and output format.",
    instructions:
      "Act as a data analyst. First ask for the input data, the analysis goal, and the desired output format. Then analyze the dataset, highlight the key insights, trends and anomalies, and present the results clearly and concisely.",
    createdAt: 0,
  },
];

export default function Sidebar() {
  const {
    isLeftSidebarOpen,
    setIsLeftSidebarOpen,
    sessions,
    activeSessionId,
    setActiveSessionId,
    startNewSession,
    setIsSettingsOpen,
    setInput,
  } = useWorkspace();

  const [showAllSessions, setShowAllSessions] = React.useState(false);

  // --- Skills state (local-first, stored in IndexedDB) ---
  const [skills, setSkills] = React.useState<Skill[]>([]);
  const [activeSkillId, setActiveSkillId] = React.useState<string | null>(null);
  const [skillInstructions, setSkillInstructions] = React.useState("");
  const [skillUseMcp, setSkillUseMcp] = React.useState(false);

  // --- New custom skill form state ---
  const [showCreateSkill, setShowCreateSkill] = React.useState(false);
  const [newSkillName, setNewSkillName] = React.useState("");
  const [newSkillIcon, setNewSkillIcon] = React.useState("sparkles");
  const [newSkillInstructions, setNewSkillInstructions] = React.useState("");
  const [newSkillUseMcp, setNewSkillUseMcp] = React.useState(false);

  // Load skills from IndexedDB, seeding defaults on first run
  React.useEffect(() => {
    (async () => {
      const stored = await getSkills();
      if (stored && stored.length > 0) {
        setSkills(stored);
      } else {
        await Promise.all(DEFAULT_SKILLS.map((s) => saveSkill(s)));
        setSkills(DEFAULT_SKILLS);
      }
    })();
  }, []);

  const handleDeleteSession = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (confirm("Are you sure you want to delete this session?")) {
      await deleteSession(id);
      if (activeSessionId === id) {
        startNewSession();
      }
      // Force reload page / state if needed, or handle in context
      window.location.reload();
    }
  };

  const sortedSessions = React.useMemo(() => {
    return [...sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }, [sessions]);

  const displayedSessions = showAllSessions ? sortedSessions : sortedSessions.slice(0, 10);
  const hasMoreSessions = sortedSessions.length > 10;

  const openSkill = (skill: Skill) => {
    if (activeSkillId === skill.id) {
      setActiveSkillId(null);
      return;
    }
    setActiveSkillId(skill.id);
    setSkillInstructions(skill.instructions);
    setSkillUseMcp(!!skill.useGithubMcp);
  };

  const applySkill = async (skill: Skill) => {
    const updated = { ...skill, instructions: skillInstructions, useGithubMcp: skillUseMcp };
    await saveSkill(updated);
    setSkills((prev) => prev.map((s) => (s.id === skill.id ? updated : s)));
    // Place the skill instructions into the input box for the next message
    setInput(skillInstructions);
    setActiveSkillId(null);
  };

  const handleCreateSkill = async () => {
    if (!newSkillName.trim()) return;
    const newSkill: Skill = {
      id: `skill-${Date.now()}`,
      name: newSkillName.trim(),
      icon: newSkillIcon,
      description: "Custom skill",
      instructions: newSkillInstructions.trim() || "Describe what this skill should do...",
      useGithubMcp: newSkillUseMcp,
      isCustom: true,
      createdAt: Date.now(),
    };
    await saveSkill(newSkill);
    setSkills((prev) => [...prev, newSkill]);
    setShowCreateSkill(false);
    setNewSkillName("");
    setNewSkillInstructions("");
    setNewSkillUseMcp(false);
  };

  const handleDeleteSkill = async (e: React.MouseEvent, skill: Skill) => {
    e.stopPropagation();
    if (!skill.isCustom) return;
    if (confirm(`Delete skill "${skill.name}"?`)) {
      await deleteSkill(skill.id);
      setSkills((prev) => prev.filter((s) => s.id !== skill.id));
      if (activeSkillId === skill.id) setActiveSkillId(null);
    }
  };

  if (!isLeftSidebarOpen) return null;

  return (
    <aside className="sidebar-hover fixed md:relative inset-y-0 left-0 z-40 w-64 border-r border-border bg-[var(--left-sidebar-bg)] flex flex-col transition-all duration-300 ease-in-out shrink-0 h-full shadow-xl md:shadow-none">
      <div className="h-14 border-b border-border flex items-center justify-between px-4">
        <div className="flex items-center gap-2 font-medium">
          <svg className="w-6 h-6 rounded" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="sidebarLogoGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#38bdf8" />
                <stop offset="100%" stopColor="#818cf8" />
              </linearGradient>
            </defs>
            <rect width="512" height="512" rx="128" fill="url(#sidebarLogoGrad)" />
            <path d="M256 112 L278.4 207.6 L374 230 L278.4 252.4 L256 348 L233.6 252.4 L138 230 L233.6 207.6 Z" fill="#ffffff" />
            <path d="M384 320 L393.6 360.8 L436 370.4 L393.6 380 L384 420.8 L374.4 380 L332 370.4 L374.4 360.8 Z" fill="#ffffff" opacity="0.8" />
            <path d="M128 112 L134.4 139.2 L161.6 145.6 L134.4 152 L128 179.2 L121.6 152 L94.4 145.6 L121.6 139.2 Z" fill="#ffffff" opacity="0.6" />
          </svg>
          <span className="text-sm font-semibold">AI Workspace</span>
        </div>
        <button
          onClick={() => setIsLeftSidebarOpen(false)}
          className="p-1.5 hover:bg-muted rounded-md text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          title="Collapse Sidebar"
        >
          <PanelLeftClose className="w-4 h-4" />
        </button>
      </div>

      <div className="p-3">
        <button
          onClick={startNewSession}
          className="w-full bg-background border border-border shadow-sm text-foreground text-sm font-medium py-2 px-3 rounded-lg flex items-center gap-2 hover:bg-muted/50 transition-colors cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          New Chat
        </button>
      </div>

      <div className="sidebar-scroll flex-1 overflow-y-auto px-3 py-2 space-y-6">
        <div className="space-y-1">
          <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-1 flex justify-between items-center">
            <span>Recent Sessions</span>
            {hasMoreSessions && (
              <button
                onClick={() => setShowAllSessions(!showAllSessions)}
                className="text-[10px] lowercase font-normal hover:text-primary transition-colors cursor-pointer"
              >
                {showAllSessions ? "show less" : "show all"}
              </button>
            )}
          </div>
          {sortedSessions.length === 0 ? (
            <div className="text-xs text-muted-foreground px-3 py-2 italic">
              No sessions yet
            </div>
          ) : (
            displayedSessions.map((session: Session, index: number) => (
              <div
                key={session.id}
                onClick={() => setActiveSessionId(session.id)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm flex items-center gap-3 group transition-colors cursor-pointer justify-between ${activeSessionId === session.id
                  ? "bg-primary/5 text-primary"
                  : "hover:bg-muted text-muted-foreground hover:text-foreground"
                  }`}
              >
                <div className="flex items-center gap-3 truncate">
                  <MessageSquare className={`${index === 0 ? "w-5 h-5" : "w-4 h-4"} shrink-0 ${activeSessionId === session.id ? "text-primary" : ""}`} />
                  <span className="truncate font-medium">{session.title}</span>
                </div>
                <button
                  onClick={(e) => handleDeleteSession(e, session.id)}
                  className="opacity-0 group-hover:opacity-100 p-1 hover:bg-background rounded text-muted-foreground hover:text-destructive transition-all cursor-pointer"
                  title="Delete Session"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))
          )}
        </div>

        {/* Skills */}
        <div className="space-y-1">
          <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-1 flex items-center justify-between">
            <span>Skills</span>
            <button
              onClick={() => setShowCreateSkill(!showCreateSkill)}
              className={`p-1 rounded-md transition-colors cursor-pointer ${showCreateSkill ? "text-primary bg-primary/10" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`}
              title="Add Custom Skill"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Custom Skill creation form */}
          {showCreateSkill && (
            <div className="p-2.5 rounded-lg border border-border bg-muted/30 space-y-2 mb-1.5 animate-in slide-in-from-top-1 duration-150">
              <div className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-primary" />
                New Custom Skill
              </div>
              <input
                value={newSkillName}
                onChange={(e) => setNewSkillName(e.target.value)}
                placeholder="Skill name"
                className="w-full bg-background border border-input rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <div className="flex gap-1">
                {Object.keys(SKILL_ICONS).map((key) => {
                  const Icon = SKILL_ICONS[key];
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setNewSkillIcon(key)}
                      className={`p-1.5 rounded-md border transition-colors cursor-pointer ${newSkillIcon === key ? "border-primary text-primary bg-primary/10" : "border-border text-muted-foreground hover:text-foreground"}`}
                      title={key}
                    >
                      <Icon className="w-3.5 h-3.5" />
                    </button>
                  );
                })}
              </div>
              <textarea
                value={newSkillInstructions}
                onChange={(e) => setNewSkillInstructions(e.target.value)}
                placeholder="Instructions for the skill..."
                className="w-full bg-background border border-input rounded-md px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-primary min-h-[60px] resize-none leading-relaxed"
              />
              <label className="flex items-center gap-2 text-[10px] text-muted-foreground cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={newSkillUseMcp}
                  onChange={(e) => setNewSkillUseMcp(e.target.checked)}
                  className="rounded border-input text-rose-600 focus:ring-rose-500 h-3.5 w-3.5"
                />
                Use GitHub MCP
              </label>
              <button
                onClick={handleCreateSkill}
                disabled={!newSkillName.trim()}
                className="w-full bg-primary text-primary-foreground text-xs font-semibold py-1.5 rounded-md hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer flex items-center justify-center gap-1"
              >
                <Check className="w-3.5 h-3.5" />
                Create Skill
              </button>
            </div>
          )}

          {skills.length === 0 && (
            <div className="text-xs text-muted-foreground px-3 py-2 italic">
              No skills yet
            </div>
          )}

          {skills.map((skill) => {
            const Icon = SKILL_ICONS[skill.icon] || Sparkles;
            const isActive = activeSkillId === skill.id;
            return (
              <div key={skill.id}>
                <div
                  onClick={() => openSkill(skill)}
                  className={`w-full text-left px-3 py-2 rounded-lg text-sm flex items-center gap-3 group transition-colors cursor-pointer justify-between ${isActive ? "bg-primary/5 text-primary" : "hover:bg-muted text-muted-foreground hover:text-foreground"}`}
                >
                  <div className="flex items-center gap-3 truncate">
                    <Icon className={`w-4 h-4 shrink-0 ${isActive ? "text-primary" : ""}`} />
                    <div className="truncate">
                      <div className="truncate font-medium">{skill.name}</div>
                      <div className="text-[10px] text-muted-foreground truncate font-normal">{skill.description}</div>
                    </div>
                  </div>
                  {skill.isCustom && (
                    <button
                      onClick={(e) => handleDeleteSkill(e, skill)}
                      className="opacity-0 group-hover:opacity-100 p-0.5 text-muted-foreground hover:text-destructive transition-all cursor-pointer shrink-0"
                      title="Delete skill"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {/* Composer state — opened on click, not auto-sent */}
                {isActive && (
                  <div className="ml-5 mr-1 mb-2 p-2.5 rounded-lg border border-primary/30 bg-muted/20 space-y-2 animate-in slide-in-from-top-1 duration-150">
                    <div className="text-[11px] font-semibold text-foreground">{skill.name}</div>
                    <textarea
                      value={skillInstructions}
                      onChange={(e) => setSkillInstructions(e.target.value)}
                      placeholder="Instruction preview / editable text..."
                      className="w-full bg-background border border-input rounded-md px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-primary min-h-[80px] resize-none leading-relaxed"
                    />
                    <label className="flex items-center gap-2 text-[10px] text-muted-foreground cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={skillUseMcp}
                        onChange={(e) => setSkillUseMcp(e.target.checked)}
                        className="rounded border-input text-rose-600 focus:ring-rose-500 h-3.5 w-3.5"
                      />
                      Use GitHub MCP
                    </label>
                    <div className="flex gap-2">
                      <button
                        onClick={() => applySkill(skill)}
                        className="flex-1 bg-primary text-primary-foreground text-[11px] font-semibold py-1.5 rounded-md hover:bg-primary/90 transition-colors cursor-pointer flex items-center justify-center gap-1"
                      >
                        <Check className="w-3 h-3" />
                        Apply
                      </button>
                      <button
                        onClick={() => setActiveSkillId(null)}
                        className="px-2.5 border border-border bg-background text-foreground text-[11px] font-semibold py-1.5 rounded-md hover:bg-muted transition-colors cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="p-4 border-t border-border mt-auto">
        <button
          onClick={() => setIsSettingsOpen(true)}
          className="flex items-center gap-3 text-sm text-muted-foreground hover:text-foreground transition-colors px-1 w-full cursor-pointer"
        >
          <Settings className="w-4 h-4 animate-hover-spin" />
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
}
