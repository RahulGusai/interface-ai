# Meridian Testbed Contact Mutation Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for Codex execution. In Lovable, follow the sequential tasks and verification requirements below. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Meridian's existing contact-edit workflow a clear, reproducible mutation demonstration: the agent prepares a synthetic email change, a human reviews the proposed Save action in AI Agent Console, and the agent verifies the persisted result after approval.

**Architecture:** Reuse Meridian's current form and local mutation store. Add an inline stored-versus-proposed summary so the runtime's screenshot captures the exact change and customer. Keep approval/rejection entirely in the external console/runtime. Meridian continues to save only when its existing form is submitted.

**Tech Stack:** Existing React 19, TypeScript, TanStack Router, Zod, `mlb-*` legacy banking styles, versioned localStorage, Vitest/Testing Library and Playwright.

**Spec:** This document, Meridian's inspected `AGENTS.md`/`README.md`, backend `docs/human-review.md`, and the companion console plan `2026-10-12-lovable-human-review.md`.

## Verified project and structure

Work only in **Meridian Testbed**, project `23654c50-2a16-49e7-af7d-2a13399f8b0b`, in the AI workflows workspace.

- Editor: <https://lovable.dev/projects/23654c50-2a16-49e7-af7d-2a13399f8b0b>
- Existing published origin: <https://legacy-account-servicing.lovable.app/>
- Source inspected on 2026-10-12 at `787359cfe2ce1280974babef8c557d04987d957a`. Recheck the current revision before implementation.
- This plan is based on source inspection, not a fresh verification of the published site's behavior. No application change or publication was performed while preparing it.

| Existing area | Current behavior | Role in this demonstration |
|---|---|---|
| `/` — customer search | Name, customer ID, account and branch search; deliberate duplicate names | Locate an exact customer using its ID |
| `/customers/$customerId` | Customer/contact/account overview, contact revision, statement iframe and print control | Read baseline and verify saved email/revision |
| `/customers/$customerId/contact` | Six contact fields, validation, top/bottom Save and Cancel, async save feedback | Prepare and commit the selected mutation |
| `/accounts/$accountId/transactions` | Read/filter/sort/paginate/export | Preserve existing read workflow |
| `/accounts/$accountId/limit` | Creates a PENDING transfer-limit request; cannot apply the limit | Keep as a separate domain workflow |
| `/supervisor/review` | Simulated approval/rejection that can change the transfer limit | Preserve; do not connect it to agent review |
| `/__dev/fixtures` | Seed/reset and failure-scenario controls | Operator setup only; not part of agent navigation |

`src/lib/bank/store.ts` already implements `saveContact`, `runMutation`, payload fingerprints, operation identity, revisions and storage failures. `saveContact` stores `{contact, rev, savedAt}` under `state.contacts[customerId]`; the overview reads it through `getCustomer`. The current app therefore **already has the Save operation needed for the take-home**. Do not build another mutation store or a new generic test-record page.

## Selected flow and alternatives

**Use contact email update as the primary demo.** It is a staff operation that visibly changes a customer record, uses the existing `type_text`/`click` tools, and has a simple success check. It avoids introducing unrelated screens or domain approval requirements.

Two alternatives were considered:

- A transfer-limit request is more consequential, but the external agent approval would only authorize submitting a request; a separate Meridian supervisor approval would still be needed to change the limit. That adds two queues and obscures the simple pause/resume demonstration.
- A new notes/test-record feature could work, but would add a new data model and persistence path when the contact workflow already supplies both.

The proposed frontend change is deliberately small: keep the contact workflow and add an inline change preview, clearer draft/save state, and focused verification tests.

## Global Constraints

1. Existing Meridian project only. No changes to AI Agent Console, the Node runtime, FastAPI, or model/provider configuration in this task.
2. All values remain fictional: email ends in `@example.test`; phone is `555-0100`–`555-0199`; postcode follows the existing fictional pattern. Preserve every current validation rule.
3. Preserve the legacy banking layout, density and `mlb-*` style system. No redesign or dependency upgrade.
4. Preserve routes, duplicate top/bottom Save/Cancel controls, accessible field labels, stable IDs and deliberate automation challenges.
5. Every actual mutation still uses `saveContact -> runMutation` and the existing `resolveOp`/fingerprint rules. No autosave, blur save, preview write, or direct localStorage write from UI components.
6. Preserve seed determinism, fixed reference date `2026-03-31`, local schema version 1, shared seed/reset version and `SharedConfigGate`. No database migration or shared customer-data persistence.
7. No review table, review API calls, run IDs, approval token, or “Awaiting human” state in Meridian. External runtime review gates the browser action; Meridian does not enforce agent policy.
8. Do not add a second target-side confirmation dialog. The existing Save submission is the commit point. Typing and navigation can also receive external review according to the runtime's assessment.
9. Keep all current failure scenarios and uncertain-result semantics. Do not convert ambiguous success into a definite failure or blindly resubmit.
10. Do not publish as part of implementing this plan. Return a saved revision, diff and verification evidence.

## Review Focus

- Typing or rendering the preview must not persist contact data or increment its revision.
- The screenshot must identify the exact customer and show both the stored and proposed email near Save.
- An old success banner must not imply that a subsequently edited draft is saved.
- An ambiguous save can already have committed; unchanged retry remains idempotent even when the preview now shows no difference.
- Verification must read stored data in the same browser profile and origin, not just inspect the draft input or an operator's separate browser.

## User-visible mutation flow

1. Search by the exact customer ID and open its overview. Record the original email and revision (`Original fixture` means no saved contact revision yet).
2. Select **Edit contact details**. Keep customer name and ID visible.
3. Change only Email to `review.approved@example.test`; leave all other fields unchanged.
4. Before Save, show the inline **Proposed contact changes** section containing customer identity, baseline revision, and a table with **Field / Stored value / Proposed value**. For this example there is one Email row. Show **Changes are not saved until you select Save.**
5. The agent proposes clicking one of the existing Save buttons. The external runtime classifies and routes the tool call. For the intended demo this action must be assessed `requires_human_review`; the runtime pauses before dispatch and creates the screenshot-backed review.
6. Approval in AI Agent Console allows the runtime to recheck the screen/target and dispatch Save. Meridian runs its current async mutation, shows **Contact details saved (revision rN).**, and updates the stored baseline.
7. The agent navigates back to the overview, reads the stored email and revision, then reopens or reloads the record in the same profile to verify persistence. It reports the actual email/customer/revision, not merely that approval was granted.
8. Rejection/expiry/cancellation occurs externally before Save dispatch. The contact draft may still be on screen, but the stored email and revision stay at their baseline. The target does not need to receive a rejection callback.

Do not add instructions to page content telling the LLM to call tools, request approval or change its policy. The page describes its own Save semantics. Model assessment remains a backend limitation: READ_WRITE does not guarantee review for every mutation, and a target-side preview cannot enforce the external classifier's decision. Record the actual review row and assessment in the demo evidence.

## Contact preview and state specification

### Preview layout

- Place the preview after the existing identity panel and before the top actions, so customer, change and Save can fit together in a normal desktop screenshot. Preserve the bottom toolbar for longer forms.
- Render a named section/table using semantic HTML and existing compact banking styles. Use text values, never injected HTML. Empty address line 2 displays `(empty)` in the comparison.
- Compare with the latest stored customer contact, not the generated fixture unconditionally. Subsequent edits compare against r1/r2/etc.
- Show only changed fields in fixed order: Address line 1, Address line 2, City, Postcode, Email, Phone. An unchanged valid draft says **No pending contact changes.**
- Use the exact existing Zod normalization (trim, lower-case email, upper-case postcode) when the whole draft validates. For an invalid draft, show its raw proposed values and **Draft needs validation. Nothing has been saved.** Preserve current field-error behavior on submit; do not advertise invalid values as ready to commit.
- Do not disable Save solely because the difference list is empty. Existing ambiguous-result retries must still be able to reuse the same operation ID and obtain their prior result. Do not change the current no-op submission semantics in this task.
- Do not add a ticking clock, animated status, or polling to this form. The external runtime compares screen state after human approval; avoid unnecessary screen changes during its wait.

### Draft and saved state

- Keep local form edits local. Preview computation must be pure and must not call `saveContact`, `commit`, `newOpId` or `resolveOp`.
- Preserve the current `busy` guard and read-only fields/disabled actions while saving. Both Save buttons use the same submit handler and operation identity.
- After confirmed save, retain the existing saved message and revision. The preview compares the normalized form to the now-stored values and has no pending rows.
- If the user edits again after confirmed success, replace the old success message with ordinary draft state so it cannot describe the new values as saved. Do not clear an ambiguous-result warning merely because the input changes: the earlier submission's result is still unknown.
- Keep the existing ambiguity guidance: reopen/reload before deciding whether another save is necessary. An unchanged retry from the same mounted form uses the same op ID; edited values use a new ID. Do not promise that the in-memory op ref survives reload.
- Keep Cancel as discard-and-return to the overview, not a new mutation. Reload before Save also discards the unsaved draft, using current behavior.
- Key `ContactBody` by customer ID when mounted by `ContactPage`, ensuring navigation to another customer does not reuse the previous customer's draft, operation reference or success state.
- Keep storage errors and simulated validation/session failures honest. A failed write cannot display the draft as a persisted contact value.

## Persistence and setup boundaries

Contact mutations persist only under `localStorage["meridian-legacy-bank/state"]` for one browser profile and origin. The shared Lovable Cloud row contains only the active fixture seed/reset version. It does not synchronize contacts, scenarios or operator changes into the agent's browser.

Consequences for the take-home:

- Use the agent's own subsequent observations/evidence to demonstrate the saved result. An operator visiting Meridian in a separate browser still sees that browser's data.
- Reopen/reload on the same origin in the same running session proves local persistence. A new runtime/browser profile is a separate fresh experiment and should not be expected to retain the contact edit.
- Select the customer ID from the active shared seed. Names deliberately repeat; do not hardcode a customer's name/ID from another seed. Record the seed and reset version in demo setup notes.
- Use a fresh agent profile with default scenarios for the basic approve/reject runs. Scenario toggles made in an operator's browser do not arm the agent's separate browser.
- A shared reset invalidates local mutations on the next load, even at the same seed because reset version increments. Avoid resetting during a running review. Reset is setup, not an agent tool step.
- Existing e2e reset helpers write the real shared seed row. Do not run them against the published/shared environment casually. Use isolated test configuration or mocked shared-config transport; document any explicitly performed shared reset and restore its prior seed, while acknowledging the reset version has advanced.

## Sequential implementation tasks

All paths below refer to the **Meridian Lovable repository**.

### Task 1 — Pure contact preview model

**Create:** `src/lib/bank/contact.ts`, `src/test/contact-preview.test.ts`.

**Modify:** `src/routes/customers.$customerId.contact.tsx` to import/re-export the existing `contactSchema` from the new module if it moves.

**Interfaces:** Export the unchanged `contactSchema`, fixed field labels, `ContactChange = {field: keyof Contact; label: string; before: string; after: string}`, and `buildContactPreview(stored: Contact, draft: Contact): {valid: boolean; normalized: Contact | null; changes: ContactChange[]}`. This module contains schema/display/comparison logic only, with no store reads or writes. Keep imports acyclic.

- [ ] Add tests for one email difference, multiple differences in fixed order, existing saved baseline, empty optional field, schema normalization, invalid synthetic email/phone/postcode, and no difference after a confirmed save.
- [ ] Run `bunx vitest run src/test/contact-preview.test.ts` and observe feature-related failures before implementing the helper.
- [ ] Implement the pure helper and preserve all schema bounds/messages. Rerun the test file; require all tests to pass.

### Task 2 — Inline preview and accurate form feedback

**Create:** `src/components/bank/ContactChangePreview.tsx`, `src/test/contact-form.test.tsx`.

**Modify:** `src/routes/customers.$customerId.contact.tsx`; `src/styles.css` only if existing table/panel classes cannot cover the compact preview.

**Interfaces:** `ContactChangePreview({customerId, customerName, storedRevision, preview}: {customerId: string; customerName: string; storedRevision: number | null; preview: ReturnType<typeof buildContactPreview>})` is display-only. The route owns form state and uses the existing `saveContact` pipeline.

- [ ] Add failing form tests: editing does not write contacts/revisions; preview identifies the customer; Save commits exactly the normalized draft; Cancel discards; a new edit clears a previous confirmed-success banner; a different customer receives a fresh form.
- [ ] Render the preview at the specified position, with visible stored/proposed values and no runtime-policy instructions.
- [ ] Add customer-keyed mounting and narrowly adjust confirmed-success-to-draft feedback on edit. Preserve ambiguity warnings and op refs.
- [ ] Test top and bottom Save through the same handler, pending disables, failed storage has no success, and ambiguity retry is still possible with an empty difference list.
- [ ] Run `bunx vitest run src/test/contact-preview.test.ts src/test/contact-form.test.tsx src/test/bank.test.ts src/test/shared-seed.test.ts`; require all new/affected tests to pass.

### Task 3 — Same-session persistence verification and regression checks

**Create:** `tests/e2e/contact_review_ready.py`.

**Modify:** `README.md`, `QA.md`; add a short instruction to `AGENTS.md` that the contact preview is display-only and external review remains outside this app.

- [ ] Build a browser check using an isolated/mock shared seed config, without invoking the public `reset_fixture_seed` RPC. Navigate from search to an exact customer, capture baseline email/revision, edit Email, and inspect the preview before Save.
- [ ] Verify no stored change after typing or Cancel. After Save, verify rN increments once, the overview displays the new email, and reopening/reloading in the same browser profile retains it.
- [ ] Cover both Save controls, invalid values, slow save/double click, storage failure and ambiguous unchanged retry. Reuse existing store test semantics; do not add a fake human-review backend to the target.
- [ ] Verify the preview and Save are legible at desktop and narrow widths, with no unnecessary layout/style changes to search, transactions, limit or developer screens.
- [ ] Run `bunx vitest run`, `bunx tsc --noEmit`, `bun run build`, and `bun run lint`. If Lovable reserves manual typecheck/build for its harness, report the available harness result and the unrun command separately; do not equate build with typecheck.
- [ ] Run `BASE_URL=http://localhost:8080 python3 tests/e2e/contact_review_ready.py` against the isolated development preview. Run broader existing browser suites only with their shared-reset side effects understood and contained.
- [ ] Return changed files, saved SHA, exact test results, screenshots, and any limitations. Do not publish.

## Cross-application take-home acceptance

These checks follow Meridian implementation, console implementation and compatible backend deployment. They are not tests of the target frontend alone.

Configure the run as **READ_WRITE** and use the exact allowlisted Meridian hostname. The preview and published hostnames are different; configure whichever one the run actually uses. Preserve the current route restrictions and avoid `/__dev/*` and `/supervisor/*` for this demonstration.

Choose an exact customer ID from the active seed and a proposed email different from the baseline. A copy-ready task template is:

> Find customer [exact customer ID] in Meridian Testbed. Update only their email to review.approved@example.test. Treat saving this customer contact change as requiring human review. After the approved Save, reopen the customer's record and confirm the stored email and revision. Leave all other details unchanged.

Replace the bracketed customer ID before creating the run. The app must not choose a fixture customer secretly or bypass normal search. User task instructions express the desired intervention; the actual runtime assessment and review row are the evidence that it occurred.

| Experiment | Required evidence |
|---|---|
| Approve | Correct run/review IDs; review screenshot shows customer and proposed email; no contact commit before approval; then tool execution, overview/reopened email and revision; final run outcome |
| Reject on a fresh run/profile | A distinct proposal such as `review.rejected@example.test`; reject the Save review; no Save tool dispatch and stored contact remains baseline |
| Expire/cancel | Pending action is not dispatched; run stops with actual outcome; no target-side fake rejection state |
| Second queued run | Remains queued while first run awaits review; progresses after the first ends |
| Replay/validation | Fresh current screenshot/arguments and review per actual replay/validation run; historical approval is not reused |
| Changed page after approval | Runtime recheck may produce a new review or fail; do not claim approval guarantees a contact write |

The primary demo should not arm slow/ambiguous/session scenarios or depend on arbitrary sleeps. Those are separate robustness checks. Human review can occur on other tool calls too, and discovery may spawn validation with another review; do not assume exactly one prompt across an entire discovery pipeline.

## Copy-ready Lovable instruction

Attach this entire file to the existing Meridian Testbed project and send:

> Implement the attached contact-mutation plan in this existing Meridian Testbed project (`23654c50-2a16-49e7-af7d-2a13399f8b0b`). The app already has a working contact Save flow: reuse it. Add the inline stored-versus-proposed contact summary and accurate draft/saved feedback so an external agent-review screenshot clearly shows the customer and proposed change. Preserve current validation, duplicate top/bottom Save controls, local persistence, operation fingerprints/idempotency, seed/reset gate, failure scenarios, and legacy banking styling. Keep actual human approval/rejection in the external AI Agent Console/runtime; do not add review APIs, approvals, run tracking, shared contact storage, a new workflow or database migration here. Follow the plan's exact files, tests and acceptance checks. Recheck current source and baseline first, avoid public shared-reset side effects during tests, and return changed files, saved revision, test/harness results, screenshots and limitations. Do not publish or change the console/backend/provider configuration.
