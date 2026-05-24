import { Check, ChevronDown } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

export type SelectOption = { value: string; label: string };

interface SelectProps {
  options: SelectOption[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
}

export function Select({
  options,
  value: controlledValue,
  defaultValue,
  onChange,
  placeholder,
  disabled,
  className,
  id,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [internalValue, setInternalValue] = useState<string>(defaultValue ?? "");
  const containerRef = useRef<HTMLDivElement>(null);

  const isControlled = controlledValue !== undefined;
  const currentValue = isControlled ? controlledValue : internalValue;
  const selectedOption = options.find((opt) => opt.value === currentValue);

  const handleSelect = useCallback(
    (val: string) => {
      if (!isControlled) setInternalValue(val);
      onChange?.(val);
      setOpen(false);
    },
    [isControlled, onChange],
  );

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        containerRef.current?.querySelector<HTMLButtonElement>(".select-trigger")?.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  return (
    <div
      ref={containerRef}
      className={["select-container", disabled ? "disabled" : "", className ?? ""].filter(Boolean).join(" ")}
      id={id}
    >
      <button
        type="button"
        className={["select-trigger", open ? "open" : ""].filter(Boolean).join(" ")}
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={selectedOption ? "select-trigger-text" : "select-trigger-text placeholder"}>
          {selectedOption ? selectedOption.label : placeholder ?? "请选择"}
        </span>
        <ChevronDown className={["select-arrow", open ? "open" : ""].join(" ")} size={16} />
      </button>

      {open ? (
        <ul className="select-dropdown" role="listbox">
          {options.map((opt) => (
            <li
              key={opt.value}
              role="option"
              aria-selected={opt.value === currentValue}
              className={["select-option", opt.value === currentValue ? "active" : ""].filter(Boolean).join(" ")}
              onClick={() => handleSelect(opt.value)}
            >
              <span>{opt.label}</span>
              {opt.value === currentValue ? <Check className="select-option-check" size={16} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
