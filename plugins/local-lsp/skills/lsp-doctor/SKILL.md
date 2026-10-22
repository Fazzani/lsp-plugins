---
name: lsp-doctor
description: Audit LSP installation, client configuration and semantic navigation for the current repository in Claude Code, Codex or GitHub Copilot CLI. Use when asked to check LSP health or diagnose missing code intelligence; report repo-specific findings without installing or changing configuration.
---

# LSP doctor

Diagnose the current repository and active agent, in the user's language. A binary
on PATH or a valid manifest does not prove that the agent can navigate code.
Keep the audit read-only. If the user also requests repairs, finish the diagnosis
first and apply only the authorized fixes; invoking this skill alone authorizes
no installation, configuration edit or client/plugin reload.

## Determine what this repository needs

Identify the repository/workspace root, active client and execution environment
(Windows, WSL, container, SSH or hosted). Paths, runtimes and servers must exist in
the environment where that client's adapter runs. Do not assume a Windows install
is accessible from WSL or a container.

Use a bounded file inventory with `rg --files --hidden`, excluding `.git`,
dependencies, caches and generated/build output. Inspect relevant manifests and
source directories, including distinct projects in a monorepo. Do not run package
scripts to discover languages. A lockfile, documentation snippet, dependency or
fixture alone does not make a stack required. Record ambiguous cases explicitly.

The plugin's supported mappings and launch arguments are maintained in
[lsp-config/claude.json](../../lsp-config/claude.json). Read that file rather than
copying a separate server catalog into this skill. Typical repository signals:

| Stack | Evidence in the selected project |
|---|---|
| C# | `.csproj`, `.sln`/`.slnx`, `.cs`; inspect `global.json` and target frameworks |
| TypeScript / JavaScript | `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs`; inspect package and TypeScript configuration |
| Python | `.py`, `.pyi`, `pyproject.toml`; inspect interpreter/environment requirements |
| Terraform | `.tf`, `.tfvars`; inspect required Terraform/provider versions |
| YAML | `.yaml`, `.yml`; identify the schema or CI platform when relevant |
| Dart / Flutter | `pubspec.yaml`, `.dart`; inspect SDK constraints |
| PHP | `composer.json`, `.php`, `.phtml`; inspect the PHP version and Composer autoload |

Report other source languages as well. An existing trusted integration may support
them; otherwise mark them `unsupported` by this plugin, not missing dependencies
that should automatically be installed. Check Razor separately from C#.

## Check installation and the effective client configuration

For the required stacks only, resolve configured commands with `Get-Command`
(PowerShell) or `command -v` (POSIX), including installed project-local tools when
appropriate. Check the relevant SDK/interpreter and repository version constraints.
Use documented non-serving version commands with a bounded timeout; never launch
`--stdio` or `serve` merely to obtain a version. An IDE extension is only evidence
of editor support, not an agent-accessible server.

Inspect the active client's loaded integration, not just this plugin's source:

- **Claude Code:** inspect enabled language plugins and the available native LSP
  tool. Resolve the installed manifest's `lspServers` path and validate it with
  `claude plugin validate <plugin-directory>` when the CLI is available.
- **GitHub Copilot CLI:** use `copilot lsp list --json`, then inspect the effective
  entries and their source plugins/project/user configuration. The plugin uses
  `.github/plugin/plugin.json` and `lsp-config/servers.json`. Copilot in VS Code
  uses the editor's language integrations; identify that environment separately.
- **Codex:** inspect the loaded `local-lsp` MCP entry and whether semantic tools
  are available in this session. The manifest is `.codex-plugin/plugin.json`;
  `local-lsp-mcp` must resolve, with an installed `lspi` on PATH, in
  `~/.local/bin`, or at `LOCAL_LSP_LSPI`. Its workspace is the launch working
  directory; a bridge rooted at a different repository is unhealthy.

Do not print whole MCP/configuration dumps: they may contain credentials. For
example, expose only the relevant non-secret Codex fields:

```powershell
codex mcp list --json | ConvertFrom-Json |
  Where-Object name -eq 'local-lsp' |
  Select-Object name, enabled,
    @{Name='command'; Expression={$_.transport.command}},
    @{Name='cwd'; Expression={$_.transport.cwd}}
```

From the target repository, `local-lsp-mcp --doctor` can check executable
resolution for this plugin. It reports all configured language IDs: filter its
`servers[].preflight` and `failures` to the repo's required mappings. Its generic
preflight does **not** initialize servers, check every SDK or prove semantic health.
Do not flag unrelated missing servers as repository blockers.

Check disabled plugins, stale installed copies, PATH inherited before installation,
wrong working directory, launch arguments, extension/language IDs and overlapping
servers for the same extension. Propose the smallest fix with a precise location;
do not edit plugin caches. Do not execute arbitrary launch commands discovered in
repository configuration. Prefer the trusted integration already active.

Claude Code and Codex start Dart through `scripts/lsp-share.mjs`, which shares one
server between sessions (see the plugin README). Its configured command is `node`:
resolve `dart` instead, and compare that SDK with the project's (for example the
`flutterRoot` in `.dart_tool/package_config.json`). For a slow or failing Dart
server, read the daemon log in the share state directory (`*.log`) before retrying.

## Verify real semantic navigation

Use the active agent's available LSP/MCP tool on an existing symbol in each required
stack/project with a distinct configuration. Request a definition or references
and verify the returned file and position against the source. For the lspi bridge,
`find_definition_at` / `find_references_at` inputs are **1-based**, while returned
LSP ranges are **0-based**. Native tools may use different conventions.

If initialization fails, inspect the specific error and relevant configuration;
retry only after identifying a reason. Do not install packages, restore/build a
project, run `terraform init`, modify files, or download schemas to make the audit
pass. A bounded diagnostics request can supplement navigation, but empty results,
process startup, editor IntelliSense and CLI preflight alone never mean `ready`.

For YAML without a navigable symbol, report configuration/diagnostics evidence
and leave semantic navigation unverified. Do not infer Razor support from a C#
check, or full Azure Pipelines support from generic YAML validation.

If tools are unavailable in the current session, report `configured_unverified`
or `client_bridge_missing` as appropriate, with a concrete next step. A standalone
protocol check or this plugin's synthetic fixture suite is supplementary evidence,
not proof that this agent session is connected to this repository. Audit other
clients only if requested; never infer their runtime health from the active client.

## Report

Lead with the repository, client/environment and whether required stacks have
blockers. Use one compact table:

| Stack / project | Server and resolved path | Client integration | Status | Evidence / next action |
|---|---|---|---|---|

Statuses: `ready` (verified semantic result in this agent/repo), `server_missing`,
`client_bridge_missing`, `unhealthy` (configured but a demonstrated check fails),
`configured_unverified`, `editor_only`, `unsupported`, or `not_needed`.

Distinguish missing installation, configuration failure, project prerequisite and
session reload. State checks not performed and their impact. End with the smallest
concrete corrective actions, if any, and confirm whether files/packages changed.
Never claim everything is healthy when required semantic checks remain unverified.
