$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public class W {
  public delegate bool E(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, E cb, IntPtr l);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int m);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int m);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageW")] public static extern IntPtr SendStr(IntPtr h,uint m,IntPtr w,string l);
  [DllImport("user32.dll",EntryPoint="SendMessageW")] public static extern IntPtr SendNum(IntPtr h,uint m,IntPtr w,IntPtr l);
  public static List<IntPtr> Ch(IntPtr p){ var l=new List<IntPtr>(); EnumChildWindows(p,(h,x)=>{l.Add(h);return true;},IntPtr.Zero); return l; }
  public static string Cls(IntPtr h){ var s=new StringBuilder(256); GetClassName(h,s,256); return s.ToString(); }
  public static string Txt(IntPtr h){ var s=new StringBuilder(512); GetWindowText(h,s,512); return s.ToString(); }
}
"@
$WM_SETTEXT=[uint32]0x000C; $BM_CLICK=[uint32]0x00F5

$script:win=[IntPtr]::Zero
[W]::EnumChildWindows([IntPtr]::Zero,[W+E]{param($h,$l) if([W]::IsWindowVisible($h) -and ([W]::Txt($h) -like "*VISION Invoice Digital*")){$script:win=$h; return $false} return $true},[IntPtr]::Zero)|Out-Null
"win=$script:win"

$edits=@(); $buttons=@{}
foreach($h in [W]::Ch($script:win)){
  $c=[W]::Cls($h)
  if($c -eq "TEdit"){ $edits += $h }
  elseif($c -eq "TButton"){ $buttons[([W]::Txt($h)).Trim()]=$h }
}
"edits=$($edits.Count) buttons=$($buttons.Keys -join '|')"
$supp = $edits[$edits.Count-1]  # akan dikoreksi; cari TEdit paling atas via order tak terjamin -> pakai semua
# Set sentinel ke SEMUA edit lalu baca balik
$i=0
foreach($e in $edits){ [W]::SendStr($e,$WM_SETTEXT,[IntPtr]::Zero,"SENT$i")|Out-Null; $i++ }
Start-Sleep -Milliseconds 200
"after SETTEXT readback: " + (($edits | ForEach-Object { [W]::Txt($_) }) -join ' | ')

$clear = $buttons.Keys | Where-Object { $_ -like "*Clear*" } | Select-Object -First 1
[W]::SendNum($buttons[$clear],$BM_CLICK,[IntPtr]::Zero,[IntPtr]::Zero)|Out-Null
Start-Sleep -Milliseconds 400
"after CLEAR readback: " + (($edits | ForEach-Object { '[' + [W]::Txt($_) + ']' }) -join ' ')
