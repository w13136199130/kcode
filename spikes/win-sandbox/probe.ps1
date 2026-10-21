param(
  [switch]$KeepSystemProbe
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $root "out"
$systemProbe = "C:\Windows\kcode-sandbox-probe.txt"
New-Item -ItemType Directory -Force -Path $out | Out-Null
Remove-Item (Join-Path $out "sandbox-probe.txt"), (Join-Path $out "sandbox-groups.txt"), (Join-Path $out "system-write-error.txt") -ErrorAction SilentlyContinue
Remove-Item $systemProbe -ErrorAction SilentlyContinue

$code = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class SandboxProbe
{
    private const uint TOKEN_ASSIGN_PRIMARY = 0x0001;
    private const uint TOKEN_DUPLICATE = 0x0002;
    private const uint TOKEN_QUERY = 0x0008;
    private const uint TOKEN_ADJUST_DEFAULT = 0x0080;
    private const uint TOKEN_ADJUST_SESSIONID = 0x0100;
    private const uint DISABLE_MAX_PRIVILEGE = 0x1;
    private const uint CREATE_SUSPENDED = 0x4;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x400;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint WAIT_TIMEOUT = 0x00000102;

    [StructLayout(LayoutKind.Sequential)]
    private struct SID_AND_ATTRIBUTES
    {
        public IntPtr Sid;
        public uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool CreateRestrictedToken(
        IntPtr existingToken,
        uint flags,
        uint disableSidCount,
        IntPtr sidsToDisable,
        uint deletePrivilegeCount,
        IntPtr privilegesToDelete,
        uint restrictedSidCount,
        IntPtr sidsToRestrict,
        out IntPtr newToken);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool ConvertStringSidToSid(string stringSid, out IntPtr sid);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint infoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessAsUser(
        IntPtr token,
        string applicationName,
        string commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    public static string Run(string workDir, bool useRestrictedSids)
    {
        StringBuilder log = new StringBuilder();
        IntPtr job = IntPtr.Zero;
        IntPtr token = IntPtr.Zero;
        IntPtr restricted = IntPtr.Zero;
        IntPtr jobInfo = IntPtr.Zero;
        PROCESS_INFORMATION pi = new PROCESS_INFORMATION();

        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero)
            {
                return "FAIL job=CreateJobObject error=" + Marshal.GetLastWin32Error();
            }

            JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int infoSize = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            jobInfo = Marshal.AllocHGlobal(infoSize);
            Marshal.StructureToPtr(info, jobInfo, false);
            bool jobConfigured = SetInformationJobObject(job, JobObjectExtendedLimitInformation, jobInfo, (uint)infoSize);
            log.AppendLine("job.configured=" + jobConfigured + " error=" + (jobConfigured ? 0 : Marshal.GetLastWin32Error()));

            uint access = TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT | TOKEN_ADJUST_SESSIONID;
            bool opened = OpenProcessToken(GetCurrentProcess(), access, out token);
            if (!opened)
            {
                return "FAIL token=OpenProcessToken error=" + Marshal.GetLastWin32Error();
            }

            IntPtr sidUsers = IntPtr.Zero;
            IntPtr sidRestricted = IntPtr.Zero;
            IntPtr sidList = IntPtr.Zero;
            uint restrictedCount = 0;
            bool converted = true;
            if (useRestrictedSids)
            {
                converted = ConvertStringSidToSid("S-1-5-32-545", out sidUsers)
                    && ConvertStringSidToSid("S-1-5-12", out sidRestricted);
                SID_AND_ATTRIBUTES[] entries = new SID_AND_ATTRIBUTES[2];
                entries[0].Sid = sidUsers;
                entries[0].Attributes = 0;
                entries[1].Sid = sidRestricted;
                entries[1].Attributes = 0;
                int entrySize = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
                sidList = Marshal.AllocHGlobal(entrySize * entries.Length);
                for (int i = 0; i < entries.Length; i++)
                {
                    Marshal.StructureToPtr(entries[i], IntPtr.Add(sidList, i * entrySize), false);
                }
                restrictedCount = (uint)entries.Length;
            }

            bool restrictedOk = converted && CreateRestrictedToken(
                token, DISABLE_MAX_PRIVILEGE, 0, IntPtr.Zero, 0, IntPtr.Zero,
                restrictedCount, sidList, out restricted);
            if (sidUsers != IntPtr.Zero) LocalFree(sidUsers);
            if (sidRestricted != IntPtr.Zero) LocalFree(sidRestricted);
            if (sidList != IntPtr.Zero) Marshal.FreeHGlobal(sidList);
            if (!restrictedOk)
            {
                return "FAIL token=CreateRestrictedToken(restricted=" + useRestrictedSids + ") error=" + Marshal.GetLastWin32Error();
            }
            log.AppendLine("token.restricted=" + useRestrictedSids);

            STARTUPINFO si = new STARTUPINFO();
            si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            si.lpDesktop = "winsta0\\default";
            string command = "C:\\Windows\\System32\\cmd.exe /c \"echo SANDBOX_OK>sandbox-probe.txt & whoami /groups>sandbox-groups.txt 2>&1 & echo SYSTEM_WRITE>C:\\Windows\\kcode-sandbox-probe.txt 2>system-write-error.txt\"";
            uint flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW;

            bool created = CreateProcessAsUser(
                restricted, null, command, IntPtr.Zero, IntPtr.Zero, false,
                flags, IntPtr.Zero, workDir, ref si, out pi);
            int createError = created ? 0 : Marshal.GetLastWin32Error();
            log.AppendLine("launch.createProcessAsUser=" + created + " error=" + createError);
            if (!created)
            {
                return "FAIL launch error=" + createError;
            }

            bool assigned = AssignProcessToJobObject(job, pi.hProcess);
            int assignError = assigned ? 0 : Marshal.GetLastWin32Error();
            bool inJob = false;
            IsProcessInJob(pi.hProcess, job, out inJob);
            log.AppendLine("job.assigned=" + assigned + " error=" + assignError + " inJob=" + inJob);

            ResumeThread(pi.hThread);
            uint wait = WaitForSingleObject(pi.hProcess, 15000);
            uint exitCode = 0;
            GetExitCodeProcess(pi.hProcess, out exitCode);
            if (wait == WAIT_TIMEOUT)
            {
                TerminateProcess(pi.hProcess, 1);
                log.AppendLine("process.timeout=true");
            }
            log.AppendLine("process.wait=" + wait + " exit=" + exitCode);
            return "OK " + log.ToString();
        }
        finally
        {
            if (jobInfo != IntPtr.Zero) Marshal.FreeHGlobal(jobInfo);
            if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
            if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
            if (restricted != IntPtr.Zero) CloseHandle(restricted);
            if (token != IntPtr.Zero) CloseHandle(token);
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }
}
'@

if (-not ("SandboxProbe" -as [type])) {
  Add-Type -TypeDefinition $code -Language CSharp
}

function Invoke-Probe([bool]$restricted) {
  $mode = if ($restricted) { "restricted-sids" } else { "privilege-removed-only" }
  Write-Output ("=== " + $mode + " ===")
  Remove-Item (Join-Path $out "sandbox-probe.txt"), (Join-Path $out "sandbox-groups.txt"), (Join-Path $out "system-write-error.txt") -ErrorAction SilentlyContinue
  Remove-Item $systemProbe -ErrorAction SilentlyContinue

  $result = [SandboxProbe]::Run($out, $restricted)
  Write-Output $result

  $workspaceWrite = Test-Path (Join-Path $out "sandbox-probe.txt")
  $systemWrite = Test-Path $systemProbe
  Write-Output ("workspace.write=" + $workspaceWrite)
  Write-Output ("system.write=" + $systemWrite)
  if ($workspaceWrite) {
    Write-Output ("workspace.content=" + (Get-Content (Join-Path $out "sandbox-probe.txt") -Raw).Trim())
  }
  if (-not $KeepSystemProbe) {
    Remove-Item $systemProbe -ErrorAction SilentlyContinue
  }
  Write-Output ""
}

Invoke-Probe $false
Invoke-Probe $true
