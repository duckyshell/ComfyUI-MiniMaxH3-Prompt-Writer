param(
    [switch]$NoZip,
    [switch]$AllowDirty
)

$ErrorActionPreference = "Stop"
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$standaloneRoot = Join-Path $repositoryRoot "standalone"
$version = [IO.File]::ReadAllText((Join-Path $standaloneRoot "VERSION")).Trim()
if ($version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Invalid Standalone version: $version"
}

foreach ($required in @("backend\routes.py", "web\main.js", "standalone\h3_standalone\app.py")) {
    if (-not (Test-Path -LiteralPath (Join-Path $repositoryRoot $required))) {
        throw "Required source is missing: $required"
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $repositoryRoot ".git")) -or -not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "The Standalone release build requires a Git checkout and git on PATH"
}
$repositoryCommit = (& git -C $repositoryRoot rev-parse HEAD).Trim()
$repositoryDirty = [bool]((& git -C $repositoryRoot status --porcelain) -join "")
if ($repositoryDirty -and -not $AllowDirty) {
    throw "The checkout has local changes. Commit them or pass -AllowDirty for a development build."
}
if ($repositoryDirty) {
    Write-Warning "Building from a dirty checkout because -AllowDirty was specified."
}

$distRoot = Join-Path $repositoryRoot "dist"
$packageName = "H3-Prompt-Writer-Standalone-Windows-v$version"
$target = Join-Path $distRoot $packageName
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

foreach ($name in @("h3_standalone", "ui")) {
    Copy-Item -LiteralPath (Join-Path $standaloneRoot $name) -Destination (Join-Path $target $name) -Recurse
}
foreach ($name in @("start.bat", "requirements.txt", "README.md", "CHANGELOG.md", "RELEASE_NOTES.md", "VERSION")) {
    Copy-Item -LiteralPath (Join-Path $standaloneRoot $name) -Destination (Join-Path $target $name)
}

$dataTarget = Join-Path $target "data"
New-Item -ItemType Directory -Force -Path $dataTarget | Out-Null
Copy-Item -LiteralPath (Join-Path $standaloneRoot "data\settings.example.json") -Destination (Join-Path $dataTarget "settings.example.json")
New-Item -ItemType Directory -Force -Path (Join-Path $target "models") | Out-Null

$upstreamTarget = Join-Path $target "upstream"
New-Item -ItemType Directory -Force -Path $upstreamTarget | Out-Null
foreach ($name in @("backend", "web", "guides", "models.json", "LICENSE")) {
    Copy-Item -LiteralPath (Join-Path $repositoryRoot $name) -Destination (Join-Path $upstreamTarget $name) -Recurse
}
$versionSource = [IO.File]::ReadAllText((Join-Path $repositoryRoot "backend\version.py"))
$extensionMatch = [regex]::Match($versionSource, 'VERSION\s*=\s*"([^"]+)"')
$extensionVersion = if ($extensionMatch.Success) { $extensionMatch.Groups[1].Value } else { "unknown" }
$snapshot = @(
    "H3 Prompt Writer core snapshot"
    "repository_commit=$repositoryCommit"
    "dirty=$($repositoryDirty.ToString().ToLowerInvariant())"
    "extension_version=$extensionVersion"
    "standalone_version=$version"
)
[IO.File]::WriteAllLines((Join-Path $upstreamTarget "UPSTREAM_SNAPSHOT.txt"), $snapshot)

Get-ChildItem -LiteralPath $target -Recurse -Directory -Filter "__pycache__" |
    Remove-Item -Recurse -Force

if ($NoZip) {
    Write-Host "Built: $target"
    exit 0
}
if (Test-Path -LiteralPath $zip) {
    Remove-Item -LiteralPath $zip -Force
}
Compress-Archive -Path (Join-Path $target "*") -DestinationPath $zip -CompressionLevel Optimal
Write-Host "Built: $zip"
