from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    reserve_name: str | None = Field(default=None, max_length=120)


class MediaImportRequest(BaseModel):
    paths: list[str] = Field(min_length=1)
    batch_name: str | None = Field(default=None, max_length=160)
    camera_site: str | None = Field(default=None, max_length=120)
    extract_frames: bool = False


class DatasetCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    dataset_type: Literal["public", "user", "fusion"]
    media_asset_ids: list[int] = Field(default_factory=list)
    composition_rule: dict[str, Any] = Field(default_factory=dict)


class DatasetFusionCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    source_dataset_ids: list[int] = Field(min_length=1)


class DatasetTargetNew(BaseModel):
    mode: Literal["new"]
    name: str = Field(min_length=1, max_length=160)


class DatasetTargetExisting(BaseModel):
    mode: Literal["existing"]
    dataset_id: int


DatasetTarget = DatasetTargetNew | DatasetTargetExisting


class DatasetFolderImportRequest(BaseModel):
    path: str = Field(min_length=1)
    name: str | None = Field(default=None, max_length=160)
    dataset_kind: Literal["auto", "labeled", "unlabeled"] = "auto"
    batch_name: str | None = Field(default=None, max_length=160)
    create_dataset: bool = True
    extract_frames: bool = False
    target_dataset: DatasetTarget | None = None


class DatasetMediaAdd(BaseModel):
    media_asset_ids: list[int] = Field(min_length=1)


class ClassCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120, pattern=r"^[A-Za-z0-9_.-]+$")
    display_name: str = Field(min_length=1, max_length=120)
    color: str | None = Field(default=None, pattern=r"^#[0-9A-Fa-f]{6}$")


class PublicDatasetJobRequest(BaseModel):
    sample_limit: int | None = Field(default=None, ge=1, le=100000)
    source_path: str | None = Field(default=None, min_length=1)
    force: bool = False


class AnnotationBoxBase(BaseModel):
    class_id: int
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    width: float = Field(gt=0, le=1)
    height: float = Field(gt=0, le=1)
    review_status: Literal["draft", "confirmed", "rejected"] = "draft"

    @model_validator(mode="after")
    def box_must_fit_image(self) -> "AnnotationBoxBase":
        if self.x + self.width > 1:
            raise ValueError("x + width must be less than or equal to 1.")
        if self.y + self.height > 1:
            raise ValueError("y + height must be less than or equal to 1.")
        return self


class AnnotationSave(AnnotationBoxBase):
    dataset_id: int
    media_asset_id: int
    source_prediction_id: int | None = None


class AnnotationUpdate(AnnotationBoxBase):
    dataset_id: int


class AnnotationBulkUpsert(AnnotationBoxBase):
    id: int | None = None


class AnnotationBulkSave(BaseModel):
    upserts: list[AnnotationBulkUpsert] = Field(default_factory=list)
    delete_ids: list[int] = Field(default_factory=list)


class AnnotationBatchCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    media_asset_ids: list[int] = Field(default_factory=list)
    source_model_id: int | None = None


class TrainingJobCreate(BaseModel):
    dataset_id: int
    name: str = Field(min_length=1, max_length=160)
    epochs: int = Field(default=50, ge=1, le=1000)
    image_size: int = Field(default=960, ge=128, le=2048)
    batch_size: int = Field(default=8, ge=1, le=128)
    device: str = Field(default="auto", max_length=40)
    mode: Literal["train", "resume"] = "train"
    base_model_id: int | None = None
    base_model_path: str | None = Field(default=None, max_length=500)
    resume_job_id: int | None = None
    checkpoint_path: str | None = Field(default=None, max_length=500)
    run_yolo: bool = False
    advanced: dict[str, Any] = Field(default_factory=dict)


class ModelProfileRequest(BaseModel):
    model_id: int | None = None
    model_path: str | None = Field(default=None, max_length=500)
