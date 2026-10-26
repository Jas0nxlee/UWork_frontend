# @zcode/zcode-cua

UWork's local macOS Computer Use runtime. An independent Helper.app owns TCC
permissions, the native `@trycua/cua-driver@0.28.2` SDK and the serialized input
queue. Shared node_repl discovers its transport through the Host, then connects
directly to the authenticated Helper so its peer identity remains visible.
It never loads the native SDK. The Host starts the Helper on discovery without
blocking ordinary Agent startup on Helper installation or health checks.

Build the local development Helper with pinned Node 24.14.0:

```sh
node scripts/build-cua-helper-app.mjs --allow-unsigned-launcher-local-dev
```

Run that command from the repository root. The existing desktop dev entry injects
the resulting Helper path and explicit development trust mode. Packaged builds
stage the Helper under `Contents/Resources/cua-helper`; production installation
requires a valid configured signing team, complete signature and Gatekeeper
verification. An ad-hoc development build is not production signing acceptance.

Permissions are read without prompting or capturing the screen. The user grants
Accessibility and Screen Recording in System Settings; the Host then restarts the
same Helper to refresh TCC. Unknown status is never inferred to be denied.

Application/window observation and supported AX/keyboard operations use the
public driver. Unsupported methods return explicit errors. Coordinate actions
without a verified screenshot-to-window mapping fail closed. PiP projection and
the original private native-addon API are not provided by this implementation.
Windows/Linux do not advertise this macOS Helper.

The protocol translation derives from Zcode-CE/Zcode-CE revision
`7fc3bfe252e7fb1833dc06113e3c2c012910996d` (Apache-2.0), adapted for an independent
Helper, macOS permission shape, workspace/session isolation and stop admission.
Dependency and copied-source licenses are retained in the repository's third-party
notices. See `specs/restore-macos-computer-use-runtime.md` for the ownership and
acceptance contract.

License: Apache-2.0.
