import { useState } from "react";
import { Trash2, ChevronDown, ChevronRight, NotebookPen } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PageHeader } from "@/components/ui/PageHeader";
import { GlassCard } from "@/components/ui/GlassCard";
import { Disclaimer } from "@/components/ui/Disclaimer";
import { loadNotes, deleteNote, clearNotes, type Note } from "@/lib/notes";

const KIND_COLOR: Record<string, string> = {
  复盘: "bg-primary/15 text-primary",
  今日要点: "bg-warning/15 text-warning",
  问AI: "bg-success/15 text-success",
};

export function Notes() {
  const [notes, setNotes] = useState<Note[]>(loadNotes);
  const [openId, setOpenId] = useState<string | null>(null);

  const fmt = (ts: number) => new Date(ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

  return (
    <div>
      <PageHeader
        title="研究记录"
        subtitle="把 AI 复盘 / 要点 / 问答沉淀在本地，随时回看。数据只存本地、不上传。"
        actions={notes.length > 0 && (
          <button onClick={() => { if (confirm("清空所有研究记录？")) { clearNotes(); setNotes([]); } }}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:text-destructive">
            <Trash2 className="h-4 w-4" /> 清空
          </button>
        )}
      />

      {notes.length === 0 ? (
        <GlassCard>
          <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
            <NotebookPen className="h-8 w-8 text-muted-foreground/40" />
            还没有记录。在「每日复盘」「资讯雷达」或「问 AI」里点 <b className="text-foreground">「存入沉淀」</b> 保存分析结果。
          </div>
        </GlassCard>
      ) : (
        <div className="space-y-2">
          {notes.map((n) => {
            const open = openId === n.id;
            return (
              <GlassCard key={n.id} className="!p-0 overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-3">
                  <button onClick={() => setOpenId(open ? null : n.id)} className="flex flex-1 items-center gap-2 text-left">
                    {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${KIND_COLOR[n.kind] || "bg-muted/50 text-muted-foreground"}`}>{n.kind}</span>
                    <span className="flex-1 truncate text-sm font-medium">{n.title}</span>
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground/60">{fmt(n.ts)}</span>
                  </button>
                  <button onClick={() => setNotes(deleteNote(n.id))} className="shrink-0 text-muted-foreground/60 hover:text-destructive" title="删除">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                {open && (
                  <div className="border-t border-border/40 px-4 py-3">
                    <div className="prose prose-sm prose-invert max-w-none text-foreground">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{n.content}</ReactMarkdown>
                    </div>
                  </div>
                )}
              </GlassCard>
            );
          })}
        </div>
      )}

      <Disclaimer />
    </div>
  );
}
