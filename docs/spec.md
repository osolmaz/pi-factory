# Pi Factory Specification

Status: draft
Date: 2026-06-24

## Purpose

Pi Factory defines a small convention for building standalone applications on top
of Pi.

The core idea:

```text
Pi app directory -> pi-factory.toml -> resolved bundle -> generated Pi config -> native Pi launch
```

Pi Factory should make it easy to say "launch the `localpager` Pi app" and have
the right model, provider, config directory, extensions, prompts, tools, and
session directory resolved automatically.

It must not replace Pi. It should compile app-specific configuration into the
mechanisms Pi already supports.

## Goals

- Define a manifest format for named Pi applications.
- Install and link app bundle directories without a central registry.
- Load app configuration from linked, installed, or explicit app directories.
- Support reusable extension packs.
- Generate Pi-compatible runtime config files.
- Launch Pi through its native CLI and TUI.
- Preserve Pi's extension SDK as the only extension mechanism.
- Make standalone Pi apps reproducible, testable, and easy to package.
- Keep product-specific behavior outside the shared launcher layer.

## Non-Goals

- Do not create a new TUI.
- Do not create a second extension API.
- Do not wrap or bypass Pi's native model selector, commands, status display, or
  token display.
- Do not own local model server lifecycle by default.
- Do not merge applications such as `localpi` and `localpager-agent` into one
  product.
- Do not turn app manifests into arbitrary code execution.
- Do not maintain a central app registry or hardcoded alias list. Install
  arguments are source locators, and app names come from manifests.

## Concepts

### App Bundle

An app bundle is a directory containing a `pi-factory.toml` manifest and the files it
references.

Examples:

- `localpi`
- `localpager`
- `repo-agent`
- `demo-wall`

Example directory:

```text
localpager-app/
  pi-factory.toml
  prompts/system.md
  prompts/reposhell.md
  extensions/reposhell.ts
  extensions/final-schema.ts
```

The manifest answers:

- What is the app called?
- Which provider and model should Pi use?
- Which runtime config files should be generated?
- Which extensions should be loaded?
- Which tools should be available?
- Which system prompts should be appended?
- Where should sessions and state live?

### Extension Pack

An extension pack is a reusable group of Pi extensions and related prompt text.

It is not a new extension system. Each extension pack resolves to normal Pi
arguments such as:

```bash
--extension ./extensions/reposhell.ts
--append-system-prompt ./prompts/reposhell.md
```

Extension packs are only a packaging and naming convention.

### Runtime Config

Runtime config is generated Pi configuration for a resolved app bundle.

The first target files are:

- `models.json`
- `settings.json`

The generated config directory is passed to Pi through `PI_CODING_AGENT_DIR`.

### Launch Plan

A launch plan is the fully resolved Pi invocation:

- command
- args
- environment
- working directory
- session directory

The launch plan should be inspectable before execution.

## Manifest

The manifest file is `pi-factory.toml` at the app bundle root.

Example:

```toml
id = "localpager"
name = "LocalPager"
version = "0.1.0"
schema_version = 1
description = "LocalPager as a standalone Pi app"
platforms = ["linux", "macos", "windows"]

state_dir = "~/.local/state/localpager"
session_dir = "~/.local/state/localpager/sessions"
pi_command = ["npx", "-y", "@earendil-works/pi-coding-agent@latest"]
thinking = "medium"
tools = ["bash", "final_json"]
system_prompt = "prompts/system.md"

[provider]
id = "local-openai"
base_url = "http://127.0.0.1:1234/v1"
api = "openai-completions"

[model]
id = "auto"
context_window = 32768
max_tokens = 8192
reasoning = true
thinking_format = "qwen-chat-template"

[env]
PI_OFFLINE = "1"
PI_TELEMETRY = "0"
PI_SKIP_VERSION_CHECK = "1"

[[extensions]]
path = "extensions/reposhell.ts"
append_system_prompt = "prompts/reposhell.md"

[[extensions]]
path = "extensions/final-schema.ts"
append_system_prompt = "prompts/final-schema.md"
```

Top-level `id`, `name`, `version`, and `schema_version` are required. App ids
may use ASCII letters, digits, dot, colon, underscore, and hyphen.

Paths inside the manifest are relative to the app bundle root unless absolute.

Apps may reference Pi's provider catalog instead of defining a custom endpoint:

```toml
[provider]
id = "openai-codex"
source = "pi"

[model]
id = "gpt-5.6-terra"
reasoning = true
```

Pi Factory omits catalog providers from generated `models.json`. The app's isolated profile owns authentication by default. A local auth grant can point the app at regular Pi's credential file without changing its generated settings or models.

## Install and Link

Pi Factory should use a Herdr-style source model.

For local development:

```bash
pi-factory link /path/to/app-bundle
```

For managed installs:

```bash
pi-factory install owner/repo[/subdir...] [--ref REF] [--yes]
```

`install` accepts a source locator, not an app alias. It clones the GitHub
source, finds `pi-factory.toml` at the selected root, previews the app in
interactive terminals, runs supported build commands, copies the checkout into
Pi Factory-managed app storage, and registers the app from its manifest id.

There is no central registry. `localpi` is recognized only if a linked or
installed app bundle declares `id = "localpi"`.

Pi Factory should persist a local installed-app index containing:

- app id
- name
- version
- manifest path
- app root
- enabled flag
- source kind
- source owner/repo/subdir/ref/commit for managed GitHub installs
- install timestamp
- warnings

The index is local state, not a registry. If an app manifest becomes unreadable,
the index entry should remain visible with a warning so users can repair or
unlink it.

## Discovery

Pi Factory should search for app bundles in deterministic order:

1. Explicit `--app-file <path>` or `--app-dir <path>`.
2. Project-local `.pi/apps/<app-id>/pi-factory.toml`.
3. Linked apps from the local installed-app index.
4. Managed installs from the local installed-app index.

An explicit path always wins. Ambiguous app names should fail with a structured
error listing every matching path.

## Resolution

Resolution turns a manifest into a launch plan.

Resolution steps:

1. Load the manifest.
2. Validate required fields.
3. Expand `~`, environment variables, and relative paths.
4. Resolve extension packs into Pi extension arguments.
5. Resolve prompt files into `--system-prompt` or `--append-system-prompt`
   arguments.
6. Generate Pi runtime config files.
7. Build the native Pi command, args, and environment.
8. Return an inspectable launch plan.

Resolution must be deterministic. The same manifest and environment should
produce the same launch plan.

## Generated Pi Config

For an OpenAI-compatible local provider, generated `models.json` should describe
the provider and model in Pi's expected format.

Generated `settings.json` should define:

- default provider
- default model
- default thinking level
- telemetry preference
- startup quietness
- compaction policy

Generated files should live under the app state directory, for example:

```text
~/.local/state/localpager/pi-config-runtime/models.json
~/.local/state/localpager/pi-config-runtime/settings.json
```

The generated directory should be passed as:

```bash
PI_CODING_AGENT_DIR=~/.local/state/localpager/pi-config-runtime
```

## Launching

Pi Factory launches the real Pi command. It should not emulate Pi behavior.

Example resolved command:

```bash
PI_CODING_AGENT_DIR=~/.local/state/localpager/pi-config-runtime \
PI_CODING_AGENT_SESSION_DIR=~/.local/state/localpager/sessions \
PI_OFFLINE=1 \
PI_TELEMETRY=0 \
PI_SKIP_VERSION_CHECK=1 \
npx -y @earendil-works/pi-coding-agent@latest \
  --provider local-openai \
  --model auto \
  --thinking medium \
  --extension ./extensions/reposhell.ts \
  --append-system-prompt ./prompts/reposhell.md \
  --tools bash,final_json
```

Interactive launches should preserve Pi's native TUI.

Print or structured modes may add Pi flags, but must still use Pi's existing
CLI behavior. Library callers may override provider, model, thinking level, and session behavior for one launch. Native Pi commands such as authentication and model listing use the generated app profile through command plans. When a local auth grant exists, command and app launch plans add Pi's `--auth-file` option automatically.

## API Shape

The first library API should stay small:

```ts
type PiAppManifest = unknown;

type PiLaunchPlan = {
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd?: string;
};

async function loadPiApp(input: {
  app?: string;
  appFile?: string;
  appDir?: string;
  searchDirs?: readonly string[];
}): Promise<PiAppManifest>;

async function resolvePiApp(manifest: PiAppManifest): Promise<PiLaunchPlan>;

async function writePiRuntimeConfig(manifest: PiAppManifest): Promise<{
  configDir: string;
  modelsPath?: string;
  settingsPath?: string;
}>;

async function runPiApp(plan: PiLaunchPlan): Promise<number>;
```

The implementation can add narrower typed interfaces once the manifest stabilizes.

## CLI Shape

The CLI should support:

```bash
pi-factory run localpager
pi-factory plan localpager
pi-factory validate ./localpager-app
pi-factory init localpager
pi-factory link /path/to/localpager-app
pi-factory install osolmaz/localpi/pi-factory
pi-factory uninstall localpager
pi-factory list
```

`plan` should print the resolved launch plan without starting Pi.

`run` should start Pi with the native TUI unless the resolved app explicitly uses
Pi print mode.

## Implementation Plan

Build Pi Factory as one coherent end-to-end implementation, not as staged MVP
phases. The first complete implementation should include the core library, CLI,
manifest schema, examples, and tests together so the conventions are proven as a
working standalone Pi app system.

The implementation should deliver:

- A TypeScript package named `pi-factory`.
- A CLI binary named `pi-factory`.
- A versioned TOML manifest type for `schema_version = 1`.
- Manifest loading from explicit files, explicit app directories, project-local
  app directories, linked apps, and managed installs.
- Herdr-style `install owner/repo[/subdir...]`, `link /path`, `uninstall`, and
  `list` commands.
- Managed GitHub checkout storage with source metadata and replacement safety.
- A local installed-app index with warning-preserving reload behavior.
- Deterministic app discovery with clear structured errors for missing or
  ambiguous app names.
- Manifest validation with actionable field-level error messages.
- Path expansion for `~`, environment variables, and paths relative to the
  manifest file.
- Extension pack resolution to native Pi `--extension`, `--system-prompt`, and
  `--append-system-prompt` arguments.
- Generated Pi runtime config for `models.json` and `settings.json`.
- Inspectable launch plans that include command, args, env, cwd, generated
  files, selected app, and warnings.
- Native Pi process launching with inherited stdio, signal forwarding, and no
  custom TUI.
- CLI commands for `run`, `plan`, `validate`, `init`, `inspect`, `link`,
  `install`, `uninstall`, and `list`.
- Example app bundles for `localpi`, `localpager-agent`, and a minimal demo
  app.
- A documented manifest schema in `docs/manifest-v1.md`.
- A documented manifest reference suitable for editor/tool integration.
- Unit tests for manifest loading, validation, path resolution, config
  generation, extension argument ordering, launch-plan generation, installed-app
  index persistence, and install/link resolution.
- Integration tests using fake Pi commands and temporary directories.

The implementation is complete only when a user can run:

```bash
pi-factory init demo-agent
pi-factory validate demo-agent
pi-factory link demo-agent
pi-factory plan demo-agent
pi-factory run demo-agent
```

and `run` launches the real Pi CLI with Pi's native TUI and the app's resolved
configuration.

The implementation should keep the boundary strict:

- Pi Factory owns app bundle resolution and launch preparation.
- Pi owns the runtime, TUI, command system, model selector, session behavior, and
  extension SDK.
- App bundle projects own their domain-specific extensions, prompts, schemas,
  tools, and model/runtime discovery.

## Relationship To Existing Projects

### localpi

`localpi` should continue owning local model runtime selection and managed
`llama-server` behavior.

Pi Factory can replace the generic Pi config and launch-plan wiring, but should
not absorb runtime management.

### localpager-agent

`localpager-agent` should continue owning structured output, repo shell behavior,
prompt templating, and sampling controls.

Pi Factory can replace common config generation and launch-plan construction.

## Testing

Core tests should cover:

- manifest loading and search order
- path expansion
- validation failures
- generated `models.json`
- generated `settings.json`
- extension argument ordering
- launch-plan generation
- spawn behavior and signal forwarding

Tests should use fake Pi commands and temporary directories. They should not call
real model providers.

## Open Questions

- Should v1 use TOML only, or should generated JSON manifests be supported later
  for tool-generated app bundles?
- Should extension packs be inline TOML tables only, or separately named
  manifests?
- Should `systemPrompt` accept arrays, or should only `appendSystemPrompt` be
  repeatable?
- Should provider/model discovery remain app-specific, or should Pi Factory
  define provider discovery hooks later?
- Should app bundles support inheritance, or should composition happen through
  extension packs only?
- Should managed installs support npm package specs later, or should v1 stay
  GitHub-directory only like Herdr plugin install?
