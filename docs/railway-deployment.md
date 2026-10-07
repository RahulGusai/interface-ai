# Railway deployment

Date: 2026-10-07. The first deployment is live; this record distinguishes configured resources from verified live behavior.

- Public source: https://github.com/RahulGusai/interface-ai, branch `main`, tested code commit `185ef506659f6267a4d80b796033b80f53e5af69`.
- Railway project: `ephemeral-services` (`4073cc7f-ee57-40d0-b8a1-41aadacee6df`).
- Environment: `production` (`3af28427-7dab-4d28-a80b-968e5c3289c4`).
- FastAPI service: `interface-ai-api` (`5003670b-2910-4bf3-ada3-b3a545fc469b`), Dockerfile, one worker/replica, `us-west2`, port 8000, `/health/live` deployment healthcheck.
- Persistent volume: `interface-ai-data` (`674ef42c-6f7b-4a00-bc2c-a2be2679dbff`), requested 500 MB at `/app/data`. Runtime database: `/app/data/interface-ai.sqlite3`. The database and SQLite sidecar files remain on this volume across deployments.
- Existing MinIO service: `Bucket`, private DNS label `bucket`, external S3 host `bucket-production-0901.up.railway.app`. Its existing deployment and volume are retained.
- Application bucket: `interface-ai-evidence`, created in the existing MinIO deployment and verified private in the MinIO console.
- Storage credentials use Railway references to `Bucket.MINIO_ROOT_USER` and `Bucket.MINIO_ROOT_PASSWORD`; no credentials are stored in this repository or frontend configuration.
- Requested provider model: `z-ai/glm-4.6`.
- Public API origin: `https://interface-ai-api-production.up.railway.app`. Frontend configuration: `VITE_API_BASE_URL=https://interface-ai-api-production.up.railway.app` (no trailing slash).
- Public OpenAPI URL: `https://interface-ai-api-production.up.railway.app/openapi.json`.
- Exact CORS origins currently configured: `https://id-preview--6f60c709-4fda-4f4e-8a77-4430b0d24c22.lovable.app`, `https://lovable.dev`, `http://localhost:5173`.

Railway confirms the provisioned volume is 500 MB at `/app/data`, with one replica. The user explicitly approved public HTTPS access.

## Live verification

Deployment `8457a48c-e26f-4025-b8dd-0923766003e6` reached `SUCCESS`; one replica is running. Docker/Chromium installation and application startup succeeded. Runtime logs confirm the attached volume was mounted before startup.

- `GET /health/live`: 200, alive.
- `GET /health/ready`: 200; database, actual MinIO store and browser worker ready; replay available. Discovery is currently unavailable because the provider key has not yet been copied to Railway.
- `GET /v1/app-deployments` and `/v1/capabilities`: 200 with truthful empty persisted catalogs.
- Live OpenAPI paths and components exactly match the checked-in contract.
- CORS preflight for the existing Lovable preview origin: 200 with the exact allowed origin.

Pending: explicit approval to copy the existing local OpenRouter key to this service's private Railway environment. Genuine discovery, live image upload/signature/expiry and an observed restart with populated records are not claimed. The persistent volume is configured and startup migrations preserve existing data.

Frontend integration is running in a separate Codex chat, `01a113a7-1141-70d1-91ec-3ca94eba5c54`, against existing Lovable project `6f60c709-4fda-4f4e-8a77-4430b0d24c22`. Its frontend is not being published by this deployment task.
