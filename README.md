# Lantern

A standalone Go debugger built with Delve, Wails, and React.

## Build and run

Install Go 1.26 or later, Bun, Delve, and the platform prerequisites from the
[Wails installation guide](https://wails.io/quick-start/installation/).
Linux uses GTK4 and WebKitGTK 6.0. macOS requires Xcode command-line tools.
No Wails CLI is required for these commands.

```sh
make setup
make run
```

`make setup` installs the locked frontend dependencies. `make run` builds the
frontend and native executable, then opens Lantern. The executable is
`bin/lantern`.

## Debug the example service

1. Select **New session**.
2. Name the session and choose **Go package**.
3. Set the package directory to the absolute path of `examples/orders`.
4. Select **Launch**.
5. Open `main.go` and set a breakpoint on the line marked `Try a breakpoint here`.
   Click the source gutter, or use **Go to line** and press F9.
6. Request the URL printed in **Output**, using a browser or `curl`.
7. Inspect the stack and variables. Step over the calculation to see `subtotal`
   change from `0` to `2400`.

The service binds an available loopback port and needs no external services.
Stop the session when finished.

For short-lived programs and tests, enable **Pause before runtime initialization**
in the advanced launch settings, set source breakpoints, and continue. Delve
cannot always provide a Go stack at that early pause. You can also add pending
breakpoints to an ended session and restart it.

## Connect to an existing Delve server

Start a target under a loopback-only headless server:

```sh
dlv debug --headless --listen=127.0.0.1:38697 --accept-multiclient ./examples/orders
```

Choose **Existing Delve endpoint** in Lantern. Enter the address and, optionally,
the local source root. Connecting pauses the target until you choose **Continue**.
Target output remains in its original terminal.

This connection mode expects a headless Delve server that already owns a target,
not an unconfigured `dlv dap` server. Server configuration determines what happens
on disconnect. Do not expose a DAP endpoint on an untrusted network. Use an SSH
tunnel when a remote target must appear as a local endpoint.

## Current capabilities

- Launch Go packages, test packages, and existing executables.
- Switch between independent sessions without mixing stacks or variable handles.
- Set line and conditional breakpoints, logpoints, and hit conditions when supported.
- Continue, pause, step, inspect goroutines and frames, and explicitly restart.
- Inspect lazy, paged variables, compare observed values, pin watches, and copy values.
- Read highlighted source, search within a file, navigate to a line, and inspect identifier hovers.
- Resize and hide panels. At narrow widths, switch between source, navigation, output, and inspection.
- Save local launches, breakpoints, watches, layout, appearance, and keyboard shortcuts.

Source is read-only. **Open source in editor** uses the default text-file
application unless you configure an argument array in **Settings**. The `{file}`
and `{line}` placeholders support an editor launched through your terminal.
Commands do not pass through a shell.

## Data and limits

Settings use the operating system's user configuration directory under
`lantern/settings.json`. Files are created with owner-only permissions.
Environment overrides are saved there in plain text. They are not a credential
vault, so prefer inherited environment variables for secrets.
For isolated local testing, set `LANTERN_CONFIG_DIR` to an absolute directory.

Program output and captured values are not persisted. Inspection is bounded to
100 values per page, 2,000 retained values per inspector, and eight tree levels.
Collapse branches to release loaded values. Delve can truncate strings and other
values before Lantern receives them. Source files are limited to 1 MiB, and the
output buffer retains at most 256 KiB or 512 chunks.

Go setup is in `internal/debugger/adapter.go`. Protocol framing and response
correlation are in `internal/dapclient`. Session lifecycle and pause identities
are in `internal/debugger`, and Wails bindings are in `internal/desktop`.
The React workspace is under `frontend/src`.

## Verify

```sh
make check
make integration
```

`make check` runs the build, Go vet, race-enabled tests, TypeScript, Oxlint,
Oxfmt, and frontend unit tests. `make integration` launches real Delve processes
and checks the service investigation, Go test launch, independent sessions,
collection paging, and preservation of a running external target on disconnect.

With `agent-browser` installed, `make browser-check` exercises the production
frontend against a loopback-only verification build of the real backend. It
launches the example service, steps through a request, checks both themes and
the compact layout, and runs accessibility scans. It uses isolated temporary
settings and closes its own backend and browser afterward. Screenshots and
diagnostics remain in the printed artifact directory.

This is a development build tested on COSMIC/Wayland. macOS, native file-picker
and clipboard behavior, fractional scaling, and full accessibility remain
unverified. Browser checks do not verify native desktop behavior.
