# 编译 CloudLinux 启动器（原生 GUI EXE）
#
# 用 Windows 自带的 .NET Framework 编译器，不需要安装任何 SDK。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File launcher\build-launcher.ps1
#
# 产物：dist\cloudlinux-launcher.exe

[CmdletBinding()]
param(
    [string]$Out = ''
)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent $here
if (-not $Out) { $Out = Join-Path $repo 'dist\cloudlinux-launcher.exe' }

Write-Host 'CloudLinux 启动器 —— 编译' -ForegroundColor Cyan
Write-Host "  源码： $here\CloudLinuxLauncher.cs"
Write-Host "  输出： $Out"

# 找一个可用的 csc.exe（优先 64 位 .NET Framework 4）
$candidates = @(
    "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
    "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)
$csc = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $csc) {
    # 退而求其次：找 MSBuild 里带 Roslyn 的 csc
    $roslyn = Get-ChildItem "$env:ProgramFiles\Microsoft Visual Studio","${env:ProgramFiles(x86)}\Microsoft Visual Studio" -Recurse -Filter csc.exe -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($roslyn) { $csc = $roslyn.FullName }
}

if (-not $csc) {
    Write-Error '找不到 csc.exe。请安装 .NET Framework 4.x（Windows 通常自带），或 Visual Studio / Build Tools。'
    exit 1
}
Write-Host "  编译器： $csc"

$outDir = Split-Path -Parent $Out
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
if (Test-Path $Out) { Remove-Item $Out -Force }

$src = Join-Path $here 'CloudLinuxLauncher.cs'

# 说明：
#   /target:winexe  → GUI 程序，不弹控制台窗口
#   /optimize+      → 优化
#   /platform:anycpu → 32/64 位 Windows 都能跑
& $csc /nologo /target:winexe /optimize+ /platform:anycpu `
    /reference:System.dll,System.Drawing.dll,System.Windows.Forms.dll `
    /out:$Out $src

if ($LASTEXITCODE -ne 0 -or -not (Test-Path $Out)) {
    Write-Error "编译失败（csc 退出码 $LASTEXITCODE）"
    exit 1
}

$size = [math]::Round((Get-Item $Out).Length / 1KB, 1)
Write-Host ''
Write-Host '─' * 58
Write-Host "  编译完成： $Out"
Write-Host "  体积：     $size KB"
Write-Host '─' * 58
Write-Host ''
Write-Host '使用方式：'
Write-Host '  1. 把 cloudlinux-launcher.exe 和 cloudlinux-agent.exe 放在同一个目录'
Write-Host '  2. 双击启动器 → 它会自动拉起助手，并显示配对码'
Write-Host '  3. 点「打开控制台」用浏览器完成配对'
Write-Host ''
Write-Host '  可选：同目录放一个 launcher.ini 可以改控制台地址和端口，例如'
Write-Host '        consoleUrl=https://wangyvqian.github.io/cloudlinux/'
Write-Host '        port=8765'
Write-Host '        autoStart=1'
Write-Host ''
