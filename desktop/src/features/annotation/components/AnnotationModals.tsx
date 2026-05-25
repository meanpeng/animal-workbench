type AnnotationModalsProps = {
  addClassOpen: boolean;
  newClassDisplayName: string;
  addClassError: string;
  addingClass: boolean;
  onNewClassDisplayNameChange: (value: string) => void;
  onCloseAddClass: () => void;
  onCreateClass: () => void;
  saveModalOpen: boolean;
  otherDraftCount: number;
  onCloseSaveModal: () => void;
  onSaveCurrent: () => void;
  onSaveAllDrafts: () => void;
  unsavedModalOpen: boolean;
  draftCount: number;
  onCancelUnsaved: () => void;
  onDiscardUnsaved: () => void;
  onSaveAllAndContinue: () => void;
};

export function AnnotationModals({
  addClassOpen,
  newClassDisplayName,
  addClassError,
  addingClass,
  onNewClassDisplayNameChange,
  onCloseAddClass,
  onCreateClass,
  saveModalOpen,
  otherDraftCount,
  onCloseSaveModal,
  onSaveCurrent,
  onSaveAllDrafts,
  unsavedModalOpen,
  draftCount,
  onCancelUnsaved,
  onDiscardUnsaved,
  onSaveAllAndContinue,
}: AnnotationModalsProps) {
  return (
    <>
      {addClassOpen ? (
        <div className="modal-overlay">
          <div className="modal-dialog" onClick={(event) => event.stopPropagation()}>
            <h3>新增标注类别</h3>
            <input
              value={newClassDisplayName}
              onChange={(event) => onNewClassDisplayNameChange(event.target.value)}
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

      {saveModalOpen ? (
        <div className="modal-overlay">
          <div className="modal-dialog" onClick={(event) => event.stopPropagation()}>
            <h3>保存标注</h3>
            <p className="modal-desc">
              当前有 {otherDraftCount} 张其他图片的标注草稿未保存。
            </p>
            <div className="modal-actions">
              <button onClick={onCloseSaveModal}>取消</button>
              <button onClick={onSaveCurrent}>仅保存当前图片</button>
              <button className="primary" onClick={onSaveAllDrafts}>保存全部草稿</button>
            </div>
          </div>
        </div>
      ) : null}

      {unsavedModalOpen ? (
        <div className="modal-overlay">
          <div className="modal-dialog" onClick={(event) => event.stopPropagation()}>
            <h3>未保存的草稿</h3>
            <p className="modal-desc">
              当前有 {draftCount} 张图片的标注草稿未保存，离开后草稿会丢失。
            </p>
            <div className="modal-actions">
              <button onClick={onCancelUnsaved}>取消</button>
              <button onClick={onDiscardUnsaved}>不保存</button>
              <button className="primary" onClick={onSaveAllAndContinue}>保存全部并返回</button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
