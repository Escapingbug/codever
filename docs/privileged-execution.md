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
  -> fingerprint, face, or device unlock on the PWA
  -> client-side TOTP calculation
  -> allow once / deny
  -> user-owned Helper credential
  -> root-owned Unix-socket Helper
  -> independent TOTP validation and one-time-step claim
  -> exact executable + argv, without an implicit shell
```

The Helper independently enforces a host executable policy, a 30-second grant
lifetime, durable one-shot request IDs and TOTP time steps, a bounded execution
timeout, a minimal environment, and capped stdout/stderr. The executable is
resolved to its real path and must be root-owned and not group/world writable.
Five invalid TOTP attempts in one 30-second window temporarily rate-limit
further attempts.

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

The installer also prints a 32-character Base32 TOTP setup key and an
`otpauth://` provisioning URI exactly when installation completes. Save the
setup key directly in the privilege-approval PWA. It is stored in plaintext
only in the root-owned Helper configuration; the Gateway credential does not
contain it.

Restart the Matrix Gateway after installation. It automatically discovers that
credential. Verify the service from the Gateway account:

```sh
codever privilege status --gateway-data-dir /absolute/path/to/gateway-data
```

Re-run the install command after upgrading the Helper. This copies the new
bundle, rotates both the client token and TOTP setup key, and restarts the root
service. Use “Set up or replace TOTP” on the next privilege request to enroll
the new key.

## Pair an approval device

Create an invitation from the running Gateway's local admin interface:

```sh
codever gateway invite --privilege-approval
```

Use `--socket` if the Gateway admin socket is not at the configured default.
Pair a PWA from this invitation. Existing devices are not silently upgraded;
re-pair the device that should be allowed to approve root requests.

On its first administrator approval, the PWA asks for the setup key printed by
the installer. It creates a WebAuthn credential requiring fingerprint, face,
PIN, or device unlock, derives an encryption key through the WebAuthn PRF
extension, and stores only the encrypted TOTP key in browser storage. The
browser and authenticator must support WebAuthn PRF; enrollment fails closed
when they do not.

## Runtime behavior

The Agent receives `privileged_exec` only when the Helper is configured. It
must supply an absolute executable, an argv array, a reason shown to the user,
and an optional timeout. Privileged execution is accepted only while that
session has an active Agent turn.

An unanswered approval expires after five minutes. Every approval requires a
fresh device unlock and consumes one Helper request plus one accepted TOTP time
step. There is no session-wide approval lease. Denial, a missing or invalid
TOTP, an expired approval, a replayed request or TOTP time step, a policy
violation, or a turn ending before execution all fail closed.

This TOTP design keeps the long-term TOTP key out of the Gateway account, but a
live six-digit code is relayed through Codever after approval. TOTP does not
cryptographically bind that code to the displayed command. A compromised
Gateway could attempt to race the approved request during the current time
step; the Helper's one-use claim prevents later replay but is not
transaction-signing. Use this mode only with that simplified security boundary
understood.

The Helper closes stdin, so commands must be non-interactive. Do not allowlist
`sh`, `bash`, `env`, language runtimes, or package tools that execute
project-controlled hooks unless that breadth is intentional and understood.
