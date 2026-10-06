from typing import Any, Generic, Literal, TypeVar, Annotated
from uuid import UUID
from urllib.parse import urlsplit
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class DTO(BaseModel):
    model_config = ConfigDict(extra='forbid')


class DeploymentCreate(DTO):
    tenant_id: str = Field(min_length=1)
    product_id: str = Field(min_length=1)
    base_url: str
    environment: str = Field(min_length=1)
    ui_variant: str = Field(min_length=1)
    vendor_release: str | None = None

    @field_validator('base_url')
    @classmethod
    def valid_url(cls, value):
        url = urlsplit(value)
        if url.scheme not in ('http','https') or not url.hostname or url.username or url.password or url.fragment:
            raise ValueError('Expected an HTTP URL without credentials')
        return value.rstrip('/')


class DeploymentPatch(DTO):
    expected_config_version: int = Field(ge=1)
    base_url: str | None = None
    environment: str | None = Field(None, min_length=1)
    ui_variant: str | None = Field(None, min_length=1)
    vendor_release: str | None = None

    @field_validator('base_url')
    @classmethod
    def valid_url(cls, value):
        return DeploymentCreate.valid_url(value) if value is not None else value

    @model_validator(mode='after')
    def non_null_fields(self):
        for key in ('base_url','environment','ui_variant'):
            if key in self.model_fields_set and getattr(self,key) is None:
                raise ValueError('Configuration field cannot be null')
        return self


class AppDeploymentDTO(DeploymentCreate):
    app_deployment_id: str
    config_version: int
    created_at: str
    updated_at: str


class CapabilityDTO(DTO):
    capability_id: str
    name: str
    description: str
    input_schema: dict[str, Any]
    output_schema: dict[str, Any]
    created_at: str
    counts: dict[str, int] = Field(default_factory=dict)


class DiscoveryStart(DTO):
    kind: Literal['discovery']
    app_deployment_id: UUID
    task: str = Field(min_length=1)
    inputs: dict[str, Any] = Field(default_factory=dict)

    @field_validator('task')
    @classmethod
    def nonblank(cls,value):
        if not value.strip():
            raise ValueError('Task cannot be blank')
        return value.strip()


class ReplayStart(DTO):
    kind: Literal['replay']
    app_deployment_id: UUID
    artifact_id: UUID
    inputs: dict[str, Any]

RunStart = Annotated[DiscoveryStart | ReplayStart, Field(discriminator='kind')]
RunStatus = Literal['queued','running','awaiting_finalization','validating','cancelling','completed','failed','cancelled','interrupted']


class OutcomeDTO(DTO):
    kind: Literal['success','expected_outcome','hard_failure']
    code: str
    message: str
    outputs: dict[str, Any] | None = None
    failure_stage: Literal['input_validation','readiness','execution','finalization','storage'] | None = None
    step_id: str | None = None
    expected: Any = None
    observed: Any = None
    dispatch_state: Literal['not_dispatched','completed','uncertain'] = 'not_dispatched'


class ProgressDTO(DTO):
    last_event_sequence: int
    current_step_id: str | None = None
    completed_steps: int | None = None
    total_steps: int | None = None


class RunDTO(DTO):
    run_id: str
    kind: Literal['discovery','replay']
    purpose: Literal['user','validation']
    app_deployment_id: str
    deployment_snapshot: dict[str, Any]
    capability_id: str | None
    task: str | None
    inputs: dict[str, Any]
    pinned_artifact_id: str | None
    artifact_version: int | None
    artifact_definition_sha256: str | None
    finalized_artifact_id: str | None
    parent_run_id: str | None
    binding_id: str | None
    binding_version: int | None
    binding_snapshot: dict[str, Any] | None
    selection_source: Literal['discovery','binding','explicit_artifact','validation']
    status: RunStatus
    outcome: OutcomeDTO | None
    stop_reason: dict[str, Any] | None
    runtime_result: dict[str, Any] | None
    progress: ProgressDTO
    created_at: str
    started_at: str | None
    finished_at: str | None


class RunEventDTO(DTO):
    run_id: str
    sequence: int
    timestamp: str
    type: str
    step_id: str | None
    payload: dict[str, Any]


class EventsDTO(DTO):
    items: list[RunEventDTO]
    next_after_sequence: int
    has_more: bool
    run_status: RunStatus


T = TypeVar('T')
class Page(DTO, Generic[T]):
    items: list[T]
    total: int
    page: int
    page_size: int


class ValidateRequest(DTO):
    app_deployment_id: UUID
    inputs: dict[str, Any]


class InvokeRequest(ValidateRequest):
    pass


class ActivateRequest(DTO):
    artifact_id: UUID
    validation_run_id: UUID
    expected_binding_version: int | None
    selection_note: str | None = None


class BindingDTO(DTO):
    binding_id: str
    app_deployment_id: str
    capability_id: str
    artifact_id: str
    binding_version: int
    state: Literal['ready','retired']
    deployment_config_version: int
    validation_run_id: str
    selection_note: str | None
    created_at: str
    retired_at: str | None
    readiness: dict[str, Any]


class EvidenceAssetDTO(DTO):
    asset_id: str
    run_id: str
    event_sequence: int
    kind: str
    object_key: str
    mime_type: str
    sha256: str
    byte_size: int
    width: int
    height: int
    captured_at: str
    label: str
    result: str | None
    detail: str | None


class ArtifactAssetDTO(DTO):
    asset_id: str
    artifact_id: str
    kind: Literal['reference_crop']
    object_key: str
    mime_type: str
    sha256: str
    byte_size: int
    width: int
    height: int
    source_run_id: str
    source_event_sequence: int
    source_evidence_asset_id: str | None
    crop_rect: dict[str, int]
    relative_point: dict[str, float]
    capture_context: dict[str, Any]
    created_at: str


class SignedAssetDTO(DTO):
    asset_id: str
    url: str
    expires_at: str
    sha256: str
    width: int
    height: int
    mime_type: str


class ArtifactSummaryDTO(DTO):
    artifact_id: str
    source_run_id: str
    capability_id: str | None
    version: int | None
    schema_version: int
    tool_contract_version: int
    state: str
    definition_sha256: str
    validated_run_id: str | None
    created_at: str
    published_at: str | None
    compatibility: dict[str, Any]
    publication: dict[str, Any]
    lineage: dict[str, Any]


class ArtifactDTO(ArtifactSummaryDTO):
    definition: dict[str, Any]
    assets: list[ArtifactAssetDTO]
