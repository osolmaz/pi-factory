# Pi App Manifest v1

Pi Factory app bundles contain `pi-factory.toml` at the bundle root.

## Required fields

- `id`: stable app ID with ASCII letters, digits, dot, colon, underscore, or hyphen
- `name`: display name
- `version`: app version
- `schema_version`: must be `1`
- `state_dir`: app state directory
- `[provider]`: a custom provider or a Pi provider reference
- `[model]`: the app's default model

Common optional fields are:

- `description`
- `platforms`
- `session_dir`
- `pi_command`
- `thinking`
- `tools`
- `system_prompt`
- `[env]`
- `[inherit]`
- `[[inherit.packages]]`
- `[[extensions]]`
- `[[build]]`

## Custom provider example

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

A custom provider may omit `source` or set `source = "custom"`. It must define `base_url`. It must
not appear in `inherit.providers`.

## Pi provider example

A Pi provider uses the implementation and model data selected from the user's main Pi profile.

```toml
[provider]
id = "openai-codex"
source = "pi"

[model]
id = "gpt-5.6-terra"
reasoning = true

[inherit]
providers = ["openai-codex"]
```

Every provider with `source = "pi"` must appear once in `inherit.providers`. Pi Factory uses the
main profile's provider implementation, model data, and existing authentication state. The app still
selects its own provider and model. Pi Factory does not write the provider or model selection back to
the main Pi profile.

Credentials are not inherited as manifest values. They stay in the main profile's `auth.json` or
the selected provider's existing store. Sessions also stay outside the inheritance contract.

## Package resources

An app can select enabled resources from packages configured in the user's main Pi profile.

```toml
[inherit]
providers = ["openai-codex"]

[[inherit.packages]]
source = "example-package"
extensions = ["extensions/example.ts"]
skills = ["skills/example"]
prompt_templates = ["prompts/example.md"]
themes = ["themes/example.json"]
```

`source` must equal the package source in Pi settings. The resource arrays use Pi's package filters.
Each filter must match an enabled user-profile resource. Project packages are not eligible.

Missing arrays select nothing. Empty, duplicate, disabled, missing, or ambiguous selections are
errors. Package resolution does not install missing packages and does not execute extension code.

## Isolation

Selective inheritance denies ambient resources by default. Pi Factory disables automatic discovery
of extensions, skills, prompt templates, themes, and context files. It then passes only app-owned
paths and selected inherited paths through Pi's existing explicit resource interfaces.

The app keeps ownership of:

- its prompt and appended prompts;
- tools and commands;
- sessions and session directory;
- repository policy and context files;
- application lifecycle and submission behavior.

The broad `profile: ambient` option is not a fallback for selective inheritance.

## Paths and commands

Paths are relative to the app bundle root unless they are absolute. `pi_command` is a nonempty argv
array. Pi Factory does not interpret shell syntax in it. Prefix bundle-relative command paths with
`./`, put environment values in `[env]`, and use a bundle script when shell behavior is needed.

Pi Factory loads prompt files and passes them to Pi through native prompt flags.

## Provider package declaration

Pi does not yet expose providers as a package resource. A package that supplies an executable
provider override can declare it in `package.json`:

```json
{
  "piFactory": {
    "providers": [
      {
        "version": 1,
        "id": "openai-codex",
        "module": "./provider-module.ts",
        "extension": "./index.ts"
      }
    ]
  }
}
```

The named extension must be enabled in the main Pi profile. The module must stay inside the installed
package root and return one complete Pi `Provider` with the declared ID. A selected declaration that
fails to load or construct the provider is a final error. Pi Factory does not retry with Pi's
built-in provider.

See the [selective Pi profile inheritance plan](2026-08-21-selective-profile-inheritance-plan.md)
for the full provider module, runtime, isolation, and rollout requirements.
