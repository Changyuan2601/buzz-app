# Buzz's own copy of Claude on Windows, apart from any `claude` the user
# installed: the counterpart of claude.sh. The plugin runs it with
# `powershell.exe -EncodedCommand` (see `withPowerShell` in powershell.ts),
# each time with one of these steps:
#
#   install VERSION PLATFORM SHA256  downloads a release, checks it, and
#                                    points `next` at it for its test
#   use VERSION                      points `current` at a downloaded release
#
# There is no `run` step. The host starts `current\claude.exe`, or
# `next\claude.exe` for a test, itself: Windows PowerShell 5.1 drops empty
# arguments and does not escape quotes when it starts a program, and sessions
# pass both (`--tools ""`, `--mcp-config {...}`). `current` and `next` are
# junctions, which need no administrator or Developer Mode.
#
# Windows PowerShell 5.1 only: no `??`, ternaries or pwsh-only parameters.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Shared by every Buzz build on this computer, so there is one download. The
# host expands the manifest's `~` the same way, from the user's profile.
$dir = Join-Path $env:USERPROFILE 'AppData\Local\Buzz\claude-code'
# pwsh off Windows, only to test this script: no junctions or curl.exe there.
$windows = [Environment]::OSVersion.Platform -eq 'Win32NT'

function Fail([string] $message, [int] $code = 1) {
  [Console]::Error.WriteLine($message)
  exit $code
}

# Versions name folders, so only digits and dots: no `..` or `\` escapes.
function Test-Version([string] $version) {
  return $version -match '^[0-9][0-9.]*$'
}

# Whether release $a is newer than release $b.
function Test-Newer([string] $a, [string] $b) {
  $x = $a.Split('.')
  $y = $b.Split('.')
  for ($i = 0; $i -lt 3; $i++) {
    $left = 0
    $right = 0
    if ($i -lt $x.Length) { $left = [int] $x[$i] }
    if ($i -lt $y.Length) { $right = [int] $y[$i] }
    if ($left -ne $right) { return $left -gt $right }
  }
  return $false
}

function Test-Link([string] $path) {
  try {
    $attributes = [IO.File]::GetAttributes($path)
  } catch {
    return $false
  }
  return [bool] ($attributes -band [IO.FileAttributes]::ReparsePoint)
}

# Removes the link alone. Never Remove-Item -Recurse: Windows PowerShell 5.1
# follows a junction and deletes what it points at.
function Remove-Link([string] $path) {
  if (Test-Link $path) { [IO.Directory]::Delete($path, $false) }
}

# Points junction $name at release $version. Windows cannot rename a folder
# over another, so the old link moves aside first; a start in that moment
# finds no `current`, and the plugin tries it again.
function Set-Link([string] $name, [string] $version) {
  $link = Join-Path $dir $name
  $fresh = "$link.$PID"
  $old = "$link.old.$PID"
  Remove-Link $fresh
  $target = Join-Path $dir $version
  if ($windows) {
    New-Item -ItemType Junction -Path $fresh -Target $target | Out-Null
  } else {
    New-Item -ItemType SymbolicLink -Path $fresh -Target $target | Out-Null
  }
  if (Test-Link $link) { [IO.Directory]::Move($link, $old) }
  [IO.Directory]::Move($fresh, $link)
  Remove-Link $old
}

# One switch at a time across Buzz builds, so none prunes the release
# another just switched to. Windows releases the lock when this process
# ends, however it ends.
function Lock-Switch {
  [IO.Directory]::CreateDirectory($dir) | Out-Null
  $path = Join-Path $dir '.lock'
  while ($true) {
    try {
      return [IO.File]::Open($path, 'OpenOrCreate', 'ReadWrite', 'None')
    } catch [IO.IOException] {
      Start-Sleep -Milliseconds 200
    }
  }
}

function Read-Current {
  try {
    return [IO.File]::ReadAllText((Join-Path $dir 'current.txt')).Trim()
  } catch {
    return ''
  }
}

function Install-Release([string] $version, [string] $platform, [string] $checksum) {
  if (-not (Test-Version $version)) { Fail 'Invalid version' 2 }
  if ($platform -ne 'win32-x64' -and $platform -ne 'win32-arm64') {
    Fail 'Unsupported platform' 2
  }
  if ($checksum -notmatch '^[0-9a-f]{64}$') { Fail 'Invalid checksum' 2 }
  $folder = Join-Path $dir $version
  $binary = Join-Path $folder 'claude.exe'
  [IO.Directory]::CreateDirectory($folder) | Out-Null
  # A release already here may be running, and Windows will not replace a
  # running program; keep it if it is whole.
  $whole = (Test-Path -LiteralPath $binary) -and
    (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant() -eq $checksum
  if (-not $whole) {
    # Each download has its own temporary file, so two Buzz builds updating
    # at once do not write over each other.
    $part = "$binary.$PID"
    try {
      $curl = 'curl'
      if ($windows) { $curl = 'curl.exe' }
      # Give up on a stalled download rather than holding the update forever.
      & $curl -fsSL --speed-limit 1024 --speed-time 60 -o $part `
        "https://downloads.claude.ai/claude-code-releases/$version/$platform/claude.exe"
      if ($LASTEXITCODE -ne 0) { Fail "The download failed (curl $LASTEXITCODE)" }
      # The release manifest's checksum, which the plugin passes in.
      $actual = (Get-FileHash -LiteralPath $part -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($actual -ne $checksum) { Fail 'The download did not match its checksum' }
      # A rename, so a session starting now sees the old file or the whole
      # new one.
      Move-Item -LiteralPath $part -Destination $binary -Force
    } finally {
      if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }
    }
  }
  $lock = Lock-Switch
  try {
    Set-Link 'next' $version
  } finally {
    $lock.Dispose()
  }
}

function Use-Release([string] $version) {
  if (-not (Test-Version $version)) { Fail 'Invalid version' 2 }
  $lock = Lock-Switch
  try {
    # Checked under the lock: another build may have pruned it meanwhile.
    if (-not (Test-Path -LiteralPath (Join-Path $dir "$version\claude.exe"))) {
      Fail "Claude Code $version is no longer downloaded"
    }
    $previous = Read-Current
    Set-Link 'current' $version
    $text = Join-Path $dir "current.txt.$PID"
    [IO.File]::WriteAllText($text, $version)
    Move-Item -LiteralPath $text -Destination (Join-Path $dir 'current.txt') -Force
    # Keep the new release, the one before it to fall back to, and any newer
    # one, which another build may be testing; remove the rest. A release a
    # session is still running cannot be deleted, so it waits for a later
    # switch.
    foreach ($entry in [IO.Directory]::GetDirectories($dir)) {
      $name = [IO.Path]::GetFileName($entry)
      if (-not (Test-Version $name) -or (Test-Link $entry)) { continue }
      if ($name -eq $version -or $name -eq $previous -or (Test-Newer $name $version)) {
        continue
      }
      try {
        # The program first: if it is running, nothing else is touched.
        $program = Join-Path $entry 'claude.exe'
        if (Test-Path -LiteralPath $program) { Remove-Item -LiteralPath $program -Force }
        Remove-Item -LiteralPath $entry -Recurse -Force
      } catch {
        [Console]::Error.WriteLine("Kept Claude Code ${name}: it is in use")
      }
    }
  } finally {
    $lock.Dispose()
  }
}

try {
  if ($args.Count -lt 1) { Fail 'Unknown command: ' 2 }
  $command = $args[0]
  $rest = @($args | Select-Object -Skip 1)
  switch ($command) {
    'install' {
      if ($rest.Count -ne 3) { Fail 'install needs VERSION PLATFORM SHA256' 2 }
      Install-Release $rest[0] $rest[1] $rest[2]
    }
    'use' {
      if ($rest.Count -ne 1) { Fail 'use needs VERSION' 2 }
      Use-Release $rest[0]
    }
    default { Fail "Unknown command: $command" 2 }
  }
} catch {
  Fail $_.Exception.Message
}
exit 0
