import { Plus } from "lucide-react";
import type { ClassItem } from "../../../types";
import { shortcutLabel } from "../utils";

export function ClassManager({
  datasetClasses,
  activeClassId,
  selectedBoxClassId,
  addClassOpen,
  newClassDisplayName,
  addClassError,
  addingClass,
  onClassChange,
  onOpenAddClass,
  onCloseAddClass,
  onCreateClass,
  onNewClassDisplayNameChange,
}: {
  datasetClasses: ClassItem[];
  activeClassId: number;
  selectedBoxClassId: number | undefined;
  addClassOpen: boolean;
  newClassDisplayName: string;
  addClassError: string;
  addingClass: boolean;
  onClassChange: (classId: number) => void;
  onOpenAddClass: () => void;
  onCloseAddClass: () => void;
  onCreateClass: () => void;
  onNewClassDisplayNameChange: (value: string) => void;
}) {
  return (
    <>
      <div className="class-tags">
        {datasetClasses.map((item, index) => {
          const isActive = item.id === (selectedBoxClassId ?? activeClassId);
          const color = item.color ?? "#2979ff";
          const shortcut = shortcutLabel(index);
          return (
            <button
              key={item.id}
              className={`class-tag ${isActive ? "active" : ""}`}
              style={{
                "--tag-color": color,
                "--tag-border": color + "33",
                "--tag-bg": color + "14",
                "--tag-border-hover": color + "66",
                "--tag-bg-hover": color + "22",
              } as React.CSSProperties}
              onClick={() => onClassChange(item.id)}
              title={shortcut ? `${item.display_name} (${shortcut})` : item.display_name}
            >
              {shortcut ? <span className="class-tag-num">{shortcut}</span> : null}
              {item.display_name}
            </button>
          );
        })}
        <button
          className="class-tag class-tag-add"
          onClick={onOpenAddClass}
          title="新增类别"
        >
          <Plus size={13} />
          新增
        </button>
      </div>

      {addClassOpen ? (
        <div className="modal-overlay" onClick={onCloseAddClass}>
          <div className="modal-dialog" onClick={(event) => event.stopPropagation()}>
            <h3>新增标注类别</h3>
            <input
              value={newClassDisplayName}
              onChange={(event) => {
                onNewClassDisplayNameChange(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !addingClass) onCreateClass();
              }}
              placeholder="类别名称，例如：野猫"
              autoFocus
              disabled={addingClass}
            />
            {addClassError ? <p className="modal-error">{addClassError}</p> : null}
            <div className="modal-actions">
              <button onClick={onCloseAddClass} disabled={addingClass}>取消</button>
              <button className="primary" onClick={onCreateClass} disabled={addingClass || !newClassDisplayName.trim()}>
                {addingClass ? "创建中..." : "确定"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
