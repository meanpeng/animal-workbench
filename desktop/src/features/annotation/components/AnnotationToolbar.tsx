import { CheckCircle2, RotateCcw, RotateCw, Trash2 } from "lucide-react";

export function AnnotationToolbar({
  message,
  saveStatus,
  historyLength,
  futureLength,
  hasSelectedBox,
  canSave,
  onUndo,
  onRedo,
  onDelete,
  onSave,
}: {
  message: string;
  saveStatus: "idle" | "saving" | "saved" | "error";
  historyLength: number;
  futureLength: number;
  hasSelectedBox: boolean;
  canSave: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onDelete: () => void;
  onSave: () => void;
}) {
  return (
    <div className="canvas-actions-row">
      <span className="inline-status">
        {saveStatus === "saving" ? "⏳ " : saveStatus === "saved" ? "✓ " : saveStatus === "error" ? "⚠ " : ""}
        {message}
      </span>
      <div className="canvas-actions">
        <button title="撤销 Ctrl+Z" onClick={onUndo} disabled={historyLength === 0}>
          <RotateCcw size={15} />
          <span>撤销</span>
        </button>
        <button title="重做 Ctrl+Y" onClick={onRedo} disabled={futureLength === 0}>
          <RotateCw size={15} />
          <span>重做</span>
        </button>
        <button title="删除标注 Delete" onClick={onDelete} disabled={!hasSelectedBox}>
          <Trash2 size={15} />
          <span>删除</span>
        </button>
        <button className="save-btn" title="保存标注" onClick={onSave} disabled={!canSave}>
          <CheckCircle2 size={15} />
          <span>保存</span>
        </button>
      </div>
    </div>
  );
}
