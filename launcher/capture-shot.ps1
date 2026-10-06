# 抓取启动器窗口截图，用于验证布局（按钮是否溢出、配对码是否可见）
#
# 用 EnumWindows 按标题找窗口 —— Process.MainWindowHandle 有时会指向隐藏的辅助窗口，
# 抓出来是个 158x26 的空图。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File launcher\capture-shot.ps1
#   powershell -ExecutionPolicy Bypass -File launcher\capture-shot.ps1 -Out D:\shot.png

param(
    [string]$Out = "$env:TEMP\launcher-shot.png",
    [int]$WaitSeconds = 20
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class WinCap {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

  // 找标题里带"启动器"的可见窗口，取面积最大的那个
  public static IntPtr FindLauncher() {
    IntPtr best = IntPtr.Zero;
    long bestArea = 0;
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      if (!IsWindowVisible(h)) return true;
      StringBuilder sb = new StringBuilder(512);
      GetWindowTextW(h, sb, sb.Capacity);
      string t = sb.ToString();
      if (t.IndexOf("启动器", StringComparison.Ordinal) < 0) return true;
      RECT r;
      if (!GetWindowRect(h, out r)) return true;
      long area = (long)(r.R - r.L) * (r.B - r.T);
      if (area > bestArea) { bestArea = area; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
"@

# 等窗口出现
$h = [IntPtr]::Zero
for ($i = 0; $i -lt ($WaitSeconds * 2); $i++) {
    $h = [WinCap]::FindLauncher()
    if ($h -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 500
}
if ($h -eq [IntPtr]::Zero) { Write-Error "找不到启动器窗口（等了 $WaitSeconds 秒）"; exit 1 }

[void][WinCap]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 900

$r = New-Object WinCap+RECT
[void][WinCap]::GetWindowRect($h, [ref]$r)
$w = $r.R - $r.L
$hh = $r.B - $r.T
Write-Host "窗口尺寸： ${w} x ${hh}"

$bmp = New-Object System.Drawing.Bitmap($w, $hh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc()
# PrintWindow flag=2 会带上子控件（对 WinForms 更可靠）
[void][WinCap]::PrintWindow($h, $dc, 2)
$g.ReleaseHdc($dc)
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Host "已保存： $Out"
