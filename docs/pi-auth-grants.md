# Shared Pi authentication grants

This is a proposal.

This document proposes an opt-in Pi Factory grant that lets one app use credentials from the user's regular Pi profile. The app keeps its own models, settings, prompts, tools, and sessions.

## User flow

A user grants access from local Pi Factory state:

```bash
pi-factory auth grant pi-reviewer --source pi
pi-factory auth status pi-reviewer
pi-factory auth revoke pi-reviewer
```

`grant` must show the app id and resolved Pi auth file before asking for confirmation. The command records the grant after confirmation. An app manifest cannot create or enable a grant.

The default remains an isolated app profile. Revoking the grant returns the app to its own auth file.

## Launch behavior

Pi Factory continues to generate the app's `models.json` and `settings.json` under its state directory. It also keeps the app's session directory unchanged.

For a granted app, the launch plan adds a proposed Pi option:

```text
--auth-file /home/user/.pi/agent/auth.json
```

Pi uses that file for credential reads and OAuth refresh writes. Pi still loads models and settings from the app's `PI_CODING_AGENT_DIR`.

A launch without a grant does not include `--auth-file`. Pi then uses the app profile's normal `auth.json`.

## Pi support

Pi's SDK already accepts a separate `authPath` when creating `ModelRuntime`. The native CLI needs an equivalent `--auth-file <path>` option so Pi Factory can keep using native Pi launch plans.

Pi must resolve the supplied path before creating `ModelRuntime`. The option must affect only credential storage. It must not change the settings, models, resources, or session directories.

A CLI option is preferable to an environment variable because an older Pi version will reject an unknown option. This makes unsupported launches fail instead of silently using the wrong auth file.

## Grant storage

The grant belongs to Pi Factory's local installed-app state. It is separate from `pi-factory.toml` and records only:

- the app id
- the auth source
- the resolved absolute auth file path

Pi Factory must never store credential contents in its app index. Moving or removing the source auth file makes the grant invalid until the user grants access again.

## Credential writes

The app and regular Pi use one canonical auth file. OAuth refreshes must update that file so both processes see the current refresh token.

Login and logout from a granted app also affect regular Pi authentication. Pi Factory must state this during grant confirmation. Model selection and all other app configuration remain private to the app.

Pi Factory must not copy credentials into the app profile. It must not use symlinks, hard links, fallback copies, or one-way synchronization. Those approaches can leave two rotating OAuth refresh tokens in use and cause `refresh_token_reused` failures.

## Trust and safety

A downloaded bundle cannot grant itself access. Only an explicit local command may create the grant.

Pi Factory must avoid printing credentials and must preserve the source file's permissions. Launch plans may show the auth file path because the path is not a credential.

Pi Factory does not sandbox app code. A grant records the user's choice and provides no filesystem security boundary.

## Failure behavior

Pi Factory must stop before starting Pi when:

- the auth file does not exist
- the auth path is not a regular file
- the current user cannot read and write the file

An older Pi command will reject `--auth-file` during argument parsing. Pi Factory must report that failure and must not retry without the option.

Pi Factory must not fall back to the app's auth file after one of these failures. The error should name the failed check without exposing file contents.

## Verification

Tests should prove that:

- isolated apps still use their own auth file by default
- a grant adds the canonical auth path to the launch plan
- the app's model and settings paths remain isolated
- unsupported Pi versions fail closed
- missing or unreadable auth files fail closed
- revocation removes the shared-auth launch option
- manifests cannot enable grants
- generated config never contains copied credentials

An integration test should use a fake Pi command and temporary files. It should confirm that changing an app's selected model leaves the regular Pi `settings.json` byte-for-byte unchanged.

## Boundaries

The first version shares the complete Pi auth file with one app. Provider-specific grants require a credential-store interface or broker and belong in a later design.

This proposal does not change app manifests, provider definitions, model selection, session storage, or extension loading.
