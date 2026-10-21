param(
  [Parameter(Mandatory=$true)][string]$JobFile,
  [Parameter(Mandatory=$true)][string]$OutDir,
  [Parameter(Mandatory=$true)][string]$ExePath,
  [Parameter(Mandatory=$true)][string]$ResultFile
)

# ============================================================================
# Invoice Vision - worker otomasi
# Meluncurkan instance sendiri aplikasi "VISION Invoice Digital Transformation",
# mengisi 5 field, menekan Generate QR lalu Copy, dan menyimpan gambar QR dari
# clipboard sebagai PNG. QR dibuat sepenuhnya oleh aplikasi resminya.
#
# Catatan:
# - Harus jalan mode STA (clipboard). Server memanggil powershell dengan -Sta.
# - Worker membuka instance miliknya sendiri (integrity Medium) supaya pesan
#   Win32 diterima. Jangan jalankan aplikasi VISION "as administrator".
# ============================================================================

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

Add-Type @"
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public class Win {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int m);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int m);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageW")] public static extern IntPtr SendStr(IntPtr h,uint m,IntPtr w,string l);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageW")] public static extern IntPtr GetStr(IntPtr h,uint m,IntPtr w,StringBuilder l);
  [DllImport("user32.dll",EntryPoint="SendMessageW")] public static extern IntPtr SendNum(IntPtr h,uint m,IntPtr w,IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr SetForegroundWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static List<IntPtr> Children(IntPtr parent){ var l=new List<IntPtr>(); EnumChildWindows(parent,(h,x)=>{l.Add(h);return true;},IntPtr.Zero); return l; }
  public static string Cls(IntPtr h){ var s=new StringBuilder(256); GetClassName(h,s,256); return s.ToString(); }
  public static string Txt(IntPtr h){ var s=new StringBuilder(512); GetWindowText(h,s,512); return s.ToString(); }
  public static string Edit(IntPtr h){ var s=new StringBuilder(1024); GetStr(h,0x000D,(IntPtr)1024,s); return s.ToString(); }
}
"@

$WM_SETTEXT = [uint32]0x000C
$BM_CLICK   = [uint32]0x00F5
$FIELD_ORDER = @("suppInvNo","amountBeforeTax","totalInvoiceAmount","invTaxAmount","invTaxNo")

function Set-Field($h, $value) { [Win]::SendStr($h, $WM_SETTEXT, [IntPtr]::Zero, [string]$value) | Out-Null }
function Click($h) { [Win]::SendNum($h, $BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null }

# True kalau bitmap punya piksel gelap (QR sudah terisi, bukan kotak putih kosong)
function Test-HasInk([System.Drawing.Bitmap]$bmp) {
  $step = [Math]::Max(1, [int]($bmp.Width/40))
  for ($y=0; $y -lt $bmp.Height; $y+=$step) {
    for ($x=0; $x -lt $bmp.Width; $x+=$step) {
      $c = $bmp.GetPixel($x,$y)
      if ($c.R -lt 128 -and $c.G -lt 128 -and $c.B -lt 128) { return $true }
    }
  }
  return $false
}

# Klik Generate, tunggu QR render, klik Copy, ambil gambar dari clipboard.
# Diulang beberapa kali kalau gambar masih kosong.
function Get-Qr($hGen, $hCopy, $hwnd) {
  for ($try=0; $try -lt 4; $try++) {
    [Win]::SetForegroundWindow($hwnd) | Out-Null
    Click $hGen
    Start-Sleep -Milliseconds (900 + $try*600)
    try { [System.Windows.Forms.Clipboard]::Clear() } catch {}
    Click $hCopy
    Start-Sleep -Milliseconds 400
    for ($i=0; $i -lt 12; $i++) {
      if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
        $img = [System.Windows.Forms.Clipboard]::GetImage()
        if ($img) {
          $bmp = New-Object System.Drawing.Bitmap($img)
          if (Test-HasInk $bmp) { return $bmp }
          $bmp.Dispose()
        }
      }
      Start-Sleep -Milliseconds 150
    }
  }
  return $null
}

# --- Luncurkan instance sendiri ---
$proc = Start-Process -FilePath $ExePath -PassThru
$proc.WaitForInputIdle(10000) | Out-Null
$win = [IntPtr]::Zero
for ($i=0; $i -lt 40 -and $win -eq [IntPtr]::Zero; $i++) { Start-Sleep -Milliseconds 300; $proc.Refresh(); $win = $proc.MainWindowHandle }
if ($win -eq [IntPtr]::Zero) { throw "Jendela aplikasi VISION tidak muncul." }

# --- Petakan kontrol ---
$edits = @(); $buttons = @{}
foreach ($h in [Win]::Children($win)) {
  $cls = [Win]::Cls($h)
  if ($cls -eq "TEdit") {
    $r = New-Object Win+RECT; [Win]::GetWindowRect($h, [ref]$r) | Out-Null
    $edits += [pscustomobject]@{ h=$h; top=$r.Top }
  } elseif ($cls -eq "TButton") {
    $buttons[([Win]::Txt($h)).Trim()] = $h
  }
}
$edits = $edits | Sort-Object top
if ($edits.Count -lt 5) { try { $proc.CloseMainWindow() | Out-Null } catch {}; throw "Kolom input tidak lengkap ($($edits.Count)/5)." }
$hGen  = $buttons[(($buttons.Keys) | Where-Object { $_ -like "*Generate*" } | Select-Object -First 1)]
$hCopy = $buttons[(($buttons.Keys) | Where-Object { $_ -like "*Copy*" } | Select-Object -First 1)]
if (-not $hGen -or -not $hCopy) { try { $proc.CloseMainWindow() | Out-Null } catch {}; throw "Tombol Generate/Copy tidak ditemukan." }

$rows = (Get-Content $JobFile -Raw | ConvertFrom-Json).rows
$results = @(); $ok = 0

foreach ($row in $rows) {
  try {
    for ($i=0; $i -lt 5; $i++) { Set-Field $edits[$i].h ([string]$row.($FIELD_ORDER[$i])) }
    Start-Sleep -Milliseconds 150
    # Verifikasi field benar-benar terisi (lintas-proses pakai WM_GETTEXT)
    $readback = [Win]::Edit($edits[0].h)
    if ($readback -ne [string]$row.suppInvNo) { throw "Field tidak terisi (baca '$readback')" }

    $bmp = Get-Qr $hGen $hCopy $win
    if ($bmp) {
      $dest = Join-Path $OutDir $row.file
      $bmp.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
      $bmp.Dispose()
      $ok++
      $results += [pscustomobject]@{ no=$row.no; suppInvNo=$row.suppInvNo; file=$row.file; ok=$true }
      Write-Host ("[{0}/{1}] {2} -> OK" -f $row.no, $rows.Count, $row.suppInvNo)
    } else {
      $results += [pscustomobject]@{ no=$row.no; suppInvNo=$row.suppInvNo; file=$row.file; ok=$false; error="QR kosong / tidak tersalin" }
      Write-Host ("[{0}/{1}] {2} -> GAGAL (QR kosong)" -f $row.no, $rows.Count, $row.suppInvNo)
    }
  } catch {
    $results += [pscustomobject]@{ no=$row.no; suppInvNo=$row.suppInvNo; file=$row.file; ok=$false; error=$_.Exception.Message }
    Write-Host ("[{0}/{1}] {2} -> ERROR: {3}" -f $row.no, $rows.Count, $row.suppInvNo, $_.Exception.Message)
  }
}

try { $proc.CloseMainWindow() | Out-Null } catch {}

[pscustomobject]@{ total=$rows.Count; ok=$ok; gagal=($rows.Count-$ok); results=$results; finishedAt=(Get-Date).ToString("s") } |
  ConvertTo-Json -Depth 5 | Set-Content -Path $ResultFile -Encoding UTF8
Write-Host ("Selesai: {0} OK, {1} gagal." -f $ok, ($rows.Count-$ok))
