# pi-factory

Pi Factory lets you develop and deploy isolated bundles of
[Pi](https://pi.dev) for specific purposes.

Use it when you want a named standalone Pi app with its own model/provider
config, prompts, extensions, state directory, and session directory, while still
using Pi's normal CLI, TUI, model picker, slash commands, and extension SDK.

Pi Factory does not replace Pi and does not manage local model servers by
default. App projects such as `localpi` decide how models are discovered or
started; Pi Factory resolves the app bundle and launches Pi with the right
config.

## Install

From npm:

```bash
npm install -g @osolmaz/pi-factory
```

During development:

```bash
npm install
npm run build
node dist/src/cli/main.js --help
```

## Create an App Bundle

```bash
pi-factory init my-app
```

That creates:

```text
my-app/
  pi-factory.toml
  prompts/system.md
  extensions/
```

Minimal `pi-factory.toml`:

```toml
id = "my-app"
name = "My App"
version = "0.1.0"
schema_version = 1
state_dir = "~/.local/state/my-app"
pi_command = ["npx", "-y", "@earendil-works/pi-coding-agent@latest"]
thinking = "medium"
tools = ["read", "bash"]
system_prompt = "prompts/system.md"

[provider]
id = "local-openai"
base_url = "http://127.0.0.1:1234/v1"
api = "openai-completions"

[model]
id = "auto"
context_window = 32768
max_tokens = 8192
reasoning = false
```

Add Pi extensions with normal Pi extension files:

```toml
[[extensions]]
path = "extensions/demo.ts"
append_system_prompt = "prompts/demo.md"
```

Paths are relative to the app bundle root unless absolute. `pi_command` is an argv array, not a shell string. Put environment values in `[env]` and use a script file when shell behavior is needed.

## Run

Inspect the resolved launch without starting Pi:

```bash
pi-factory plan --app-dir ./my-app
```

Validate a bundle:

```bash
pi-factory validate ./my-app
```

Launch Pi through the app bundle:

```bash
pi-factory run --app-dir ./my-app
```

Repository-focused apps can keep their bundle files separate from the working
directory used by Pi:

```bash
pi-factory run my-app --cwd /path/to/repository
```

The launch writes Pi-compatible runtime config under the app state directory,
then starts the configured Pi command with environment variables such as
`PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR`. Bundle resources still
resolve from the app root when `--cwd` selects another directory.

## Link and Install Apps

For local app bundles:

```bash
pi-factory link /path/to/my-app
pi-factory run my-app
```

For GitHub-hosted bundles:

```bash
pi-factory install owner/repo[/subdir...] --ref main --yes
pi-factory run my-app
```

There is no central registry. The app name comes from the installed bundle's
manifest `id`.

## Commands

```text
pi-factory init <app-id> [dir]
pi-factory validate <app-id|app-dir|app-file>
pi-factory plan <app-id>|--app-dir <dir>|--app-file <file>
pi-factory run <app-id>|--app-dir <dir>|--app-file <file>
pi-factory inspect <app-id>|--app-dir <dir>|--app-file <file>
pi-factory link <app-dir>
pi-factory install <owner>/<repo>[/subdir...] [--ref REF] [--yes]
pi-factory uninstall <app-id>
pi-factory list
```

## JavaScript API

```ts
import {
  createPiLaunchPlan,
  loadPiApp,
  manifestToDefinition,
  runPiApp,
  writePiRuntimeConfig
} from "@osolmaz/pi-factory";
```

Use the API when another launcher wants Pi Factory's app resolution and config
generation but owns its own model discovery or local runtime setup.
`createPiLaunchPlan` and `runPiApp` accept launch overrides for a target `cwd`,
Pi run mode, session, name, and initial messages.

## More

- [Specification](docs/spec.md)
- [Manifest reference](docs/manifest-v1.md)

## License

[MIT](LICENSE)
