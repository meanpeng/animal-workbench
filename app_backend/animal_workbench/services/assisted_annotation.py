from __future__ import annotations

import sqlite3
import threading
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from ..repository import json_dumps, json_loads, list_dataset_classes


SETTINGS_KEY = "assisted_annotation"
DEFAULT_SETTINGS = {
    "enabled": False,
    "model_path": "",
    "confidence": 0.25,
    "preload_radius": 3,
    "image_size": 640,
    "device": "auto",
}


def assisted_annotation_settings(conn: sqlite3.Connection) -> dict[str, Any]:
    row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (SETTINGS_KEY,)).fetchone()
    settings = {**DEFAULT_SETTINGS, **json_loads(row["value"] if row else None, {})}
    settings["enabled"] = bool(settings.get("enabled"))
    settings["model_path"] = str(settings.get("model_path") or "")
    settings["confidence"] = float(settings.get("confidence") or DEFAULT_SETTINGS["confidence"])
    settings["preload_radius"] = int(settings.get("preload_radius") or DEFAULT_SETTINGS["preload_radius"])
    settings["image_size"] = int(settings.get("image_size") or DEFAULT_SETTINGS["image_size"])
    settings["device"] = str(settings.get("device") or DEFAULT_SETTINGS["device"])
    return settings


def save_assisted_annotation_settings(conn: sqlite3.Connection, payload: dict[str, Any]) -> dict[str, Any]:
    settings = {**DEFAULT_SETTINGS, **payload}
    if settings["model_path"]:
        settings["model_path"] = str(Path(str(settings["model_path"])).expanduser().resolve())
    conn.execute(
        """
        INSERT INTO app_settings(key, value, updated_at)
        VALUES(?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
        """,
        (SETTINGS_KEY, json_dumps(settings)),
    )
    conn.commit()
    return assisted_annotation_settings(conn)


def _normalize_class_name(value: str) -> str:
    return value.strip().lower().replace(" ", "_")


class AssistedAnnotationRuntime:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._model: Any | None = None
        self._model_path = ""
        self._names: dict[int, str] = {}
        self._error: str | None = None

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "loaded": self._model is not None,
                "model_path": self._model_path,
                "class_names": self._names,
                "error": self._error,
            }

    def start(self, settings: dict[str, Any]) -> dict[str, Any]:
        if not settings.get("enabled"):
            self.stop()
            return {"enabled": False, **self.status()}
        model_path = str(settings.get("model_path") or "").strip()
        if not model_path:
            raise HTTPException(status_code=422, detail="请先在全局设置中选择辅助标注模型。")
        resolved = str(Path(model_path).expanduser().resolve())
        if not Path(resolved).exists():
            raise HTTPException(status_code=422, detail="辅助标注模型文件不存在。")

        with self._lock:
            if self._model is not None and self._model_path == resolved:
                return {"enabled": True, **self.status()}
            self.stop()
            try:
                from ultralytics import YOLO

                self._model = YOLO(resolved)
                raw_names = getattr(self._model, "names", {}) or {}
                if isinstance(raw_names, dict):
                    self._names = {int(key): str(value) for key, value in raw_names.items()}
                else:
                    self._names = {index: str(value) for index, value in enumerate(raw_names)}
                self._model_path = resolved
                self._error = None
            except Exception as exc:
                self._model = None
                self._model_path = ""
                self._names = {}
                self._error = str(exc)
                raise HTTPException(status_code=500, detail=f"加载辅助标注模型失败：{exc}") from exc
            return {"enabled": True, **self.status()}

    def stop(self) -> dict[str, Any]:
        with self._lock:
            self._model = None
            self._model_path = ""
            self._names = {}
            self._error = None
            return self.status()

    def predict(
        self,
        conn: sqlite3.Connection,
        project_id: int,
        dataset_id: int,
        media_asset_ids: list[int],
        settings: dict[str, Any],
    ) -> dict[str, Any]:
        self.start(settings)
        with self._lock:
            model = self._model
            names = dict(self._names)
        if model is None:
            raise HTTPException(status_code=422, detail="辅助标注模型尚未加载。")

        rows = conn.execute(
            f"""
            SELECT id, internal_path, width, height
            FROM media_assets
            WHERE project_id = ? AND media_type IN ('image', 'frame')
              AND id IN ({",".join("?" for _ in media_asset_ids)})
            """,
            (project_id, *media_asset_ids),
        ).fetchall()
        media_by_id = {int(row["id"]): row for row in rows}

        dataset_classes = list_dataset_classes(conn, project_id, dataset_id)
        class_by_name: dict[str, int] = {}
        for item in dataset_classes:
            class_by_name[_normalize_class_name(str(item["name"]))] = int(item["id"])
            class_by_name[_normalize_class_name(str(item["display_name"]))] = int(item["id"])

        results_by_media: list[dict[str, Any]] = []
        predict_kwargs: dict[str, Any] = {
            "conf": float(settings.get("confidence") or DEFAULT_SETTINGS["confidence"]),
            "imgsz": int(settings.get("image_size") or DEFAULT_SETTINGS["image_size"]),
            "verbose": False,
        }
        device = str(settings.get("device") or "auto").strip()
        if device and device != "auto":
            predict_kwargs["device"] = device

        for media_id in media_asset_ids:
            row = media_by_id.get(media_id)
            if row is None:
                results_by_media.append({"media_asset_id": media_id, "predictions": [], "error": "图片不存在"})
                continue
            source = str(Path(str(row["internal_path"])).expanduser())
            try:
                yolo_results = model.predict(source=source, **predict_kwargs)
            except Exception as exc:
                results_by_media.append({"media_asset_id": media_id, "predictions": [], "error": str(exc)})
                continue

            predictions: list[dict[str, Any]] = []
            for result in yolo_results:
                height, width = getattr(result, "orig_shape", (row["height"], row["width"]))
                if not width or not height:
                    continue
                boxes = getattr(result, "boxes", None)
                if boxes is None:
                    continue
                xyxy = boxes.xyxy.cpu().tolist()
                cls_values = boxes.cls.cpu().tolist()
                conf_values = boxes.conf.cpu().tolist()
                for coords, class_index, confidence in zip(xyxy, cls_values, conf_values):
                    x1, y1, x2, y2 = [float(value) for value in coords]
                    class_name = names.get(int(class_index), f"class_{int(class_index)}")
                    normalized_name = _normalize_class_name(class_name)
                    predictions.append(
                        {
                            "class_id": class_by_name.get(normalized_name),
                            "class_name": class_name,
                            "confidence": float(confidence),
                            "x": max(0.0, min(1.0, x1 / float(width))),
                            "y": max(0.0, min(1.0, y1 / float(height))),
                            "width": max(0.001, min(1.0, (x2 - x1) / float(width))),
                            "height": max(0.001, min(1.0, (y2 - y1) / float(height))),
                        }
                    )
            results_by_media.append({"media_asset_id": media_id, "predictions": predictions})
        return {"settings": settings, "results": results_by_media, **self.status()}


runtime = AssistedAnnotationRuntime()
