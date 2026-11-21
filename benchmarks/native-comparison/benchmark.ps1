param(
  [string]$OutputDirectory = "",
  [ValidateRange(1, 20)]
  [int]$RuntimeRuns = 3,
  [ValidateRange(0, 10)]
  [int]$WarmupRuns = 1,
  [ValidateSet(0, 3)]
  [int]$ScriptcOptLevel = 0,
  [switch]$FreshScriptcCache
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not ("NativeJobMeter" -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public sealed class NativeJobMeter : IDisposable
{
    private IntPtr handle;

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicAccounting
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimit
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
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimit
    {
        public BasicLimit BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength,
        out uint returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    public NativeJobMeter()
    {
        handle = CreateJobObject(IntPtr.Zero, null);
        if (handle == IntPtr.Zero)
            throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    public void AddProcess(IntPtr processHandle)
    {
        if (!AssignProcessToJobObject(handle, processHandle))
            throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    private T Query<T>(int informationClass) where T : struct
    {
        int size = Marshal.SizeOf<T>();
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            if (!QueryInformationJobObject(handle, informationClass, buffer, (uint)size, out _))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            return Marshal.PtrToStructure<T>(buffer);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    public double TotalCpuMilliseconds()
    {
        BasicAccounting value = Query<BasicAccounting>(1);
        return (value.TotalUserTime + value.TotalKernelTime) / 10000.0;
    }

    public long PeakJobMemoryBytes()
    {
        ExtendedLimit value = Query<ExtendedLimit>(9);
        return unchecked((long)value.PeakJobMemoryUsed.ToUInt64());
    }

    public void Dispose()
    {
        if (handle != IntPtr.Zero)
        {
            CloseHandle(handle);
            handle = IntPtr.Zero;
        }
    }
}
"@
}

function Get-Median {
  param([double[]]$Values)
  $ordered = @($Values | Sort-Object)
  if ($ordered.Count -eq 0) {
    return 0.0
  }
  $middle = [int][Math]::Floor($ordered.Count / 2)
  if ($ordered.Count % 2 -eq 1) {
    return [double]$ordered[$middle]
  }
  return ([double]$ordered[$middle - 1] + [double]$ordered[$middle]) / 2.0
}

function Invoke-MeasuredProcess {
  param(
    [Parameter(Mandatory)] [string]$FilePath,
    [string[]]$Arguments = @(),
    [Parameter(Mandatory)] [string]$WorkingDirectory,
    [hashtable]$Environment = @{},
    [switch]$TrackChildren,
    [ValidateRange(5, 1000)] [int]$SampleMilliseconds = 20
  )

  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $FilePath
  $startInfo.WorkingDirectory = $WorkingDirectory
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  foreach ($argument in $Arguments) {
    $null = $startInfo.ArgumentList.Add($argument)
  }
  foreach ($entry in $Environment.GetEnumerator()) {
    $startInfo.Environment[[string]$entry.Key] = [string]$entry.Value
  }

  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  $job = [NativeJobMeter]::new()
  if (-not $process.Start()) {
    throw "could not start $FilePath"
  }
  $job.AddProcess($process.Handle)
  $startedAt = $process.StartTime
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $process.WaitForExit()
  $finishedAt = $process.ExitTime
  $stdout = $stdoutTask.GetAwaiter().GetResult()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  $cpuMilliseconds = $job.TotalCpuMilliseconds()
  $peakPrivateBytes = $job.PeakJobMemoryBytes()
  $job.Dispose()

  return [pscustomobject]@{
    ExitCode = $process.ExitCode
    WallMilliseconds = [Math]::Round(($finishedAt - $startedAt).TotalMilliseconds, 3)
    CpuMilliseconds = [Math]::Round($cpuMilliseconds, 3)
    PeakPrivateBytes = $peakPrivateBytes
    Stdout = $stdout
    Stderr = $stderr
  }
}

function Invoke-RuntimeMode {
  param(
    [Parameter(Mandatory)] [string]$Name,
    [Parameter(Mandatory)] [string]$FilePath,
    [string[]]$Arguments = @(),
    [Parameter(Mandatory)] [string]$WorkingDirectory,
    [Parameter(Mandatory)] [AllowEmptyString()] [string]$ExpectedStdout,
    [Parameter(Mandatory)] [AllowEmptyString()] [string]$ExpectedStderr,
    [Parameter(Mandatory)] [int]$ExpectedExitCode
  )

  for ($warmup = 0; $warmup -lt $WarmupRuns; $warmup += 1) {
    $null = Invoke-MeasuredProcess -FilePath $FilePath -Arguments $Arguments -WorkingDirectory $WorkingDirectory -SampleMilliseconds 20
  }

  $runs = @()
  for ($index = 0; $index -lt $RuntimeRuns; $index += 1) {
    $runs += Invoke-MeasuredProcess -FilePath $FilePath -Arguments $Arguments -WorkingDirectory $WorkingDirectory -SampleMilliseconds 10
  }
  $parity = $true
  foreach ($run in $runs) {
    if ($run.ExitCode -ne $ExpectedExitCode -or $run.Stdout -cne $ExpectedStdout -or $run.Stderr -cne $ExpectedStderr) {
      $parity = $false
    }
  }

  return [pscustomobject]@{
    Name = $Name
    Parity = $parity
    ExitCode = $runs[0].ExitCode
    Stdout = $runs[0].Stdout
    Stderr = $runs[0].Stderr
    MedianWallMilliseconds = [Math]::Round((Get-Median @($runs.WallMilliseconds)), 3)
    MedianCpuMilliseconds = [Math]::Round((Get-Median @($runs.CpuMilliseconds)), 3)
    MedianPeakPrivateBytes = [long](Get-Median @($runs.PeakPrivateBytes))
    Runs = $runs
  }
}

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path ([IO.Path]::GetTempPath()) ("scriptc-native-comparison-{0}-{1}" -f (Get-Date -Format "yyyyMMdd-HHmmss"), $PID)
} elseif (Test-Path -LiteralPath $OutputDirectory) {
  throw "OutputDirectory must not already exist: $OutputDirectory"
}
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
$null = New-Item -ItemType Directory -Path $outputRoot

$nodeShim = (Get-Command node -ErrorAction Stop).Source
$nodeExecutable = (& $nodeShim -p "process.execPath").Trim()
$bunShim = (Get-Command bun -ErrorAction Stop).Source
$bunExecutable = (& $bunShim -e "console.log(process.execPath)").Trim()
$scriptcExecutable = Join-Path $repositoryRoot "packages/compiler-rust/target/debug/scriptc.exe"
if (-not (Test-Path -LiteralPath $scriptcExecutable)) {
  throw "Build the native compiler first: pnpm build:compiler-rust"
}
$nodeSeaBuilder = Join-Path $PSScriptRoot "build-node-sea.mjs"

$scriptcEnvironment = @{
  CARGO_BUILD_JOBS = "1"
  SCRIPTC_NATIVE_CODEGEN_UNITS = "16"
}
$scriptcLabel = "scriptc-rust"
if ($ScriptcOptLevel -eq 3) {
  $scriptcLabel = "scriptc-rust-release"
}
if ($FreshScriptcCache) {
  $scriptcEnvironment.SCRIPTC_NATIVE_CARGO_TARGET_DIR = Join-Path $outputRoot "scriptc-cargo-target"
}

$programs = @(
  [pscustomobject]@{ Name = "numeric"; File = "numeric.js" },
  [pscustomobject]@{ Name = "records"; File = "records.ts" },
  [pscustomobject]@{ Name = "collections"; File = "collections.ts" }
)
$results = @()

foreach ($program in $programs) {
  Write-Host "[$($program.Name)] building serially"
  $programDirectory = Join-Path $outputRoot $program.Name
  $null = New-Item -ItemType Directory -Path $programDirectory
  $source = Join-Path $PSScriptRoot $program.File
  $nodeSea = Join-Path $programDirectory "$($program.Name)-node-sea.exe"
  $bunBinary = Join-Path $programDirectory "$($program.Name)-bun.exe"
  $scriptcBinary = Join-Path $programDirectory "$($program.Name)-scriptc.exe"

  $nodeBuild = Invoke-MeasuredProcess -FilePath $nodeExecutable -Arguments @(
    $nodeSeaBuilder,
    $source,
    $nodeSea,
    (Join-Path $programDirectory "node-sea-work")
  ) -WorkingDirectory $repositoryRoot -TrackChildren -SampleMilliseconds 50
  $bunBuild = Invoke-MeasuredProcess -FilePath $bunExecutable -Arguments @(
    "build",
    $source,
    "--compile",
    "--outfile",
    $bunBinary
  ) -WorkingDirectory $repositoryRoot -TrackChildren -SampleMilliseconds 50
  $scriptcArguments = @(
    "build",
    $source,
    "--no-engine",
    "--out",
    $scriptcBinary
  )
  if ($ScriptcOptLevel -eq 3) {
    $scriptcArguments += "--release"
  }
  $scriptcBuild = Invoke-MeasuredProcess -FilePath $scriptcExecutable -Arguments $scriptcArguments -WorkingDirectory $repositoryRoot -Environment $scriptcEnvironment -TrackChildren -SampleMilliseconds 50

  $builds = @(
    [pscustomobject]@{ Name = "node-sea"; Result = $nodeBuild; Path = $nodeSea },
    [pscustomobject]@{ Name = "bun-compile"; Result = $bunBuild; Path = $bunBinary },
    [pscustomobject]@{ Name = $scriptcLabel; Result = $scriptcBuild; Path = $scriptcBinary }
  )
  foreach ($build in $builds) {
    if ($build.Result.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $build.Path)) {
      throw "$($program.Name) $($build.Name) build failed (exit $($build.Result.ExitCode))`nstdout:`n$($build.Result.Stdout)`nstderr:`n$($build.Result.Stderr)"
    }
  }

  $nodeOracle = Invoke-MeasuredProcess -FilePath $nodeExecutable -Arguments @($source) -WorkingDirectory $repositoryRoot -SampleMilliseconds 10
  $runtimeModes = @(
    Invoke-RuntimeMode -Name "node-source" -FilePath $nodeExecutable -Arguments @($source) -WorkingDirectory $repositoryRoot -ExpectedStdout $nodeOracle.Stdout -ExpectedStderr $nodeOracle.Stderr -ExpectedExitCode $nodeOracle.ExitCode
    Invoke-RuntimeMode -Name "bun-source" -FilePath $bunExecutable -Arguments @($source) -WorkingDirectory $repositoryRoot -ExpectedStdout $nodeOracle.Stdout -ExpectedStderr $nodeOracle.Stderr -ExpectedExitCode $nodeOracle.ExitCode
    Invoke-RuntimeMode -Name "node-sea" -FilePath $nodeSea -WorkingDirectory $repositoryRoot -ExpectedStdout $nodeOracle.Stdout -ExpectedStderr $nodeOracle.Stderr -ExpectedExitCode $nodeOracle.ExitCode
    Invoke-RuntimeMode -Name "bun-compile" -FilePath $bunBinary -WorkingDirectory $repositoryRoot -ExpectedStdout $nodeOracle.Stdout -ExpectedStderr $nodeOracle.Stderr -ExpectedExitCode $nodeOracle.ExitCode
    Invoke-RuntimeMode -Name $scriptcLabel -FilePath $scriptcBinary -WorkingDirectory $repositoryRoot -ExpectedStdout $nodeOracle.Stdout -ExpectedStderr $nodeOracle.Stderr -ExpectedExitCode $nodeOracle.ExitCode
  )

  $results += [pscustomobject]@{
    Program = $program.Name
    Source = $program.File
    Oracle = $nodeOracle
    Builds = @($builds | ForEach-Object {
      [pscustomobject]@{
        Name = $_.Name
        ExitCode = $_.Result.ExitCode
        WallMilliseconds = $_.Result.WallMilliseconds
        CpuMilliseconds = $_.Result.CpuMilliseconds
        PeakPrivateBytes = $_.Result.PeakPrivateBytes
        BinaryBytes = (Get-Item -LiteralPath $_.Path).Length
        Stdout = $_.Result.Stdout
        Stderr = $_.Result.Stderr
      }
    })
    Runtime = $runtimeModes
  }
}

$metadata = [pscustomobject]@{
  Timestamp = (Get-Date).ToString("o")
  Repository = $repositoryRoot
  OutputDirectory = $outputRoot
  NodeVersion = (& $nodeExecutable --version).Trim()
  BunVersion = (& $bunExecutable --version).Trim()
  RustVersion = (& rustc --version).Trim()
  ScriptcVersion = (& $scriptcExecutable --version).Trim()
  RuntimeRuns = $RuntimeRuns
  WarmupRuns = $WarmupRuns
  ScriptcOptLevel = $ScriptcOptLevel
  FreshScriptcCache = [bool]$FreshScriptcCache
}
$document = [pscustomobject]@{ Metadata = $metadata; Programs = $results }
$document | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $outputRoot "results.json") -Encoding utf8NoBOM

$lines = @(
  "# Native comparison results",
  "",
  "Node $($metadata.NodeVersion), Bun $($metadata.BunVersion), $($metadata.RustVersion). Runtime values are medians of $RuntimeRuns fresh processes after $WarmupRuns warmup run(s). Memory is aggregate peak private memory; CPU is process-tree CPU time. Builds ran one at a time. scriptc used opt-level $ScriptcOptLevel and $($(if ($FreshScriptcCache) { 'a fresh' } else { 'the existing shared' })) Cargo dependency cache.",
  "",
  "## Build",
  "",
  "| Program | Builder | Wall ms | CPU ms | Peak private MiB | Binary MiB |",
  "| --- | --- | ---: | ---: | ---: | ---: |"
)
foreach ($programResult in $results) {
  foreach ($build in $programResult.Builds) {
    $lines += "| $($programResult.Program) | $($build.Name) | $([Math]::Round($build.WallMilliseconds, 1)) | $([Math]::Round($build.CpuMilliseconds, 1)) | $([Math]::Round($build.PeakPrivateBytes / 1MB, 2)) | $([Math]::Round($build.BinaryBytes / 1MB, 2)) |"
  }
}
$lines += @(
  "",
  "## Runtime",
  "",
  "| Program | Mode | Output parity | Wall ms | CPU ms | Peak private MiB |",
  "| --- | --- | :---: | ---: | ---: | ---: |"
)
foreach ($programResult in $results) {
  foreach ($runtime in $programResult.Runtime) {
    $parity = if ($runtime.Parity) { "yes" } else { "NO" }
    $lines += "| $($programResult.Program) | $($runtime.Name) | $parity | $([Math]::Round($runtime.MedianWallMilliseconds, 1)) | $([Math]::Round($runtime.MedianCpuMilliseconds, 1)) | $([Math]::Round($runtime.MedianPeakPrivateBytes / 1MB, 2)) |"
  }
}
$lines += @("", "Artifacts: $outputRoot", "")
$summaryPath = Join-Path $outputRoot "summary.md"
$lines | Set-Content -LiteralPath $summaryPath -Encoding utf8NoBOM
$lines | ForEach-Object { Write-Host $_ }
