<#
.SYNOPSIS
  Uninstall the @qbot/dsh-agent bundle from the DeepSeek Harness desktop profile.

.DESCRIPTION
  Mirror image of install-dsh-plugin.ps1:

    1. backs up package.json / pnpm-lock.yaml / pnpm-workspace.yaml /
       cordis.patch.yml (and the skills it is about to remove) to
       <ProfileDir>\backups\<timestamp>-uninstall\;
    2. runs pnpm remove @qbot/dsh-agent with cwd = the profile directory,
       using the app's bundled node + pnpm;
    3. removes the bundle name from dsh.profile.bundles;
    4. removes the seeded skills unless -KeepSkills is given;
    5. reports leftovers (node_modules metadata, lockfile, orphan snapshot).

  Safety: refuses to write while <ProfileDir>\lock exists; restores the
  backed-up files if anything fails; never touches unrelated skills.
  -DryRun prints the plan without writing anything.

.PARAMETER InstallDir
  DeepSeek Harness install directory. Default: D:\klein\code_agent\dsh

.PARAMETER ProfileDir
  DSH desktop profile directory.
  Default: %USERPROFILE%\.dsh\profiles\desktop

.PARAMETER PluginDir
  The @qbot/dsh-agent bundle directory, used to learn the bundle name and the
  seeded skill names. Default: <repo>\agent. Falls back to the installed copy
  and finally to the literal name @qbot/dsh-agent.

.PARAMETER SkillsDir
  Where skills were seeded. Default: %USERPROFILE%\.dsh\skills

.PARAMETER DryRun
  Print the plan and exit without writing anything.

.PARAMETER KeepSkills
  Keep the seeded skills (they are user-editable data).

.PARAMETER TestFailAt
  Test hook (default None). "AfterBackup" / "AfterPnpm" force a failure at
  that point so the rollback path can be verified against a scratch profile.

.EXAMPLE
  .\uninstall-dsh-plugin.ps1 -DryRun
.EXAMPLE
  .\uninstall-dsh-plugin.ps1
.EXAMPLE
  .\uninstall-dsh-plugin.ps1 -KeepSkills
#>
[CmdletBinding()]
param(
    [string]$InstallDir = 'D:\klein\code_agent\dsh',
    [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
    [string]$PluginDir,
    [string]$SkillsDir = (Join-Path $env:USERPROFILE '.dsh\skills'),
    [switch]$DryRun,
    [switch]$KeepSkills,
    [ValidateSet('None', 'AfterBackup', 'AfterPnpm')]
    [string]$TestFailAt = 'None'
)

$ErrorActionPreference = 'Stop'

$script:TrackedFiles = @('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml')
$script:FileExistedBefore = @{}
$script:SkillState = @{}

# ---------------------------------------------------------------------------
# output helpers
# ---------------------------------------------------------------------------
function Write-Step {
    param([string]$Message)
    Write-Host ("`n[uninstall] " + $Message) -ForegroundColor Cyan
}
function Write-Detail {
    param([string]$Message)
    Write-Host ("            " + $Message)
}
function Write-Plan {
    param([string]$Message)
    Write-Host ("[dry-run]   " + $Message) -ForegroundColor DarkCyan
}
function Write-Warn {
    param([string]$Message)
    Write-Host ("[warn]      " + $Message) -ForegroundColor Yellow
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
    param([string]$ProfileFull, [string]$Suffix = '')
    $stamp = (Get-Date -Format 'yyyyMMdd-HHmmss') + $Suffix
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

function Remove-BundleFromManifest {
    param([string]$ManifestPath, [string]$BundleName)
    $read = Read-JsonFile $ManifestPath
    $manifest = $read.Value
    $bundles = @()
    $node = Get-Prop (Get-Prop (Get-Prop $manifest 'dsh') 'profile') 'bundles'
    if ($null -ne $node) { $bundles = @($node) }
    if (-not ($bundles -contains $BundleName)) { return $false }
    $new = @($bundles | Where-Object { $_ -ne $BundleName })
    $manifest.dsh.profile.bundles = $new
    $json = ConvertTo-PrettyJson $manifest 0
    if ($read.Raw.EndsWith("`n")) { $json += "`n" }
    Write-TextNoBom $ManifestPath $json
    return $true
}

function Remove-SkillDirs {
    param([string]$SkillsFull, [string[]]$SkillNames)
    foreach ($name in $SkillNames) {
        $dst = Join-Path $SkillsFull $name
        if (Test-Path -LiteralPath $dst) {
            Remove-Item -LiteralPath $dst -Recurse -Force
            Write-Detail ("removed skill " + $dst + " (backup kept)")
        }
    }
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
    $nodeCmd = Join-Path $installFull 'resources\runtime\bin\node.cmd'
    $pnpmEntry = Join-Path $installFull 'resources\runtime\pnpm\bin\pnpm.mjs'
    $appExe = Join-Path $installFull 'DeepSeek Harness.exe'
    foreach ($runtimeFile in @($nodeCmd, $pnpmEntry, $appExe)) {
        if (-not (Test-Path -LiteralPath $runtimeFile -PathType Leaf)) {
            throw "Missing DeepSeek Harness runtime file: $runtimeFile"
        }
    }

    $profileFull = Resolve-ExistingPath $ProfileDir 'ProfileDir'
    $manifestPath = Join-Path $profileFull 'package.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "Profile manifest not found: $manifestPath" }
    $lockPath = Join-Path $profileFull 'lock'
    if (Test-Path -LiteralPath $lockPath) {
        throw "Profile is locked (the app is mid-operation): $lockPath exists. Wait for the app to finish, then retry."
    }

    $pluginFull = $null
    $pluginSource = $null
    $pluginName = $null
    if (-not [string]::IsNullOrWhiteSpace($PluginDir) -and (Test-Path -LiteralPath $PluginDir)) {
        $pluginFull = (Resolve-Path -LiteralPath $PluginDir).ProviderPath
        $pkgPath = Join-Path $pluginFull 'package.json'
        if (Test-Path -LiteralPath $pkgPath -PathType Leaf) {
            $pkg = (Read-JsonFile $pkgPath).Value
            $name = [string]$pkg.name
            if ($name -ne '@qbot/dsh-agent') {
                throw "Refusing to uninstall: $pkgPath declares name '$name', expected '@qbot/dsh-agent'."
            }
            $pluginName = $name
            $pluginSource = $pluginFull
        }
    }
    else {
        Write-Warn ("PluginDir not found: " + $PluginDir + " (falling back to the installed copy)")
    }

    $installedDir = Join-Path $profileFull 'node_modules\@qbot\dsh-agent'
    $installedPkgPath = Join-Path $installedDir 'package.json'
    if ($null -eq $pluginName -and (Test-Path -LiteralPath $installedPkgPath -PathType Leaf)) {
        $pkg = (Read-JsonFile $installedPkgPath).Value
        $pluginName = [string]$pkg.name
        $pluginSource = $installedDir
    }
    if ([string]::IsNullOrWhiteSpace($pluginName)) {
        $pluginName = '@qbot/dsh-agent'
        Write-Warn ("Could not read a bundle name from any package.json; using literal '" + $pluginName + "'.")
    }

    $skillsSource = $null
    foreach ($cand in @($pluginSource, $installedDir)) {
        if (-not [string]::IsNullOrWhiteSpace($cand)) {
            $s = Join-Path $cand 'skills'
            if (Test-Path -LiteralPath $s -PathType Container) { $skillsSource = $s; break }
        }
    }
    $skillNames = @()
    if ($null -ne $skillsSource) {
        $skillNames = @(Get-ChildItem -LiteralPath $skillsSource -Force | Sort-Object Name | ForEach-Object { $_.Name })
    }

    $manifest = (Read-JsonFile $manifestPath).Value
    $depNames = @()
    $depNode = Get-Prop $manifest 'dependencies'
    if ($null -ne $depNode) { $depNames = @($depNode.PSObject.Properties | ForEach-Object { $_.Name } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) }
    $depInstalled = $depNames -contains $pluginName
    $bundleNode = Get-Prop (Get-Prop (Get-Prop $manifest 'dsh') 'profile') 'bundles'
    $bundles = @()
    if ($null -ne $bundleNode) { $bundles = @($bundleNode) }
    $bundleRegistered = $bundles -contains $pluginName
    $installedDirExists = Test-Path -LiteralPath $installedDir

    $skillsToRemove = @()
    if (-not $KeepSkills) {
        foreach ($name in $skillNames) {
            if (Test-Path -LiteralPath (Join-Path $SkillsDir $name)) { $skillsToRemove += $name }
        }
    }

    $needsPnpm = $depInstalled
    $needsManifestEdit = $bundleRegistered
    $needsSkillRemoval = $skillsToRemove.Count -gt 0
    $isNoOp = (-not $needsPnpm) -and (-not $needsManifestEdit) -and (-not $needsSkillRemoval)

    Write-Detail ("InstallDir : " + $installFull)
    Write-Detail ("ProfileDir : " + $profileFull)
    Write-Detail ("PluginDir  : " + $(if ($null -ne $pluginFull) { $pluginFull } else { '(not found; using installed copy)' }))
    Write-Detail ("SkillsDir  : " + $SkillsDir)
    Write-Detail ("Bundle     : " + $pluginName)
    Write-Detail ("Lock       : not present (ok)")
    Write-Detail ("Installed  : dependency=" + $depInstalled + " bundleEntry=" + $bundleRegistered + " snapshotDir=" + $installedDirExists)
    if ($KeepSkills) { Write-Detail 'Skills     : kept (-KeepSkills)' }
    elseif ($skillNames.Count -eq 0) { Write-Detail 'Skills     : none known' }
    else { Write-Detail ("Skills     : " + ($skillNames -join ', ') + " (present=" + (($skillsToRemove | Measure-Object).Count) + ")") }
    if ($TestFailAt -ne 'None') { Write-Warn ("TestFailAt=" + $TestFailAt + " is a test hook; use only on scratch profiles.") }

    if ($DryRun) {
        Write-Step 'DRY RUN - printing the plan, nothing will be written'
        if ($isNoOp) {
            Write-Plan 'nothing to do: dependency absent, bundle not registered, no seeded skills present'
        }
        else {
            if ($needsPnpm) {
                Write-Plan ("RUN  cwd=" + $profileFull + "  env DSH_DESKTOP_NODE_EXECUTABLE=" + $appExe)
                Write-Plan ("     & `"" + $nodeCmd + "`" `"" + $pnpmEntry + "`" remove " + $pluginName)
            }
            else {
                Write-Plan 'SKIP pnpm (dependency is not present in package.json)'
            }
            Write-Plan ('BACKUP dir: ' + (Join-Path (Join-Path $profileFull 'backups') '<timestamp>-uninstall'))
            foreach ($name in $script:TrackedFiles) {
                $exists = Test-Path -LiteralPath (Join-Path $profileFull $name) -PathType Leaf
                $label = if ($exists) { 'copy  ' } else { 'absent' }
                Write-Plan ('  ' + $label + ' ' + (Join-Path $profileFull $name))
            }
            if ($needsManifestEdit) {
                Write-Plan ('MANIFEST remove ' + $pluginName + ' from dsh.profile.bundles in ' + $manifestPath)
            }
            else {
                Write-Plan ('MANIFEST no change: dsh.profile.bundles does not contain ' + $pluginName)
            }
            if ($KeepSkills) { Write-Plan 'SKILLS kept (-KeepSkills)' }
            elseif ($skillsToRemove.Count -eq 0) { Write-Plan 'SKILLS none of the known skills are present' }
            else {
                foreach ($name in $skillsToRemove) {
                    Write-Plan ('SKILLS backup + remove ' + (Join-Path $SkillsDir $name))
                }
            }
            Write-Plan 'POST-CHECK re-read manifest; verify dependency + bundle entry removed; report leftovers'
        }
        if ($installedDirExists -and (-not $depInstalled)) {
            Write-Plan ('LEFTOVER orphan snapshot (not a dependency): ' + $installedDir)
        }
        Write-Host "`n[dry-run] no files were written." -ForegroundColor Green
        exit 0
    }

    if ($isNoOp) {
        Write-Step 'Nothing to uninstall'
        Write-Detail ($pluginName + " is not a dependency and is not registered in dsh.profile.bundles.")
        if ($installedDirExists) { Write-Warn ("orphan snapshot left in place: " + $installedDir + " (delete manually if no longer needed)") }
        if ($KeepSkills -and $skillNames.Count -gt 0) { Write-Detail ('skills kept (-KeepSkills): ' + ($skillNames -join ', ')) }
        Write-Host "`n[uninstall] nothing to do." -ForegroundColor Green
        exit 0
    }

    Write-Step 'Backing up profile files'
    $backupDir = New-BackupDir $profileFull '-uninstall'
    $backedFiles = Backup-ProfileFiles $profileFull $backupDir
    if (-not $KeepSkills) { Backup-SkillDirs $backupDir $SkillsDir $skillsToRemove }
    $backupInfo = [ordered]@{
        tool          = 'uninstall-dsh-plugin.ps1'
        timestamp     = (Get-Date).ToString('o')
        pluginName    = $pluginName
        profileDir    = $profileFull
        skillsDir     = $SkillsDir
        filesBackedUp = @($backedFiles)
        skillState    = $script:SkillState
    }
    Write-TextNoBom (Join-Path $backupDir 'backup.json') ((ConvertTo-PrettyJson $backupInfo 0) + "`n")
    Write-Detail ("backup: " + $backupDir)
    if ($backedFiles.Count -gt 0) { Write-Detail ("backed up: " + ($backedFiles -join ', ')) }

    if ($TestFailAt -eq 'AfterBackup') { throw 'Simulated failure after backup (TestFailAt=AfterBackup).' }

    if (Test-Path -LiteralPath $lockPath) { throw "Profile lock appeared while running: $lockPath" }

    Write-Step 'Removing bundle dependency with pnpm'
    if ($needsPnpm) {
        $removeLog = Join-Path $backupDir 'pnpm-remove.log'
        $code = Invoke-Pnpm -PnpmArgs @('remove', $pluginName) -ProfileFull $profileFull -NodeCmd $nodeCmd -PnpmEntry $pnpmEntry -AppExe $appExe -LogPath $removeLog
        if ($code -ne 0) { throw "pnpm remove failed with exit code $code (log: $removeLog)" }
    }
    else {
        Write-Detail 'dependency not present in package.json; pnpm skipped'
    }

    if ($TestFailAt -eq 'AfterPnpm') { throw 'Simulated failure after pnpm (TestFailAt=AfterPnpm).' }

    if (Test-Path -LiteralPath $lockPath) { throw "Profile lock appeared while running: $lockPath" }

    Write-Step 'Removing bundle from dsh.profile.bundles'
    if (Remove-BundleFromManifest $manifestPath $pluginName) {
        Write-Detail ("removed '" + $pluginName + "' from dsh.profile.bundles")
    }
    else {
        Write-Detail ("'" + $pluginName + "' was not present in dsh.profile.bundles")
    }

    Write-Step 'Removing seeded skills'
    if ($KeepSkills) {
        Write-Detail 'kept (-KeepSkills)'
    }
    elseif ($skillsToRemove.Count -eq 0) {
        Write-Detail 'none of the known skills are present'
    }
    else {
        Remove-SkillDirs $SkillsDir $skillsToRemove
    }

    Write-Step 'Post-check'
    $final = (Read-JsonFile $manifestPath).Value
    $finalDepNames = @()
    $finalDepNode = Get-Prop $final 'dependencies'
    if ($null -ne $finalDepNode) { $finalDepNames = @($finalDepNode.PSObject.Properties | ForEach-Object { $_.Name } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) }
    if ($finalDepNames -contains $pluginName) { throw "Post-check failed: dependency '$pluginName' still present in $manifestPath." }
    $finalBundles = @()
    $finalBundleNode = Get-Prop (Get-Prop (Get-Prop $final 'dsh') 'profile') 'bundles'
    if ($null -ne $finalBundleNode) { $finalBundles = @($finalBundleNode) }
    if ($finalBundles -contains $pluginName) { throw "Post-check failed: dsh.profile.bundles still contains '$pluginName'." }
    if (Test-Path -LiteralPath $installedDir) {
        Write-Warn ("leftover snapshot: " + $installedDir)
    }
    else {
        Write-Detail 'node_modules\@qbot\dsh-agent removed'
    }

    $scopeDir = Join-Path $profileFull 'node_modules\@qbot'
    if (Test-Path -LiteralPath $scopeDir -PathType Container) {
        $scopeChildren = @(Get-ChildItem -LiteralPath $scopeDir -Force)
        if ($scopeChildren.Count -eq 0) {
            Remove-Item -LiteralPath $scopeDir -Force
            Write-Detail 'removed empty leftover dir node_modules\@qbot'
        }
        else {
            Write-Warn ('leftover: ' + $scopeDir + ' still contains: ' + (($scopeChildren | ForEach-Object { $_.Name }) -join ', '))
        }
    }
    foreach ($leftover in @('node_modules\.pnpm', 'node_modules\.modules.yaml', 'node_modules\.pnpm-workspace-state-v1.json', 'pnpm-lock.yaml')) {
        $p = Join-Path $profileFull $leftover
        if (Test-Path -LiteralPath $p) { Write-Detail ('leftover (normal pnpm metadata): ' + $p) }
    }
    if ($KeepSkills -and $skillNames.Count -gt 0) {
        Write-Detail ('skills kept (-KeepSkills): ' + (($skillNames | ForEach-Object { Join-Path $SkillsDir $_ }) -join ', '))
    }

    Write-Host ''
    Write-Host ("[uninstall] " + $pluginName + " removed from " + $profileFull) -ForegroundColor Green
    Write-Detail ("backup : " + $backupDir)
    Write-Host '[uninstall] Restart the DeepSeek Harness app so the bundle unmounts.' -ForegroundColor Green
}
catch {
    $message = $_.Exception.Message
    Write-Host ("`n[FAIL] " + $message) -ForegroundColor Red
    if ($backupDir -and (Test-Path -LiteralPath $backupDir)) {
        Invoke-Rollback -BackupDir $backupDir -ProfileFull $profileFull -SkillsFull $SkillsDir
        Write-Host ("[FAIL] rollback done; backup kept at " + $backupDir) -ForegroundColor Red
    }
    else {
        Write-Host '[FAIL] nothing was written (failure happened before the backup step).' -ForegroundColor Red
    }
    exit 1
}

exit 0
