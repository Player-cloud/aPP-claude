# Implementation Roadmap

**Status:** Proposed phased roadmap  
**Document role:** Defines a dependency-aware build order and exit criteria.  
**Related documents:** [Product Vision](PRODUCT_VISION.md) · [System Architecture](SYSTEM_ARCHITECTURE.md) · [Functional Requirements](FUNCTIONAL_REQUIREMENTS.md) · [Tool Registry](TOOL_REGISTRY.md)

## 1. Roadmap principles

- Build a working vertical slice before implementing every listed capability.
- Verify the installation target and execution model before committing to an architecture.
- Treat tool names as candidates until their current source, compatibility, permissions, and installation have been checked.
- Build automated tests and evidence collection into the workflow from the start.
- Implement the Iterative Layer in read-only/recommendation mode before permitting it to implement platform changes.
- Do not automate production deployment or permission changes without explicit approval.
- Use the Project Layer itself to implement later improvements to the platform.

## 2. Phase 0 — Resolve foundational decisions

**Goal:** Remove ambiguities that could force a costly architecture change later.

### Tasks
- Choose target operating systems and installable-app approach.
- Decide whether execution is local, remote, or hybrid.
- Define where project files, application state, credentials, logs, and artifacts live.
- Define privacy boundaries for source code and model-provider requests.
- Select initial model provider(s), cost limits, and tool permissions.
- Decide the first external integrations and whether multi-user collaboration is required.
- Review the candidate tools in `TOOL_REGISTRY.md`, beginning with the tools required for the first vertical slice.

### Exit criteria
- Architecture decisions are recorded with alternatives and trade-offs.
- The minimum release scope is approved.
- The installable target and execution/security model are selected.

## 3. Phase 1 — Application shell and project workspace

**Goal:** Deliver a usable installable application foundation.

### Tasks
- Create the application shell and navigation for Project Layer and Iterative Layer.
- Establish shared design tokens and reusable components guided by the supplied screenshots in `design-references/`: dark navy/near-black base with restrained blue/violet accents, plus a light-theme direction where practical.
- Define the primary shell layout: navigation rail/sidebar, top-level workspace controls, primary content area, and optional contextual panels. Avoid forcing all workflows into one layout pattern.
- Implement project creation and project selection.
- Establish persistent project metadata, workflow state, artifacts, and event records.
- Implement settings, credential references, and a basic integration registry.
- Add structured errors, logs, and a consistent workflow-status model.
- Add baseline unit tests, build verification, and packaging smoke tests.

### Exit criteria
- A clean installation can launch the application on the chosen target platform.
- Projects can be created, listed, reopened, and inspected after restart.
- Workflow states and failures are visible and persisted.
- Secrets are not stored in ordinary project documents or logs.

## 4. Phase 2 — Main agent and task orchestration

**Goal:** Establish controlled delegation before adding many specialised workflows.

### Tasks
- Implement the main agent/orchestration interface.
- Define bounded task specifications, output contracts, permissions, timeouts, and budgets.
- Implement single-agent and subagent paths first.
- Add agent-team execution only when parallel independent tasks justify the overhead.
- Capture strategy choice, task status, failures, and delegated outputs.
- Add a test matrix for sequential, independent, conflicting, failed, and permission-limited tasks.

### Exit criteria
- The orchestrator chooses a defensible strategy and records its rationale.
- Delegated work is reconciled before completion.
- Tool failure, agent failure, and timeout states do not become false successes.
- A simple task is not automatically escalated to an agent team.

## 5. Phase 3 — Project Layer planning vertical slice

**Goal:** Turn a rough idea into an approved, traceable project specification.

### Tasks
- Implement project brief, requirements, assumptions, risks, acceptance criteria, and roadmap output.
- Verify and install EGM in a controlled workspace, if the current repository/version is compatible.
- Integrate the supported EGM brainstorm, draft, review, and drift-report capabilities through a clear adapter.
- Store living design docs in `docs/designs/` by default.
- Add spec versioning and approval state.
- Provide a fallback or blocked-state message if EGM commands are missing or fail.

### Exit criteria
- A sample idea produces a reviewable concept brief and specification.
- The system distinguishes confirmed facts from assumptions.
- Requirements have IDs and acceptance criteria.
- The system can show whether EGM commands actually ran and capture their outputs.

## 6. Phase 4 — Build Feature workflow

**Goal:** Implement bounded features from approved requirements.

### Tasks
- Create `/build-start`, `/build-feature`, `/build-verify`, `/build-review`, `/build-fix`, and `/build-handoff` or equivalent skills/workflows where needed.
- Inspect existing code and tests before editing.
- Add requirement-to-code/test traceability where practical.
- Implement test execution, diff review, error reporting, and test evidence capture.
- Add a root-cause-oriented bug-fix loop.
- Integrate only the code-review/security/test tools that are verified and useful for the stack.

### Exit criteria
- A sample feature can be planned, implemented, tested, reviewed, and reported.
- Test results are real and distinguish passed, failed, skipped, and blocked checks.
- The workflow leaves unrelated files unchanged unless justified.
- A known test failure can be reproduced, fixed, and protected by a regression test.

## 7. Phase 5 — Design, animation, and Learning Studio

**Goal:** Allow the application to refine UI and motion while preserving behaviour.

### Tasks
- Build the Learning Studio reference inbox and viewer.
- Use the bundled UI reference set to guide the platform's visual language without copying source branding or treating screenshots as exact product requirements.
- Support relevant visual file types and short video/reference ingestion according to chosen implementation and licensing constraints.
- Add tagging, explanation/classification suggestions, and project linkage.
- Verify and selectively adopt `frontend-design`, `modern-web-guidance`, Figma integration, and the motion skills in the Tool Registry.
- Implement the Polish the UI workflow with conditional stages rather than invoking every tool for every change.
- Add responsive, accessibility, reduced-motion, and animation-performance checks.

### Exit criteria
- References can be imported, viewed, found, and associated with a project.
- A UI refinement task preserves existing functionality and reports the relevant checks.
- The application uses consistent design tokens, a coherent workspace hierarchy, and responsive navigation/panels based on the reference direction.
- Key screens are checked for keyboard access, contrast, focus visibility, loading/error/empty states, and relevant viewport sizes.
- Motion changes are reviewed for purpose, reduced-motion behaviour, and performance where relevant.

## 8. Phase 6 — Check, review, and ship gates

**Goal:** Prove the app can prevent unsafe or unverified changes from being released.

### Tasks
- Integrate `rift-check` and `qa` after confirming their actual sources and behaviour.
- Implement independent code/security review and test gates.
- Implement `ship-check` as a workflow that gathers release evidence and checks required conditions.
- Separate release preparation from deployment execution.
- Integrate a CI/CD adapter for the selected platform.
- Add deployment health checks and a rollback/mitigation runbook.
- Test the pipeline with deliberate defects, failing tests, missing configuration, and failed health checks.

### Exit criteria
- Required failures block release by default.
- Exceptions require recorded approval and rationale.
- The release report shows evidence for passed, failed, skipped, and blocked gates.
- Production deployment requires the configured authorisation.
- A sample rollback or mitigation drill is completed.

## 9. Phase 7 — Existing-project import and enterprise assessment

**Goal:** Assess new and existing projects without confusing code evidence with external infrastructure state.

### Tasks
- Add repository import/read-only analysis.
- Build the capability model for Product, Operations, Interfaces, and Management.
- Detect relevant code/configuration evidence and list what could not be verified.
- Add focused assessments for a single requested aspect.
- Implement the integration registry and a first external connector only after selecting the initial provider.
- Ensure connector scopes distinguish read-only inspection from write/deploy actions.

### Exit criteria
- An imported project can receive a scoped report with evidence and confidence.
- Code-managed, externally managed, partially present, missing, and unverified states are distinct.
- A selected single-aspect assessment does not silently expand into an unrestricted audit.
- External state is reported only when supported by authorised evidence.

## 10. Phase 8 — Iterative Layer in observe/recommend mode

**Goal:** Collect evidence and propose platform improvements without modifying the running system.

### Tasks
- Instrument workflow outcomes, errors, latency, manual interventions, usage and cost where available.
- Build the improvement backlog and prioritisation model.
- Add session wrap-up, feedback intake, and approved Preferences/Vault notes.
- Identify recurring workflow failures and opportunities for skill or orchestration improvements.
- Add before/after evaluation templates for proposed changes.

### Exit criteria
- Improvement proposals cite evidence, expected outcome, risk, cost, dependencies, and success criteria.
- Duplicate proposals can be linked or consolidated.
- The system remains read-only with respect to platform code/configuration until an improvement is approved.

## 11. Phase 9 — External ecosystem monitoring

**Goal:** Detect and assess changes in Claude and the tools on which the platform depends.

### Tasks
- Maintain the versioned Tool Registry and dependent-workflow map.
- Define trusted upstream sources for each adopted tool.
- Add periodic/manual checks of release notes, changelogs, advisories, repositories, and package metadata as appropriate.
- Store detection time, source, observed version, change summary, confidence, impacts, and recommendation.
- Implement prioritisation for security patches, breaking changes, deprecations, and potential improvements.
- Add a compatibility/evaluation environment for high-impact changes.

### Exit criteria
- A known version change can be detected and linked to affected workflows.
- The system distinguishes discovery, recommendation, approval, installation, and verification.
- It does not auto-install arbitrary updates or expand permissions.
- Reports identify stale or unreachable sources and do not claim monitoring coverage where checks did not run.

## 12. Phase 10 — Tool conflict detection and safe cleanup

**Goal:** Detect overlapping or incompatible tools and provide a safe, auditable way to disable or uninstall a selected conflict without damaging unrelated setup.

### Tasks
- Extend the Tool Registry with installation scope, provenance, dependencies/conflicts, supported disable/uninstall method, and recovery information.
- Build read-only inventory discovery for supported project-local, user-level, and integration-managed tool locations; label unknown ownership rather than guessing.
- Detect duplicate commands/skills, overlapping capabilities, incompatible versions, conflicting hooks/configuration, duplicate MCP tool names, and broken tool/workflow dependencies where applicable.
- Produce conflict reports that classify harmless overlap, potential conflict, confirmed conflict, and release-blocking conflict with evidence and confidence.
- Implement remediation recommendations that prefer coexistence/configuration changes or disablement before uninstalling.
- Add dry-run plans that enumerate exact targets, dependent workflows, required permissions, backup/recovery paths, and expected consequences.
- Implement approved removal through supported uninstall mechanisms; if safe ownership or removal cannot be established, generate manual instructions instead.
- Add audit events, post-removal inventory refresh, affected-workflow tests, and failure/recovery reporting.
- Test with duplicate plugins, same-name tools from different sources, missing dependencies, unknown installation scope, failed uninstall commands, and tools shared by multiple workflows.

### Exit criteria
- The manager detects and explains representative conflicts without treating every duplicate capability as an error.
- Dry-run output shows exact targets and impact before any destructive operation.
- No destructive removal occurs without the required approval.
- The system never uses broad deletion or removes operating-system components, shared runtimes, unrelated tools, credentials, or user files as collateral cleanup.
- Successful, failed, and partial removals are recorded accurately; affected workflows are re-checked.
- Unmanaged or ambiguous tools produce a safe manual remediation report instead of a guessed uninstall.

## 13. Phase 11 — Controlled self-improvement

**Goal:** Route approved platform improvements through the normal project lifecycle.

### Tasks
- Create a platform-maintenance project template.
- Implement isolated branches/worktrees or a suitable development environment for self-changes.
- Add mandatory regression, security, and workflow evaluation suites for core platform changes.
- Maintain a known-good release and test recovery procedure.
- Require approval for changes to permissions, security policies, release gates, and production configuration.
- Measure results after release and close or reopen improvement backlog items based on evidence.

### Exit criteria
- An approved proposal can become a bounded implementation task and pass through all standard gates.
- The running production instance is never edited directly by the Iterative Layer.
- A failed evaluation blocks or rolls back the change under the configured policy.
- The system records whether the intended improvement actually happened.

## 14. Phase 12 — Learning and developer-environment enhancements

**Goal:** Add useful preference learning and optional development aids without making the product depend on them.

### Tasks
- Implement approved feedback and preference storage.
- Add source-cited learning from video/document workflows if selected.
- Propose reusable skills from repeated tasks while checking for duplicates.
- Evaluate `wrap-up`, `token-weather`, `cache-tax`, `you-should-know`, `replay-theater`, `filetree`, `savvy-progress`, and `reflect-mod` individually.
- Remove or consolidate duplicate memory/feedback paths.

### Exit criteria
- Preferences are scoped, reviewable, and editable/removable.
- A tool is included only after source, permissions, compatibility, cost, and benefit have been reviewed.
- Optional development mods can be disabled without breaking core product workflows.

## 15. Later enterprise hardening

After the end-to-end vertical slice is dependable, prioritise maturity features based on actual use:

- Multi-user permissions, tenant isolation, and administrative controls if needed.
- Formal audit-log protections, retention, and export.
- Data residency enforcement and evidence for the specific requirements that apply.
- Backups, recovery testing, availability targets, rate limits, and capacity planning.
- Deeper integrations for analytics, issues, file storage, domains, databases, vector stores, scheduled jobs, email, voice, webhooks, and custom models.
- Additional model evaluations, cost controls, and orchestration optimisation.

Do not implement empty dashboards for every enterprise category. Each capability should exist because there is a real requirement, a supported data source, and a way to verify correctness.

## 16. Global definition of done

A milestone is complete only when:

- Its acceptance criteria are met with evidence.
- Relevant tests, reviews, and build checks have actually run.
- Security, privacy, permissions, and operational effects have been considered.
- Documentation, tool statuses, architecture decisions, and known limitations are updated.
- Installation or upgrade behaviour is verified where relevant.
- Failure and recovery paths are understood for consequential operations.
- No unresolved critical issue is hidden by a green summary.

## 17. Decisions to resolve early

Track these as explicit roadmap decisions rather than leaving them implicit:

- Target platform, app framework, and packaging strategy.
- Local/remote execution and code sandbox design.
- Model/provider and credential-handling strategy.
- First supported Git provider, hosting platform, and browser automation stack.
- State database and artifact storage.
- Privacy, telemetry, retention, and data residency defaults.
- Approval policy and which low-risk operations, if any, may run autonomously.
- MVP boundary and measurable success metrics.
