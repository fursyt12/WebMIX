# Helpers for the release workflow on Windows (dot-sourced, not executed).
#
# Same idea as packaging/ci.sh: a failed command's output is only visible to
# someone who can open the Actions logs, so the tail of a failure is repeated as
# ::error:: annotations, which the run's API exposes publicly.

function Invoke-CiCommand {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string] $FilePath,

        [string[]] $Arguments = @()
    )

    $log = New-TemporaryFile
    $lines = & $FilePath @Arguments 2>&1
    $code = $LASTEXITCODE

    $lines | ForEach-Object { Write-Host $_ }
    $lines | Set-Content -Path $log -Encoding utf8

    if ($code -ne 0) {
        Get-Content $log | Select-Object -Last 20 | ForEach-Object { Write-Host "::error::$_" }
    }

    Remove-Item $log -Force -ErrorAction SilentlyContinue
    return $code
}
