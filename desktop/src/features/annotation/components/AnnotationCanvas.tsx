import { Fragment, useCallback, useMemo, useRef } from "react";
import type React from "react";
import { CheckCircle2, Plus, RotateCcw, RotateCw, Trash2 } from "lucide-react";
import { Image as KonvaImage, Label as KonvaLabel, Layer, Rect, Stage, Tag as KonvaTag, Text, Transformer } from "react-konva";
import type { DatasetDetail, Summary } from "../../../types";
import type { AnnotationBox } from "../annotationTypes";
import type { ImageLayout } from "../imageGeometry";
import { predictedClassColor, readableTextColor, shortcutLabel } from "../uiUtils";

const BOX_FILL_OPACITY = "1A";

type AnnotationCanvasProps = {
  datasetClasses: Summary["classes"];
  selectedBox: AnnotationBox | undefined;
  activeClassId: number;
  onChangeClass: (classId: number) => void;
  onApplySingleBoxClass: (classId: number) => void;
  onOpenAddClass: () => void;
  stageContainerRef: React.RefObject<HTMLDivElement>;
  stageRef: React.RefObject<any>;
  transformerRef: React.RefObject<any>;
  canvasDims: { width: number; height: number };
  onStartDraw: (event: any) => void;
  onUpdateDraw: (event: any) => void;
  onFinishDraw: () => void;
  image: HTMLImageElement | null;
  selected: DatasetDetail["media"][number] | undefined;
  layout: ImageLayout;
  displayedBoxes: AnnotationBox[];
  selectedBoxKey: string | null;
  draftBox: AnnotationBox | null;
  onSelectBox: (localId: string) => void;
  onDragStart: (box: AnnotationBox, event: any) => void;
  onDragEnd: (box: AnnotationBox, event: any) => void;
  onTransformStart: (box: AnnotationBox, event: any) => void;
  onTransformEnd: (box: AnnotationBox, event: any) => void;
  saveStatus: "idle" | "saving" | "saved" | "error";
  message: string;
  onUndo: () => void;
  canUndo: boolean;
  onRedo: () => void;
  canRedo: boolean;
  onDeleteSelected: () => void;
  onSave: () => void;
};

export function AnnotationCanvas({
  datasetClasses,
  selectedBox,
  activeClassId,
  onChangeClass,
  onApplySingleBoxClass,
  onOpenAddClass,
  stageContainerRef,
  stageRef,
  transformerRef,
  canvasDims,
  onStartDraw,
  onUpdateDraw,
  onFinishDraw,
  image,
  selected,
  layout,
  displayedBoxes,
  selectedBoxKey,
  draftBox,
  onSelectBox,
  onDragStart,
  onDragEnd,
  onTransformStart,
  onTransformEnd,
  saveStatus,
  message,
  onUndo,
  canUndo,
  onRedo,
  canRedo,
  onDeleteSelected,
  onSave,
}: AnnotationCanvasProps) {
  const classById = useMemo(() => new Map(datasetClasses.map((item) => [item.id, item])), [datasetClasses]);
  const hasSingleBox = displayedBoxes.length === 1;

  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const imageBounds = useCallback((_oldBox: { x: number; y: number; width: number; height: number; rotation?: number }, newBox: { x: number; y: number; width: number; height: number; rotation?: number }) => {
    const { x: imgLeft, y: imgTop, width: imgW, height: imgH } = layoutRef.current;
    const imgRight = imgLeft + imgW;
    const imgBottom = imgTop + imgH;
    const minSize = 4;
    let { x, y, width, height } = newBox;
    if (x < imgLeft) {
      width -= imgLeft - x;
      x = imgLeft;
    }
    if (x + width > imgRight) {
      width = imgRight - x;
    }
    if (y < imgTop) {
      height -= imgTop - y;
      y = imgTop;
    }
    if (y + height > imgBottom) {
      height = imgBottom - y;
    }
    if (width < minSize) width = minSize;
    if (height < minSize) height = minSize;
    return { x, y, width, height, rotation: newBox.rotation ?? 0 };
  }, []);

  return (
    <>
      <div className="class-tags">
        {datasetClasses.map((item, index) => {
          const isActive = item.id === (selectedBox?.class_id ?? activeClassId);
          const color = item.color ?? "#2979ff";
          const shortcut = shortcutLabel(index);
          const shortcutTitle = shortcut ? ` (${shortcut})` : "";
          const singleBoxHint = hasSingleBox ? "；仅有一个标注框时，双击标签或双按快捷键可直接修改它的类别" : "";
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
              onClick={() => onChangeClass(item.id)}
              onDoubleClick={() => onApplySingleBoxClass(item.id)}
              title={`${item.display_name}${shortcutTitle}${singleBoxHint}`}
            >
              {shortcut ? <span className="class-tag-num">{shortcut}</span> : null}
              {item.display_name}
            </button>
          );
        })}
        <button className="class-tag class-tag-add" onClick={onOpenAddClass} title="新增类别">
          <Plus size={13} />
          新增
        </button>
      </div>

      <div className="stage-container" ref={stageContainerRef}>
        <Stage
          ref={stageRef}
          width={canvasDims.width}
          height={canvasDims.height}
          onMouseDown={onStartDraw}
          onMouseMove={onUpdateDraw}
          onMouseUp={onFinishDraw}
        >
          <Layer>
            <Rect name="canvas-bg" x={0} y={0} width={canvasDims.width} height={canvasDims.height} fill="#121213" />
            {image && selected ? (
              <KonvaImage name="image" image={image} x={layout.x} y={layout.y} width={layout.width} height={layout.height} />
            ) : (
              <Text x={canvasDims.width / 2 - 100} y={canvasDims.height / 2 - 15} text={selected ? "正在加载图片" : "选择图片后开始标注"} fontSize={20} fill="#334155" />
            )}
            {displayedBoxes.map((box) => {
              const classItem = classById.get(box.class_id);
              const displayName = classItem?.display_name ?? box.predicted_class_name ?? "";
              const color = classItem?.color ?? predictedClassColor(displayName || String(box.class_id));
              const labelTextColor = readableTextColor(color);
              const labelText =
                displayName && box.source === "assistant" && typeof box.confidence === "number"
                  ? `${displayName} ${box.confidence.toFixed(2)}`
                  : displayName;
              const px = layout.x + box.x * layout.width;
              const py = layout.y + box.y * layout.height;
              const pw = box.width * layout.width;
              return (
                <Fragment key={box.local_id}>
                  <Rect
                    id={`box-${box.local_id}`}
                    name="annotation-box"
                    onMouseEnter={(event) => {
                      const stage = event.target.getStage();
                      if (stage) stage.container().style.cursor = "pointer";
                    }}
                    onMouseLeave={(event) => {
                      const stage = event.target.getStage();
                      if (stage) stage.container().style.cursor = "default";
                    }}
                    x={px}
                    y={py}
                    width={pw}
                    height={box.height * layout.height}
                    stroke={color}
                    fill={`${color}${BOX_FILL_OPACITY}`}
                    strokeWidth={box.local_id === selectedBoxKey ? 4 : 3}
                    perfectDrawEnabled={false}
                    shadowForStrokeEnabled={false}
                    draggable={!draftBox}
                    dragBoundFunc={draftBox ? undefined : (pos: { x: number; y: number }) => ({
                      x: Math.max(layout.x, Math.min(pos.x, layout.x + layout.width - pw)),
                      y: Math.max(layout.y, Math.min(pos.y, layout.y + layout.height - box.height * layout.height)),
                    })}
                    dash={box.id ? undefined : [4, 3]}
                    onMouseDown={(event) => {
                      event.cancelBubble = true;
                      onSelectBox(box.local_id);
                    }}
                    onDragStart={(event) => onDragStart(box, event)}
                    onDragEnd={(event) => onDragEnd(box, event)}
                    onTransformStart={(event) => onTransformStart(box, event)}
                    onTransformEnd={(event) => onTransformEnd(box, event)}
                  />
                  {labelText ? (
                    <KonvaLabel x={px} y={py - 22}>
                      <KonvaTag fill={color} cornerRadius={2} />
                      <Text text={labelText} fontSize={13} fontStyle="bold" fill={labelTextColor} padding={3} />
                    </KonvaLabel>
                  ) : null}
                </Fragment>
              );
            })}
            <Transformer
              ref={transformerRef}
              rotateEnabled={false}
              boundBoxFunc={imageBounds}
              enabledAnchors={[
                "top-left",
                "top-center",
                "top-right",
                "middle-left",
                "middle-right",
                "bottom-left",
                "bottom-center",
                "bottom-right",
              ]}
              borderStroke="#0f172a"
              anchorStroke="#0f172a"
              anchorFill="#ffffff"
              anchorSize={8}
            />
          </Layer>
        </Stage>
      </div>

      <div className="canvas-actions-row">
        <span className="inline-status">
          {saveStatus === "saving" ? "⏳" : saveStatus === "saved" ? "✓" : saveStatus === "error" ? "⚠" : ""}
          {message}
        </span>
        <div className="canvas-actions">
          <button title="撤销 Ctrl+Z" onClick={onUndo} disabled={!canUndo}>
            <RotateCcw size={15} />
            <span>撤销</span>
          </button>
          <button title="重做 Ctrl+Y" onClick={onRedo} disabled={!canRedo}>
            <RotateCw size={15} />
            <span>重做</span>
          </button>
          <button title="删除标注 Delete" onClick={onDeleteSelected} disabled={!selectedBoxKey}>
            <Trash2 size={15} />
            <span>删除</span>
          </button>
          <button className="save-btn" title="保存标注" onClick={onSave} disabled={!selected}>
            <CheckCircle2 size={15} />
            <span>保存</span>
          </button>
        </div>
      </div>
    </>
  );
}
