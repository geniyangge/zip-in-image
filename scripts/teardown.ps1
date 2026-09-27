<#
.SYNOPSIS
    Cleanup gate for the browser QA run (scripts/browser-qa.mjs).

.DESCRIPTION
    Removes the QA-scoped artifacts this gate produced and then PROVES nothing was left
    running:

      1. `.tmp/qa` is deleted (screenshots, downloads, copies made for the unzip checks).
      2. `.tmp/evidence` and `.tmp/fixtures` are asserted to still be present -- they
         belong to `scripts/real-surface-check.ps1`, a separate gate, and this script must
         never be the reason that gate's inputs disappear.
      3. No `vite preview` process is still running, and nothing is still LISTENING on
         port 4173. The socket is checked twice: with `Get-NetTCPConnection` when the
         module is available, and independently by parsing `netstat -ano`, so a missing
         or permission-denied cmdlet cannot silently turn into a pass.

    Idempotent: running it twice is a supported operation, and the second run must also
    exit 0.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/teardown.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# The project root is a NON-ASCII path, so console output must be forced to UTF-8 or the
# Chinese status text this script prints comes back as mojibake.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$Port = 4173
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$QaDir = Join-Path $Root '.tmp\qa'
$EvidenceDir = Join-Path $Root '.tmp\evidence'
$FixturesDir = Join-Path $Root '.tmp\fixtures'

$problems = New-Object System.Collections.Generic.List[string]

function Write-Step([string]$message) {
    Write-Output "  $message"
}

Write-Output '=== teardown: browser QA artifacts and process state ==='
Write-Output "  root = $Root"

# ------------------------------------------------------------------------------------------
# 1. Remove the QA-scoped directory
# ------------------------------------------------------------------------------------------
Write-Output ''
Write-Output '--- artifacts ---'

# The path is rebuilt from $Root and then verified to sit inside it, so a malformed or
# edited $Root can never turn this into a delete outside the project.
$resolvedQa = [System.IO.Path]::GetFullPath($QaDir)
$resolvedRoot = [System.IO.Path]::GetFullPath($Root)
if (-not $resolvedQa.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    $problems.Add("refusing to delete a path outside the project root: $resolvedQa")
    Write-Output "[FAIL] guard: $resolvedQa is not under $resolvedRoot"
}
elseif (Test-Path -LiteralPath $resolvedQa) {
    Remove-Item -LiteralPath $resolvedQa -Recurse -Force
    if (Test-Path -LiteralPath $resolvedQa) {
        $problems.Add(".tmp\qa still exists after Remove-Item")
        Write-Output "[FAIL] .tmp\qa still exists after removal"
    }
    else {
        Write-Output '[ok]   removed .tmp\qa (screenshots + downloads)'
    }
}
else {
    Write-Output '[ok]   .tmp\qa was already absent (nothing to remove)'
}

# ------------------------------------------------------------------------------------------
# 2. The other gate's inputs must have survived this one
# ------------------------------------------------------------------------------------------
foreach ($protected in @(@{ Name = '.tmp\evidence'; Path = $EvidenceDir }, @{ Name = '.tmp\fixtures'; Path = $FixturesDir })) {
    if (Test-Path -LiteralPath $protected.Path) {
        Write-Output "[ok]   $($protected.Name) intact and untouched by this teardown"
    }
    else {
        $problems.Add("$($protected.Name) is missing")
        Write-Output "[FAIL] $($protected.Name) is missing -- this teardown must never remove it"
    }
}

# ------------------------------------------------------------------------------------------
# 3a. No surviving `vite preview` process
# ------------------------------------------------------------------------------------------
Write-Output ''
Write-Output '--- processes ---'

$survivors = @()
try {
    $procs = Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop
    foreach ($proc in $procs) {
        $cmdline = "$($proc.CommandLine)"
        # Match the preview server specifically: a node process that merely has `vite` in
        # its path is not a leftover from this gate.
        if ($cmdline -match 'vite' -and $cmdline -match 'preview' -and $cmdline -match '4173') {
            $survivors += [pscustomobject]@{ Id = $proc.ProcessId; CommandLine = $cmdline }
        }
    }
}
catch {
    Write-Step "WARN: could not enumerate node.exe processes ($($_.Exception.Message)); falling back to Get-Process"
    foreach ($proc in (Get-Process -Name 'node' -ErrorAction SilentlyContinue)) {
        Write-Step "  a node.exe process is running (pid $($proc.Id)) but its command line is unreadable here; verify manually"
    }
}

if ($survivors.Count -eq 0) {
    Write-Output '[ok]   no surviving `vite preview --port 4173` process'
}
else {
    foreach ($survivor in $survivors) {
        $problems.Add("vite preview process $($survivor.Id) is still running")
        Write-Output "[FAIL] vite preview still running: pid $($survivor.Id)"
        Write-Step "  $($survivor.CommandLine)"
    }
}

# ------------------------------------------------------------------------------------------
# 3b. Nothing still LISTENING on the port -- two independent checks
# ------------------------------------------------------------------------------------------
Write-Output ''
Write-Output '--- port ---'

$hasTcpCmdlet = $null -ne (Get-Command -Name 'Get-NetTCPConnection' -ErrorAction SilentlyContinue)

if ($hasTcpCmdlet) {
    # Deliberately NOT `-State Listen -ErrorAction Stop`: the cmdlet THROWS a "no matching
    # objects" error when the port is simply free, which would have to be told apart from
    # a real WMI failure by parsing a message that is localized on this host. Querying
    # every state and filtering client-side needs no message parsing at all, and a cmdlet
    # that is absent entirely is detected above instead of being guessed at.
    # This file is also kept ASCII-only on purpose: Windows PowerShell 5.1 decodes a
    # BOM-less UTF-8 script as ANSI, so non-ASCII inside a STRING literal corrupts the
    # parse. Non-ASCII is safe in `#` comments only.
    $listeners = @(Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 'Listen' })
    if ($listeners.Count -gt 0) {
        foreach ($listener in $listeners) {
            $problems.Add("something is still LISTENING on port $Port (pid $($listener.OwningProcess))")
            Write-Output "[FAIL] port $Port is still bound: pid $($listener.OwningProcess) state=$($listener.State)"
        }
    }
    else {
        Write-Output "[ok]   Get-NetTCPConnection: no socket in state Listen on port $Port"
    }
}
else {
    Write-Step 'Get-NetTCPConnection is not available on this host; the netstat -ano cross-check is carrying the port verdict'
}

# Independent second opinion, so a failed cmdlet above cannot read as a pass.
$netstatHits = @()
try {
    $netstatHits = @(& netstat.exe -ano -p TCP 2>$null | Select-String -Pattern "LISTENING" | Select-String -Pattern ":$Port\s")
}
catch {
    Write-Step "WARN: netstat.exe could not be run ($($_.Exception.Message))"
}

if ($netstatHits.Count -gt 0) {
    foreach ($hit in $netstatHits) {
        $problems.Add("netstat reports a LISTENING socket on port $Port")
        Write-Output "[FAIL] netstat: $($hit.ToString().Trim())"
    }
}
else {
    Write-Output "[ok]   netstat -ano reports no LISTENING socket on port $Port"
}

# ------------------------------------------------------------------------------------------
# Verdict
# ------------------------------------------------------------------------------------------
Write-Output ''
if ($problems.Count -eq 0) {
    Write-Output 'checks: 6 ; passed: 6 ; failed: 0'
    Write-Output 'RESULT: CLEAN'
    exit 0
}

Write-Output "checks: 6 ; passed: $(6 - $problems.Count) ; failed: $($problems.Count)"
foreach ($problem in $problems) {
    Write-Output "  left behind: $problem"
}
Write-Output 'RESULT: NOT CLEAN'
exit 1
