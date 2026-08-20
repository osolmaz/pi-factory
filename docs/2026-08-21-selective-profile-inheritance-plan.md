---
title: Selective Pi profile inheritance plan
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-21
tags: [pi, profiles, providers, packages]
---

# Selective Pi profile inheritance plan

## Goal

Let a pi-factory app use selected resources from the user's main Pi profile while all other profile
resources stay isolated. Selection is explicit and denies everything else by default.

Pi Reviewer is the first user. It must use the main profile's `openai-codex` provider implementation,
model data, authentication, and multi-account routing. Pi Reviewer still chooses its own provider and
model for each run. It must not change the provider or model selected in normal Pi.

This plan covers three repositories:

- `osolmaz/pi-factory` owns selection, package resolution, runtime construction, and run lifetime.
- `osolmaz/onurpi` owns the Codex provider implementation, account policy, and credential vault.
- `osolmaz/pi-reviewer` owns review policy, model choice, tools, prompts, sessions, and submission.

## Selected design

pi-factory adds one `inherit` section to manifest version 1. The app selects providers by provider ID
and package resources by the package source and Pi resource filters.

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

A missing list selects nothing. Credentials and sessions are not entries in `inherit`.

- Model data follows the selected provider and the main profile's `models.json`.
- The app selects its provider and model without writing the main profile's settings.
- Credentials stay in the main profile's `auth.json` or the provider's existing store.
- Sessions, application prompts, tools, commands, policy, and lifecycle stay with the app.

pi-factory uses Pi's public `SettingsManager`, `DefaultPackageManager`, `DefaultResourceLoader`,
`ModelRuntime`, provider registration, and explicit resource flags.

## Resource selection

pi-factory reads configured user packages from the main profile with project trust disabled. It does
not install or repair a missing package while resolving inheritance.

Each package selection uses the exact source string from Pi settings. pi-factory applies Pi's
resource filters and returns only enabled paths that match the request. A missing, disabled,
duplicate, or ambiguous selection is an error.

Package resolution reads metadata. It does not execute extension code. pi-factory loads executable
code only after it has selected an exact extension or provider module.

For SDK apps, `DefaultResourceLoader` uses the app's agent directory. Automatic ambient discovery and
context-file loading stay disabled. Selected package paths are passed as additional extension, skill,
prompt template, or theme paths.

For normal Pi launches, pi-factory passes these flags before adding exact selected paths:

```text
--no-extensions
--no-skills
--no-prompt-templates
--no-themes
--no-context-files
--no-approve
```

The selected paths then use Pi's existing `--extension`, `--skill`, `--prompt-template`, and `--theme`
flags. The app's prompt, tools, command arguments, and session directory remain unchanged.

The broad `profile: ambient` option is removed as an inheritance path. It is not kept as a fallback.

## Provider declaration

Pi does not yet expose providers as a package resource. pi-factory therefore defines one small,
versioned package declaration until Pi provides that public feature.

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

The declaration names:

- the contract version;
- the provider ID;
- the provider module;
- the normal Pi extension whose enabled state activates the provider.

pi-factory reads bounded `package.json` files from packages already configured in the user profile.
It checks that the activation extension is enabled, resolves real paths inside the installed package
root, and requires one matching provider declaration.

A provider with no enabled package declaration uses Pi's built-in provider. If pi-factory selects an
enabled declaration and its module fails to load or construct the provider, the error is final. Pi
Factory does not retry with the built-in provider. Duplicate enabled declarations are errors.

## Provider module

A provider module exports contract version 1 and a `createProvider` function. pi-factory gives it:

- the selected provider ID;
- the main agent directory;
- the current built-in provider when one exists;
- an abort signal.

The function returns one complete Pi `Provider` with the selected ID. It can also return `startRun`,
`finishRun`, and `close` functions.

The module does not receive application tools, prompts, commands, sessions, repository policy,
`ExtensionAPI`, or credential values. It can read its existing provider-owned state under the main
agent directory.

Each runtime gets new provider state. Two concurrent apps may share the provider's existing locked
credential store, but they do not share in-memory run state.

The provider module also has a default Pi extension export for normal Pi launches through an explicit
`--extension` path. That export registers only the provider and its lifecycle. A package's normal Pi
extension can add user commands separately.

## SDK runtime

pi-factory adds a public runtime API that accepts:

- the app definition;
- the main and app agent directories;
- the working directory;
- the selected provider and model IDs;
- app-owned resource-loader options;
- an abort signal.

The runtime creation order is fixed:

1. Resolve the explicit inheritance selection.
2. Create `ModelRuntime` with the main profile's `auth.json`, `models.json`, and model store.
3. Get the built-in provider when it exists.
4. Load and register one selected provider module over the same provider ID.
5. Resolve the app-selected model.
6. Check authentication.
7. Create the app-owned `DefaultResourceLoader` with only app and selected package paths.

pi-factory never writes the main profile's selected provider or model. A Pi Reviewer override changes
only that review process.

## Run lifetime

The SDK runtime exposes `run(runId, operation)` and `close()`.

One run starts before the first possible model request and stays active through model turns, tool
continuations, retries, compaction, finalization, and cancellation. `finishRun` runs once when no more
automatic model requests can occur. Cleanup is idempotent and runs after success, failure, or handled
cancellation.

Provider code owns semantic-output rules. The Codex provider may change accounts only after
confirmed usage exhaustion and before it emits text, thinking, or a tool call. The first semantic
event fixes one account for the rest of the high-level run.

## OnurPi changes

The Codex switcher moves provider construction into shared code. The shared code continues to own:

- the existing policy and vault paths;
- account order and billing policy;
- official OAuth login and refresh;
- usage checks and reset handling;
- confirmed pre-output fallback;
- semantic-output account selection;
- compaction authentication;
- vault locking and redacted errors.

The normal Pi extension becomes a thin adapter. It registers the shared provider, maps documented Pi
lifecycle events, and keeps `/codex-switcher` account management.

The pi-factory provider module becomes another thin adapter. It exports `createProvider` and a
provider-only Pi extension. It does not add `/codex-switcher` or any unrelated resource.

The change does not migrate or rewrite configuration or credentials.

## Pi Reviewer changes

Pi Reviewer replaces direct source-Pi `ModelRuntime` construction with the pi-factory runtime.
Inherited worker requests contain only:

- the main agent directory;
- provider and model IDs;
- existing review controls.

They do not contain a provider package name, module path, account ID, credential, vault path, or
provider-specific setting. Explicit custom model manifests keep their separate current path and do
not act as a fallback for inherited providers.

Pi Reviewer selects `openai-codex` and its configured model. It selects no inherited package
resources. Its review extension, prompt, tools, settings, session manager, repository policy,
receipts, finalization, and submission gate stay isolated.

The complete three-phase review runs inside one pi-factory `run` operation. This includes exploration,
tool calls, retries, compaction, soft finalization, hard finalization, forced submission turns, and
automatic continuations.

`pi-reviewer models` constructs the same selected provider before listing models. Authentication
checks use the provider's existing state. If a selected provider module owns authentication and does
not expose a general login operation, `pi-reviewer login` reports that authentication is managed in
the main Pi profile. It does not create a single fallback credential.

## Failure behavior

The following conditions stop the operation with a clear error:

- malformed inheritance data;
- a missing or disabled selected package resource;
- duplicate or ambiguous resource matches;
- malformed or oversized provider metadata;
- a provider path outside its installed package root;
- an unsupported provider contract version;
- duplicate enabled provider declarations;
- provider import, construction, model, or authentication failure;
- nested or reused run IDs.

A selected provider module never falls back to another implementation after failure.

## Security boundary

Selected provider and extension code is trusted executable code in the app process. Resource
selection limits what pi-factory loads. It is not an operating-system sandbox.

pi-factory and Pi Reviewer do not copy, serialize, return, log, or mirror credentials. They do not
create a proxy, service, temporary auth file, temporary home directory, wrapper retry, provider alias,
or compatibility reader.

## Implementation order

1. Update pi-factory manifest version 1, package resolution, provider loading, SDK runtime, launch
   planning, lifecycle handling, documentation, and tests.
2. Release the existing `@osolmaz/pi-factory` package.
3. Refactor the OnurPi Codex switcher, add its provider declaration and module, run checks, and sync
   the installed package without changing credentials.
4. Update Pi Reviewer worker input, runtime construction, run lifetime, model listing,
   authentication behavior, documentation, and tests.
5. Release and install Pi Reviewer.
6. Run synthetic cross-repository tests and bounded real Pi and Pi Reviewer checks.
7. Run the review that was blocked by missing `openai-codex` authentication.

## Verification

pi-factory tests must cover:

- manifest parsing and hard replacement of broad ambient inheritance;
- exact package and resource matching;
- disabled, missing, duplicate, and ambiguous resources;
- bounded provider metadata and path containment;
- provider registration before model and authentication checks;
- built-in provider behavior when no enabled declaration exists;
- final failure after a selected provider module fails;
- app-owned resource loading and explicit launch flags;
- success, error, cancellation, compaction, cleanup, and concurrent runs;
- package and installed-consumer checks.

OnurPi tests must cover:

- equal provider behavior through normal Pi and pi-factory adapters;
- account order, billing policy, usage checks, OAuth refresh, and vault locking;
- pre-output fallback and post-output account selection;
- tools, retries, compaction, cancellation, reset recovery, and concurrent instances;
- no credential or account value in output.

Pi Reviewer tests must cover:

- generic provider selection with no switcher-specific production code;
- an app-selected model that does not change the main Pi selection;
- inherited, built-in, and explicit custom model paths;
- resource and session isolation;
- one provider run around the full review;
- exactly-once submission and lifecycle receipts;
- provider failure without native fallback;
- no credential copy or new fallback credential.

Run each repository's full local checks, review loop, and CI. Release in dependency order. The final
bounded check must show that normal Pi still manages Codex accounts, Pi Reviewer lists and uses its
own selected model, the review authenticates through the inherited provider, and no main Pi setting
or credential file changed.

## Outside scope

This work does not:

- change Pi, pi-ai, or another upstream repository;
- add a service, proxy, broker, or new credential store;
- load all ambient extensions to find a provider;
- migrate unrelated provider packages;
- inherit sessions, context files, application policy, or submission behavior;
- claim operating-system isolation;
- keep the old inheritance path as a fallback.

The long-term replacement belongs in Pi. Pi can later add providers as a first-class package resource
and give providers one stable high-level run lifetime. pi-factory must remove its temporary provider
declaration and run wrapper when that public support exists. The two paths must not remain together.
