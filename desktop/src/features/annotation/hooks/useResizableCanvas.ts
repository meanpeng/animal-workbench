import { useLayoutEffect, useRef, useState } from "react";

export function useResizableCanvas(resetKey: number | null) {
  const [canvasDims, setCanvasDims] = useState({ width: 860, height: 520 });
  const stageContainerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = stageContainerRef.current;
    if (!el) return;
    const syncSize = () => {
      const width = Math.floor(el.clientWidth);
      const height = Math.floor(el.clientHeight);
      if (width <= 0 || height <= 0) return;
      setCanvasDims((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    };
    syncSize();
    const ro = new ResizeObserver(syncSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, [resetKey]);

  return { canvasDims, stageContainerRef };
}
