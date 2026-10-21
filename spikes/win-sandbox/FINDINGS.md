# 4-01 spike findings (2026-10-21)

Environment: Windows 11 22621, elevated administrator token, Node/PowerShell 5.1.

## Measured

| Mode | Token | Process | Job Object | Workspace write | `C:\Windows` write |
|---|---|---|---|---|---|
| A | `CreateRestrictedToken(DISABLE_MAX_PRIVILEGE)` | starts, exit 0 | configured + assigned (`inJob=true`) | ✅ | **✅** |
| B | A + restricted SIDs `Users` + `RESTRICTED` | `CreateProcessAsUser` returns true, child exits `0xC0000142` | configured + assigned | ❌ | ❌ |

## Interpretation

1. **Job Object works**: `KILL_ON_JOB_CLOSE` was accepted and the child was confirmed in the job.
2. **Privilege removal alone is not a sandbox**: the child still has the Administrators group and High integrity; it can write `C:\Windows`.
3. **Adding restricted SIDs blocks process initialization** on this host: `cmd.exe` exits `0xC0000142` (DLL init failed) before any command runs. This is not a command error; the child never reaches `cmd /c`.
4. **Conclusion: pure `CreateRestrictedToken` is not a viable production path as-is.** The Codex-style "restricted token + job object" needs more than these two calls — likely an AppContainer/low-integrity token plus workspace ACLs, or an elevated helper that constructs the token in a different session/service context.

## Decision

Do **not** start 4-01 M1 (read-only / workspace-write productization) from this spike.

Next spike (1–2 days), pick one:

- **AppContainer**: create profile + token, grant workspace capability/ACL, test `cmd`, workspace write, system write, network.
- **Low integrity + ACL**: set `TokenIntegrityLevel` low, label workspace low, verify system write denied and workspace write allowed.
- **Elevated helper service**: if neither token path launches reliably, test a helper process that owns token creation; Node only passes command/cwd over IPC.

The job-object lifecycle and command plumbing can be reused; the blocker is token construction/launch, not process cleanup.

## AppContainer second spike (success)

`appcontainer.ps1` uses the Microsoft-documented `CreateAppContainerProfile` +
`STARTUPINFOEX` + `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` path, then grants the
workspace to the AppContainer Package SID with `icacls` for the probe.

Measured on the same host (2026-10-21). The current host runs an elevated admin token;
unelevated validation is still required before M1.

| Check | Result |
|---|---|
| create profile / derive SID | ✅ |
| launch `cmd.exe` with AppContainer attribute list | ✅ exit 0 |
| token integrity | Low (`S-1-16-4096`) |
| workspace write (ACL granted to Package SID) | ✅ |
| `C:\Windows` write | ❌ denied |
| network (`curl https://example.com`, no `internetClient`) | ❌ curl exit 28 (blocked/timeout) |

This is a viable direction. Remaining production questions:

1. **Integration mechanism**: Node cannot build `STARTUPINFOEX`/AppContainer tokens
   directly. Either ship a small native helper (`kcode-sandbox.exe`) that creates the
   token/job and proxies stdio, or add a native addon. Helper is lower-risk for ABI and
   packaging.
2. **ACL lifecycle**: production must grant/remove the workspace ACE deterministically
   (and use a read-only ACE for read-only mode) instead of shelling out to `icacls`.
3. **Process tree**: combine AppContainer with the already-working Job Object
   (`KILL_ON_JOB_CLOSE`) and test child/grandchild cleanup.
4. **Capabilities**: no `internetClient` for default; an explicit network policy needs
   a capability or proxy allowlist — do not silently add network.
5. **Profile naming/cleanup**: per-install or per-session profile; remove stale profiles.

Decision: **proceed to 4-01 M1 spike-to-product**, starting with the native helper and
ACL lifecycle. Do not call the current probe production-ready: it shells out to `icacls`
and only proves the token/launch mechanics.

