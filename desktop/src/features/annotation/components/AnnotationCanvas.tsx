import { Fragment, useMemo } from "react";
import type React from "react";
import { CheckCircle2, Plus, RotateCcw, RotateCw, Trash2 } from "lucide-react";
import { Image as KonvaImage, Label as KonvaLabel, Layer, Rect, Stage, Tag as KonvaTag, Text, Transformer } from "react-konva";
import type { DatasetDetail, Summary } from "../../../types";
import type { AnnotationBox } from "../annotationTypes";
import type { ImageLayout } from "../imageGeometry";
import { readableTextColor, shortcutLabel } from "../uiUtils";

type AnnotationCanvasProps = {
  datasetClasses: Summary["classes"];
  selectedBox: AnnotationBox | undefined;
  activeClassId: number;
  onChangeClass: (classId: number) => void;
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

  return (
    <>
      <div className="class-tags">
        {datasetClasses.map((item, index) => {
          const isActive = item.id === (selectedBox?.class_id ?? activeClassId);
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
              onClick={() => onChangeClass(item.id)}
              title={shortcut ? `${item.display_name} (${shortcut})` : item.display_name}
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
                    onMouseDown={(event) => {
                      event.cancelBubble = true;
                      onSelectBox(box.local_id);
                    }}
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
