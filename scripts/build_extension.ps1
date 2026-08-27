param(
    [switch]$NoZip,
    [switch]$AllowDirty
)

$ErrorActionPreference = "Stop"
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$pyproject = [IO.File]::ReadAllText((Join-Path $repositoryRoot "pyproject.toml"))
$projectMatch = [regex]::Match($pyproject, '(?m)^version\s*=\s*"([^"]+)"')
if (-not $projectMatch.Success) {
    throw "Extension version is missing from pyproject.toml"
}
$version = $projectMatch.Groups[1].Value
if ($version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Invalid extension version: $version"
}

$backendVersionSource = [IO.File]::ReadAllText((Join-Path $repositoryRoot "backend\version.py"))
$backendMatch = [regex]::Match($backendVersionSource, 'VERSION\s*=\s*"([^"]+)"')
if (-not $backendMatch.Success -or $backendMatch.Groups[1].Value -ne $version) {
    throw "pyproject.toml and backend/version.py versions do not match"
}

foreach ($required in @("__init__.py", "backend\routes.py", "web\main.js", "models.json")) {
    if (-not (Test-Path -LiteralPath (Join-Path $repositoryRoot $required))) {
        throw "Required extension source is missing: $required"
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $repositoryRoot ".git")) -or -not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "The extension release build requires a Git checkout and git on PATH"
}
$repositoryDirty = [bool]((& git -C $repositoryRoot status --porcelain) -join "")
if ($repositoryDirty -and -not $AllowDirty) {
    throw "The checkout has local changes. Commit them or pass -AllowDirty for a development build."
}
if ($repositoryDirty) {
    Write-Warning "Building from a dirty checkout because -AllowDirty was specified."
}

$distRoot = Join-Path $repositoryRoot "dist"
$packageFolderName = "ComfyUI-MiniMaxH3-Prompt-Writer"
$packageName = "H3-Prompt-Writer-ComfyUI-v$version"
$target = Join-Path $distRoot $packageFolderName
$zip = Join-Path $distRoot "$packageName.zip"
$resolvedDist = [IO.Path]::GetFullPath($distRoot)
$resolvedTarget = [IO.Path]::GetFullPath($target)
if (-not $resolvedTarget.StartsWith($resolvedDist + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to replace a target outside dist: $resolvedTarget"
}

New-Item -ItemType Directory -Force -Path $distRoot | Out-Null
if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $target | Out-Null

$ignorePath = (Resolve-Path (Join-Path $repositoryRoot ".comfyignore")).Path.Replace("\", "/")
$trackedFiles = @(& git -C $repositoryRoot ls-files)
if ($LASTEXITCODE -ne 0 -or -not $trackedFiles) {
    throw "Could not read tracked files from Git"
}

$packageFiles = @()
foreach ($relativePath in $trackedFiles) {
    & git -C $repositoryRoot -c "core.excludesFile=$ignorePath" check-ignore --no-index --quiet -- $relativePath
    if ($LASTEXITCODE -eq 0) {
        continue
    }
    if ($LASTEXITCODE -ne 1) {
        throw "Could not evaluate .comfyignore for: $relativePath"
    }
    $packageFiles += $relativePath
}

$forbidden = @($packageFiles | Where-Object {
    $_ -match '^(standalone|scripts|tests|\.github)/' -or $_ -match '^docs/dev/standalone/'
})
if ($forbidden) {
    throw "Extension package contract includes forbidden files: $($forbidden -join ', ')"
}

foreach ($relativePath in $packageFiles) {
    $nativeRelativePath = $relativePath.Replace("/", [IO.Path]::DirectorySeparatorChar)
    $source = Join-Path $repositoryRoot $nativeRelativePath
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Tracked package file is missing: $relativePath"
    }
    $destination = Join-Path $target $nativeRelativePath
    $destinationParent = Split-Path -Parent $destination
    New-Item -ItemType Directory -Force -Path $destinationParent | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination
}

if ($NoZip) {
    Write-Host "Built: $target"
    exit 0
}
if (Test-Path -LiteralPath $zip) {
    Remove-Item -LiteralPath $zip -Force
}
Compress-Archive -Path $target -DestinationPath $zip -CompressionLevel Optimal
Write-Host "Built: $zip ($($packageFiles.Count) files)"
