import { useEffect, useState } from "react";

export function Modal({
  title,
  defaultValue,
  open,
  onConfirm,
  onCancel,
}: {
  title: string;
  defaultValue: string;
  open: boolean;
  onConfirm: (value: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(defaultValue);
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    if (open) {
      setValue(defaultValue);
      setSubmitting(false);
    }
  }, [open, defaultValue]);

  if (!open) return null;

  return (
    <div className="modal-overlay">
      <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="数据集名称"
          autoFocus
        />
        <div className="modal-actions">
          <button onClick={onCancel} disabled={submitting}>取消</button>
          <button
            className="primary"
            disabled={submitting}
            onClick={async () => {
              setSubmitting(true);
              try {
                await onConfirm(value.trim() || defaultValue);
              } finally {
                setSubmitting(false);
              }
            }}
          >
            {submitting ? "处理中..." : "确定"}
          </button>
        </div>
      </div>
    </div>
  );
}
