# Functional Requirements

**Status:** Initial requirements baseline; acceptance criteria must be refined during implementation.  
**Document role:** States what the application must do and how completion can be verified.  
**Related documents:** [Product Vision](PRODUCT_VISION.md) · [System Architecture](SYSTEM_ARCHITECTURE.md) · [Tool Registry](TOOL_REGISTRY.md) · [Implementation Roadmap](IMPLEMENTATION_ROADMAP.md)

## 1. Requirement conventions

Priority levels:

- **MUST:** required for the relevant release or workflow to be considered complete.
- **SHOULD:** important; can be deferred only with a documented reason.
- **COULD:** optional capability for a later iteration.

A requirement is not complete because a screen, file, or command with its name exists. Completion requires the behaviour and acceptance criteria to be verified. External integrations must be marked unverified until actual access and behaviour have been tested.

## 2. Application foundation

### FR-APP-001 — Installable application [MUST]

Provide an application that can be installed and launched on the agreed target platforms.

**Acceptance criteria**
- The supported operating systems and minimum requirements are documented.
- A clean installation and launch can be tested from the project's release artifact.
- Application configuration and user data have documented storage locations.
- Upgrade and recovery behaviour are specified before automatic updates are introduced.

### FR-APP-002 — Persistent workspace [MUST]

Persist projects, workflow runs, specifications, evidence, tool inventory, approvals, and improvement proposals across application restarts.

**Acceptance criteria**
- A closed and reopened application can list projects and resume or inspect prior workflow results.
- Workflow state distinguishes successful, failed, blocked, cancelled, and awaiting-approval runs.
- Corrupt or missing state produces a recoverable error rather than silent data loss.

### FR-APP-003 — Main agent and orchestration [MUST]

Use a main agent/orchestrator that selects the appropriate execution strategy for each task.

**Acceptance criteria**
- The orchestrator can select one agent, a subagent, or an agent team based on scope, parallelism, risk, context, coordination cost, and budget.
- It records the strategy and rationale for each delegated task.
- Each delegated task has a scope, expected output, permission boundary, and verification method.
- Task results are reconciled before a workflow is marked complete.
- A single-agent path is available and preferred when delegation adds no clear value.

### FR-APP-004 — Workflow visibility [MUST]

Show current phase, task progress, approvals required, tool activity, failures, and next steps.

**Acceptance criteria**
- A blocked workflow explains the blocker and how to resolve it.
- Progress reporting does not claim success before a step has actually completed.
- Long-running work can be inspected and resumed where technically supported.

## 3. Project management and import

### FR-PROJ-001 — Create a project [MUST]

Create a project from a new idea or an initial specification.

**Acceptance criteria**
- A project receives a stable identifier, workspace, initial status, and document location.
- The user can see which details are confirmed and which remain assumptions.

### FR-PROJ-002 — Import an existing project [MUST]

Import or connect an existing repository without unnecessarily rewriting it.

**Acceptance criteria**
- The system inspects repository structure, stack, dependencies, tests, configuration, and documentation using available access.
- The original repository is not modified during the initial read-only assessment.
- The report lists what was inspected, what could not be inspected, and the evidence supporting conclusions.
- Write access and external connections require the appropriate permission.

### FR-PROJ-003 — Focused assessment [MUST]

Allow the user to assess a selected aspect of a project instead of running a full assessment.

**Acceptance criteria**
- The assessment scope is recorded before execution.
- The report stays within the selected scope except for explicitly disclosed dependencies required to interpret findings.
- The user can run a broader assessment later.

### FR-PROJ-004 — Enterprise capability assessment [MUST]

Assess capability coverage across the categories below and distinguish code-based implementation from external configuration.

- **Product:** Overview, Pitch Deck, Assessment, Roadmap.
- **Operations:** Analytics, Performance, Usage & Cost, Issues, Database, Vector Database, Deployments, File Storage, Domains, Secrets, Code, Automation, Custom Models.
- **Interfaces:** API, MCP, Voice, Email Inbox, Email Outbox, Scheduled Jobs, Webhooks.
- **Management:** Audit Log, Models & Agents, Data Residency, Users, Settings.

**Acceptance criteria**
- Each applicable capability receives a status such as implemented in code, configured externally, partly present, missing, not verified, or not applicable.
- Every significant finding includes evidence, confidence, impact, and suggested next action.
- The system does not claim external services are connected merely because their names appear in code or documentation.
- The report separates an assessment from a compliance certification; it does not claim certification without a defined standard and evidence.

### FR-PROJ-005 — External service connectors [MUST for any connector enabled]

Connect to supported external services through an approved plugin, MCP server, API, CLI, or other documented adapter.

**Acceptance criteria**
- Each connector documents scopes, required permissions, data accessed, supported actions, and failure behaviour.
- Read access is separated from write/deploy/destructive access where possible.
- Connection status is verified with a real authorised request.
- The user can disconnect the integration and revoke stored credentials.

## 4. Planning workflow

### FR-PLAN-001 — Concept brief and design specification [MUST]

Provide a guided planning workflow that turns an idea into an approved concept brief and specification.

**Acceptance criteria**
- The workflow captures goals, users, use cases, scope, non-goals, assumptions, dependencies, risks, and success criteria.
- Requirements have stable identifiers and acceptance criteria.
- Design documents are saved under `docs/designs/` by default, unless the project's existing structure is intentionally retained.
- Changes to an approved specification are recorded rather than silently overwriting the original decision.

### FR-PLAN-002 — EGM integration [SHOULD]

Integrate Google Elephant-Goldfish Model using the sources recorded in the Tool Registry, after verifying compatibility and installation.

**Acceptance criteria**
- The installed commands/capabilities are discovered rather than assumed.
- The intended workflow supports brainstorm, draft, fresh-context review, and drift reporting where the installed EGM version provides them.
- If EGM is unavailable, the application explains the blocker and does not claim that EGM review or drift reporting ran.
- After implementation milestones, the system can compare code and approved specifications and record discrepancies.

## 5. Build workflow

### FR-BUILD-001 — Specification-driven feature implementation [MUST]

Break approved work into bounded features and implement them one at a time.

**Acceptance criteria**
- Each feature references requirement IDs, acceptance criteria, impacted components, dependencies, and verification commands.
- Existing architecture and code conventions are inspected before changes.
- The implementation is the smallest complete change consistent with approved requirements.
- The resulting diff and unresolved risks are reported.

### FR-BUILD-002 — Test-driven verification [MUST]

Create or update appropriate tests for each feature.

**Acceptance criteria**
- Relevant unit/integration/end-to-end or contract tests are selected based on the change.
- Actual test results are recorded; unrun checks are clearly marked.
- Failed tests are not suppressed or weakened simply to produce a pass.

### FR-BUILD-003 — Bug-fixing workflow [MUST]

Use the sequence: reproduce/debug → regression test → fix → tests → review.

**Acceptance criteria**
- The workflow records reproduction steps and root-cause evidence where available.
- A regression test is added when practical.
- The smallest reasonable fix is applied and all relevant checks are rerun.

## 6. Design and animation workflow

### FR-DESIGN-001 — Learning Studio [SHOULD]

Provide an inbox and viewer for design files, screenshots, animation samples, short videos, and other references.

**Acceptance criteria**
- References can be imported, previewed, tagged, searched, and linked to a project.
- Claude can propose a classification and explanation, and the user can correct it.
- Reference content is not automatically treated as a specification change.

### FR-DESIGN-002 — UI refinement [MUST when design work is requested]

Improve visual quality while preserving project functionality, architecture, and styling conventions.

**Acceptance criteria**
- The workflow inspects existing components and design tokens before changing them.
- Responsive behaviour, accessibility, loading/error/empty states, and relevant user journeys are checked.
- Unnecessary framework or animation-library changes are avoided unless justified.

### FR-DESIGN-003 — Animation quality [MUST when animation work is requested]

Use purposeful animation and assess performance.

**Acceptance criteria**
- The agent determines whether motion is necessary and identifies purpose, properties, timing/easing, and exit behaviour.
- Reduced-motion preferences are respected.
- Performance-sensitive animation uses appropriate properties and is tested where practical.
- Auditing, planning, implementation, and review are distinct activities.

### FR-DESIGN-004 — Application visual system and reference direction [MUST]

Implement a coherent UI for the installable application, using the supplied screenshots in `design-references/` as visual guidance: a dark productivity dashboard, a dark knowledge/file manager, and a light cloud-file workspace.

The direction should combine persistent navigation, a clear primary work area, optional contextual panels, readable cards/tables, strong hierarchy, and searchable/grouped file or reference collections where appropriate. Start with deep navy/near-black surfaces and restrained blue/violet accents, and support a light theme or theme preference where practical. These references are inspiration, not exact screen specifications.

**Acceptance criteria**
- The app uses shared design tokens and reusable UI components rather than unrelated one-off styles.
- Primary navigation, current workspace, workflow status, important actions, and contextual details are visually distinguishable.
- Learning Studio and project/document management support appropriate ways to find, group, preview, and inspect references.
- Typography, contrast, spacing, selection/focus states, loading/error/empty states, and responsive behaviour are checked.
- The interface remains keyboard-accessible and respects reduced-motion preferences.
- The design does not copy reference logos, product names, or proprietary visual details.
- The UI is validated at the project's agreed target viewport sizes and through relevant browser QA.
- The platform's visual design does not silently impose its design system on projects imported into or created with the application.

## 7. Check and review workflow

### FR-QA-001 — Specification drift [MUST]

Compare implementation against approved specifications and report mismatches.

**Acceptance criteria**
- Findings link to a requirement, the observed implementation, and supporting evidence.
- Findings distinguish defect, missing requirement, intentional deviation, specification change, and optional improvement.
- The workflow does not change specifications just to make the code appear compliant.

### FR-QA-002 — Real-browser QA [SHOULD]

Exercise important user journeys in a real browser and produce screenshots/evidence where supported.

**Acceptance criteria**
- The test uses declared journeys and expected outcomes.
- Failures include reproducible steps and available screenshots/logs.
- Browser tooling failure is reported as a blocked check, not a pass.

### FR-QA-003 — Independent review and simplification [MUST]

Review changes for correctness, security, regressions, test adequacy, maintainability, and complexity.

**Acceptance criteria**
- Reviews report severity, evidence, impact, and remediation.
- Simplification runs only when relevant and is followed by the tests affected by its changes.
- Duplicate reviewers are avoided unless they add a genuinely distinct perspective.

### FR-QA-004 — Quality gate [MUST]

Prevent progression to release when mandatory gates fail.

**Acceptance criteria**
- Critical defects, high-risk unresolved security findings, failing required tests, and significant unexplained spec discrepancies block release by default.
- Exceptions require explicit, recorded authorisation and a mitigation plan.
- A final report shows passed, failed, skipped, and blocked checks.

## 8. Ship and deploy workflow

### FR-SHIP-001 — Security + Ship [MUST]

Run the intended sequence: `code-review → security-review → tests → ship-check`.

**Acceptance criteria**
- The installed commands/tools are verified before use.
- `ship-check` validates spec/review evidence, test results, environment config, secrets, migrations, deployment target, health checks, monitoring, and rollback readiness.
- Preparing a release is distinct from executing the production deployment.

### FR-SHIP-002 — Controlled deployment [MUST]

Deploy via the project's supported CI/CD or release path.

**Acceptance criteria**
- Production deployment requires appropriate authorisation.
- The correct environment and version are verified before deployment.
- Post-deploy health checks and monitoring are performed.
- A documented rollback/mitigation procedure exists and is usable.

## 9. Iterative Layer

### FR-ITER-001 — Application self-assessment [MUST]

Analyse application errors, failed workflows, user feedback, repeated manual intervention, task outcomes, agent behaviour, tool usage, execution time, resource usage, and integration failures where telemetry is available.

**Acceptance criteria**
- Proposed improvements cite the evidence used and identify gaps in telemetry.
- The system distinguishes observations, inferences, and recommendations.
- Improvement proposals are deduplicated or linked to existing backlog items where possible.

### FR-ITER-002 — Improvement backlog [MUST]

Maintain a backlog of proposed and implemented changes to the platform.

**Acceptance criteria**
- Each item includes problem, evidence, expected outcome, priority, risk, dependencies, status, approver, implementation result, and measured outcome.
- The backlog distinguishes idea, proposed, approved, in progress, blocked, verified, released, and rejected states or equivalent.

### FR-ITER-003 — Safe self-improvement [MUST]

Route approved platform changes through the Project Layer.

**Acceptance criteria**
- Changes are isolated from the running production version.
- Existing approvals and security controls cannot be bypassed by the Iterative Layer.
- A known-good version and recovery path are preserved.
- Successful tests alone do not imply a change has produced the expected operational benefit.

### FR-ITER-004 — External ecosystem monitoring [SHOULD]

Monitor trusted sources for relevant changes to Claude, plugins, skills, MCP servers, models, libraries, and external integrations.

**Acceptance criteria**
- The system records source, detection time, release/version details when available, affected tools, risk, recommendation, approval status, and verification result.
- It maps tools to dependent workflows and tests.
- It distinguishes a discovered update from an installed update.
- It does not install arbitrary code or grant new permissions automatically.
- Relevant updates can be evaluated in isolation before adoption.

### FR-ITER-005 — Model behaviour evaluation [SHOULD]

Use representative evaluations when model changes may affect workflow quality.

**Acceptance criteria**
- Evaluation tasks are repeatable and cover relevant measures such as task completion, spec adherence, tool use, quality, security, latency, and cost where measurable.
- A newer model is not automatically adopted based on recency alone.

## 10. Learning, memory, and developer tools

### FR-LEARN-001 — Approved preferences [SHOULD]

Allow feedback to become a preference only after the wording is proposed and approved.

**Acceptance criteria**
- Entries have scope (global/project), source/provenance, and editable/removable status.
- Conflicting or duplicate preferences are surfaced rather than silently combined.

### FR-LEARN-002 — Learning from source material [COULD]

Extract cited lessons from videos, transcripts, and PDFs and propose system changes.

**Acceptance criteria**
- Claims are linked to source passages/pages/timestamps when available.
- Suggestions are clearly separated from source-derived information.
- No system changes are made merely because content was analysed.

### FR-LEARN-003 — Reusable skill proposals [COULD]

Identify repetitive tasks and propose reusable skills for approval.

**Acceptance criteria**
- A proposal includes repeated examples, intended trigger, workflow, permissions, tests, and expected benefit.
- Existing skills are checked before a duplicate is created.

### FR-LEARN-004 — Session wrap-up [SHOULD]

Summarise session decisions, progress, blockers, and next steps, and offer approved saving to the Vault inbox.

**Acceptance criteria**
- Summary separates confirmed decisions from assumptions.
- A summary is not stored as a permanent global rule without approval.

## 11. Tool conflict detection and safe uninstallation

### FR-TOOL-001 — Tool inventory and installation scope [MUST]

Maintain a current inventory of plugins, skills, local mods, hooks, MCP servers, CLI tools, and integration configuration that the application manages or can inspect with permission.

**Acceptance criteria**
- Entries record source, version where available, lifecycle status, dependencies, permissions, installation scope, provenance, and supported disable/uninstall method where known.
- Unknown ownership, scope, and version are represented as unknown rather than inferred.
- The registry distinguishes tools managed by the application from tools installed independently by the user or another package manager.

### FR-TOOL-002 — Conflict and duplication detection [MUST]

Identify potentially conflicting or redundant tools and explain the evidence for each finding.

**Acceptance criteria**
- Checks cover duplicate command/skill names, overlapping capabilities, incompatible versions, conflicting hooks/configuration, duplicate MCP tool names, dependency collisions, and broken workflow dependencies where applicable.
- Findings are classified as informational overlap, potential conflict, confirmed conflict, or release-blocking conflict.
- The report maps affected workflows and components and distinguishes evidence from inference.
- Similar names alone do not prove a conflict or authorise removal.

### FR-TOOL-003 — Remediation recommendations and dry run [MUST]

Recommend the least disruptive way to resolve each confirmed or likely conflict before performing changes.

**Acceptance criteria**
- Recommendations consider coexistence, configuration, disabling, replacing, and uninstalling in that order where appropriate.
- A dry-run report lists the exact components and configuration to be changed, affected dependencies/workflows, expected effects, risks, and recovery options.
- A tool that is required by another tool or workflow cannot be removed without surfacing that dependency and resolving or explicitly accepting it.

### FR-TOOL-004 — Scoped, approved uninstallation [MUST]

Disable or uninstall a conflicting tool only when the application can identify the target and use a supported removal path safely.

**Acceptance criteria**
- Destructive cleanup requires explicit approval appropriate to the installation scope and risk.
- The application uses the native uninstall mechanism where available and never relies on broad wildcard deletion or name matching alone.
- The application must not remove operating-system components, shared runtimes, unrelated applications, credentials, or user-created files as collateral cleanup.
- If ownership, scope, or removal safety is uncertain, the operation stops and produces manual instructions instead.
- The application cannot expand its own permissions to bypass a blocked removal.

### FR-TOOL-005 — Backup, audit, and recovery [MUST]

Make cleanup changes traceable and recoverable where technically possible.

**Acceptance criteria**
- Relevant configuration is backed up or its recovery method is recorded before removal where practical.
- The system records the approval, target, reason, exact action, result, and recovery information in an audit event.
- The result is verified by refreshing the inventory and testing affected workflows/integrations.
- A failed removal or verification is reported as failed/partial, not successful; recovery or manual next steps are supplied.

## 12. Security, privacy and audit requirements

### FR-SEC-001 — Least-privilege tools [MUST]

Each tool or integration declares required permissions and available actions. Read-only access is the default when sufficient.

### FR-SEC-002 — Secrets protection [MUST]

Credentials must not be committed to source, stored in ordinary notes, exposed in logs, or included in generated reports. The application must document how credentials are stored and revoked.

### FR-SEC-003 — Approval for high-impact actions [MUST]

Require authorisation for production deployment, destructive changes, permission widening, external messages, sensitive-data export, or other configured high-impact actions.

### FR-SEC-004 — Auditability [MUST]

Record material workflow starts/ends, approvals, tool changes, configuration changes, external connections, and deployments with enough information to reconstruct what happened, subject to privacy and retention policy.

### FR-SEC-005 — Untrusted input and code execution [MUST]

Treat imported content and external tool results as untrusted. Execute code in an isolated environment appropriate to the selected deployment model.

## 13. Definition of done for a feature

A feature is complete when:

- Its acceptance criteria have been reviewed and met.
- Relevant automated checks have actually run and their results are recorded.
- Security, privacy, and operational implications have been considered.
- Documentation and configuration are updated where necessary.
- Any migration, recovery, and deployment impacts are understood.
- Specification discrepancies are reconciled or explicitly recorded.
- Remaining risks and unverified behaviours are disclosed.
