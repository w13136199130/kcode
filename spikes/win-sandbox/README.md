# Windows sandbox spike (4-01)

Goal: prove or disprove the **restricted token + job object** path on this machine before
committing 15–20 days to production sandboxing.

This is a spike, not production code. It answers:

1. Can we create a restricted primary token from the current process?
2. Can we launch `cmd.exe` with that token (unelevated/elevated)?
3. Can we put the child in a Job Object with `KILL_ON_JOB_CLOSE`?
4. Does the child get a restricted token / deny-only admin SID?
5. Can it still write the workspace (expected yes) and write `C:\Windows` (expected no)?
6. Is network blocked by this approach (expected **no** — network needs a separate policy/proxy/firewall layer)?

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\spikes\win-sandbox\probe.ps1
```

The script writes `sandbox-probe.txt` / `sandbox-groups.txt` under `spikes\win-sandbox\out`
and prints a short verdict.

Decision rules:

- Token creation or process launch fails with 1314/5 → restricted-token path cannot be
  done from a normal Node process; production needs an elevated helper/service or an
  AppContainer design. Stop before 4-01 M1.
- Launch works + job assignment succeeds + workspace write works + system write fails →
  proceed to a Node wrapper (M1) and add network policy.
- Launch works but job assignment fails (nested job) → design for `CREATE_BREAKAWAY_FROM_JOB`
  / helper service before production.

## First result

See [FINDINGS.md](./FINDINGS.md): Job Object works, but privilege removal alone leaves
system write access; adding restricted SIDs makes `cmd.exe` exit `0xC0000142`. The pure
`CreateRestrictedToken` path is **blocked**.

## Second result: AppContainer works

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\appcontainer.ps1
```

It creates a temporary AppContainer profile, grants the probe workspace to the Package
SID, launches `cmd.exe` with `STARTUPINFOEX`, and verifies: workspace write ✅,
`C:\Windows` write ❌, network ❌ (no `internetClient` capability).

This is the direction for 4-01 M1. Production still needs a native helper (Node cannot
construct `STARTUPINFOEX`/AppContainer tokens), deterministic ACL grant/remove, and
combination with the Job Object.
