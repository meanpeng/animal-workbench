import { Fragment, useEffect, useLayoutEffect, useRef } from "react";
import { Image as KonvaImage, Label as KonvaLabel, Layer, Rect, Stage, Tag as KonvaTag, Text, Transformer } from "react-konva";
import type { AnnotationBox, ImageLayout } from "../types";
import { readableTextColor } from "../utils";
import type { ClassItem } from "../../../types";

export function AnnotationCanvas({
  canvasDims,
  setCanvasDims,
  selectedDatasetId,
  image,
  selected,
  layout,
  displayedBoxes,
  selectedBoxKey,
  draftBox,
  classById,
  transformerRef,
  stageContainerRef,
  stageRef,
  onMouseDown,
  onMouseMove,
  onMouseUp,
  onBoxMouseDown,
  onDragStart,
  onDragEnd,
  onTransformStart,
  onTransformEnd,
}: {
  canvasDims: { width: number; height: number };
  setCanvasDims: React.Dispatch<React.SetStateAction<{ width: number; height: number }>>;
  selectedDatasetId: number | null;
  image: HTMLImageElement | null;
  selected: { id: number } | undefined;
  layout: ImageLayout;
  displayedBoxes: AnnotationBox[];
  selectedBoxKey: string | null;
  draftBox: AnnotationBox | null;
  classById: Map<number, ClassItem>;
  transformerRef: React.RefObject<any>;
  stageContainerRef: React.RefObject<HTMLDivElement>;
  stageRef: React.RefObject<any>;
  onMouseDown: (event: any) => void;
  onMouseMove: (event: any) => void;
  onMouseUp: () => void;
  onBoxMouseDown: (box: AnnotationBox, event: any) => void;
  onDragStart: (box: AnnotationBox, event: any) => void;
  onDragEnd: (box: AnnotationBox, event: any) => void;
  onTransformStart: (box: AnnotationBox, event: any) => void;
  onTransformEnd: (box: AnnotationBox, event: any) => void;
}) {
  useLayoutEffect(() => {
    const el = stageContainerRef.current as HTMLDivElement | null;
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
  }, [selectedDatasetId]);

  useEffect(() => {
    const transformer = transformerRef.current;
    if (!transformer) return;
    const stage = transformer.getStage();
    const node = selectedBoxKey ? stage?.findOne(`#box-${selectedBoxKey}`) : null;
    transformer.nodes(node ? [node] : []);
    transformer.getLayer()?.batchDraw();
  }, [selectedBoxKey, displayedBoxes, layout]);

  return (
    <div className="stage-container" ref={stageContainerRef}>
      <Stage
        ref={stageRef}
        width={canvasDims.width}
        height={canvasDims.height}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
      >
        <Layer>
          <Rect name="canvas-bg" x={0} y={0} width={canvasDims.width} height={canvasDims.height} fill="#f8fafc" />
          {image && selected ? (
            <KonvaImage name="image" image={image} x={layout.x} y={layout.y} width={layout.width} height={layout.height} />
          ) : (
            <Text x={canvasDims.width / 2 - 100} y={canvasDims.height / 2 - 15} text={selected ? "正在加载图片" : "选择图片后开始标注"} fontSize={20} fill="#334155" />
          )}
          {displayedBoxes.map((box) => {
            const classItem = classById.get(box.class_id);
            const color = classItem?.color ?? "#2979ff";
            const labelTextColor = readableTextColor(color);
            const displayName = classItem?.display_name ?? "";
            const px = layout.x + box.x * layout.width;
            const py = layout.y + box.y * layout.height;
            const pw = box.width * layout.width;
            return (
              <Fragment key={box.local_id}>
                <Rect
                  id={`box-${box.local_id}`}
                  name="annotation-box"
                  x={px}
                  y={py}
                  width={pw}
                  height={box.height * layout.height}
                  stroke={color}
                  strokeWidth={box.local_id === selectedBoxKey ? 4 : 3}
                  perfectDrawEnabled={false}
                  shadowForStrokeEnabled={false}
                  draggable={!draftBox}
                  dash={box.id ? undefined : [8, 6]}
                  onMouseDown={(event) => onBoxMouseDown(box, event)}
                  onDragStart={(event) => onDragStart(box, event)}
                  onDragEnd={(event) => onDragEnd(box, event)}
                  onTransformStart={(event) => onTransformStart(box, event)}
                  onTransformEnd={(event) => onTransformEnd(box, event)}
                />
                {displayName ? (
                  <KonvaLabel x={px} y={py - 22}>
                    <KonvaTag fill={color} cornerRadius={2} />
                    <Text text={displayName} fontSize={13} fontStyle="bold" fill={labelTextColor} padding={3} />
                  </KonvaLabel>
                ) : null}
              </Fragment>
            );
          })}
          <Transformer
            ref={transformerRef}
            rotateEnabled={false}
            enabledAnchors={["top-left", "top-right", "bottom-left", "bottom-right", "middle-left", "middle-right"]}
            borderStroke="#0f172a"
            anchorStroke="#0f172a"
            anchorFill="#ffffff"
            anchorSize={8}
          />
        </Layer>
      </Stage>
    </div>
  );
}
