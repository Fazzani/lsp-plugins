# local-lsp

Local language servers for **Claude Code**, **Codex** and **GitHub Copilot CLI**.
Claude and Copilot use native LSP integration. Codex uses the local
[lspi 0.2.0 MCP bridge](https://github.com/Latias94/lspi/releases/tag/v0.2.0)
(MIT OR Apache-2.0), with read-only navigation and diagnostics tools.

## Language servers

Reuse installed servers. Commands must be on the PATH of the client process;
environment changes require restarting desktop clients.

| Language | Command | Version checked on Windows |
|---|---|---|
| C# | `roslyn-language-server --stdio --autoLoadProjects` | `5.12.0-1.26475.2` (existing prerelease; .NET SDK required) |
| Terraform | `terraform-ls serve` | `0.39.0` |
| TypeScript / JavaScript / JSX / TSX | `typescript-language-server --stdio` | `6.0.2`, with TypeScript `5.9.3` |
| Python | `pyright-langserver --stdio` | `pyright@1.1.414` |
| YAML | `yaml-language-server --stdio` | `1.25.0` |
| Dart / Flutter | `dart language-server --protocol=lsp`, shared between sessions ([below](#shared-dart-server)) | Dart SDK `3.13.4` |
| PHP | `phpantom_lsp` (stdio) | [PHPantom](https://github.com/PHPantom-dev/phpantom_lsp) `0.11.1`, not yet run here |

The Dart server is bundled with the SDK. For the two previously missing servers:

```powershell
npm install --global --ignore-scripts pyright@1.1.414 yaml-language-server@1.25.0
```

For PHP, download `phpantom_lsp-x86_64-pc-windows-msvc.zip` from the
[PHPantom 0.11.1 release](https://github.com/PHPantom-dev/phpantom_lsp/releases/tag/0.11.1),
verify it, extract `phpantom_lsp.exe` to a directory on PATH. Homebrew users can run
`brew install phpantom-lsp`. Blade templates (`.blade.php`) are not mapped.

Razor (`.razor`, `.cshtml`) mappings are retained but semantic support is
**unverified**; a C# definition check does not validate Razor. YAML navigation
does not fully validate Azure Pipelines template expressions. Terraform provider
schemas require the project's normal initialization; this plugin does not run
`terraform init`.

## Install

Run these commands from this plugin directory. The marketplace root is `../..`.

### Claude Code

```powershell
claude plugin marketplace add ../..
claude plugin install local-lsp@local-lsp
claude plugin validate .
```

Reload plugins or start a new session. Avoid overlapping language plugins: when
this plugin handles TypeScript, disable `typescript-lsp@claude-plugins-official`
if it was already enabled.

### GitHub Copilot CLI

```powershell
copilot plugin marketplace add ../..
copilot plugin install local-lsp@local-lsp
copilot lsp list --json
```

Restart the session, then use `/lsp` to inspect and test the servers. This targets
**Copilot CLI**; Copilot in VS Code uses the editor's own language integrations.

### Codex

Requires Node.js 20+ and `lspi` 0.2.0. Install the bridge from its pinned upstream
release, or build with `cargo install lspi --version 0.2.0 --locked`.
Put the executable on PATH or at `~/.local/bin/lspi` (`lspi.exe` on Windows).
`LOCAL_LSP_LSPI` may specify another installed executable.

For Windows x64, the upstream `lspi-x86_64-pc-windows-msvc.zip` archive SHA-256 is
`a48c4c192e2d1d3f1f5e47a54da624bf945b448f44320931077b03bce39b6a94`.
Extract the executable after verifying the checksum; no remote installer script
is required. The bridge is installed separately and is not bundled in the plugin.

```powershell
npm link --ignore-scripts
codex plugin marketplace add ../..
codex plugin add local-lsp@local-lsp
local-lsp-mcp --doctor
```

The npm link registers the `local-lsp-mcp` executable from this checkout, so keep
the checkout in place and repeat the link if it moves. Restart Codex and inspect
`/mcp`. Start Codex from the project to inspect: the launcher inherits its working
directory as the workspace root, not the plugin directory.

The runtime converts the native configuration into a temporary lspi configuration
and starts language servers on demand. It performs no downloads at startup,
does not read project-supplied lspi launch commands, and stops its own process tree
on MCP disconnection. MCP position inputs are **1-based**; returned LSP ranges are
**0-based**. An empty diagnostic result is not a substitute for project tests.

## LSP doctor skill

The bundled [lsp-doctor](skills/lsp-doctor/SKILL.md) skill audits the current
repository in Claude Code, Codex or Copilot CLI. Ask: **"Use lsp-doctor to check
whether the LSPs for this repository are installed, configured and working."**
In Codex, it can also be invoked as `$lsp-doctor`.

It detects the repository's stacks, checks only relevant servers and runtimes,
inspects the active client's configuration and verifies definitions/references
on real project symbols when semantic tools are available. It reports missing
installation, broken configuration and unverified session connectivity separately.
The audit does not install packages or change repository/client configuration.

After updating this plugin, reload it or start a new session to discover the skill.

## LSP-first hooks (Claude Code)

Claude Code defers the `LSP` tool and its system prompt steers agents to `Grep`, so
an instruction alone rarely changes the first tool chosen. The plugin ships three hooks
([hooks/hooks.json](hooks/hooks.json)); Codex and Copilot CLI do not use them. Both
consider only servers found on PATH and do nothing when none is installed.

- **SessionStart** injects a short reminder: load the tool with
  `ToolSearch select:LSP`, locate the symbol with `workspaceSymbol`, then use
  position-based operations (`findReferences`, `goToDefinition`, …) and trust them.
- **PreToolUse on Grep, Bash and PowerShell** denies a code-symbol lookup in covered
  files (camelCase, PascalCase compounds, snake_case, dotted names, `class X`, `X\(`,
  `: IX`, or an alternation of those) and names the LSP calls to make instead. In
  shell commands it checks each `grep`, `egrep`, `fgrep`, `rg` and `git grep`
  invocation, including inside `&&`, `;` and pipelines. A grep reading piped output
  without a path is ignored. Literal text, real regexes, `-i` searches,
  `SCREAMING_SNAKE`, `TODO`, non-code globs or paths, `docs/`, YAML and Razor pass.
  Repeating a denied search does not unlock it. The lookup is allowed once the
  session has called `workspaceSymbol` with a query containing that name, so a text
  search for strings or comments stays possible after the LSP lookup. State lives in
  `<tmp>/local-lsp-guard/<session_id>.json`. Any guard error allows the call.
  `Select-String` is not checked: it is case-insensitive by default, like `-i`.
- **PostToolUse on LSP** records the `workspaceSymbol` query for the guard, then
  detects the empty "not finished indexing" answer a cold server gives to its first
  request and tells the agent to retry the identical call instead of falling back
  to Grep.

## Shared Dart server

`dart language-server` analyzes the whole project before it answers, so on a large
Flutter project a fresh server can take more than a minute on its first request.
Claude Code and Codex therefore start Dart through
[scripts/lsp-share.mjs](scripts/lsp-share.mjs), which keeps one server per user,
project and client type and shares it between sessions. The first session waits for
the analysis; later sessions and forks connect to the warm server.

- A detached daemon owns the server. On Windows it listens on a named pipe whose
  access list it restricts to the current user, through a short PowerShell call at
  startup; on Linux and macOS, on a Unix socket in a `0700` directory. A socket path
  longer than `sun_path` (103 bytes) moves to `$TMPDIR/local-lsp-<uid>/` or
  `/tmp/local-lsp-<uid>/` under a hashed name. Sessions authenticate with a token
  stored in the state directory; a connection that sends no valid token within 5 s
  is closed.
- The daemon turns off `dynamicRegistration` in the capabilities it forwards, so the
  server declares all its capabilities in the `initialize` result, which the daemon
  caches for every session. It routes each session's requests and diagnostics to
  that session, keeps a document open while any session has it open, and gives the
  last diagnostics of a document to a session that opens it later. A session's
  `shutdown` disconnects only that session.
- After 30 minutes without a session, the daemon stops the server and exits.
  `LOCAL_LSP_SHARE_IDLE_MS` sets another delay. A server that does not answer
  `initialize` within 60 s (`LOCAL_LSP_SHARE_INIT_TIMEOUT_MS`) fails the waiting
  sessions and stops the daemon, so the next session starts afresh.
- Tokens and the daemon log, which includes the server's stderr, live in
  `%LOCALAPPDATA%\local-lsp\share` on Windows and `~/.cache/local-lsp/share`
  elsewhere. `LOCAL_LSP_SHARE_DIR` sets another directory.
- `LOCAL_LSP_SHARE=off` gives each session its own server, as before. To stop a
  shared server early, end its `node … lsp-share.mjs --daemon` process.
- Dart requests wait up to 180 s (`requestTimeout`) instead of Claude Code's 60 s
  default, which covers the first analysis. Claude Code rejects unknown keys in
  `lspServers`, so this plugin needs Claude Code `2.1.288` or later.
- The server is the `dart` found first on PATH. Flutter's `bin\dart.bat` is replaced
  by the `dart.exe` of its SDK cache, so no `cmd.exe` sits between the daemon and the
  server. Put the project's SDK first
  (`<flutter>/bin` or `<flutter>/bin/cache/dart-sdk/bin`): with another SDK, the
  analysis may differ from the editor's and cannot reuse its cache. Restart the
  client after changing PATH.
- Copilot CLI starts `dart language-server` directly, without sharing.

Not runtime-tested: a client that kills every process of its session job could also
end the daemon. Each session would then start its own server again.

## Configuration and verification

`lsp-config/claude.json` is the source of truth. After changing its mappings, run:

```powershell
npm run sync
npm test
node scripts/verify-semantic.mjs
```

`sync` generates Copilot's `lsp-config/servers.json`, with shared servers replaced
by their direct command; tests reject stale mappings.
The Codex launcher reads the source directly. Claude's manifest explicitly
references the source because a root `.lsp.json` is also discovered by Copilot,
which expects a different JSON shape. Separate manifests keep native clients from
loading a duplicate MCP adapter.

The semantic check creates a temporary workspace, tests actual definitions for
C#, Terraform, TypeScript, JavaScript, Python, YAML anchors, Dart and PHP, and
references for all except YAML. It requires all seven installed servers and a .NET 10 SDK for
its C# fixture. It also checks that MCP offers no rename tools. Configuration
validation alone does not prove a semantic connection in a running client.

Validated client versions: Claude Code `2.1.296`, Codex CLI `0.162.1`, Copilot CLI
`1.0.95`. Other platforms have not been runtime-tested.

Format references: [Claude LSP plugins](https://code.claude.com/docs/en/plugins/components#lsp-servers),
[Copilot CLI plugins](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference),
[Codex plugins](https://developers.openai.com/plugins/build/plugins).
