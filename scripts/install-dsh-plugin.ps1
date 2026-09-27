<#
.SYNOPSIS
  Install the @qbot/dsh-agent bundle into the DeepSeek Harness desktop profile.

.DESCRIPTION
  Mirrors what the DSH desktop plugin manager does:

    1. runs pnpm with cwd = the profile directory and args
       "add file:<absolute PluginDir>" using the app's bundled node + pnpm;
    2. appends the bundle name to dsh.profile.bundles when the installed
       package declares dsh.bundle.patch.

  It also seeds the bundle's skills into <DSH home>\skills.

  Safety:
    * refuses to write while <ProfileDir>\lock exists (app mid-operation);
    * backs up package.json / pnpm-lock.yaml / pnpm-workspace.yaml /
      cordis.patch.yml to <ProfileDir>\backups\<timestamp>\ before writing;
    * restores those files if anything fails;
    * -DryRun prints the exact commands and every file path it would touch,
      without writing anything.

  pnpm note: for "file:" dependencies pnpm creates HARD LINKS from the profile
  to the source directory. Files edited in place are shared automatically, but
  files that are added or replaced afterwards are not refreshed by a plain
  "pnpm add" (it reports "Already up to date"). When the source fingerprint
  differs from the installed snapshot this script refreshes the links with
  "pnpm remove @qbot/dsh-agent" followed by "pnpm add file:<dir>".

.PARAMETER InstallDir
  DeepSeek Harness install directory (contains "DeepSeek Harness.exe" and
  resources\runtime). Default: D:\klein\code_agent\dsh

.PARAMETER ProfileDir
  DSH desktop profile directory.
  Default: %USERPROFILE%\.dsh\profiles\desktop

.PARAMETER PluginDir
  The @qbot/dsh-agent bundle directory. Default: <repo>\agent

.PARAMETER SkillsDir
  Destination for seeded skills. Default: %USERPROFILE%\.dsh\skills
  Override it when DSH_HOME is not the default, or for scratch-profile tests.

.PARAMETER DryRun
  Print the plan and exit without writing anything.

.PARAMETER SkipSkills
  Do not copy the bundle's skills into SkillsDir.

.PARAMETER Force
  Refresh the pnpm install even when the installed snapshot already matches.

.PARAMETER TestFailAt
  Test hook (default None). "AfterBackup" / "AfterPnpm" force a failure at
  that point so the rollback path can be verified against a scratch profile.

.EXAMPLE
  .\install-dsh-plugin.ps1 -DryRun
.EXAMPLE
  .\install-dsh-plugin.ps1
.EXAMPLE
  .\install-dsh-plugin.ps1 -ProfileDir $env:TEMP\scratch-profile -SkillsDir $env:TEMP\scratch-skills
#>
[CmdletBinding()]
param(
    [string]$InstallDir = 'D:\klein\code_agent\dsh',
    [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
    [string]$PluginDir,
    [string]$SkillsDir = (Join-Path $env:USERPROFILE '.dsh\skills'),
    [switch]$DryRun,
    [switch]$SkipSkills,
    [switch]$Force,
    [ValidateSet('None', 'AfterBackup', 'AfterPnpm')]
    [string]$TestFailAt = 'None'
)

$ErrorActionPreference = 'Stop'

$script:TrackedFiles = @('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml')
$script:FileExistedBefore = @{}
$script:SkillState = @{}
$script:SourceFingerprint = $null

# ---------------------------------------------------------------------------
# output helpers
# ---------------------------------------------------------------------------
function Write-Step {
    param([string]$Message)
    Write-Host ("`n[install] " + $Message) -ForegroundColor Cyan
}
function Write-Detail {
    param([string]$Message)
    Write-Host ("          " + $Message)
}
function Write-Plan {
    param([string]$Message)
    Write-Host ("[dry-run] " + $Message) -ForegroundColor DarkCyan
}
function Write-Warn {
    param([string]$Message)
    Write-Host ("[warn]    " + $Message) -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# generic helpers
# ---------------------------------------------------------------------------
function Resolve-ExistingPath {
    param([string]$Path, [string]$Label)
    if ([string]::IsNullOrWhiteSpace($Path)) { throw "$Label path is empty." }
    if (-not (Test-Path -LiteralPath $Path)) { throw "$Label not found: $Path" }
    return (Resolve-Path -LiteralPath $Path).ProviderPath
}

function Get-Prop {
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    $p = $Object.PSObject.Properties[$Name]
    if ($null -eq $p) { return $null }
    return $p.Value
}

function ConvertTo-JsonText {
    param([string]$Value)
    $sb = New-Object System.Text.StringBuilder
    foreach ($ch in $Value.ToCharArray()) {
        $code = [int][char]$ch
        switch ($code) {
            34 { [void]$sb.Append('\"') }
            92 { [void]$sb.Append('\\') }
            8  { [void]$sb.Append('\b') }
            12 { [void]$sb.Append('\f') }
            10 { [void]$sb.Append('\n') }
            13 { [void]$sb.Append('\r') }
            9  { [void]$sb.Append('\t') }
            default {
                if ($code -lt 32) { [void]$sb.Append('\u' + $code.ToString('x4')) }
                else { [void]$sb.Append($ch) }
            }
        }
    }
    return $sb.ToString()
}

function ConvertTo-PrettyJson {
    param($Value, [int]$Indent = 0)
    $pad = ' ' * $Indent
    $pad2 = ' ' * ($Indent + 2)
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [bool]) { if ($Value) { return 'true' } else { return 'false' } }
    if ($Value -is [string]) { return '"' + (ConvertTo-JsonText $Value) + '"' }
    if ($Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal] -or $Value -is [single]) {
        return [System.Convert]::ToString($Value, [System.Globalization.CultureInfo]::InvariantCulture)
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $keys = @($Value.Keys)
        if ($keys.Count -eq 0) { return '{}' }
        $parts = foreach ($k in $keys) {
            $pad2 + '"' + (ConvertTo-JsonText ([string]$k)) + '": ' + (ConvertTo-PrettyJson $Value[$k] ($Indent + 2))
        }
        return '{' + "`n" + ($parts -join (',' + "`n")) + "`n" + $pad + '}'
    }
    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        $props = @($Value.PSObject.Properties)
        if ($props.Count -eq 0) { return '{}' }
        $parts = foreach ($p in $props) {
            $pad2 + '"' + (ConvertTo-JsonText $p.Name) + '": ' + (ConvertTo-PrettyJson $p.Value ($Indent + 2))
        }
        return '{' + "`n" + ($parts -join (',' + "`n")) + "`n" + $pad + '}'
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        $items = @($Value)
        if ($items.Count -eq 0) { return '[]' }
        $parts = foreach ($it in $items) {
            $pad2 + (ConvertTo-PrettyJson $it ($Indent + 2))
        }
        return '[' + "`n" + ($parts -join (',' + "`n")) + "`n" + $pad + ']'
    }
    return '"' + (ConvertTo-JsonText ([string]$Value)) + '"'
}

function Write-TextNoBom {
    param([string]$Path, [string]$Text)
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $enc)
}

function Read-JsonFile {
    param([string]$Path)
    $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    return [pscustomobject]@{ Raw = $raw; Value = ($raw | ConvertFrom-Json) }
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
        $bytes = [Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))
        $hex = ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join ''
    }
    finally { $sha.Dispose() }
    return [pscustomobject]@{ Count = $files.Count; Hash = $hex }
}

function Get-PluginPatchDeclaration {
    param($PackageJson)
    $patch = Get-Prop (Get-Prop (Get-Prop $PackageJson 'dsh') 'bundle') 'patch'
    if ($null -eq $patch) { return $null }
    if ($patch -is [string]) {
        if ([string]::IsNullOrWhiteSpace($patch)) { return $null }
        return @($patch)
    }
    $list = @()
    foreach ($item in @($patch)) {
        if (-not [string]::IsNullOrWhiteSpace([string]$item)) { $list += [string]$item }
    }
    if ($list.Count -eq 0) { return $null }
    return $list
}

# ---------------------------------------------------------------------------
# backup / rollback
# ---------------------------------------------------------------------------
function New-BackupDir {
    param([string]$ProfileFull)
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $root = Join-Path $ProfileFull 'backups'
    $dir = Join-Path $root $stamp
    $n = 1
    while (Test-Path -LiteralPath $dir) {
        $dir = Join-Path $root ($stamp + '-' + $n)
        $n++
    }
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    return $dir
}

function Backup-ProfileFiles {
    param([string]$ProfileFull, [string]$BackupDir)
    $backed = @()
    foreach ($name in $script:TrackedFiles) {
        $src = Join-Path $ProfileFull $name
        $exists = Test-Path -LiteralPath $src -PathType Leaf
        $script:FileExistedBefore[$name] = $exists
        if ($exists) {
            Copy-Item -LiteralPath $src -Destination (Join-Path $BackupDir $name) -Force
            $backed += $name
        }
    }
    return $backed
}

function Backup-SkillDirs {
    param([string]$BackupDir, [string]$SkillsFull, [string[]]$SkillNames)
    $skillRoot = Join-Path $BackupDir 'skills'
    foreach ($name in $SkillNames) {
        $dest = Join-Path $SkillsFull $name
        $existed = Test-Path -LiteralPath $dest
        $state = [pscustomobject]@{ ExistedBefore = $existed; BackupPath = $null }
        if ($existed) {
            if (-not (Test-Path -LiteralPath $skillRoot)) { New-Item -ItemType Directory -Path $skillRoot -Force | Out-Null }
            $b = Join-Path $skillRoot $name
            Copy-Item -LiteralPath $dest -Destination $b -Recurse -Force
            $state.BackupPath = $b
        }
        $script:SkillState[$name] = $state
    }
}

function Invoke-Rollback {
    param([string]$BackupDir, [string]$ProfileFull, [string]$SkillsFull)
    Write-Host ("`n[rollback] restoring pre-run state from " + $BackupDir) -ForegroundColor Yellow
    foreach ($name in $script:TrackedFiles) {
        $dest = Join-Path $ProfileFull $name
        $src = Join-Path $BackupDir $name
        try {
            if (Test-Path -LiteralPath $src -PathType Leaf) {
                if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue }
                Copy-Item -LiteralPath $src -Destination $dest -Force
                Write-Host ("[rollback] restored " + $dest)
            }
            elseif ($script:FileExistedBefore.ContainsKey($name) -and (-not $script:FileExistedBefore[$name])) {
                if (Test-Path -LiteralPath $dest) {
                    Remove-Item -LiteralPath $dest -Force
                    Write-Host ("[rollback] removed " + $dest + " (did not exist before)")
                }
            }
        }
        catch { Write-Host ("[rollback][FAIL] " + $name + ": " + $_.Exception.Message) -ForegroundColor Red }
    }
    foreach ($name in @($script:SkillState.Keys)) {
        $state = $script:SkillState[$name]
        $dest = Join-Path $SkillsFull $name
        try {
            if ($state.ExistedBefore -and $state.BackupPath) {
                if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
                Copy-Item -LiteralPath $state.BackupPath -Destination $dest -Recurse -Force
                Write-Host ("[rollback] restored skill " + $dest)
            }
            elseif (Test-Path -LiteralPath $dest) {
                Remove-Item -LiteralPath $dest -Recurse -Force
                Write-Host ("[rollback] removed skill " + $dest + " (did not exist before)")
            }
        }
        catch { Write-Host ("[rollback][FAIL] skill " + $name + ": " + $_.Exception.Message) -ForegroundColor Red }
    }
}

# ---------------------------------------------------------------------------
# pnpm / manifest / skills
# ---------------------------------------------------------------------------
function Invoke-Pnpm {
    param(
        [string[]]$PnpmArgs,
        [string]$ProfileFull,
        [string]$NodeCmd,
        [string]$PnpmEntry,
        [string]$AppExe,
        [string]$LogPath
    )
    Write-Host ("    cwd " + $ProfileFull)
    Write-Host ("    node pnpm.mjs " + ($PnpmArgs -join ' '))
    $oldEnv = $env:DSH_DESKTOP_NODE_EXECUTABLE
    $env:DSH_DESKTOP_NODE_EXECUTABLE = $AppExe
    $lines = New-Object System.Collections.Generic.List[string]
    $prevEap = $ErrorActionPreference
    $exitCode = -1
    Push-Location -LiteralPath $ProfileFull
    try {
        # native stderr must not terminate the script; capture it instead
        $ErrorActionPreference = 'Continue'
        & $NodeCmd $PnpmEntry @PnpmArgs 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) {
                if ($_.Exception -and $_.Exception.Message) { $lines.Add($_.Exception.Message) } else { $lines.Add($_.ToString()) }
            }
            else { $lines.Add([string]$_) }
        }
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $prevEap
        Pop-Location
        if ($null -eq $oldEnv) { Remove-Item Env:\DSH_DESKTOP_NODE_EXECUTABLE -ErrorAction SilentlyContinue }
        else { $env:DSH_DESKTOP_NODE_EXECUTABLE = $oldEnv }
    }
    foreach ($l in $lines) { Write-Host ("    " + $l) }
    if ($LogPath) { Write-TextNoBom $LogPath (($lines -join "`r`n") + "`r`n") }
    return $exitCode
}

function Add-BundleToManifest {
    param([string]$ManifestPath, [string]$BundleName)
    $read = Read-JsonFile $ManifestPath
    $manifest = $read.Value
    if ($null -eq (Get-Prop $manifest 'dsh')) {
        $manifest | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{})
    }
    if ($null -eq (Get-Prop $manifest.dsh 'profile')) {
        $manifest.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{})
    }
    if ($null -eq (Get-Prop $manifest.dsh.profile 'bundles')) {
        $manifest.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @()
    }
    $bundles = @($manifest.dsh.profile.bundles)
    if ($bundles -contains $BundleName) { return $false }
    $manifest.dsh.profile.bundles = @($bundles + $BundleName)
    $json = ConvertTo-PrettyJson $manifest 0
    if ($read.Raw.EndsWith("`n")) { $json += "`n" }
    Write-TextNoBom $ManifestPath $json
    return $true
}

function Copy-PluginSkills {
    param([string]$SkillsSource, [string]$SkillsFull, [string[]]$SkillNames)
    if (-not (Test-Path -LiteralPath $SkillsFull)) {
        New-Item -ItemType Directory -Path $SkillsFull -Force | Out-Null
        Write-Detail ("created " + $SkillsFull)
    }
    foreach ($name in $SkillNames) {
        $src = Join-Path $SkillsSource $name
        $dst = Join-Path $SkillsFull $name
        $existed = Test-Path -LiteralPath $dst
        if (Test-Path -LiteralPath $src -PathType Container) {
            if (-not (Test-Path -LiteralPath $dst)) { New-Item -ItemType Directory -Path $dst -Force | Out-Null }
            $children = @(Get-ChildItem -LiteralPath $src -Force)
            if ($children.Count -gt 0) {
                Copy-Item -Path (Join-Path $src '*') -Destination $dst -Recurse -Force
            }
        }
        else {
            Copy-Item -LiteralPath $src -Destination $dst -Force
        }
        $note = if ($existed) { ' (overwrote; previous copy backed up)' } else { '' }
        Write-Detail ("copied skill " + $name + " -> " + $dst + $note)
    }
}

function Test-SkillsUpToDate {
    param([string]$SkillsSource, [string]$SkillsFull, [string[]]$SkillNames)
    foreach ($name in $SkillNames) {
        $src = Join-Path $SkillsSource $name
        $dst = Join-Path $SkillsFull $name
        if (-not (Test-Path -LiteralPath $dst)) { return $false }
        if (Test-Path -LiteralPath $src -PathType Container) {
            if ((Get-TreeFingerprint $src).Hash -ne (Get-TreeFingerprint $dst).Hash) { return $false }
        }
        else {
            if ((Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash) { return $false }
        }
    }
    return $true
}

# ===========================================================================
# main
# ===========================================================================
if ([string]::IsNullOrWhiteSpace($PluginDir)) {
    $PluginDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'agent'
}

$backupDir = $null
try {
    Write-Step 'Preflight'
    $installFull = Resolve-ExistingPath $InstallDir 'InstallDir'
    if (-not (Test-Path -LiteralPath $installFull -PathType Container)) { throw "InstallDir is not a directory: $installFull" }
    $nodeCmd = Join-Path $installFull 'resources\runtime\bin\node.cmd'
    $pnpmEntry = Join-Path $installFull 'resources\runtime\pnpm\bin\pnpm.mjs'
    $appExe = Join-Path $installFull 'DeepSeek Harness.exe'
    foreach ($runtimeFile in @($nodeCmd, $pnpmEntry, $appExe)) {
        if (-not (Test-Path -LiteralPath $runtimeFile -PathType Leaf)) {
            throw "Missing DeepSeek Harness runtime file: $runtimeFile"
        }
    }

    $profileFull = Resolve-ExistingPath $ProfileDir 'ProfileDir'
    if (-not (Test-Path -LiteralPath $profileFull -PathType Container)) { throw "ProfileDir is not a directory: $profileFull" }
    $manifestPath = Join-Path $profileFull 'package.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "Profile manifest not found: $manifestPath" }
    $lockPath = Join-Path $profileFull 'lock'
    if (Test-Path -LiteralPath $lockPath) {
        throw "Profile is locked (the app is mid-operation): $lockPath exists. Wait for the app to finish, then retry."
    }

    $pluginFull = Resolve-ExistingPath $PluginDir 'PluginDir'
    $pluginPkgPath = Join-Path $pluginFull 'package.json'
    if (-not (Test-Path -LiteralPath $pluginPkgPath -PathType Leaf)) { throw "Plugin package.json not found: $pluginPkgPath" }
    $pluginPkg = (Read-JsonFile $pluginPkgPath).Value
    $pluginName = [string]$pluginPkg.name
    if ($pluginName -ne '@qbot/dsh-agent') {
        throw "Refusing to install: $pluginPkgPath declares name '$pluginName', expected '@qbot/dsh-agent'."
    }
    $patchFiles = Get-PluginPatchDeclaration $pluginPkg
    if ($null -eq $patchFiles) {
        throw "Refusing to install: $pluginPkgPath does not declare dsh.bundle.patch (not a DSH profile bundle)."
    }
    foreach ($pf in $patchFiles) {
        $pfPath = Join-Path $pluginFull $pf
        if (-not (Test-Path -LiteralPath $pfPath -PathType Leaf)) {
            throw "Bundle patch file declared in package.json is missing: $pfPath"
        }
    }

    Write-Detail ("InstallDir : " + $installFull)
    Write-Detail ("ProfileDir : " + $profileFull)
    Write-Detail ("PluginDir  : " + $pluginFull)
    Write-Detail ("SkillsDir  : " + $SkillsDir)
    Write-Detail ("Bundle     : " + $pluginName + " " + [string]$pluginPkg.version)
    Write-Detail ("Patches    : " + ($patchFiles -join ', '))
    Write-Detail ("Lock       : not present (ok)")
    if ($TestFailAt -ne 'None') { Write-Warn ("TestFailAt=" + $TestFailAt + " is a test hook; use only on scratch profiles.") }

    $script:SourceFingerprint = Get-TreeFingerprint $pluginFull
    $manifest = (Read-JsonFile $manifestPath).Value
    $depNames = @()
    $depNode = Get-Prop $manifest 'dependencies'
    if ($null -ne $depNode) { $depNames = @($depNode.PSObject.Properties | ForEach-Object { $_.Name } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) }
    $depInstalled = $depNames -contains $pluginName
    $bundleNode = Get-Prop (Get-Prop (Get-Prop $manifest 'dsh') 'profile') 'bundles'
    $bundles = @()
    if ($null -ne $bundleNode) { $bundles = @($bundleNode) }
    $bundleRegistered = $bundles -contains $pluginName

    $installedDir = Join-Path $profileFull 'node_modules\@qbot\dsh-agent'
    $installedPkgPath = Join-Path $installedDir 'package.json'
    $snapshotMatches = $false
    if (Test-Path -LiteralPath $installedPkgPath -PathType Leaf) {
        $installedFp = Get-TreeFingerprint $installedDir
        if ($installedFp.Hash -eq $script:SourceFingerprint.Hash) { $snapshotMatches = $true }
    }
    $needsPnpm = $Force -or (-not $snapshotMatches) -or (-not $depInstalled)
    $needsRemoveFirst = $depInstalled -and $needsPnpm

    $skillsSource = Join-Path $pluginFull 'skills'
    $skillNames = @()
    if (Test-Path -LiteralPath $skillsSource -PathType Container) {
        $skillNames = @(Get-ChildItem -LiteralPath $skillsSource -Force | Sort-Object Name | ForEach-Object { $_.Name })
    }
    $skillsNeedCopy = $false
    if ((-not $SkipSkills) -and $skillNames.Count -gt 0) {
        $skillsNeedCopy = -not (Test-SkillsUpToDate $skillsSource $SkillsDir $skillNames)
    }
    $needsSkills = (-not $SkipSkills) -and $skillNames.Count -gt 0 -and $skillsNeedCopy
    $isNoOp = (-not $needsPnpm) -and $bundleRegistered -and (-not $needsSkills)

    Write-Detail ("Installed  : dependency=" + $depInstalled + " bundleEntry=" + $bundleRegistered + " snapshotMatches=" + $snapshotMatches)
    if ($SkipSkills) { Write-Detail "Skills     : skipped (-SkipSkills)" }
    elseif ($skillNames.Count -eq 0) { Write-Detail "Skills     : none found in $skillsSource" }
    else { Write-Detail ("Skills     : " + ($skillNames -join ', ') + " (upToDate=" + (-not $skillsNeedCopy) + ")") }

    if ($DryRun) {
        Write-Step 'DRY RUN - printing the plan, nothing will be written'
        if ($isNoOp) {
            Write-Plan 'nothing to do: snapshot matches, bundle already registered, skills up to date'
        }
        else {
            if ($needsPnpm) {
                if ($needsRemoveFirst) {
                    Write-Plan ("RUN  cwd=" + $profileFull)
                    Write-Plan ("     & `"" + $nodeCmd + "`" `"" + $pnpmEntry + "`" remove " + $pluginName)
                }
                Write-Plan ("RUN  cwd=" + $profileFull + "  env DSH_DESKTOP_NODE_EXECUTABLE=" + $appExe)
                Write-Plan ("     & `"" + $nodeCmd + "`" `"" + $pnpmEntry + "`" add `"file:" + $pluginFull + "`" --offline")
            }
            else {
                Write-Plan 'SKIP pnpm (installed snapshot fingerprint matches the source)'
            }
            Write-Plan ('BACKUP dir: ' + (Join-Path (Join-Path $profileFull 'backups') '<timestamp>'))
            foreach ($name in $script:TrackedFiles) {
                $exists = Test-Path -LiteralPath (Join-Path $profileFull $name) -PathType Leaf
                $label = if ($exists) { 'copy  ' } else { 'absent' }
                Write-Plan ('  ' + $label + ' ' + (Join-Path $profileFull $name))
            }
            if ($bundleRegistered) {
                Write-Plan ('MANIFEST no change: dsh.profile.bundles already contains ' + $pluginName)
            }
            else {
                Write-Plan ('MANIFEST append ' + $pluginName + ' to dsh.profile.bundles in ' + $manifestPath)
            }
            if ($needsPnpm) {
                Write-Plan ('WRITE ' + (Join-Path $profileFull 'package.json') + ' (rewritten by pnpm)')
                Write-Plan ('WRITE ' + (Join-Path $profileFull 'pnpm-lock.yaml') + ' (pnpm)')
                Write-Plan ('WRITE ' + $installedDir + '\** (pnpm snapshot: hard links on the same volume, otherwise copies)')
                Write-Plan ('WRITE ' + (Join-Path $profileFull 'node_modules\.modules.yaml') + ' (pnpm metadata)')
                Write-Plan ('WRITE ' + (Join-Path $profileFull 'node_modules\.pnpm-workspace-state-v1.json') + ' (pnpm metadata)')
            }
            if ($SkipSkills) { Write-Plan 'SKILLS skipped (-SkipSkills)' }
            elseif ($skillNames.Count -eq 0) { Write-Plan ('SKILLS none found in ' + $skillsSource) }
            else {
                foreach ($name in $skillNames) {
                    $dst = Join-Path $SkillsDir $name
                    $note = if (Test-Path -LiteralPath $dst) { ' (existing copy backed up first)' } else { '' }
                    if (-not $skillsNeedCopy) { $note = ' (up to date; skipped)' }
                    Write-Plan ('SKILLS copy ' + (Join-Path $skillsSource $name) + ' -> ' + $dst + $note)
                }
            }
            Write-Plan 'POST-CHECK re-read manifest; verify dependency + bundle entry + installed package'
        }
        Write-Host "`n[dry-run] no files were written." -ForegroundColor Green
        exit 0
    }

    if ($isNoOp) {
        Write-Step 'Already up to date'
        Write-Detail ($pluginName + " is installed, registered and the skills are current.")
        Write-Host "`n[install] nothing to do." -ForegroundColor Green
        exit 0
    }

    Write-Step 'Backing up profile files'
    $backupDir = New-BackupDir $profileFull
    $backedFiles = Backup-ProfileFiles $profileFull $backupDir
    if (-not $SkipSkills) { Backup-SkillDirs $backupDir $SkillsDir $skillNames }
    $backupInfo = [ordered]@{
        tool              = 'install-dsh-plugin.ps1'
        timestamp         = (Get-Date).ToString('o')
        pluginName        = $pluginName
        pluginVersion     = [string]$pluginPkg.version
        pluginDir         = $pluginFull
        profileDir        = $profileFull
        skillsDir         = $SkillsDir
        patchFiles        = @($patchFiles)
        filesBackedUp     = @($backedFiles)
        skillState        = $script:SkillState
        sourceFingerprint = $script:SourceFingerprint
    }
    Write-TextNoBom (Join-Path $backupDir 'backup.json') ((ConvertTo-PrettyJson $backupInfo 0) + "`n")
    Write-Detail ("backup: " + $backupDir)
    if ($backedFiles.Count -gt 0) { Write-Detail ("backed up: " + ($backedFiles -join ', ')) }

    if ($TestFailAt -eq 'AfterBackup') { throw 'Simulated failure after backup (TestFailAt=AfterBackup).' }

    if (Test-Path -LiteralPath $lockPath) { throw "Profile lock appeared while running: $lockPath" }

    Write-Step 'Installing bundle with pnpm'
    if ($needsPnpm) {
        if ($needsRemoveFirst) {
            $removeLog = Join-Path $backupDir 'pnpm-remove.log'
            $code = Invoke-Pnpm -PnpmArgs @('remove', $pluginName) -ProfileFull $profileFull -NodeCmd $nodeCmd -PnpmEntry $pnpmEntry -AppExe $appExe -LogPath $removeLog
            if ($code -ne 0) { throw "pnpm remove failed with exit code $code (log: $removeLog)" }
        }
        $addLog = Join-Path $backupDir 'pnpm-add.log'
        $code = Invoke-Pnpm -PnpmArgs @('add', ('file:' + $pluginFull), '--offline') -ProfileFull $profileFull -NodeCmd $nodeCmd -PnpmEntry $pnpmEntry -AppExe $appExe -LogPath $addLog
        if ($code -ne 0) { throw "pnpm add failed with exit code $code (log: $addLog)" }
    }
    else {
        Write-Detail 'installed snapshot matches the source; pnpm skipped (idempotent)'
    }

    if ($TestFailAt -eq 'AfterPnpm') { throw 'Simulated failure after pnpm (TestFailAt=AfterPnpm).' }

    $manifest = (Read-JsonFile $manifestPath).Value
    $depNames = @()
    $depNode = Get-Prop $manifest 'dependencies'
    if ($null -ne $depNode) { $depNames = @($depNode.PSObject.Properties | ForEach-Object { $_.Name } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) }
    if (-not ($depNames -contains $pluginName)) {
        throw "pnpm finished but $manifestPath has no dependency '$pluginName'."
    }

    if (Test-Path -LiteralPath $lockPath) { throw "Profile lock appeared while running: $lockPath" }

    Write-Step 'Registering bundle in dsh.profile.bundles'
    if (Add-BundleToManifest $manifestPath $pluginName) {
        Write-Detail ("appended '" + $pluginName + "' to dsh.profile.bundles")
    }
    else {
        Write-Detail ("'" + $pluginName + "' already present in dsh.profile.bundles")
    }

    Write-Step 'Seeding skills'
    if ($SkipSkills) {
        Write-Detail 'skipped (-SkipSkills)'
    }
    elseif ($skillNames.Count -eq 0) {
        Write-Warn ("no skills found in " + $skillsSource)
    }
    elseif (-not $skillsNeedCopy) {
        Write-Detail 'skills already up to date; nothing copied'
    }
    else {
        Copy-PluginSkills $skillsSource $SkillsDir $skillNames
    }

    Write-Step 'Post-check'
    $final = (Read-JsonFile $manifestPath).Value
    $finalDepNames = @()
    $finalDepNode = Get-Prop $final 'dependencies'
    if ($null -ne $finalDepNode) { $finalDepNames = @($finalDepNode.PSObject.Properties | ForEach-Object { $_.Name } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) }
    $finalBundles = @()
    $finalBundleNode = Get-Prop (Get-Prop (Get-Prop $final 'dsh') 'profile') 'bundles'
    if ($null -ne $finalBundleNode) { $finalBundles = @($finalBundleNode) }
    if (-not ($finalDepNames -contains $pluginName)) { throw "Post-check failed: $manifestPath has no dependency '$pluginName'." }
    if (-not ($finalBundles -contains $pluginName)) { throw "Post-check failed: dsh.profile.bundles does not contain '$pluginName'." }
    if (-not (Test-Path -LiteralPath $installedPkgPath -PathType Leaf)) { throw "Post-check failed: installed package not found: $installedPkgPath" }
    $installedPkg = (Read-JsonFile $installedPkgPath).Value
    if ($null -eq (Get-PluginPatchDeclaration $installedPkg)) { throw 'Post-check failed: installed package does not declare dsh.bundle.patch.' }

    $installedVersion = [string]$installedPkg.version
    Write-Host ''
    Write-Host ("[install] " + $pluginName + " " + $installedVersion + " installed in " + $profileFull) -ForegroundColor Green
    Write-Detail ("dependency    : " + $pluginName)
    Write-Detail ("bundles       : " + ($finalBundles -join ', '))
    Write-Detail ("backup        : " + $backupDir)
    if (-not $SkipSkills) { Write-Detail ("skills seeded : " + $skillNames.Count + " -> " + $SkillsDir) }
    Write-Host ("[install] Restart the DeepSeek Harness app so the bundle mounts.") -ForegroundColor Green
}
catch {
    $message = $_.Exception.Message
    Write-Host ("`n[FAIL] " + $message) -ForegroundColor Red
    if ($backupDir -and (Test-Path -LiteralPath $backupDir)) {
        Invoke-Rollback -BackupDir $backupDir -ProfileFull $profileFull -SkillsFull $SkillsDir
        Write-Host ("[FAIL] rollback done; backup kept at " + $backupDir) -ForegroundColor Red
        Write-Host '[FAIL] node_modules may contain a partial snapshot; re-run this script or use uninstall-dsh-plugin.ps1.' -ForegroundColor Red
    }
    else {
        Write-Host '[FAIL] nothing was written (failure happened before the backup step).' -ForegroundColor Red
    }
    exit 1
}

exit 0
