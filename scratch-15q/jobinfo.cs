// 印自己所在工作群組的限制：jobinfo.exe <輸出檔>。從不同方式啟動，比對 ASN 實際會拿到什麼
using System;using System.IO;using System.Runtime.InteropServices;
class P{
 [DllImport("kernel32.dll")]static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll")]static extern bool IsProcessInJob(IntPtr p,IntPtr j,out bool r);
 [DllImport("kernel32.dll")]static extern bool QueryInformationJobObject(IntPtr j,int c,out EXT i,int s,IntPtr r);
 [StructLayout(LayoutKind.Sequential)]struct BASIC{public long a,b;public uint Limit;public UIntPtr c,d;public uint e;public UIntPtr f;public uint g,h;}
 [StructLayout(LayoutKind.Sequential)]struct IOC{public ulong a,b,c,d,e,f;}
 [StructLayout(LayoutKind.Sequential)]struct EXT{public BASIC B;public IOC I;public UIntPtr x,y,z,w;}
 static void Main(string[] a){bool r;IsProcessInJob(GetCurrentProcess(),IntPtr.Zero,out r);EXT e;string s="in job="+r;
  if(r&&QueryInformationJobObject(IntPtr.Zero,9,out e,Marshal.SizeOf(typeof(EXT)),IntPtr.Zero)){uint l=e.B.Limit;s+=" limit=0x"+l.ToString("X")+" kill_on_close="+((l&0x2000)!=0)+" breakaway_ok="+((l&0x800)!=0)+" silent_breakaway="+((l&0x1000)!=0);}
  else if(r)s+=" query_err="+Marshal.GetLastWin32Error();
  File.AppendAllText(a[0],s+"\r\n");}
}
