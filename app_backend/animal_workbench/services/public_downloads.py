from __future__ import annotations

import re
import urllib.parse
import urllib.request
from pathlib import Path
from zipfile import ZipFile

from .dataset_jobs import JobReporter
from .public_catalog import PublicDatasetSpec, public_dataset_dir


def prepare_public_dataset(spec: PublicDatasetSpec, *, sample_limit: int | None, force: bool, reporter: JobReporter) -> dict:
    root = public_dataset_dir(spec.key)
    root.mkdir(parents=True, exist_ok=True)
    reporter.update(stage="downloading", percent=2, message=f"准备下载 {spec.name}")

    if spec.key == "lote":
        download_lote(spec, root, force, reporter)
    elif spec.key == "ena24":
        download_ena24(spec, root, force, reporter)
    elif spec.key in {"swg", "wcs"}:
        download_lila_metadata(spec, root, force, reporter)
    else:
        raise ValueError(f"未知公开数据集: {spec.key}")

    (root / "workbench_public_manifest.json").write_text(
        '{"key":"%s","sample_limit":%s}\n' % (spec.key, sample_limit or "null"),
        encoding="utf-8",
    )
    return {"key": spec.key, "name": spec.name, "path": str(root), "sample_limit": sample_limit}


def download_lote(spec: PublicDatasetSpec, root: Path, force: bool, reporter: JobReporter) -> None:
    wild_dir = root / "wild_dataset"
    ann_dir = root / "corrected_annotations_wild_and_web"
    wild_target = wild_dir / "wild.zip"
    ann_target = ann_dir / "json.zip"
    download_google_drive(spec.urls["wild_zip"], wild_target, force, reporter, 5, 45)
    download_google_drive(spec.urls["json_zip"], ann_target, force, reporter, 45, 85)
    reporter.update(stage="extracting", percent=90, message="LoTE 压缩包已就绪，导入时会直接解析 zip")


def download_ena24(spec: PublicDatasetSpec, root: Path, force: bool, reporter: JobReporter) -> None:
    data_dir = root / "data"
    if data_dir.exists() and any(data_dir.glob("*.parquet")) and not force:
        reporter.update(stage="downloading", percent=100, message="ENA24 parquet 已存在")
        return
    try:
        from huggingface_hub import snapshot_download
    except ImportError as exc:
        raise RuntimeError("下载 ENA24 需要安装 huggingface_hub。") from exc
    reporter.update(stage="downloading", percent=10, message="正在从 Hugging Face 下载 ENA24")
    snapshot_download(
        repo_id=spec.urls["huggingface_repo"],
        repo_type="dataset",
        local_dir=root,
        allow_patterns=["*.parquet", "README*", "*.json", "*.yaml", "*.yml", "*.txt"],
    )
    reporter.update(stage="downloading", percent=100, message="ENA24 下载完成")


def download_lila_metadata(spec: PublicDatasetSpec, root: Path, force: bool, reporter: JobReporter) -> None:
    zip_target = root / Path(urllib.parse.urlparse(spec.urls["boxes_zip"]).path).name
    download_url(spec.urls["boxes_zip"], zip_target, force, reporter, 5, 75)
    reporter.update(stage="extracting", percent=80, message="正在解压标注 JSON")
    with ZipFile(zip_target) as archive:
        for member in archive.namelist():
            if member.lower().endswith(".json"):
                target = root / Path(member).name
                if force or not target.exists():
                    target.write_bytes(archive.read(member))
                break
        else:
            raise RuntimeError(f"{zip_target} 中没有 JSON 标注文件")
    (root / "image_base_url.txt").write_text(spec.urls["image_base"], encoding="utf-8")
    reporter.update(stage="extracting", percent=100, message="标注 JSON 已就绪，图片会在导入时按样本上限补齐")


def download_google_drive(url: str, target: Path, force: bool, reporter: JobReporter, start: float, end: float) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and target.stat().st_size > 0 and not force:
        reporter.update(stage="downloading", percent=end, message=f"已存在 {target.name}")
        return
    try:
        import gdown
    except ImportError:
        file_id = google_drive_file_id(url)
        export_url = f"https://drive.google.com/uc?export=download&id={file_id}"
        download_url(export_url, target, force, reporter, start, end)
        return
    reporter.update(stage="downloading", percent=start, message=f"正在下载 {target.name}")
    result = gdown.download(id=google_drive_file_id(url), output=str(target), quiet=False)
    if not result:
        raise RuntimeError(f"下载失败: {url}")
    reporter.update(stage="downloading", percent=end, message=f"已下载 {target.name}")


def google_drive_file_id(url: str) -> str:
    for pattern in (r"/file/d/([^/]+)", r"[?&]id=([^&]+)"):
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    raise ValueError(f"无法解析 Google Drive 文件 id: {url}")


def download_url(url: str, target: Path, force: bool, reporter: JobReporter, start: float, end: float) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and target.stat().st_size > 0 and not force:
        reporter.update(stage="downloading", percent=end, message=f"已存在 {target.name}")
        return
    temp = target.with_suffix(target.suffix + ".tmp")
    request = urllib.request.Request(url, headers={"User-Agent": "AnimalDetectionWorkbench/0.1"})
    with urllib.request.urlopen(request, timeout=60) as response:
        total = int(response.headers.get("Content-Length") or "0")
        current = 0
        with temp.open("wb") as handle:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                handle.write(chunk)
                current += len(chunk)
                if total:
                    percent = start + (end - start) * current / total
                    reporter.update(
                        stage="downloading",
                        percent=percent,
                        current=current,
                        total=total,
                        message=f"正在下载 {target.name}",
                    )
    temp.replace(target)
    reporter.update(stage="downloading", percent=end, message=f"已下载 {target.name}")
