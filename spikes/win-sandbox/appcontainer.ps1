$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $root "out-appcontainer"
New-Item -ItemType Directory -Force -Path $out | Out-Null
Remove-Item (Join-Path $out "sandbox-probe.txt"), (Join-Path $out "sandbox-groups.txt"), (Join-Path $out "system-write-error.txt"), (Join-Path $out "network.txt"), (Join-Path $out "network-exit.txt") -ErrorAction SilentlyContinue
Remove-Item "C:\Windows\kcode-sandbox-ac.txt" -ErrorAction SilentlyContinue

$code = @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class AppContainerProbe
{
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x400;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const int PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009;
    private const int ERROR_INSUFFICIENT_BUFFER = 122;
    private const int HRESULT_ALREADY_EXISTS = unchecked((int)0x800700B7);

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
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
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
    private struct SECURITY_CAPABILITIES
    {
        public IntPtr AppContainerSid;
        public IntPtr Capabilities;
        public uint CapabilityCount;
        public uint Reserved;
    }

    [DllImport("userenv.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    private static extern int CreateAppContainerProfile(
        string appContainerName,
        string displayName,
        string description,
        IntPtr capabilities,
        uint capabilityCount,
        out IntPtr appContainerSid);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    private static extern int DeriveAppContainerSidFromAppContainerName(
        string appContainerName,
        out IntPtr appContainerSid);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    private static extern int DeleteAppContainerProfile(string appContainerName);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr stringSid);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr attributeList,
        int attributeCount,
        int flags,
        ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr attributeList,
        uint flags,
        IntPtr attribute,
        IntPtr value,
        IntPtr size,
        IntPtr previousValue,
        IntPtr returnSize);

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcess(
        string applicationName,
        string commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFOEX startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static void GrantWorkspace(string workDir, string sid)
    {
        ProcessStartInfo psi = new ProcessStartInfo("icacls");
        psi.Arguments = "\"" + workDir + "\" /grant *" + sid + ":(OI)(CI)M";
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        using (Process p = Process.Start(psi))
        {
            if (p != null) p.WaitForExit(5000);
        }
    }

    public static string Run(string workDir)
    {
        StringBuilder log = new StringBuilder();
        string profileName = "kcodeSandboxSpike" + Process.GetCurrentProcess().Id;
        IntPtr sid = IntPtr.Zero;
        IntPtr sidStringPtr = IntPtr.Zero;
        IntPtr attributeList = IntPtr.Zero;
        IntPtr securityCapsPtr = IntPtr.Zero;
        PROCESS_INFORMATION pi = new PROCESS_INFORMATION();

        try
        {
            int hr = CreateAppContainerProfile(profileName, "kcode sandbox spike", "4-01 AppContainer probe", IntPtr.Zero, 0, out sid);
            if (hr == HRESULT_ALREADY_EXISTS)
            {
                hr = DeriveAppContainerSidFromAppContainerName(profileName, out sid);
                log.AppendLine("profile.existing=true");
            }
            else
            {
                log.AppendLine("profile.created=" + (hr == 0));
            }
            if (hr != 0)
            {
                return "FAIL profile hr=0x" + hr.ToString("X8");
            }

            bool sidOk = ConvertSidToStringSid(sid, out sidStringPtr);
            string sidString = sidOk ? Marshal.PtrToStringUni(sidStringPtr) : "<unknown>";
            log.AppendLine("appcontainer.sid=" + sidString);

            GrantWorkspace(workDir, sidString);

            IntPtr attributeSize = IntPtr.Zero;
            bool sized = InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
            if (!sized && Marshal.GetLastWin32Error() != ERROR_INSUFFICIENT_BUFFER)
            {
                return "FAIL attribute.size error=" + Marshal.GetLastWin32Error();
            }
            attributeList = Marshal.AllocHGlobal(attributeSize);
            if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeSize))
            {
                return "FAIL attribute.init error=" + Marshal.GetLastWin32Error();
            }

            SECURITY_CAPABILITIES caps = new SECURITY_CAPABILITIES();
            caps.AppContainerSid = sid;
            caps.Capabilities = IntPtr.Zero;
            caps.CapabilityCount = 0;
            caps.Reserved = 0;
            int capsSize = Marshal.SizeOf(typeof(SECURITY_CAPABILITIES));
            securityCapsPtr = Marshal.AllocHGlobal(capsSize);
            Marshal.StructureToPtr(caps, securityCapsPtr, false);

            bool updated = UpdateProcThreadAttribute(
                attributeList,
                0,
                (IntPtr)PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                securityCapsPtr,
                (IntPtr)capsSize,
                IntPtr.Zero,
                IntPtr.Zero);
            log.AppendLine("attribute.capabilities=" + updated + " error=" + (updated ? 0 : Marshal.GetLastWin32Error()));
            if (!updated)
            {
                return "FAIL attribute.update error=" + Marshal.GetLastWin32Error();
            }

            STARTUPINFOEX si = new STARTUPINFOEX();
            si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            si.StartupInfo.lpDesktop = null;
            si.lpAttributeList = attributeList;
            string command = "C:\\Windows\\System32\\cmd.exe /v:on /c \"echo SANDBOX_OK>sandbox-probe.txt & whoami /groups>sandbox-groups.txt 2>&1 & echo SYSTEM_WRITE>C:\\Windows\\kcode-sandbox-ac.txt 2>system-write-error.txt & curl.exe -s -m 3 https://example.com>network.txt 2>&1 & echo NETWORK_EXIT=!ERRORLEVEL!>network-exit.txt\"";
            uint flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW;

            bool created = CreateProcess(
                null,
                command,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                flags,
                IntPtr.Zero,
                workDir,
                ref si,
                out pi);
            int createError = created ? 0 : Marshal.GetLastWin32Error();
            log.AppendLine("launch.appcontainer=" + created + " error=" + createError);
            if (!created)
            {
                return "FAIL launch error=" + createError;
            }

            uint wait = WaitForSingleObject(pi.hProcess, 15000);
            uint exitCode = 0;
            GetExitCodeProcess(pi.hProcess, out exitCode);
            if (wait == 0x00000102)
            {
                TerminateProcess(pi.hProcess, 1);
                log.AppendLine("process.timeout=true");
            }
            log.AppendLine("process.wait=" + wait + " exit=" + exitCode);
            return "OK " + log.ToString();
        }
        finally
        {
            if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
            if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
            if (securityCapsPtr != IntPtr.Zero) Marshal.FreeHGlobal(securityCapsPtr);
            if (attributeList != IntPtr.Zero)
            {
                DeleteProcThreadAttributeList(attributeList);
                Marshal.FreeHGlobal(attributeList);
            }
            if (sidStringPtr != IntPtr.Zero) LocalFree(sidStringPtr);
            if (sid != IntPtr.Zero) LocalFree(sid);
            DeleteAppContainerProfile(profileName);
        }
    }
}
'@

if (-not ("AppContainerProbe" -as [type])) {
  Add-Type -TypeDefinition $code -Language CSharp
}

Write-Output ("workDir=" + $out)
$result = [AppContainerProbe]::Run($out)
Write-Output $result
$workspaceWrite = Test-Path (Join-Path $out "sandbox-probe.txt")
$systemWrite = Test-Path "C:\Windows\kcode-sandbox-ac.txt"
$networkExit = Get-Content (Join-Path $out "network-exit.txt") -ErrorAction SilentlyContinue
Write-Output ("workspace.write=" + $workspaceWrite)
Write-Output ("system.write=" + $systemWrite)
Write-Output ("network.exit=" + ($networkExit -join ""))
if (Test-Path "C:\Windows\kcode-sandbox-ac.txt") { Remove-Item "C:\Windows\kcode-sandbox-ac.txt" -ErrorAction SilentlyContinue }
