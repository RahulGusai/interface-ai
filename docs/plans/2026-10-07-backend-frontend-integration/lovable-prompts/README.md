# Future Lovable integration prompts

These files are **written only, not sent**. Target exclusively AI Agent Console project `6f60c709-4fda-4f4e-8a77-4430b0d24c22` in workspace `workspace_01km5gk4jhe1kawz9qk0cd76xf`. Never legacy Meridian. New API naming app_deployments/app_deployment_id overrides old mock app_instances.

Before sending during a later authorized integration task: implement/test the prerequisites in 11; supply the real tested API origin as `VITE_API_BASE_URL`, reachable OpenAPI and relevant 07/09 excerpts if the Lovable agent cannot fetch OpenAPI. Local files are not automatically readable by Lovable. Endpoint unavailable is a STOP condition for that stage, not permission to simulate success/add a different backend. Local API with remote HTTPS preview may be browser-blocked; use exported frontend locally for local test or the actual future hosted HTTPS API, not an unrequested tunnel.

| Prompt | Prerequisites |
|---|---|
| [01-transport-and-reads.md](01-transport-and-reads.md) | Health, OpenAPI, deployment/capability/binding read endpoints implemented |
| [02-runs-and-progress.md](02-runs-and-progress.md) | Actual discovery start/worker, run/list/events/cancel/by-request reads/actions implemented |
| [03-artifacts-replay-lifecycle.md](03-artifacts-replay-lifecycle.md) | Published artifacts, exact replay, JSON schema forms, deployment CRUD, same-deployment validation/activation implemented |
| [04-evidence-and-assets.md](04-evidence-and-assets.md) | Real evidence/crop metadata and signed content-url endpoints implemented; browser-reachable storage |
| [05-final-integration-review.md](05-final-integration-review.md) | Prior four stages pass their gates; genuine end-to-end backend fixture available |

Send one prompt only after preceding response is terminal and independently checked. Record future response/commit SHA separately from actual frontend verification. Refresh source baseline if commit drifted since `93cb7664b8b135482ef8392d90a899efe023add7`. This pack makes no Lovable mutations.
