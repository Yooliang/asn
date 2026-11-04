Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class Q {
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint a, bool b, int p);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr h, uint f, StringBuilder s, ref uint n);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static string Path(int pid){ var h=OpenProcess(0x1000,false,pid); var s=new StringBuilder(1024); uint n=1024; var ok=QueryFullProcessImageNameW(h,0,s,ref n); CloseHandle(h); return ok?s.ToString():"fail"; }
}
"@
$dir = Join-Path $env:TEMP ("rn" + [guid]::NewGuid().ToString("N").Substring(0,8))
New-Item -ItemType Directory $dir | Out-Null
$exe = Join-Path $dir "wezterm-mux-server.exe"
Copy-Item C:\Windows\System32\ping.exe $exe
$pr = Start-Process $exe -ArgumentList "-n 20 127.0.0.1" -WindowStyle Hidden -PassThru
Start-Sleep -Milliseconds 800
"before: " + [IO.Path]::GetFileName([Q]::Path($pr.Id))
Rename-Item $exe "wezterm-mux-server.exe.old"
"after:  " + [IO.Path]::GetFileName([Q]::Path($pr.Id))
"getprocess: " + [IO.Path]::GetFileName($pr.Path)
Stop-Process -Id $pr.Id -Force
Start-Sleep -Milliseconds 300
Remove-Item $dir -Recurse -Force
