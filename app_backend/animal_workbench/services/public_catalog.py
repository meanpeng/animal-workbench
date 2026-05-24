from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..config import get_paths


@dataclass(frozen=True)
class PublicDatasetSpec:
    key: str
    name: str
    annotation_format: str
    description: str
    urls: dict[str, str]
    default_sample_limit: int | None = None


PUBLIC_DATASETS: dict[str, PublicDatasetSpec] = {
    "lote": PublicDatasetSpec(
        key="lote",
        name="LoTE-Animal",
        annotation_format="coco_zip",
        description="Long time-span endangered animal camera-trap dataset.",
        urls={
            "wild_zip": "https://drive.google.com/file/d/1-2p5cDy4SnJJ6M0Kknp7oXgIp3rvppHO/view?usp=sharing",
            "json_zip": "https://drive.google.com/open?id=1meha9-e0R824EEs3OxQ2YAygIlTEMO1C&usp=drive_fs",
        },
    ),
    "ena24": PublicDatasetSpec(
        key="ena24",
        name="ENA24 Detection",
        annotation_format="parquet",
        description="Small camera-trap detection dataset distributed on Hugging Face.",
        urls={"huggingface_repo": "davanstrien/ena24-detection"},
    ),
    "swg": PublicDatasetSpec(
        key="swg",
        name="SWG Camera Traps",
        annotation_format="coco_lila",
        description="Species-level camera-trap boxes from the LILA wildlife collection.",
        urls={
            "boxes_zip": "https://storage.googleapis.com/public-datasets-lila/swg-camera-traps/swg_camera_traps.bounding_boxes.with_species.zip",
            "image_base": "https://storage.googleapis.com/public-datasets-lila/swg-camera-traps/",
        },
        default_sample_limit=2000,
    ),
    "wcs": PublicDatasetSpec(
        key="wcs",
        name="WCS Camera Traps",
        annotation_format="coco_lila",
        description="Large global camera-trap collection with species-level boxes.",
        urls={
            "boxes_zip": "https://storage.googleapis.com/public-datasets-lila/wcs/wcs_20220205_bboxes_with_classes.zip",
            "image_base": "https://storage.googleapis.com/public-datasets-lila/wcs-unzipped/",
        },
        default_sample_limit=2000,
    ),
}


def public_dataset_dir(key: str) -> Path:
    return get_paths().public_data_dir / key


def list_public_dataset_statuses() -> list[dict[str, Any]]:
    statuses = []
    for spec in PUBLIC_DATASETS.values():
        root = public_dataset_dir(spec.key)
        statuses.append(
            {
                "key": spec.key,
                "name": spec.name,
                "annotation_format": spec.annotation_format,
                "description": spec.description,
                "default_sample_limit": spec.default_sample_limit,
                "local_path": str(root),
                "downloaded": root.exists() and any(root.iterdir()),
                "importable": root.exists() and any(root.rglob("*")),
            }
        )
    return statuses


def public_spec(key: str) -> PublicDatasetSpec:
    if key not in PUBLIC_DATASETS:
        raise KeyError(key)
    return PUBLIC_DATASETS[key]
