# Tool Registry

**Status:** Initial candidate inventory. This document does not assert that the listed tools are installed, compatible, or verified.  
**Document role:** Tracks tools, integrations, dependencies, permissions, compatibility, costs, and adoption status.  
**Related documents:** [Product Vision](PRODUCT_VISION.md) · [System Architecture](SYSTEM_ARCHITECTURE.md) · [Functional Requirements](FUNCTIONAL_REQUIREMENTS.md) · [Implementation Roadmap](IMPLEMENTATION_ROADMAP.md)

## 1. Registry rules

Tool names and capabilities below reflect the current planning notes. They must be checked against the actual installed environment, official source, current version, license, permissions, and compatibility before being adopted.

### Status values

- **Proposed:** desired but not yet inspected.
- **Needs verification:** name or source has been identified but availability, version, or compatibility is not confirmed.
- **Evaluated:** inspected and tested in a controlled environment.
- **Approved:** approved for a specified use and permission scope.
- **Installed:** installation confirmed.
- **Verified:** intended behaviour and required checks have passed.
- **Disabled:** retained in the inventory but not enabled.
- **Deprecated/Rejected:** not recommended for continued use; record the reason.

Do not change a status to `Installed` or `Verified` based only on a planned installation prompt or a successful package download. Record evidence.

## 2. Registry fields

Every entry should eventually include:

| Field | Meaning |
|---|---|
| ID | Stable identifier, for example `TOOL-PLAN-001`. |
| Name | Human-readable tool or integration name. |
| Kind | Skill, plugin, local mod, MCP server, API integration, workflow, library, model, or external service. |
| Purpose | Capability provided and reason for including it. |
| Source | Official repository, marketplace, documentation, package registry, or vendor. |
| Version | Installed/version-pinned version where available. |
| Status | One of the lifecycle statuses above. |
| Dependencies | Required commands, workflows, runtimes, packages, or services. |
| Permissions | Filesystem, network, secrets, shell, repository, account, deploy, or other permissions. |
| Data access | Data read, written, transmitted, retained, or logged. |
| Cost | Subscription, usage-based cost, token usage, hosting, or maintenance cost where known. |
| Used by | Workflows, phases, agents, or application components that depend on it. |
| Verification | Installation test, integration test, review, date, and evidence location. |
| Update policy | Pinning, monitoring source, evaluation, approval and rollback approach. |
| Installation scope | Project-local, user-level, account-level, system-wide, marketplace-managed, package-manager-managed, or unknown. |
| Provenance / owner | How the tool was installed and whether the application is authorised to manage it. |
| Conflicts / overlaps | Known or suspected conflicts, duplicate capabilities, and dependent tools/workflows. |
| Disable / uninstall method | Supported command or manager, required permissions, and whether removal is reversible. |
| Recovery method | Configuration backup, reinstall path, lockfile restoration, or documented manual recovery. |

## 3. Planning and specification tools

| ID | Name | Kind | Intended purpose | Source | Initial status | Notes / dependencies |
|---|---|---|---|---|---|---|
| TOOL-PLAN-001 | Elephant-Goldfish Model (EGM) | Toolkit / workflow integration | Brainstorming, drafting design docs, fresh-context review, and implementation drift reporting. | https://egm.dev/ · https://github.com/google/elephant-goldfish-model | Needs verification | Verify repository, current install instructions, commands, compatibility, license, and execution model. Intended commands: `/egm-brainstorm`, `/egm-draft`, `/egm-review`, `/egm-drift-report`. |
| TOOL-PLAN-002 | EGM brainstorm | Skill/command | Turn rough ideas into a tested concept brief. | EGM installation | Needs verification | Do not assume command exists until detected. |
| TOOL-PLAN-003 | EGM draft | Skill/command | Create a living design document section by section. | EGM installation | Needs verification | Default destination: `docs/designs/`. |
| TOOL-PLAN-004 | EGM review | Skill/command | Fresh-context review for completeness and implementation readiness. | EGM installation | Needs verification | Record review evidence and unresolved concerns. |
| TOOL-PLAN-005 | EGM drift report | Skill/command | Compare code with approved specification after implementation. | EGM installation | Needs verification | Must not silently rewrite approved requirements. |

## 4. Build, review, and release tools

| ID | Name | Kind | Intended purpose | Source | Initial status | Notes / dependencies |
|---|---|---|---|---|---|---|
| TOOL-BUILD-001 | Build Feature workflow | Custom workflow | Implement a bounded feature from an approved specification with tests and traceability. | To be implemented in this project | Proposed | Must inspect existing code, write/update tests, verify changes, and report files/results. |
| TOOL-REVIEW-001 | `code-review` | Claude Code plugin/command candidate | Independent code review for bugs and regressions. | Official marketplace/repository to verify | Needs verification | Similar names may refer to different commands or plugins; record exact package/source and available command. |
| TOOL-REVIEW-002 | `pr-review-toolkit` | Official plugin candidate | Specialist pull-request review, including tests/error handling/type design where available. | Official marketplace/repository to verify | Needs verification | Confirm current plugin name and supported review agents. |
| TOOL-REVIEW-003 | `code-simplifier` | Official plugin/agent candidate | Improve clarity and maintainability while preserving behaviour. | Official marketplace/repository to verify | Needs verification | Run tests after edits; avoid running redundantly with `/simplify`. |
| TOOL-REVIEW-004 | `/simplify` | Built-in command candidate | Simplify code changes after implementation. | Installed Claude Code version | Needs verification | Verify command availability; treat as an edit that requires re-testing. |
| TOOL-REVIEW-005 | `rift-check` | Toolkit skill | Report discrepancies between code and approved plan/specification. | Toolkit source to verify | Needs verification | Must classify defect, missing requirement, intentional deviation, and spec change separately. |
| TOOL-REVIEW-006 | `qa` | Toolkit skill | Exercise planned user journeys in a real browser and capture evidence/screenshots. | Toolkit source to verify | Needs verification | Requires browser automation and target app execution. |
| TOOL-REVIEW-007 | Fix a Bug | Custom workflow | Debug → reproduce → regression test → fix → tests → code review. | To be implemented in this project | Proposed | Must preserve failing evidence and rerun affected tests. |
| TOOL-SHIP-001 | `/security-review` | Security review tool/command candidate | Review vulnerabilities, data handling, authentication/authorization, and secrets exposure. | Current official source to verify | Needs verification | Do not assume command/package availability or coverage. |
| TOOL-SHIP-002 | `ship-check` | Custom workflow | Enforce release readiness and collect evidence. | To be implemented in this project | Proposed | Review findings, tests, config, secrets, migrations, monitoring, approvals and rollback. |
| TOOL-SHIP-003 | CI/CD pipeline | External service / workflow | Run checks, build artifacts and deploy with protected approvals. | Depends on selected platform | Proposed | Select during architecture; production deployment remains controlled. |

## 5. Design and animation tools

### Platform UI reference set

The following images are bundled with this documentation under `design-references/`. They describe the intended visual direction for the installable platform and Learning Studio; they are not external plugins and are not a mandate to reproduce the source interfaces exactly.

| Asset | Intended reference | How to use it |
|---|---|---|
| `ui-reference-01-dark-dashboard.jpg` | Dark navy productivity dashboard | Navigation rail, main work area, contextual panels, clear hierarchy, restrained blue accents. |
| `ui-reference-02-dark-knowledge-base.jpg` | Dark knowledge/file manager | Nested folder navigation, search, file collections and structured lists. |
| `ui-reference-03-light-cloud-dock.jpg` | Light cloud-file workspace with purple accents | Light theme alternative, folder collections, recent files, and file metadata. |

Use the assets as inspiration during UI design and visual review. Do not copy logos, product names, or proprietary details. The implemented design must use shared tokens and components, remain accessible and responsive, and respect reduced-motion settings.

| ID | Name | Kind | Intended purpose | Source | Initial status | Notes / dependencies |
|---|---|---|---|---|---|---|
| TOOL-DESIGN-001 | Learning Studio | Application feature | Inbox and viewer for design files, screenshots, animation samples, short videos and references. | To be implemented in this project | Proposed | Includes classification/explanation suggestions and links from references to projects. |
| TOOL-DESIGN-002 | `animate` | Personal skill | Decide whether to animate, purpose, tool, properties, easing and exit behaviour. | Personal skill source to verify | Needs verification | Review source and permissions. |
| TOOL-DESIGN-003 | `animation-performance` | Personal skill | Check smoothness, dropped frames and animation performance. | Personal skill source to verify | Needs verification | Requires suitable browser/performance tooling for evidence. |
| TOOL-DESIGN-004 | `improve-animations` | Personal skill | Read-only motion audit and proposed fix plan. | Personal skill source to verify | Needs verification | Should not edit code during audit. |
| TOOL-DESIGN-005 | `review-animations` | Personal skill | Review motion quality against the intended Emil Kowalski-inspired approach. | Personal skill source to verify | Needs verification | Treat as a design heuristic, not a formal certification. |
| TOOL-DESIGN-006 | `emil-design-eng` | Personal skill | Polish UI details, interactions, transitions and visual quality. | Personal skill source to verify | Needs verification | Verify source and avoid duplicating other design skills. |
| TOOL-DESIGN-007 | `frontend-design` | Official plugin candidate | Generate or refine frontend design. | Official marketplace/source to verify | Needs verification | Verify exact package and compatibility. |
| TOOL-DESIGN-008 | `modern-web-guidance` | Official plugin candidate | Apply current web development guidance. | Official marketplace/source to verify | Needs verification | Verify name/source and scope. |
| TOOL-DESIGN-009 | `figma` | Plugin/MCP integration candidate | Work with Figma files/design references where applicable. | Official source to verify | Needs verification | Requires appropriate access and permissions. |
| TOOL-DESIGN-010 | Polish the UI | Custom workflow | `frontend-design → modern-web-guidance → simplify → code-review`. | To be implemented in this project | Proposed | Invoke only relevant stages; verify after any code changes. |

## 6. Iterative Layer and learning tools

| ID | Name | Kind | Intended purpose | Source | Initial status | Notes / dependencies |
|---|---|---|---|---|---|---|
| TOOL-ITER-001 | Iterative Layer | Core application capability | Observe performance and propose, verify, and evaluate improvements to the platform. | Product requirement | Proposed | Begin read-only; route approved changes through Project Layer. |
| TOOL-ITER-002 | External Change Monitor | Core application capability | Track relevant changes to Claude, plugins, skills, models, MCP servers, dependencies and external services. | Product requirement | Proposed | Needs trusted source list, source freshness, version inventory and approval policy. |
| TOOL-ITER-003 | External Change and Compatibility Register | Core application capability | Store detected updates, impact, recommendations, tests, approval and outcomes. | Product requirement | Proposed | Link entries to inventory items, dependent workflows and backlog items. |
| TOOL-LEARN-001 | `feedback` | Toolkit skill | Propose preference/taste notes and save only after approval. | Toolkit source to verify | Needs verification | Keep global preferences separate from project-specific decisions. |
| TOOL-LEARN-002 | `learn-from-video` | Toolkit/account skill | Extract cited lessons from videos, transcripts or PDFs and propose system changes. | Toolkit source to verify | Needs verification | Source-derived claims must be distinct from recommendations. |
| TOOL-LEARN-003 | `learner` / `/learn-skills` | Toolkit plugin/command | Spot repetitive work and propose reusable skills. | Toolkit source to verify | Needs verification | Check existing skills to avoid duplicates. |
| TOOL-LEARN-004 | Preferences and Vault | Notes/storage feature | Store approved taste notes, reference notes, decisions and session learning. | To be implemented/configured | Proposed | Define scope, provenance, retrieval, edit and deletion rules. |
| TOOL-LEARN-005 | `workspace-os` modes | Toolkit feature | `/mode tutor`, `/mode build`, `/mode do`, `/mode review`. | Toolkit source to verify | Needs verification | Modes must not override security and project policy. |
| TOOL-LEARN-006 | Learning/explanatory output styles | Official plugin/style candidates | Teach key concepts and add concise insight notes when requested. | Official source to verify | Needs verification | Verify names and install instructions. |
| TOOL-LEARN-007 | `claude-md-management` | Official plugin candidate | Help maintain project instructions and reduce duplication. | Official source to verify | Needs verification | Instruction changes should be reviewable. |
| TOOL-LEARN-008 | `remember` | Official plugin/skill candidate | Maintain useful session notes or memory. | Official source to verify | Needs verification | Clarify overlap with Vault and session wrap-up. |
| TOOL-LEARN-009 | `reflect-mod` | Local mod | Convert corrections into reusable global rules. | Local mod source to verify | Needs verification | Potentially duplicates `feedback`; defer until overlap is resolved. |
| TOOL-LEARN-010 | `wrap-up` | Toolkit/account skill | Summarise session and offer to save summary to Vault inbox. | Toolkit source to verify | Needs verification | Summary should separate decisions, assumptions, blockers and next steps. |

## 7. Developer-environment enhancements

These are optional aids for the development environment. Their capabilities should not be hard-coded as mandatory features of the installed product unless a product requirement justifies that dependency.

| ID | Name | Kind | Intended purpose | Source | Initial status | Notes / dependencies |
|---|---|---|---|---|---|---|
| TOOL-DEV-001 | `token-weather` | Toolkit plugin | Context/token usage awareness. | Toolkit/source to verify | Needs verification | Clarify exact metrics and any data collection. |
| TOOL-DEV-002 | `cache-tax` / `/keepwarm` | Local mod | Warn about cold prompt-cache cost and optionally keep cache warm. | Local mod source to verify | Needs verification | Cache warming creates model requests and can increase cost; measure before enabling. |
| TOOL-DEV-003 | `you-should-know` | Built-in/agent feature candidate | Side agent points out useful observations in long tasks. | Installed environment/source to verify | Needs verification | Bound background work and cost; avoid duplicate reviewers. |
| TOOL-DEV-004 | `replay-theater` / `/replay` | Local mod | Step through edits from a prior turn. | Local mod source to verify | Needs verification | Complementary to, not a replacement for, Git history. |
| TOOL-DEV-005 | `filetree` | Local mod | Show files Claude reads/edits. | Local mod source to verify | Needs verification | Review filesystem access and permissions. |
| TOOL-DEV-006 | `savvy-progress` | Local mod | Progress UI for `/savvy-flow`. | Local mod source to verify | Needs verification | Dependency is not installed according to planning notes; defer until workflow decision. |

## 8. Tool conflict and safe uninstallation management

The platform needs a conflict and cleanup capability because many plugins, skills, mods, hooks, MCP servers, and integrations may be installed in overlapping scopes. The feature must operate from verified inventory and provenance, not assumptions.

| ID | Name | Kind | Intended purpose | Initial status | Requirements before adoption |
|---|---|---|---|---|---|
| TOOL-LIFE-001 | Tool Conflict and Cleanup Manager | Core application capability | Detect duplicate capabilities, incompatible versions/configuration, broken dependencies, and other tool conflicts; recommend safe remediation. | Proposed | Must integrate with the Tool Registry and affected-workflow map. |
| TOOL-LIFE-002 | Safe disable/uninstall executor | Core application capability | Disable or uninstall a selected plugin, skill, mod, hook, MCP server, or integration configuration using supported removal methods. | Proposed | Must support dry run, approval, scope/provenance checks, dependency checks, audit events, and post-removal verification. |
| TOOL-LIFE-003 | Configuration backup and recovery | Core application capability | Preserve relevant configuration and explain or perform recovery after an unsuccessful cleanup where supported. | Proposed | Must avoid storing credentials in plain-text backups or reports; recovery capability must be stated honestly. |

### Required conflict-resolution workflow

`Inventory → Detect → Classify → Map dependencies → Recommend → Dry run → Approve → Disable/uninstall → Verify → Record`

Required safeguards:

- Prefer configuration changes or temporary disablement over uninstalling when they solve the conflict.
- Use the source tool's supported disable/uninstall mechanism when available.
- Never use broad wildcard deletion, delete a folder based only on a matching name, or remove an entire manager/environment to resolve a single tool conflict.
- Do not remove shared runtimes, operating-system components, unrelated applications, user-created files, or credentials as collateral cleanup.
- If ownership, installation scope, dependencies, or removal safety is uncertain, stop and show manual remediation steps.
- Require explicit approval for destructive removal, account/global scope changes, shared dependencies, and uncertain/broad impacts.
- Refresh the inventory and test affected workflows after a removal. Record partial failures instead of claiming success.

A detected overlap is not automatically a conflict. The manager should distinguish harmless duplication from configuration collision and actual incompatibility, and should explain the evidence supporting that classification.

## 9. Integration candidates

| ID | Name | Kind | Intended purpose | Initial status | Requirements before adoption |
|---|---|---|---|---|---|
| TOOL-INT-001 | Vercel | External hosting/deployment service | Inspect deployment configuration/status or deploy where authorised. | Proposed | Verify project identity, scopes, available API/MCP/CLI path, secret handling and whether the operation is read-only or mutating. |
| TOOL-INT-002 | Git provider | External service | Repository, branch, pull-request and CI context. | Proposed | Select provider; scope repository permissions and protect branches. |
| TOOL-INT-003 | Browser automation | Tool/service integration | Real-browser QA and screenshots. | Proposed | Select supported tool, browser installation, environment and screenshot storage policy. |
| TOOL-INT-004 | Observability provider | External service | Errors, logs, metrics, performance and alert information. | Proposed | Select based on privacy, cost, data residency and access controls. |
| TOOL-INT-005 | Secrets manager | External service / OS store | Store and revoke credentials. | Proposed | Choose approach based on local/remote architecture and supported operating systems. |
| TOOL-INT-006 | Database / file storage | Infrastructure service | Persist application state and artifacts. | Proposed | Select based on local-first vs hosted needs, backup, encryption and retention. |

## 10. Integration onboarding checklist

Before approving a tool:

1. Confirm the exact source is authentic and maintained.
2. Review its code, license, release history, known issues, and permission requirements where available.
3. Determine whether an existing tool already provides the capability.
4. Record installation, version pinning, upgrade and rollback instructions.
5. Declare access to filesystem, shell, network, secrets, accounts, repositories, deployment, and user data.
6. Install in a controlled environment and run a minimal functional test.
7. Test failure handling and ensure the application reports unavailable tools honestly.
8. Add compatibility tests or workflow evaluations where the tool is important.
9. Record owner, dependent workflows, update source, cost, and verification evidence.
10. Approve only the minimum permission scope required.

## 11. Registry maintenance

The Iterative Layer should periodically compare recorded tool versions and sources with trusted upstream information. It should produce recommendations, not assume every update must be installed. Changes should be mapped to dependent workflows and evaluated for security, compatibility, performance, cost, and behaviour before adoption.

This registry must be refreshed as tools are installed, removed, updated, disabled, or replaced. The current statuses are planning statuses only and must be changed based on real installation and verification evidence. A cleanup operation must update the registry only after the outcome is verified; failed or partial removals must remain visible with recovery steps and affected workflows.
