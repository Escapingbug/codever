# Remote privileged execution

Codever can run a narrowly scoped command as root on a remote Linux or macOS
Gateway computer without sending an administrator password through Matrix or
the PWA. A root-owned local Helper is installed once; every later operation is
approved from a separately authorized Codever device.

This feature provides Unix root execution for command-line maintenance. On
macOS it does **not** bypass TCC, Accessibility, Screen Recording, Full Disk
Access, Secure Token, FileVault, or other consent mechanisms. Those permissions
must be provisioned locally or through an authorized device-management system.

## Security model

The flow is:

```text
Agent privileged_exec MCP call
  -> owner-only Gateway admin socket
  -> active SemanticSessionRuntime
  -> encrypted, signed PWA decision
  -> allow once / allow this session for 10 minutes / deny
  -> user-owned Helper credential
  -> root-owned Unix-socket Helper
  -> exact executable + argv, without an implicit shell
```

The Helper independently enforces a host executable policy, a 30-second grant
lifetime, durable one-shot request IDs, a bounded execution timeout, a minimal
environment, and capped stdout/stderr. The executable is resolved to its real
path and must be root-owned and not group/world writable.

Devices paired normally cannot approve these requests. The device certificate
must explicitly include `privilege.approve`. The default pairing operations do
not include it.

## One-time installation

Build the root Helper bundle first:

```sh
pnpm build
```

Identify the same absolute Gateway data directory used by
`CODEVER_MATRIX_DATA_DIR`. It must be owned by the non-root Gateway user and
must already exist and must not be group/world writable (use `chmod 700` as the
Gateway user if needed). Then run the installer once through `sudo`.
For example:

```sh
sudo "$(command -v node)" ./bin/codever.js privilege install \
  --gateway-data-dir /absolute/path/to/gateway-data \
  --allow-executable /usr/bin/apt-get \
  --allow-executable /usr/bin/systemctl
```

Use real paths present on the target machine; Linux distribution and macOS
paths differ. Repeating `--allow-executable` creates the recommended explicit
allowlist. A dedicated machine can opt into the much broader policy:

```sh
sudo "$(command -v node)" ./bin/codever.js privilege install \
  --gateway-data-dir /absolute/path/to/gateway-data \
  --allow-arbitrary-root-executables
```

The broad option still requires a root-owned, non-writable executable, but it
can include shells, interpreters, package managers, and programs that execute
project-controlled code. Treat it as equivalent to delegating wide root power
during each approved window.

The installer derives the Gateway UID/GID from `sudo`. A root login or
provisioning tool must pass `--target-uid` and `--target-gid` explicitly. It
installs:

- a root-owned Helper bundle and copied Node runtime under
  `/usr/local/libexec/codever-privilege-helper/<uid>`;
- a root-only policy and token hash under `/etc/codever`;
- a root service (`systemd` on Linux or a LaunchDaemon on macOS);
- a 0600 client credential named `privilege-client.json` in the Gateway data
  directory.

Restart the Matrix Gateway after installation. It automatically discovers that
credential. Verify the service from the Gateway account:

```sh
codever privilege status --gateway-data-dir /absolute/path/to/gateway-data
```

Re-run the install command after upgrading the Helper. This copies the new
bundle, rotates the client token, and restarts the root service.

## Pair an approval device

Create an invitation from the running Gateway's local admin interface:

```sh
codever gateway invite --privilege-approval
```

Use `--socket` if the Gateway admin socket is not at the configured default.
Pair a PWA from this invitation. Existing devices are not silently upgraded;
re-pair the device that should be allowed to approve root requests.

## Runtime behavior

The Agent receives `privileged_exec` only when the Helper is configured. It
must supply an absolute executable, an argv array, a reason shown to the user,
and an optional timeout. Privileged execution is accepted only while that
session has an active Agent turn.

An unanswered approval expires after five minutes. “Allow once” consumes one
Helper request. “Allow this session for 10 minutes”
allows further policy-compliant requests from the same Codever session during
that in-memory window. Destroying the runtime clears the window. Denial, an
expired approval, a replayed request, a policy violation, or a turn ending
before execution all fail closed.

The Helper closes stdin, so commands must be non-interactive. Do not allowlist
`sh`, `bash`, `env`, language runtimes, or package tools that execute
project-controlled hooks unless that breadth is intentional and understood.
