<#
.SYNOPSIS
  Show the @qbot/dsh-agent install status in the DeepSeek Harness desktop profile.

.DESCRIPTION
  Read-only status report:
    * whether the DeepSeek Harness app is running and whether the profile lock
      file is present (the app writes <ProfileDir>\lock during plugin
      operations);
    * profile dependencies and dsh.profile.bundles;
    * whether node_modules\@qbot\dsh-agent exists, its version, and where it
      points (junction target, or hard-linked source paths);
    * whether the installed snapshot is up to date with the source bundle;
    * the skills seeded into <DSH home>\skills.

  Exit code: 0 when the bundle is installed and registered, 1 otherwise.

.PARAMETER InstallDir
  DeepSeek Harness install directory. Default: D:\klein\code_agent\dsh

.PARAMETER ProfileDir
  DSH desktop profile directory.
  Default: %USERPROFILE%\.dsh\profiles\desktop

.PARAMETER PluginDir
  Source bundle directory used for the up-to-date check. Default: <repo>\agent

.PARAMETER SkillsDir
  Where skills are seeded. Default: %USERPROFILE%\.dsh\skills

.EXAMPLE
  .\status-dsh-plugin.ps1
#>
[CmdletBinding()]
param(
    [string]$InstallDir = 'D:\klein\code_agent\dsh',
    [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
    [string]$PluginDir,
    [string]$SkillsDir = (Join-Path $env:USERPROFILE '.dsh\skills')
)

$ErrorActionPreference = 'Continue'

if ([string]::IsNullOrWhiteSpace($PluginDir)) {
    $PluginDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'agent'
}

function Get-Prop {
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    $p = $Object.PSObject.Properties[$Name]
    if ($null -eq $p) { return $null }
    return $p.Value
}

function Get-TreeFingerprint {
    param([string]$Root)
    $rootFull = (Resolve-Path -LiteralPath $Root).ProviderPath.TrimEnd('\')
    $files = @(Get-ChildItem -LiteralPath $rootFull -Recurse -File -Force | Where-Object {
            $rel = $_.FullName.Substring($rootFull.Length).TrimStart('\')
            $rel -notmatch '^(node_modules)(\\|$)'
        } | Sort-Object FullName)
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($f in $files) {
        $rel = $f.FullName.Substring($rootFull.Length).TrimStart('\').Replace('\', '/')
        $h = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
        $lines.Add($rel + '=' + $h)
    }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hex = ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))) | ForEach-Object { $_.ToString('x2') }) -join ''
    }
    finally { $sha.Dispose() }
    return [pscustomobject]@{ Count = $files.Count; Hash = $hex }
}

function Write-Line {
    param([string]$Label, [string]$Value)
    Write-Host (('{0,-17}' -f ($Label + ':')) + ' ' + $Value)
}

function Get-HardLinkTargets {
    param([string]$InstalledDir)
    $probe = Join-Path $InstalledDir 'package.json'
    if (-not (Test-Path -LiteralPath $probe)) { return @() }
    $raw = & fsutil hardlink list $probe 2>&1
    $drives = @((Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }))
    $targets = @()
    foreach ($line in @($raw)) {
        $text = [string]$line
        if ([string]::IsNullOrWhiteSpace($text) -or (-not $text.StartsWith('\'))) { continue }
        foreach ($drive in $drives) {
            $cand = $drive + ':' + $text
            if (Test-Path -LiteralPath $cand) {
                if (-not ($cand.Equals($probe, [System.StringComparison]::OrdinalIgnoreCase))) { $targets += $cand }
                break
            }
        }
    }
    return @($targets | Select-Object -Unique)
}

Write-Host '=== @qbot/dsh-agent / DeepSeek Harness desktop status ===' -ForegroundColor Cyan

# --- app / install dir -----------------------------------------------------
$installFull = $null
if (Test-Path -LiteralPath $InstallDir) { $installFull = (Resolve-Path -LiteralPath $InstallDir).ProviderPath }
$appProcs = @()
if ($null -ne $installFull) {
    $appProcs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
            $_.ProcessName -eq 'DeepSeek Harness' -or ($_.Path -and $_.Path.StartsWith($installFull, [System.StringComparison]::OrdinalIgnoreCase))
        })
}
if ($appProcs.Count -eq 0) {
    $appProcs = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
}
if ($appProcs.Count -gt 0) {
    Write-Line 'App running' ('yes (' + $appProcs.Count + ' process(es); restart required after install/uninstall)')
}
else {
    Write-Line 'App running' 'no'
}
Write-Line 'InstallDir' $(if ($null -ne $installFull) { $installFull } else { 'NOT FOUND: ' + $InstallDir })
Write-Line 'PluginDir' $(if (Test-Path -LiteralPath $PluginDir) { (Resolve-Path -LiteralPath $PluginDir).ProviderPath } else { 'NOT FOUND: ' + $PluginDir })

# --- profile ---------------------------------------------------------------
$profileFull = $null
if (Test-Path -LiteralPath $ProfileDir) { $profileFull = (Resolve-Path -LiteralPath $ProfileDir).ProviderPath }
Write-Line 'ProfileDir' $(if ($null -ne $profileFull) { $profileFull } else { 'NOT FOUND: ' + $ProfileDir })
if ($null -eq $profileFull) {
    Write-Host 'STATUS: profile not found.' -ForegroundColor Red
    exit 1
}
$lockPath = Join-Path $profileFull 'lock'
Write-Line 'Lock file' $(if (Test-Path -LiteralPath $lockPath) { 'PRESENT (app mid-operation)' } else { 'absent' })

$manifestPath = Join-Path $profileFull 'package.json'
$pluginName = '@qbot/dsh-agent'
$manifest = $null
if (Test-Path -LiteralPath $manifestPath) {
    try {
        $manifest = (Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json)
        $manifestName = [string](Get-Prop $manifest 'name')
        Write-Line 'Profile manifest' ($manifestPath + ' (name=' + $manifestName + ')')
    }
    catch {
        Write-Line 'Profile manifest' ($manifestPath + '  [PARSE ERROR: ' + $_.Exception.Message + ']')
        exit 1
    }
}
else {
    Write-Line 'Profile manifest' ('NOT FOUND: ' + $manifestPath)
    exit 1
}

$depNames = @()
$depNode = Get-Prop $manifest 'dependencies'
if ($null -ne $depNode) { $depNames = @($depNode.PSObject.Properties | ForEach-Object { $_.Name } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) }
$bundles = @()
$bundleNode = Get-Prop (Get-Prop (Get-Prop $manifest 'dsh') 'profile') 'bundles'
if ($null -ne $bundleNode) { $bundles = @($bundleNode) }

Write-Line 'Dependencies' $(if ($depNames.Count -eq 0) { '(none)' } else { $depNames -join ', ' })
Write-Line 'Bundles' $(if ($bundles.Count -eq 0) { '(none)' } else { $bundles -join ', ' })
$depInstalled = $depNames -contains $pluginName
$bundleRegistered = $bundles -contains $pluginName
Write-Line $pluginName ('dependency=' + $depInstalled + ' bundleEntry=' + $bundleRegistered)

# --- installed package -----------------------------------------------------
$installedDir = Join-Path $profileFull 'node_modules\@qbot\dsh-agent'
$installedPkgPath = Join-Path $installedDir 'package.json'
$installedVersion = '(unknown)'
if (Test-Path -LiteralPath $installedPkgPath) {
    try {
        $installedPkg = (Get-Content -LiteralPath $installedPkgPath -Raw -Encoding UTF8 | ConvertFrom-Json)
        $installedVersion = [string](Get-Prop $installedPkg 'version')
        if ([string]::IsNullOrWhiteSpace($installedVersion)) { $installedVersion = '(no version)' }
        Write-Line 'Installed pkg' ($installedDir + ' (version ' + $installedVersion + ')')
    }
    catch {
        Write-Line 'Installed pkg' ($installedDir + '  [PARSE ERROR]')
    }
}
else {
    Write-Line 'Installed pkg' ('NOT FOUND: ' + $installedDir)
}

if (Test-Path -LiteralPath $installedDir) {
    $item = Get-Item -LiteralPath $installedDir -Force
    if ($item.LinkType) {
        Write-Line 'Link' ($item.LinkType + ' -> ' + (@($item.Target) -join ', '))
    }
    else {
        $targets = @(Get-HardLinkTargets $installedDir)
        if ($targets.Count -gt 0) {
            Write-Line 'Link' ('hard-linked to: ' + ($targets -join ', '))
        }
        else {
            Write-Line 'Link' 'copied snapshot (not hard-linked to the source; re-run install after editing the source)'
        }
    }
}

# --- snapshot freshness ----------------------------------------------------
$sourceOk = Test-Path -LiteralPath (Join-Path $PluginDir 'package.json')
if ((Test-Path -LiteralPath $installedPkgPath) -and $sourceOk) {
    $srcFp = Get-TreeFingerprint $PluginDir
    $dstFp = Get-TreeFingerprint $installedDir
    if ($srcFp.Hash -eq $dstFp.Hash) {
        Write-Line 'Snapshot' ('up to date (' + $dstFp.Count + ' files)')
    }
    else {
        Write-Line 'Snapshot' ('STALE (' + $dstFp.Count + ' installed files vs ' + $srcFp.Count + ' source files; re-run install-dsh-plugin.ps1)')
    }
}
elseif (-not $sourceOk) {
    Write-Line 'Snapshot' ('source bundle not found: ' + $PluginDir)
}
else {
    Write-Line 'Snapshot' 'not installed'
}

# --- skills ----------------------------------------------------------------
$pluginSkillNames = @()
if (Test-Path -LiteralPath (Join-Path $PluginDir 'skills')) {
    $pluginSkillNames = @(Get-ChildItem -LiteralPath (Join-Path $PluginDir 'skills') -Force | ForEach-Object { $_.Name })
}
if (Test-Path -LiteralPath $SkillsDir) {
    $present = @(Get-ChildItem -LiteralPath $SkillsDir -Force | Sort-Object Name | ForEach-Object { $_.Name })
    Write-Line 'SkillsDir' ($SkillsDir + ' (' + $present.Count + ' entries)')
    if ($present.Count -gt 0) {
        $described = foreach ($name in $present) {
            if ($pluginSkillNames -contains $name) { $name + ' [qbot]' } else { $name }
        }
        Write-Line 'Seeded skills' ($described -join ', ')
    }
    else {
        Write-Line 'Seeded skills' '(none)'
    }
}
else {
    Write-Line 'SkillsDir' ('NOT FOUND: ' + $SkillsDir)
}

# --- summary ---------------------------------------------------------------
if ($depInstalled -and $bundleRegistered) {
    Write-Host ('STATUS: installed (' + $pluginName + ' ' + $installedVersion + '). Restart the app to mount/unmount changes.') -ForegroundColor Green
    exit 0
}
else {
    Write-Host ('STATUS: not installed (dependency=' + $depInstalled + ', bundleEntry=' + $bundleRegistered + ').') -ForegroundColor Yellow
    exit 1
}
