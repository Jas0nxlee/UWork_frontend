<div align="center">
  <img src="packages/desktop/build/uwork.svg" alt="UWork" width="96" height="96" />
  <h1>UWork</h1>
  <p>Connect your model services and handle coding, documents, and daily work in one workspace.</p>
  <p><a href="README.md">简体中文</a> · English</p>
  <p><a href="https://github.com/Jas0nxlee/UWork_frontend">Source</a> · <a href="https://github.com/Jas0nxlee/UWork_frontend/releases">Downloads</a> · <a href="LICENSE">Apache-2.0</a></p>
</div>

UWork is an AI workspace for teams and individual developers. It provides UCAS and custom model services, Office / Coding modes, optional WeCom identity and gateway usage statistics, and one workspace for code, documents, and everyday tasks.

The sign-in footer shows the current build version. See [package.json](package.json) for the source version and [GitHub Releases](https://github.com/Jas0nxlee/UWork_frontend/releases) for published installers and their versions.

## Features

New to coding with UWork? Start with the [coding guide (Chinese)](docs/user-guide/README.md) for Office / Coding modes, WeCom sign-in, project work, verification, and saved progress. An [offline illustrated version](docs/user-guide/index.html) is also available.

| Feature                | Description                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| UCAS default provider  | Six models are preconfigured on first launch with fixed names, endpoint, and Chat Completions format; keys and parameters are editable.                      |
| Custom model providers | Unlock the provider entry to configure a Base URL, API key, and Chat Completions, Responses, or Anthropic Messages format.                                   |
| Model discovery        | Fetch model IDs and add new entries in a batch while preserving existing settings, enabled states, and ordering.                                             |
| Model configuration    | Edit context windows, output limits, input types, and reasoning options.                                                                                     |
| Office / Coding        | Switch modes with one button and remember the choice. Office emphasizes summaries and results; Coding shows commands, output, and changes.                   |
| WeCom identity         | Scan inside the desktop login card or skip login. Verified users see their name, department, and position; workspaces and unsent drafts remain window-local. |
| Enterprise gateway     | After sign-in, configure the UCAS gateway and key, append plan models, and show quota, request, cost, and token usage.                                       |
| Workspaces and tasks   | Projects, conversations, files, terminal, Git, plugins, MCP, skills, and subagents are available in one workspace.                                           |
| Office files           | Preview Word, Excel, and PPT; edit supported files with backups. Complex structures remain read-only under format guards.                                    |
| UWork interface        | UWork wordmark and icon, UCAS background, light and dark themes, and the client version in the sign-in footer.                                               |

Interface modes change presentation only; they do not change tool permissions or model-service access. Download installers from this repository’s Releases. Automatic updates are controlled by the build configuration and are disabled by default.

## Connect a model service

1. Start the desktop app. If you do not need enterprise identity, choose **Skip login and continue**.
2. When signing in with WeCom, the client configures the default `ucas` provider and appends models allowed by your plan. Without an enterprise backend, or when provisioning fails, open **Settings → Model Settings** and enter the API key manually.
3. Use **Fetch models**, or enter a model ID manually with **Add Model**.
4. Configure parameters according to the provider’s actual capabilities, then select the provider and model in chat.
5. Enterprise accounts can open **Settings → Usage stats → Enterprise gateway** to review the account, endpoint, quota, and usage, and to sync or replace the key explicitly.

### Use another model provider

**Add Provider** initially appears gray. Click it **20 consecutive times** during the same visit to Model Settings to unlock it, then click once more to open the template picker. Clicking elsewhere resets the counter; leaving and reopening Model Settings requires unlocking again. This is an interface rule, not an access-control mechanism.

Choose a template or create a custom provider, enter its **complete API Base URL**, matching API format, and API key, then fetch or add models.

These are fictional examples; replace them with your service’s endpoints:

| API format         | Example Base URL             | Chat request path      |
| ------------------ | ---------------------------- | ---------------------- |
| Chat Completions   | `https://api.example.com/v1` | `/v1/chat/completions` |
| Responses          | `https://api.example.com/v1` | `/v1/responses`        |
| Anthropic Messages | `https://api.example.com/v1` | `/v1/messages`         |

Access to the model list does not prove that every listed model supports inference or tool calling. Check your provider’s documentation and permissions, then verify with a simple conversation.

## Optional WeCom login

Unauthenticated desktop users can scan inside the login card or skip login and continue. Skipping applies only to the current window; login remains available after restarting. Use the entry below the UWork wordmark to reopen login, or click the verified name to view its source and sign out.

Enterprise identity provides a name label and gateway access. It does not add account-based data isolation, cloud sync, or extra local permissions. An existing local API key is never overwritten automatically; use the Enterprise gateway panel to replace it explicitly. Signing in or out does not migrate, claim, or delete existing workspaces, conversations, or model settings.

Official GitHub installers include the default public WeCom login parameters. Windows, macOS, and Linux users can scan after installation without copying a configuration file. Administrators can override the defaults with local configuration; see [WeCom integration](docs/enterprise-identity-integration.md) for its location, interface requirements, and provisioning rules.

## Office

- Built-in Office tools handle supported Word, Excel, and PPT files. Format and size guards determine editing or read-only access; saves check file revisions and create backups. Arbitrary complex documents are not guaranteed a lossless round trip. See [Office preview and editing](specs/office-editors-triad.md).
- The [office-editor plugin](plugins/office-editor/README.md) provides Word revision and comment review. Without an external editor engine configured, it uses a read-only preview. Full engine editing requires separate configuration; the plugin docs and third-party inventory record bundled-component license obligations.

## Data directory

UWork keeps its user data under `~/.uwork`, with configuration in `~/.uwork/v2`. A fresh install starts with an empty directory and does not import data from other applications. Override the root with `UWORK_DATA_BASE_DIR`; see [separate data root](specs/uwork-data-root-separation.md).

## Run from source

Local build and installation validation primarily targets **macOS Apple Silicon**. The repository also includes Windows, Linux, HTTP service, and standalone share-page entry points; this does not imply equivalent release validation on every platform.

Install Git, Node.js **24.14.0**, and pnpm **10.33.2**. [mise.toml](mise.toml) defines the tool versions. Building native components on macOS also requires Xcode Command Line Tools. Run the following commands from the repository root.

```bash
git clone https://github.com/Jas0nxlee/UWork_frontend.git
cd UWork_frontend
pnpm bootstrap
UWORK_DATA_BASE_DIR="$HOME/.uwork-dev" pnpm dev:desktop:test
```

`bootstrap` installs dependencies, prepares local runtime assets, and builds the relevant packages. The development command uses a separate data directory; use the equivalent environment-variable syntax on Windows. With mise installed, you can also run `mise install`, `mise run bootstrap`, and `mise run dev` as defined in [mise.toml](mise.toml).

| Entry point                   | Command                         |
| ----------------------------- | ------------------------------- |
| Desktop development           | `pnpm dev:desktop`              |
| Desktop with test services    | `pnpm dev:desktop:test`         |
| HTTP service development      | `pnpm dev:server`               |
| Standalone share-page develop | `pnpm dev:web-share:test`       |
| Remote workspace assets       | `pnpm bootstrap:with-remote`    |
| Desktop packaging help        | `pnpm bundle:desktop -- --help` |

`dev:desktop` uses production service configuration; `dev:desktop:test` uses test configuration. These environment names do not indicate signing, notarization, or release status.

### Build the macOS application

```bash
pnpm bundle:desktop -- --os mac --arch arm64
```

For a local installation, use the generated `UWork.app` and complete signing and verification according to your machine’s policy. Ad hoc signing is not Apple Developer ID signing or notarization. To change the app icon, edit the [SVG source](packages/desktop/build/uwork.svg), then run:

```bash
pnpm exec electron packages/desktop/scripts/build-uwork-icons.cjs
```

## HTTP service

`pnpm dev:server` starts the HTTP / WebSocket service on port `3030` by default. Use `pnpm dev:web-share:test` for the standalone share page. Remote workspaces and the share page are separate use cases; configure each according to its documentation.

## Data and network boundaries

- Model requests go to your configured provider. Plugins, remote workspaces, and diagnostics have their own network behavior.
- WeCom identity uses separate credentials and a device session. Signing in or out does not migrate, claim, or delete existing workspaces, conversations, or model settings.
- Office / Coding is a presentation mode, not an operating-system sandbox or permission level.
- Never commit API keys, real configuration, logs, or conversation data to a public repository.

## Development checks

```bash
pnpm typecheck
pnpm lint
pnpm fmt:check
pnpm architecture:check --changed
pnpm verify:pre-push
```

Test entry points and environment dependencies are defined by each package’s `package.json` and test files. These checks cover types, code quality, formatting, and architecture constraints for the current worktree.

## Source layout and design notes

| Directory                                            | Responsibility                                       |
| ---------------------------------------------------- | ---------------------------------------------------- |
| `packages/desktop`                                   | Electron Main, Host, Renderer, and desktop packaging |
| `packages/ui`                                        | Shared React UI, hooks, and state                    |
| `packages/services`                                  | Business services and persistence                    |
| `packages/provider`, `packages/provider-node`        | Provider configuration and model registry            |
| `packages/server`                                    | HTTP / WebSocket services                            |
| `packages/shared`, `packages/rpc`, `packages/client` | Protocols, RPC, and client                           |

- [Custom providers and account entry changes](specs/custom-providers-only.md)
- [Model discovery and parameter editing](specs/provider-model-discovery.md)
- [Default UCAS provider and add-provider rules](specs/ucas-default-provider.md)
- [Optional enterprise identity and cross-window sync](specs/enterprise-identity.md) · [Authentication-service integration](docs/enterprise-identity-integration.md)
- [Enterprise gateway provisioning, plans, and usage](specs/enterprise-gateway-provisioning.md)
- [UWork branding, mode switching, and interface rules](specs/uwork-branding.md)
- [UWork separate data root](specs/uwork-data-root-separation.md)
- [UI design system](DESIGN.md) · [Development conventions](AGENTS.md)

For troubleshooting, record your operating system, commit version, API format, redacted endpoint path, and reproduction steps. Do not include real credentials.

## GitHub Actions build and release

The [desktop release workflow](https://github.com/Jas0nxlee/UWork_frontend/actions/workflows/desktop-release.yml) uses Node 24.14.0 / pnpm 10.33.2, runs code and dependency audits, and builds macOS, Windows, and Linux installers on native runners.

- macOS: DMG and ZIP; Windows: NSIS EXE; Linux: AppImage, DEB, RPM, and Arch packages.
- Pushes and pull requests to `main` run checks. Pushing a `vX.Y.Z` tag matching the root version builds and publishes; the Actions Run workflow can publish the current version from `main` when `publish` is enabled.
- A release is assembled only when every platform succeeds and the production dependency audit reports no high/critical findings. Every installer has a SHA256, and the full report and source commit ship with the release.
- macOS currently uses ad hoc signing without Apple notarization; Windows has no publisher signing configured. Linux AppImage downloads need the executable bit set.

Installers are published to [GitHub Releases](https://github.com/Jas0nxlee/UWork_frontend/releases); see the [multi-platform release spec](specs/desktop-github-release.md) and [dependency security fixes](specs/release-dependency-hardening.md).

## License

First-party code is licensed under [Apache License 2.0](LICENSE). Original attribution and third-party license notices are retained in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) and the [third-party materials guide](third-party/).
