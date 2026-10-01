# Package the Windows build with CPack and give the archive a release name.
#
# The build itself is done by the workflow (cmake --preset windows-ci-x64);
# this only collects what CPack produced in build_x64:
#
#   webmix-<version>-windows-x64.zip
#
# Usage: pwsh -File packaging/windows/package.ps1 -BuildDir build_x64 -OutDir dist

[CmdletBinding()]
param(
    [string] $BuildDir = 'build_x64',
    [string] $OutDir = 'dist',
    [string] $Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'

$BuildDir = (Resolve-Path -Path $BuildDir).Path
$OutDir = New-Item -ItemType Directory -Force -Path $OutDir | Select-Object -ExpandProperty FullName

Write-Host "Packaging the Windows build..."
Push-Location $BuildDir
try {
    cpack -C $Configuration --config ./CPackConfig.cmake
} finally {
    Pop-Location
}

$zips = Get-ChildItem -Path $BuildDir -Filter 'webmix-*.zip' -File
if ($zips.Count -eq 0) {
    throw "cpack produced no webmix-*.zip in $BuildDir"
}

foreach ($zip in $zips) {
    Copy-Item $zip.FullName -Destination (Join-Path $OutDir $zip.Name) -Force
    Write-Host "  $($zip.Name)"
}
Write-Host "Artifacts written to $OutDir"
