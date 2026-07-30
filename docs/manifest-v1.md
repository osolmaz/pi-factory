# Pi App Manifest v1

Pi Factory app bundles are directories with a `pi-factory.toml` file at the root.

Required top-level fields:

- `id`: stable app id, using ASCII letters, digits, dot, colon, underscore, or hyphen
- `name`: display name
- `version`: app bundle version
- `schema_version`: must be `1`
- `state_dir`: app state directory
- `[provider]`: Pi provider configuration
- `[model]`: default model configuration

Common optional fields:

- `description`
- `platforms`
- `session_dir`
- `pi_command`
- `thinking`
- `tools`
- `system_prompt`
- `[env]`
- `[[extensions]]`
- `[[build]]`

Example:

```toml
id = "demo-agent"
name = "Demo Agent"
version = "0.1.0"
schema_version = 1
state_dir = "~/.local/state/demo-agent"
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

[env]
PI_OFFLINE = "1"
PI_TELEMETRY = "0"

[[extensions]]
path = "extensions/demo.ts"
append_system_prompt = "prompts/demo.md"
```

Paths are relative to the app bundle root unless absolute. `pi_command` is a
nonempty argv array. Pi Factory does not interpret shell syntax in it. Put
environment values in `[env]` and use a bundle script when shell behavior is
needed. Prompt files are loaded by Pi Factory and passed to Pi through Pi's
native prompt flags.
