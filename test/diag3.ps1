$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public class W {
  public delegate bool E(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, E cb, IntPtr l);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int m);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int m);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageW")] public static extern IntPtr SendStr(IntPtr h,uint m,IntPtr w,string l);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageW")] public static extern IntPtr GetStr(IntPtr h,uint m,IntPtr w,StringBuilder l);
  [DllImport("user32.dll",EntryPoint="SendMessageW")] public static extern IntPtr SendNum(IntPtr h,uint m,IntPtr w,IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr SetForegroundWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static List<IntPtr> Ch(IntPtr p){ var l=new List<IntPtr>(); EnumChildWindows(p,(h,x)=>{l.Add(h);return true;},IntPtr.Zero); return l; }
  public static string Cls(IntPtr h){ var s=new StringBuilder(256); GetClassName(h,s,256); return s.ToString(); }
  public static string Txt(IntPtr h){ var s=new StringBuilder(512); GetWindowText(h,s,512); return s.ToString(); }
  public static string EditText(IntPtr h){ var s=new StringBuilder(512); GetStr(h,0x000D,(IntPtr)512,s); return s.ToString(); }
}
"@
$WM_SETTEXT=[uint32]0x000C; $BM_CLICK=[uint32]0x00F5

$exe = "C:\Users\user\Downloads\qr_gen_2025.v.exe"
$p = Start-Process -FilePath $exe -PassThru
$p.WaitForInputIdle(10000) | Out-Null
$hwnd=[IntPtr]::Zero
for($i=0;$i -lt 30 -and $hwnd -eq [IntPtr]::Zero;$i++){ Start-Sleep -Milliseconds 300; $p.Refresh(); $hwnd=$p.MainWindowHandle }
"pid=$($p.Id) hwnd=$hwnd"
$edits=@(); $buttons=@{}
foreach($h in [W]::Ch($hwnd)){
  $c=[W]::Cls($h)
  if($c -eq "TEdit"){ $r=New-Object W+RECT; [W]::GetWindowRect($h,[ref]$r)|Out-Null; $edits += [pscustomobject]@{h=$h;top=$r.Top} }
  elseif($c -eq "TButton"){ $buttons[([W]::Txt($h)).Trim()]=$h }
}
$edits = $edits | Sort-Object top
$vals = @("4363464363","45000","100","100","189")
for($i=0;$i -lt 5;$i++){ [W]::SendStr($edits[$i].h,$WM_SETTEXT,[IntPtr]::Zero,$vals[$i])|Out-Null }
Start-Sleep -Milliseconds 300
"readback: " + (($edits | ForEach-Object { '[' + [W]::EditText($_.h) + ']' }) -join ' ')
$gen = $buttons[(($buttons.Keys)|?{$_ -like "*Generate*"}|select -First 1)]
$cop = $buttons[(($buttons.Keys)|?{$_ -like "*Copy*"}|select -First 1)]
[W]::SetForegroundWindow($hwnd)|Out-Null
[W]::SendNum($gen,$BM_CLICK,[IntPtr]::Zero,[IntPtr]::Zero)|Out-Null
Start-Sleep -Milliseconds 1500
try{[System.Windows.Forms.Clipboard]::Clear()}catch{}
[W]::SendNum($cop,$BM_CLICK,[IntPtr]::Zero,[IntPtr]::Zero)|Out-Null
Start-Sleep -Milliseconds 800
if([System.Windows.Forms.Clipboard]::ContainsImage()){
  $img=[System.Windows.Forms.Clipboard]::GetImage()
  "image $($img.Width)x$($img.Height)"
  $img.Save("D:\invoice_vision\test\out\probe3.png",[System.Drawing.Imaging.ImageFormat]::Png)
}
"PID $($p.Id) left open for inspection"
