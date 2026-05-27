export function AnnotationModals({
  saveModalOpen,
  unsavedModalOpen,
  draftCount,
  currentHasDraft,
  onCloseSaveModal,
  onSaveCurrent,
  onSaveAll,
  onCloseUnsavedModal,
  onDiscardAndNav,
  onSaveAndNav,
}: {
  saveModalOpen: boolean;
  unsavedModalOpen: boolean;
  draftCount: number;
  currentHasDraft: boolean;
  onCloseSaveModal: () => void;
  onSaveCurrent: () => void;
  onSaveAll: () => void;
  onCloseUnsavedModal: () => void;
  onDiscardAndNav: () => void;
  onSaveAndNav: () => void;
}) {
  return (
    <>
      {saveModalOpen ? (
        <div className="modal-overlay" onClick={onCloseSaveModal}>
          <div className="modal-dialog" onClick={(event) => event.stopPropagation()}>
            <h3>保存标注</h3>
            <p className="modal-desc">
              当前有 {draftCount - (currentHasDraft ? 1 : 0)} 张其他图片的标注草稿未保存。
            </p>
            <div className="modal-actions">
              <button onClick={onCloseSaveModal}>取消</button>
              <button onClick={onSaveCurrent}>
                仅保存当前图片
              </button>
              <button className="primary" onClick={onSaveAll}>
                保存全部草稿
              </button>
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
              <button onClick={onCloseUnsavedModal}>取消</button>
              <button onClick={onDiscardAndNav}>
                不保存
              </button>
              <button className="primary" onClick={onSaveAndNav}>
                保存全部并返回
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
