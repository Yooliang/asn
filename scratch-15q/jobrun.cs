// 把指令放進「關閉時結束所有成員」的工作群組跑，等它結束後關掉工作群組。
// jobrun.exe <breakaway|nobreakaway|check PID> <exe> <參數...>
using System;using System.Diagnostics;using System.Runtime.InteropServices;using System.Text;
class P{
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern IntPtr CreateJobObject(IntPtr a,string n);
 [DllImport("kernel32.dll")]static extern bool SetInformationJobObject(IntPtr j,int c,ref EXT i,int s);
 [DllImport("kernel32.dll")]static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
 [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll")]static extern uint ResumeThread(IntPtr t);
 [DllImport("kernel32.dll")]static extern uint WaitForSingleObject(IntPtr h,uint ms);
 [DllImport("kernel32.dll")]static extern bool GetExitCodeProcess(IntPtr h,out uint c);
 [DllImport("kernel32.dll")]static extern IntPtr OpenProcess(uint a,bool i,uint p);
 [DllImport("kernel32.dll")]static extern bool IsProcessInJob(IntPtr p,IntPtr j,out bool r);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern bool CreateProcess(string a,StringBuilder c,IntPtr pa,IntPtr ta,bool ih,uint f,IntPtr e,string d,ref SI si,out PI pi);
 [StructLayout(LayoutKind.Sequential)]struct BASIC{public long a,b;public uint Limit;public UIntPtr c,d;public uint e;public UIntPtr f;public uint g,h;}
 [StructLayout(LayoutKind.Sequential)]struct IOC{public ulong a,b,c,d,e,f;}
 [StructLayout(LayoutKind.Sequential)]struct EXT{public BASIC B;public IOC I;public UIntPtr x,y,z,w;}
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]struct SI{public int cb;public string a,b,c;public int d,e,f,g,h,i,j,k;public short l,m;public IntPtr n,o,p,q;}
 [StructLayout(LayoutKind.Sequential)]struct PI{public IntPtr hP,hT;public uint id,tid;}
 static int Main(string[] a){
  if(a[0]=="check"){var h=OpenProcess(0x1000,false,uint.Parse(a[1]));bool r;IsProcessInJob(h,IntPtr.Zero,out r);Console.WriteLine("in job="+r);return 0;}
  var j=CreateJobObject(IntPtr.Zero,null);var e=new EXT();e.B.Limit=0x2000|(a[0]=="breakaway"?0x800u:0u);
  if(!SetInformationJobObject(j,9,ref e,Marshal.SizeOf(e)))throw new Exception("set "+Marshal.GetLastWin32Error());
  var cmd=new StringBuilder();for(int i=1;i<a.Length;i++){cmd.Append('"').Append(a[i]).Append("\" ");}
  var si=new SI();si.cb=Marshal.SizeOf(si);PI pi;
  // CREATE_SUSPENDED | CREATE_BREAKAWAY_FROM_JOB（這個外殼可能已在工作群組裡，失敗就退回不脫離）
  if(!CreateProcess(null,cmd,IntPtr.Zero,IntPtr.Zero,false,0x4|0x01000000,IntPtr.Zero,null,ref si,out pi)&&!CreateProcess(null,cmd,IntPtr.Zero,IntPtr.Zero,false,0x4,IntPtr.Zero,null,ref si,out pi))throw new Exception("create "+Marshal.GetLastWin32Error());
  if(!AssignProcessToJobObject(j,pi.hP))throw new Exception("assign "+Marshal.GetLastWin32Error());
  ResumeThread(pi.hT);WaitForSingleObject(pi.hP,300000);uint c;GetExitCodeProcess(pi.hP,out c);
  Console.WriteLine("子程序結束 code="+c+"；關閉工作群組");CloseHandle(j);System.Threading.Thread.Sleep(1500);return 0;}
}
