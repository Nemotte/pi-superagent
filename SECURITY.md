# Security and release status

## Deployment boundary

This is a single-administrator service running locally or on an SSH host. Workers execute tools with the service account's privileges. Use a dedicated account or isolated environment, provide narrowly scoped credentials, and restrict accessible files and network endpoints. The API binds only to 127.0.0.1; use an SSH tunnel for remote management.

Protect the instance directory and backups. POSIX file modes are set for sensitive files; Windows deployments also need an account-restricted directory ACL. Session histories and job output may contain repository data and secrets shown to the model.

Verified offline snapshots contain credentials in plaintext; use encrypted storage for off-host copies. Snapshot format/checksums, SQLite integrity, paths, critical file types and Git dependencies are checked before restore. Restore requires the original absent path, host/account/profile and instance ID; it never starts the service or restores system supervision. External Git object stores/worktree administration need a separate matching backup. Retention is explicit, preview-first and limited to matching complete snapshots; no job/session/worktree pruning runs automatically. See [backup and upgrade operations](docs/backup.md).

## Management access modes

New instances default to **local** mode, with no administrator token or browser login. This mode trusts all processes able to reach this machine's loopback port, including other OS users. Use it on a trusted single-user machine. Host and exact Origin checks remain mandatory; local writes require JSON content type and `X-Superagent-Local: 1`, preventing cross-site simple requests/forms. Cross-site API Fetch Metadata is rejected; ordinary navigation to the static UI is allowed. No permissive CORS headers are emitted.

For authenticated management, initialize with `--management token`, or stop the service and use `management token --state-dir INSTANCE`. Mode changes acquire the instance lock and atomically update `management.json`, outside business configuration and model tools. Existing instances without that file retain token mode; `/superagent local` explicitly confirms conversion and a graceful restart. Existing credentials are retained on conversion but are not read or required in local mode. The plugin and CLI's direct loopback HTTP transport is independent of the host's model fetch/proxy dispatcher and does not follow redirects.

In **token** mode, each instance has its own administrator token. Pi and CLI use that credential directly; `/superagent web` obtains a bearer-authorized, origin-bound, 60-second one-use code instead of exposing the long-lived token in a browser URL. Only code hashes are held in memory (at most 32); restart invalidates outstanding codes. The browser removes the URL fragment before exchanging it for an HttpOnly/SameSite=Strict cookie, with CSRF required for subsequent writes. Cookie names are instance-specific so same-host instances do not overwrite each other's sessions.

The explicit `/superagent token` command offers a masked temporary view and copy action. Revealing displays the credential in the user's terminal; copying places it in the system clipboard. Neither action returns credentials to model tools or chat. Clipboard commands receive the value through stdin, not shell arguments. Keep terminal capture and clipboard tools trusted. Normal session startup does not mint browser grants or open URLs.

## SSH control boundary

The SSH wizard manages a preinstalled Linux service and existing checkout from local Pi. It requires token management mode and does not expose the API on a public interface. OpenSSH uses existing host-key trust with StrictHostKeyChecking and BatchMode, disables agent/X11 forwarding and shared control sockets, and receives only a minimal local runtime/SSH environment. SSH configuration is trusted executable configuration (including ProxyCommand); use a dedicated alias without unrelated port-forward rules. User commands may open an already-approved connection; model tools and session startup cannot.

Only quoted executable paths enter the remote shell command. Requests and authentication answers use bounded JSONL over encrypted stdin/stdout. Raw SSH stderr and remote exception text are not reflected into model/chat output. Instance identities are checked before credential access and after tunnel establishment. The administrator token lives only in the connected Client's memory; it is not persisted in project bindings. Both API and private credential access fail after the associated tunnel closes.

The first version forwards the same local and remote port, retaining exact Host/Origin validation. It checks local port availability and uses ExitOnForwardFailure before the remote ready handshake. Closing Pi, reloading, switching sessions or disconnecting releases only the plugin's SSH/login resources; the remote service keeps running. Service lifecycle commands require separate confirmation, keep paused/configuration state and reject unresolved lock/port/identity conditions instead of killing unrelated processes or deleting locks.

## Portable installation

The release bundle contains prebuilt product tarballs and integrity-pinned production locks, not node_modules. Use a trusted release source. The installer requires confirmation, an absent destination, Node 24+/npm 10+ and Git 2.31+. Native Node launches npm and both CLI entries without a shell or npm.cmd. Lifecycle scripts and ancestor workspace selection are disabled; installation subprocesses receive system/proxy/CA values but no ambient provider/SSH/admin credentials or personal npm configuration. Temporary npm configuration/cache is removed on success.

A private Pi profile and separate plugin dependency root prevent personal-profile changes and physical SDK/TUI duplication. Inherited session-directory overrides are cleared. Actual SDK plugin loading is verified before publishing a completed installation; version output alone is insufficient. Installation does not start services/models/autostart. Existing directories are not overwritten, interrupted installs stay marked, and launchers check OS/architecture/path identity. Windows custom destinations need user-restricted ACLs. CI consumes one candidate on six OS/architecture targets and emits a verified artifact only after all install and standard tests pass. See [installation](docs/installation.md).

## Dependency audit — 2026-11-05

The server now pins Pi SDK **1.5.0**, with **minimatch 11.0.3** and **undici 8.12.3**. The extension's SDK/TUI development versions are 1.5.0 and optional peer minimums are ^1.5.0; a plugin-only installation installs neither SDK nor TUI. No workspace overrides are used.

Public npm registry production audits returned **0 vulnerabilities** for the workspace, independently installed plugin tarball, and clean-installed server + plugin tarballs. The package test inspects the actual consumer dependency tree. This closes the previous SDK dependency release blocker:

- minimatch GHSA-g3hv-75wg-m249: fixed upstream in 11.0.1.
- undici GHSA-xjj6-f33q-929c, GHSA-4w7w-5xrc-9h26 and GHSA-2m5v-pch6-74hx: fixed upstream in 8.12.2.
- Zod remains pinned to 4.6.7, addressing GHSA-mrhx-c7xc-m3w5.

After building, run `npm run test:security` to audit the workspace and freshly installed tarballs against `https://registry.npmjs.org`. It fails on audit findings or registry errors. CI runs this gate on all three configured platforms; the original npm mirror does not implement an audit endpoint. Audit results reflect the advisory database at execution time.

Existing installations need updated dependencies and an explicitly confirmed service restart to load SDK 1.5.0; SSH hosts need the updated server package. Update host Pi to 1.5+ and reload the plugin. Linux systemd user supervision is implemented behind explicit bound-user operations: install does not start/enable, enable does not start, and ownership is pinned to the instance, UID, canonical paths and unit digest. The unit uses env-i, a private allowlisted service.env.json, bounded on-failure restart and cgroup-wide stop; it is not an OS sandbox. Unit parsing and real launcher process-crash/persistence recovery have been tested in temporary state without host registration. Actual user-manager auto-restart/boot, interactive/cloud acceptance, cross-host/path/schema migration, business-data retention and macOS/Windows execution evidence remain release work. Offline original-path restore and explicit snapshot retention are implemented; operations remain CLI-only on the execution host.

No npm package was published, no system service was installed, and no production credentials or external accounts were configured during implementation.
