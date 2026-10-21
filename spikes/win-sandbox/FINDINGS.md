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
