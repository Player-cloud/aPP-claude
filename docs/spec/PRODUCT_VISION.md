# Product Vision

**Status:** Working product vision  
**Document role:** Describes the problem, product boundaries, intended users, and desired outcomes.  
**Related documents:** [System Architecture](SYSTEM_ARCHITECTURE.md) · [Functional Requirements](FUNCTIONAL_REQUIREMENTS.md) · [Tool Registry](TOOL_REGISTRY.md) · [Implementation Roadmap](IMPLEMENTATION_ROADMAP.md)

## 1. Vision

Build an installable AI-powered development application with two connected layers:

1. **Project Layer** — helps me plan, build, design, review, ship, and deploy software projects.
2. **Iterative Layer** — observes and improves the development application itself, including its architecture, workflows, agents, tools, integrations, performance, reliability, and usability.

A main agent coordinates work and decides whether a task is best handled directly, by a single subagent, or by a coordinated agent team. The system should choose the simplest suitable approach rather than using multiple agents for every task.

The application should support both projects created from scratch and existing projects imported from a local repository. An imported project can receive a broad readiness assessment or a narrowly scoped assessment of one selected area.

## 2. The problem this product solves

Software development with AI involves more than generating code. A reliable workflow also needs requirements, architecture, design references, tests, security checks, deployment controls, maintenance, and evidence that implementation matches the intended specification.

The application should connect these activities in one repeatable workflow while allowing me to select suitable tools and integrations. It should make the work traceable from an original idea through approved specifications, code, tests, review findings, releases, and measured outcomes.

It should also help keep the platform itself up to date. The Iterative Layer should learn from the application's own performance and monitor changes in Claude, installed plugins, skills, MCP servers, models, libraries, and external services. It should assess the impact of changes and propose improvements, rather than blindly updating everything.

## 3. Target user and primary use cases

The primary user is a developer who wants to use Claude and related tools to build and maintain software through a structured, reusable engineering process.

Primary use cases:

- Start a new project from an idea and turn it into an approved concept brief and design specification.
- Implement a project in small, traceable features.
- Refine the user interface, visual design, and animation using existing design conventions and reference material.
- Test user journeys, review code, identify defects, and compare implementation against specifications.
- Prepare a release with security and deployment gates.
- Import an existing project and assess its architecture, implementation, operations, integrations, and enterprise readiness.
- Assess only a selected aspect of a project, such as API design, security, performance, database design, deployment, or accessibility.
- Connect to external services through supported integrations, plugins, APIs, or MCP servers when needed.
- Review the platform's own errors, usage, costs, workflow performance, and external dependency changes.
- Improve the platform through approved, isolated, testable changes.
- Preserve approved preferences, useful notes, and lessons between sessions.

## 4. Product structure

### 4.1 Project Layer

The Project Layer uses this standard lifecycle:

**Plan → Build → Design & Animation → Check & Review → Ship & Deploy**

Each phase must receive the relevant outputs from the previous phase and produce an explicit handoff for the next one. Testing, security, traceability, and appropriate documentation apply throughout the lifecycle, not only during final review.

#### Plan

Use Google Elephant-Goldfish Model (EGM) as a proposed planning integration, subject to verifying its installation, compatibility, and actual command names. The intended sequence is:

- `/egm-brainstorm` — clarify a rough idea through questioning and stress-test assumptions into a concept brief.
- `/egm-draft` — turn the brief into a living design document under `docs/designs/`, section by section.
- `/egm-review` — use fresh-context reviewers to assess completeness, clarity, self-containment, and implementation readiness.
- `/egm-drift-report` — compare implementation against the approved specification after implementation and report discrepancies.

The plan should identify assumptions, requirements, acceptance criteria, dependencies, risks, and priorities. The application must verify that expected commands are available instead of assuming an installation succeeded.

#### Build

Use an implementation workflow to inspect the codebase, understand the architecture, break the approved specification into manageable features, and implement one bounded feature at a time. The workflow should combine tests, debugging, code review, security checks, performance checks, and specification traceability.

#### Design & Animation

Use design references and suitable design/animation skills to improve UI quality without breaking existing behaviour or architecture. A proposed **Learning Studio** should provide an inbox for screenshots, design files, animations, short videos, and other references; Claude should classify and explain them, and the user should be able to review them in a viewer.

Design and motion work should follow the existing design system where possible, preserve accessibility and responsive behaviour, respect reduced-motion preferences, and measure animation performance where relevant.

#### Visual direction for the installable application

The application UI should take visual direction from the supplied references in [`design-references/`](design-references/):

- [`ui-reference-01-dark-dashboard.jpg`](design-references/ui-reference-01-dark-dashboard.jpg) — a dark navy workspace with persistent left navigation, a top-level utility bar, a central task/work area, and contextual cards.
- [`ui-reference-02-dark-knowledge-base.jpg`](design-references/ui-reference-02-dark-knowledge-base.jpg) — a dark knowledge/file management interface with a nested folder tree, search, folder cards, and a structured file list.
- [`ui-reference-03-light-cloud-dock.jpg`](design-references/ui-reference-03-light-cloud-dock.jpg) — a light cloud-file workspace with a dark/purple navigation rail, strong content hierarchy, recent files, and folder collections.

Use these images as design references, not exact screens to copy. The intended direction is a polished, desktop-first productivity workspace that feels organised, premium, and technically focused. Prefer a stable navigation rail/sidebar, a clear main work surface, contextual panels where useful, readable cards and tables, and an information hierarchy that makes complex workflows easy to scan. Learning Studio and project/document management should benefit from folder trees, searchable reference collections, file metadata, previews, and clear empty/loading/error states.

The initial visual theme should use deep navy or near-black surfaces with restrained blue-to-violet accents, subtle gradients, high-contrast typography, clear focus and selection states, and consistent iconography. Support a light theme or theme preference where practical, taking cues from the light reference. Do not overuse glow, blur, glass effects, gradients, or decorative charts at the expense of readability and performance. Reuse a central set of design tokens and components rather than styling each screen independently.

The references do not dictate the final brand identity, exact layout, copy, or feature set. Do not copy logos, product names, or proprietary details from the images. The application must remain responsive, keyboard-accessible, understandable at reduced motion, and usable when side panels are collapsed or the viewport is narrow. These references describe the installable platform's own UI; projects created inside it may have their own independent design systems.

#### Check & Review

Compare code with the approved plan, exercise user journeys in a real browser, run automated tests, conduct independent code reviews, simplify carefully, and report evidence and remaining risks. Defects should be reproduced and fixed with regression tests where appropriate. Required quality gates must block progression when they fail.

#### Ship & Deploy

Use a security and release workflow, intended as:

`code-review → security-review → tests → ship-check`

`ship-check` is a proposed custom workflow. It should verify release evidence, configuration, secrets handling, migrations, deployment settings, monitoring, health checks, approvals, and rollback readiness. Preparing a release and deploying to production are distinct actions; production changes require the appropriate authorisation.

### 4.2 Import and assessment modes

The Project Layer should support:

- **Create from scratch:** start with a concept and follow the project lifecycle.
- **Import and assess:** inspect an existing repository and connected services, identify what is handled in code versus external platforms, and produce an evidence-based assessment.
- **Focused assessment:** select a single assessment area and limit the scan to that scope.
- **Continue an existing project:** preserve its current stack, conventions, functionality, and deployment setup unless an approved change justifies otherwise.

The enterprise assessment should cover four groups:

- **Product:** overview, pitch deck, assessment, roadmap.
- **Operations:** analytics, performance, usage and cost, issues, database, vector database, deployments, file storage, domains, secrets, code, automation, and custom models.
- **Interfaces:** API, MCP, voice, email inbox, email outbox, scheduled jobs, and webhooks.
- **Management:** audit log, models and agents, data residency, users, and settings.

For each relevant capability, the application should report whether it is implemented in the repository, configured in an external service, partly present, absent, or not yet verified. It should not claim an external integration exists until access and evidence have been confirmed.

### 4.3 Iterative Layer

The Iterative Layer improves the application itself, rather than the projects being built with it.

Its improvement cycle is:

**Observe → Analyse → Identify → Prioritise → Propose → Implement → Verify → Deploy → Evaluate → Repeat**

It should use evidence such as errors, failed workflows, repeated manual intervention, user feedback, task completion, agent performance, tool usage, execution time, cost, resource consumption, and integration failures. It should maintain an improvement backlog containing the problem, supporting evidence, expected outcome, affected components, risk, approval status, verification plan, and measured result.

Approved improvements should go through the same Project Layer workflow as other software changes. Self-improvement must happen in an isolated branch, worktree, or development environment; preserve a known-good version; and have a recovery path. The Iterative Layer must not bypass permission boundaries, security controls, approvals, or production deployment gates.

#### External ecosystem monitoring

The Iterative Layer should monitor relevant official documentation, release notes, changelogs, plugin marketplaces, repositories, package registries, and trusted service sources for changes to Claude, Claude Code, models, installed plugins, skills, MCP servers, libraries, and integrations.

It should inventory current versions and sources where available; compare changes; assess compatibility, security, cost, and workflow impact; and recommend whether to adopt, test, retain, defer, replace, or remove a component. It must distinguish detecting an update from installing it. Significant changes should be tested in isolation and require the appropriate approval.

When version changes do not fully describe model behaviour, the system should use representative evaluations where practical. It should not assume a newer model or tool is automatically better.

#### Tool conflict detection and safe uninstallation

Because the development environment may accumulate many plugins, skills, local mods, hooks, MCP servers, command-line tools, and overlapping workflows, the application should include a **Tool Conflict and Cleanup Manager**. It should inventory installed tools, identify duplicate capabilities and compatibility conflicts, map tools to the workflows that depend on them, and explain which conflicts are confirmed versus suspected.

The manager should recommend the least disruptive resolution first: configure the tools to coexist, disable a conflicting tool, remove a duplicate integration, or uninstall a component when appropriate. It must prefer the tool's supported uninstall mechanism and should not blindly delete files, remove an entire environment, or uninstall shared runtimes or unrelated software. Before a destructive action, it should show a dry-run plan, identify affected tools and workflows, preserve restorable configuration where possible, and request approval at the required risk level. Afterward, it should verify the result and provide recovery instructions where supported.

The manager must distinguish tools installed by this application from tools installed independently by the user or another manager. If ownership, installation scope, or safe removal cannot be established, it should report the conflict and provide manual instructions rather than guessing. Conflict detection and cleanup are part of the Iterative Layer, while the Tool Registry remains the source of truth for installed tools, dependencies, permissions, and lifecycle status.

## 5. Learning and preference memory

A supporting learning capability should let the user teach the system preferences and improve recurring workflows without confusing those preferences with project requirements.

Potential capabilities include:

- `feedback`: proposes a taste or preference note for user approval before saving it.
- `learn-from-video`: extracts cited lessons from videos, transcripts, or PDFs and proposes system changes for approval.
- `learner` / `/learn-skills`: spots recurring work and proposes reusable skills.
- **Preferences and Vault:** store approved taste notes, project notes, decisions, and learning material in distinct scopes.
- `/mode tutor`, `/mode build`, `/mode do`, and `/mode review`: adjust the balance between teaching, implementation, execution, and critique, without overriding security requirements.
- Session wrap-up and notes: preserve decisions, progress, and unfinished work for later sessions.

Memory should be reviewable, scoped, de-duplicated, and editable. Temporary observations must not silently become permanent global rules.

## 6. Product principles

1. **Specification-driven:** trace work from the idea and approved requirements through implementation, tests, and release evidence.
2. **Evidence before claims:** distinguish verified behaviour from assumptions, proposals, and unverified integrations.
3. **Least complexity:** choose the simplest architecture, agent arrangement, and set of tools that meet the task.
4. **Human control:** approvals are required for consequential changes, production deployment, permission changes, and other protected operations.
5. **Safe self-improvement:** develop changes away from the running production version and preserve recovery options.
6. **Tool independence:** the product should provide capabilities through documented interfaces and adapters, not hard-code its identity to one plugin.
7. **Cost awareness:** track the cost and benefit of agent teams, background work, model calls, and integrations where data is available.
8. **Learning without uncontrolled mutation:** suggest system improvements, but apply meaningful changes through reviewed workflows.
9. **Security throughout:** permissions, secrets, data protection, and security checks apply in every phase.
10. **Graceful degradation:** if a plugin, MCP server, external provider, or model is unavailable, explain the limitation and provide a safe alternative where possible.

## 7. Measures of success

The product should eventually be able to measure:

- Percentage of requirements linked to implementation and verification evidence.
- Successful completion rate of key workflows.
- Number and severity of regressions introduced by changes.
- Time to identify, reproduce, and resolve defects.
- Accuracy of project/tool inventories and external integration assessments.
- Agent/tool usage, latency, retries, and cost per workflow where measurable.
- Rate of successful updates and frequency of update-related regressions.
- Whether iterative improvements produce their intended measurable outcomes.
- User approval/rejection rates for proposed improvements and preferences.

Targets and baselines must be established during implementation; this document does not claim that any target has already been achieved.

## 8. Open product decisions

The following decisions remain open and should be settled before architecture is fixed:

- Target operating systems and whether the application is desktop-first, web-first, or cross-platform.
- Preferred implementation stack and packaging/distribution method.
- Whether code execution and agents run locally, remotely, or in a hybrid model.
- Which data stays local and which can be sent to model providers or external integrations.
- Which integrations are essential for the first release.
- Whether team collaboration and multi-user administration are required in the first version.
- Which actions can be autonomous and which require confirmation.
- Initial budget, usage limits, and supported model providers.

These decisions are inputs to the system architecture, not assumptions to silently choose during implementation.
