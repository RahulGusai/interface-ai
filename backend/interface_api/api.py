import asyncio
from uuid import UUID

from fastapi import APIRouter, Body, Header, Query, Request, Response

from .dto import (
    DTO,
    ActivateRequest,
    AppDeploymentDTO,
    ArtifactAssetDTO,
    ArtifactDTO,
    ArtifactSummaryDTO,
    BindingDTO,
    CapabilityDTO,
    DeploymentCreate,
    DeploymentPatch,
    EventsDTO,
    EvidenceAssetDTO,
    InvokeRequest,
    Page,
    RunDTO,
    RunStart,
    SignedAssetDTO,
    ValidateRequest,
)
from .errors import ApiError
from .reads import Reads
from .repositories import page

router = APIRouter(prefix="/v1")


def repo(request):
    return request.app.state.repo


def reads(request):
    return Reads(repo(request))


def services(request):
    return request.app.state.services


async def threaded(fn, *args, **kwargs):
    return await asyncio.to_thread(fn, *args, **kwargs)


@router.get("/app-deployments", response_model=Page[AppDeploymentDTO])
async def deployments(
    request: Request,
    q: str = "",
    environment: str | None = None,
    product_id: str | None = None,
    tenant_id: str | None = None,
    order_by: str = "created_at",
    direction: str = "desc",
    page_number: int = Query(1, alias="page", ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    return await threaded(
        reads(request).collection,
        "app_deployments",
        {"environment": environment, "product_id": product_id, "tenant_id": tenant_id},
        page_number,
        page_size,
        q,
        order_by,
        direction,
    )


@router.post("/app-deployments", status_code=201, response_model=AppDeploymentDTO)
async def create_deployment(request: Request, body: DeploymentCreate):
    return await threaded(repo(request).create_deployment, body.model_dump())


@router.get("/app-deployments/{ident}", response_model=AppDeploymentDTO)
async def deployment(request: Request, ident: str):
    return await threaded(
        repo(request).get, "app_deployments", "app_deployment_id", ident
    )


@router.patch("/app-deployments/{ident}", response_model=AppDeploymentDTO)
async def update_deployment(request: Request, ident: str, body: DeploymentPatch):
    patch = body.model_dump(exclude_unset=True)
    expected = patch.pop("expected_config_version")
    return await threaded(repo(request).update_deployment, ident, expected, patch)


@router.get("/app-deployments/{ident}/bindings")
async def deployment_bindings(request: Request, ident: str):
    await threaded(repo(request).get, "app_deployments", "app_deployment_id", ident)

    def load():
        items = [
            reads(request).binding(x)
            for x in repo(request).rows(
                "capability_bindings", "app_deployment_id=?", (ident,)
            )
        ]
        pairs = []
        for cap in repo(request).rows("capabilities"):
            binding = next(
                (
                    x
                    for x in items
                    if x["state"] == "ready"
                    and x["capability_id"] == cap["capability_id"]
                ),
                None,
            )
            pairs.append(
                {
                    "capability_id": cap["capability_id"],
                    "binding_id": binding["binding_id"] if binding else None,
                    "readiness": binding["readiness"]
                    if binding
                    else {"state": "discovery_needed", "binding": None},
                }
            )
        return {"items": items, "pairs": pairs}

    return await threaded(load)


@router.get("/capabilities", response_model=Page[CapabilityDTO])
async def capabilities(
    request: Request,
    q: str = "",
    order_by: str = "name",
    direction: str = "asc",
    page_number: int = Query(1, alias="page", ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    return await threaded(
        reads(request).collection,
        "capabilities",
        {},
        page_number,
        page_size,
        q,
        order_by,
        direction,
        ("name",),
        reads(request).capability,
    )


@router.get("/capabilities/{ident}", response_model=CapabilityDTO)
async def capability(request: Request, ident: str):
    return await threaded(
        reads(request).capability,
        await threaded(repo(request).get, "capabilities", "capability_id", ident),
    )


@router.get("/bindings", response_model=Page[BindingDTO])
async def bindings(
    request: Request,
    app_deployment_id: str | None = None,
    capability_id: str | None = None,
    artifact_id: str | None = None,
    state: str | None = None,
    page_number: int = Query(1, alias="page", ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    return await threaded(
        reads(request).collection,
        "capability_bindings",
        {
            "app_deployment_id": app_deployment_id,
            "capability_id": capability_id,
            "artifact_id": artifact_id,
            "state": state,
        },
        page_number,
        page_size,
        projection=reads(request).binding,
    )


@router.post(
    "/app-deployments/{ident}/bindings/{capability_id}/activate",
    response_model=BindingDTO,
)
async def activate(
    request: Request, ident: str, capability_id: str, body: ActivateRequest
):
    row = await threaded(
        services(request).lifecycle.activate,
        ident,
        capability_id,
        str(body.artifact_id),
        str(body.validation_run_id),
        body.expected_binding_version,
        body.selection_note,
    )
    return await threaded(reads(request).binding, row)


@router.post("/runs", status_code=202, response_model=RunDTO)
async def start_run(
    request: Request, body: RunStart, key: UUID = Header(alias="Idempotency-Key")
):
    return await services(request).admit(str(key), body.model_dump(mode="json"))


@router.post("/capabilities/{ident}/invoke", status_code=202, response_model=RunDTO)
async def invoke(
    request: Request,
    ident: str,
    body: InvokeRequest,
    key: UUID = Header(alias="Idempotency-Key"),
):
    return await services(request).admit(
        str(key),
        {"kind": "replay", **body.model_dump(mode="json")},
        capability_id=ident,
    )


@router.get("/runs/by-request/{key}", response_model=RunDTO)
async def by_request(request: Request, key: UUID):
    return await threaded(
        reads(request).run,
        await threaded(repo(request).get, "runs", "idempotency_key", str(key)),
    )


@router.get("/runs", response_model=Page[RunDTO])
async def runs(
    request: Request,
    q: str = "",
    kind: str | None = None,
    purpose: str | None = None,
    status: str | None = None,
    app_deployment_id: str | None = None,
    capability_id: str | None = None,
    artifact_id: str | None = None,
    parent_run_id: str | None = None,
    order_by: str = "created_at",
    direction: str = "desc",
    page_number: int = Query(1, alias="page", ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    return await threaded(
        reads(request).collection,
        "runs",
        {
            "kind": kind,
            "purpose": purpose,
            "status": status,
            "app_deployment_id": app_deployment_id,
            "capability_id": capability_id,
            "artifact_id": artifact_id,
            "parent_run_id": parent_run_id,
        },
        page_number,
        page_size,
        q,
        order_by,
        direction,
        ("created_at", "started_at", "run_id", "status", "app_deployment_id"),
        reads(request).run,
    )


@router.get("/runs/{ident}", response_model=RunDTO)
async def get_run(request: Request, ident: str):
    return await threaded(
        reads(request).run, await threaded(repo(request).get, "runs", "run_id", ident)
    )


@router.get("/runs/{ident}/events", response_model=EventsDTO)
async def events(
    request: Request,
    ident: str,
    after_sequence: int = 0,
    limit: int = Query(100, ge=1, le=200),
    type: str | None = None,
):
    return await threaded(reads(request).events, ident, after_sequence, limit, type)


@router.post("/runs/{ident}/cancel", status_code=202, response_model=RunDTO)
async def cancel(request: Request, ident: str, body: DTO = Body(default_factory=DTO)):
    row = await request.app.state.worker.cancel(ident)
    return await threaded(reads(request).run, row)


@router.get("/artifacts", response_model=Page[ArtifactSummaryDTO])
async def artifacts(
    request: Request,
    q: str = "",
    capability_id: str | None = None,
    state: str | None = "published",
    product_id: str | None = None,
    ui_variant: str | None = None,
    source_run_id: str | None = None,
    order_by: str = "created_at",
    direction: str = "desc",
    page_number: int = Query(1, alias="page", ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    return await threaded(
        reads(request).collection,
        "artifacts",
        {
            "capability_id": capability_id,
            "state": state,
            "product_id": product_id,
            "ui_variant": ui_variant,
            "source_run_id": source_run_id,
        },
        page_number,
        page_size,
        q,
        order_by,
        direction,
        projection=reads(request).artifact,
    )


@router.get("/artifacts/{ident}", response_model=ArtifactDTO)
async def artifact(request: Request, ident: str):
    return await threaded(
        reads(request).artifact,
        await threaded(repo(request).get, "artifacts", "artifact_id", ident),
        True,
    )


@router.get("/artifacts/{ident}/deployments")
async def artifact_deployments(request: Request, ident: str):
    def load():
        a = repo(request).get("artifacts", "artifact_id", ident)
        source = repo(request).get("runs", "run_id", a["source_run_id"])
        dep = repo(request).get(
            "app_deployments", "app_deployment_id", source["app_deployment_id"]
        )
        eligibility = reads(request).eligibility(a, dep)
        return {
            "items": [
                {
                    "deployment": dep,
                    "eligibility": "eligible"
                    if eligibility["state"] == "ready"
                    else eligibility["state"],
                    "reason": eligibility["reason"],
                    "validation_run_id": eligibility["validation_run_id"],
                }
            ],
            "total": 1,
        }

    return await threaded(load)


@router.post("/artifacts/{ident}/validate", status_code=202, response_model=RunDTO)
async def validate(
    request: Request,
    ident: str,
    body: ValidateRequest,
    key: UUID = Header(alias="Idempotency-Key"),
):
    return await services(request).admit(
        str(key),
        {"kind": "replay", **body.model_dump(mode="json")},
        validation_artifact=ident,
    )


@router.get("/evidence-assets", response_model=Page[EvidenceAssetDTO])
async def evidence(
    request: Request,
    run_id: str | None = None,
    kind: str | None = None,
    run_kind: str | None = None,
    purpose: str | None = None,
    event_type: str | None = None,
    artifact_id: str | None = None,
    q: str = "",
    order_by: str = "captured_at",
    direction: str = "desc",
    page_number: int = Query(1, alias="page", ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    def load():
        if order_by != "captured_at" or direction not in ("asc", "desc"):
            raise ApiError(422, "SORT_INVALID", "Unsupported ordering")
        items = []
        for asset in repo(request).rows(
            "evidence_assets",
            order="captured_at " + direction + ",asset_id " + direction,
        ):
            r = repo(request).get("runs", "run_id", asset["run_id"])
            e = reads(request).events(asset["run_id"], asset["event_sequence"] - 1, 1)[
                "items"
            ][0]
            if any(
                value is not None and value != actual
                for value, actual in [
                    (run_id, asset["run_id"]),
                    (kind, asset["kind"]),
                    (run_kind, r["kind"]),
                    (purpose, r["purpose"]),
                    (event_type, e["type"]),
                ]
            ):
                continue
            if artifact_id:
                a = repo(request).get("artifacts", "artifact_id", artifact_id)
                if (
                    r["run_id"] != a["source_run_id"]
                    and r["pinned_artifact_id"] != artifact_id
                ):
                    continue
            if (
                q
                and q.casefold()
                not in (
                    asset["label"]
                    + " "
                    + (asset["detail"] or "")
                    + " "
                    + (r["task"] or "")
                ).casefold()
            ):
                continue
            items.append(asset)
        return page(items, page_size, page_number)

    return await threaded(load)


@router.get("/artifacts/{ident}/assets", response_model=Page[ArtifactAssetDTO])
async def artifact_assets(
    request: Request,
    ident: str,
    page_number: int = Query(1, alias="page", ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    await threaded(repo(request).get, "artifacts", "artifact_id", ident)
    return await threaded(
        reads(request).collection,
        "artifact_assets",
        {"artifact_id": ident},
        page_number,
        page_size,
    )


@router.get("/evidence-assets/{ident}/content-url", response_model=SignedAssetDTO)
async def evidence_url(request: Request, response: Response, ident: str):
    response.headers["Cache-Control"] = "no-store"
    return await services(request).signed("evidence_assets", ident)


@router.get("/artifact-assets/{ident}/content-url", response_model=SignedAssetDTO)
async def crop_url(request: Request, response: Response, ident: str):
    response.headers["Cache-Control"] = "no-store"
    return await services(request).signed("artifact_assets", ident)
