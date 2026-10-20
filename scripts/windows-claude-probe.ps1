# Checks the risky assumptions behind Buzz's Windows design for Claude agents
# (claude.ps1 + junctions + host-started claude.exe) on a real Windows machine.
#
# Run from Windows PowerShell 5.1 (not pwsh), from the repository root:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows-claude-probe.ps1
#
# Everything happens in a throwaway profile folder under %TEMP%; your real
# %LOCALAPPDATA%\Buzz and ~/.claude are not touched. Downloads ~290 MB.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$results = New-Object System.Collections.ArrayList
function Record([string] $name, [bool] $ok, [string] $detail) {
  [void] $results.Add([pscustomobject] @{ Check = $name; Ok = $ok; Detail = $detail })
  $mark = 'FAIL'
  if ($ok) { $mark = 'ok  ' }
  Write-Host "[$mark] $name - $detail"
}

$script = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\src\bundled\claude-code\claude.ps1'))
$profileDir = Join-Path $env:TEMP ("buzz-probe-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $profileDir | Out-Null
# The host's BUZZ_PLUGIN_DATA would be %LOCALAPPDATA%\Buzz\plugins\buzz.claude-code.
$dir = Join-Path $profileDir 'AppData\Local\Buzz\plugins\buzz.claude-code'

# Starts claude.ps1 the way Buzz will: powershell.exe -EncodedCommand, stdin
# piped and left open, BUZZ_PLUGIN_DATA naming the data folder.
function Invoke-Step([string[]] $stepArgs, [int] $timeoutMs = 600000) {
  $quoted = ($stepArgs | ForEach-Object { "'" + ($_ -replace "'", "''") + "'" }) -join ' '
  $body = ($script -split "`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes("& {`n$body`n} $quoted"))
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = 'powershell.exe'
  $info.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded"
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.EnvironmentVariables['BUZZ_PLUGIN_DATA'] = $dir
  $p = [Diagnostics.Process]::Start($info)
  $out = $p.StandardOutput.ReadToEndAsync()
  $err = $p.StandardError.ReadToEndAsync()
  $exited = $p.WaitForExit($timeoutMs)
  if (-not $exited) { $p.Kill() }
  return [pscustomobject] @{
    Exited = $exited; Code = $p.ExitCode; Out = $out.Result.Trim(); Err = $err.Result.Trim()
    CommandLength = $info.Arguments.Length
  }
}

try {
  # 1. Environment
  Record 'PowerShell version' ($PSVersionTable.PSVersion.Major -eq 5) $PSVersionTable.PSVersion.ToString()
  $mode = $ExecutionContext.SessionState.LanguageMode
  Record 'Language mode (ConstrainedLanguage breaks [IO.File] and friends)' ($mode -eq 'FullLanguage') "$mode"
  Record 'Execution policy (informational)' $true ((Get-ExecutionPolicy -List | ForEach-Object { "$($_.Scope)=$($_.ExecutionPolicy)" }) -join ', ')
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  Record 'curl.exe present' ([bool] $curl) "$($curl.Source)"
  Record 'Architecture' $true "PROCESSOR_ARCHITECTURE=$env:PROCESSOR_ARCHITECTURE W6432=$env:PROCESSOR_ARCHITEW6432"
  Record 'HOME vs USERPROFILE (host expands ~ from HOME first today)' ((-not $env:HOME) -or ($env:HOME -eq $env:USERPROFILE)) "HOME=$env:HOME USERPROFILE=$env:USERPROFILE"
  $bash = Get-Command bash.exe -ErrorAction SilentlyContinue
  Record 'bash.exe on PATH (WSL trap if System32)' $true "$($bash.Source)"
  $git = Test-Path 'C:\Program Files\Git\bin\bash.exe'
  Record 'Git for Windows (optional; Claude falls back to its PowerShell tool)' $true "$git"

  # 2. A junction is removed without touching what it points at.
  $t = Join-Path $profileDir 'target'
  New-Item -ItemType Directory -Path $t | Out-Null
  Set-Content -Path (Join-Path $t 'keep.txt') -Value 'x'
  $j = Join-Path $profileDir 'link'
  New-Item -ItemType Junction -Path $j -Target $t | Out-Null
  [IO.Directory]::Delete($j, $false)
  Record 'Junction created without admin, removed without its target' ((Test-Path (Join-Path $t 'keep.txt')) -and -not (Test-Path $j)) ''

  # 3. Real install and switch through -EncodedCommand.
  $version = (Invoke-RestMethod 'https://downloads.claude.ai/claude-code-releases/latest').Trim()
  $r = Invoke-Step @('platform')
  Record 'platform step' ($r.Out -eq 'Windows AMD64' -or $r.Out -eq 'Windows ARM64') "'$($r.Out)' code=$($r.Code) $($r.Err)"
  $platform = 'win32-x64'
  if ($r.Out -eq 'Windows ARM64') { $platform = 'win32-arm64' }
  $manifest = Invoke-RestMethod "https://downloads.claude.ai/claude-code-releases/$version/manifest.json"
  $sum = $manifest.platforms.$platform.checksum
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $r = Invoke-Step @('install', $version, $platform, $sum)
  Record "install $version $platform" ($r.Exited -and $r.Code -eq 0) "code=$($r.Code) $($watch.Elapsed.TotalSeconds)s cmdline=$($r.CommandLength) chars $($r.Err)"
  Record 'stdin left open does not hang PowerShell' $r.Exited ''
  $r = Invoke-Step @('install', $version, $platform, ('0' * 64))
  Record 'checksum mismatch is refused, release kept' ($r.Code -ne 0 -and (Test-Path "$dir\$version\claude.exe")) "code=$($r.Code) $($r.Err)"
  $r = Invoke-Step @('use', $version)
  Record "use $version" ($r.Code -eq 0) "code=$($r.Code) $($r.Err)"

  # 4. claude.exe starts through the junction; first start includes any
  # Defender scan, which Buzz's 15 s step timeouts must allow for.
  $exe = Join-Path $dir 'current\claude.exe'
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $v = & $exe --version 2>&1
  Record 'current\claude.exe --version (first start)' ("$v" -like "$version*") "$v in $($watch.Elapsed.TotalSeconds)s"
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $v = & $exe --version 2>&1
  Record 'second start' $true "$($watch.Elapsed.TotalSeconds)s"
  $sig = Get-AuthenticodeSignature $exe
  Record 'Authenticode signature' ($sig.Status -eq 'Valid') "$($sig.Status) $($sig.SignerCertificate.Subject)"

  # 5. A running release survives a switch and its prune.
  $old = Join-Path $dir '0.0.1'
  New-Item -ItemType Directory -Path $old | Out-Null
  Copy-Item "$dir\$version\claude.exe" "$old\claude.exe"
  $running = Start-Process -FilePath "$old\claude.exe" -ArgumentList 'doctor' -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 2
  $r = Invoke-Step @('use', $version)
  $kept = Test-Path "$old\claude.exe"
  Record 'prune skips a release that is running' ($r.Code -eq 0 -and ($kept -or $running.HasExited)) "code=$($r.Code) kept=$kept exited=$($running.HasExited) $($r.Err)"
  if (-not $running.HasExited) { $running.Kill() }
  Start-Sleep -Seconds 1
  $r = Invoke-Step @('use', $version)
  Record 'prune removes it once stopped' (-not (Test-Path $old)) "code=$($r.Code) $($r.Err)"

  # 6. A junction swap while a session runs from it.
  $session = Start-Process -FilePath $exe -ArgumentList 'doctor' -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 1
  $r = Invoke-Step @('use', $version)
  Record 'switch while a session runs from current' ($r.Code -eq 0) "code=$($r.Code) $($r.Err)"
  if (-not $session.HasExited) { $session.Kill() }

  # 7. Claude Code's project folder name for a Windows workspace.
  $projects = Join-Path $env:USERPROFILE '.claude\projects'
  $sample = ''
  if (Test-Path $projects) { $sample = (Get-ChildItem $projects -Directory | Select-Object -First 3 | ForEach-Object Name) -join ', ' }
  Record 'Existing ~/.claude/projects names (expect C--Users-...)' $true $sample
} catch {
  Record 'probe' $false $_.Exception.Message
} finally {
  Get-ChildItem $dir -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } |
    ForEach-Object { [IO.Directory]::Delete($_.FullName, $false) }
  Remove-Item $profileDir -Recurse -Force -ErrorAction SilentlyContinue
}
$results | Format-Table -AutoSize -Wrap
