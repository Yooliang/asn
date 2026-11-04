using System;using System.Text;using System.Threading;using System.Diagnostics;using System.IO;using System.Runtime.InteropServices;
class P{
 [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")]static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")]static extern bool ShowWindow(IntPtr h,int c);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")]static extern int GetWindowLong(IntPtr h,int i);
 [DllImport("user32.dll")]static extern bool GetGUIThreadInfo(uint t,ref GTI g);
 delegate bool EP(IntPtr h,IntPtr l);
 [DllImport("user32.dll")]static extern bool EnumWindows(EP e,IntPtr l);
 [DllImport("user32.dll")]static extern bool EnumChildWindows(IntPtr p,EP e,IntPtr l);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 [DllImport("user32.dll")]static extern void keybd_event(byte v,byte s,uint f,UIntPtr e);
 [DllImport("user32.dll")]static extern uint SendInput(uint n,INPUT[] i,int sz);
 [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr h,out R r);
 [DllImport("user32.dll")]static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")]static extern bool GetCursorPos(out PT p);
 [DllImport("user32.dll")]static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e);
 [DllImport("user32.dll")]static extern bool IsWindow(IntPtr h);
 [StructLayout(LayoutKind.Sequential)]struct PT{public int x,y;}
 [DllImport("winmm.dll")]static extern uint timeBeginPeriod(uint p);
 [StructLayout(LayoutKind.Sequential)]struct R{public int a,b,c,d;}
 [StructLayout(LayoutKind.Sequential)]struct GTI{public int cb;public uint flags;public IntPtr active,focus,capture,menu,move,caret;public R rc;}
 [StructLayout(LayoutKind.Sequential)]struct KI{public ushort vk,scan;public uint flags,time;public IntPtr extra;public int pad1,pad2;}
 [StructLayout(LayoutKind.Sequential)]struct INPUT{public uint type;public KI ki;}
 static Stopwatch sw=Stopwatch.StartNew();static StreamWriter log;static object lk=new object();
 static void L(string s){lock(lk){log.WriteLine(sw.ElapsedMilliseconds.ToString().PadLeft(8)+" "+s);log.Flush();}}
 static string D(IntPtr h){if(h==IntPtr.Zero)return "0";var t=new StringBuilder(256);var c=new StringBuilder(256);GetWindowText(h,t,256);GetClassName(h,c,256);uint p;GetWindowThreadProcessId(h,out p);string pn="?";try{pn=Process.GetProcessById((int)p).ProcessName;}catch{}return h.ToInt64().ToString("X")+"|"+c+"|"+t+"|"+pn+":"+p;}
 static void Mon(){IntPtr lf=(IntPtr)(-1),la=(IntPtr)(-1),lc=(IntPtr)(-1);var seen=new System.Collections.Generic.HashSet<long>();long n=0;
  while(true){var fg=GetForegroundWindow();var g=new GTI();g.cb=Marshal.SizeOf(g);GetGUIThreadInfo(0,ref g);
   if(fg!=lf){L("FG  "+D(fg));lf=fg;} if(g.focus!=lc){L("FOC "+D(g.focus));lc=g.focus;} if(g.active!=la){L("ACT "+D(g.active));la=g.active;}
   EnumWindows((h,l)=>{var t=new StringBuilder(64);GetWindowText(h,t,64);var ts=t.ToString();var cn=new StringBuilder(64);GetClassName(h,cn,64);if(ts=="ASN 提示"||ts=="ASN 安裝並登入"||cn.ToString()=="org.wezfurlong.wezterm"){bool vis=IsWindowVisible(h);R rc;GetWindowRect(h,out rc);string key=vis+" "+rc.a+","+rc.b+" "+(rc.c-rc.a)+"x"+(rc.d-rc.b);string pv;if(!rects.TryGetValue(h.ToInt64(),out pv)||pv!=key){rects[h.ToInt64()]=key;L("RECT "+h.ToInt64().ToString("X")+" "+ts+" vis="+key);}}return true;},IntPtr.Zero);
   if(++n%10==0)EnumWindows((h,l)=>{var t=new StringBuilder(64);GetWindowText(h,t,64);if(t.ToString()=="ASN 提示"){if(IsWindowVisible(h)&&seen.Add(h.ToInt64()))L("TOAST visible "+h.ToInt64().ToString("X")+" exstyle="+GetWindowLong(h,-20).ToString("X")+" noactivate="+((GetWindowLong(h,-20)&0x08000000)!=0));}return true;},IntPtr.Zero);
   Thread.Sleep(1);}}
 static IntPtr FindT(string sub){if(sub=="@fg")return GetForegroundWindow();if(sub.StartsWith("#"))return (IntPtr)long.Parse(sub.Substring(1));IntPtr r=IntPtr.Zero;EnumWindows((h,l)=>{var t=new StringBuilder(256);GetWindowText(h,t,256);if(IsWindowVisible(h)&&t.ToString().Contains(sub)){r=h;return false;}return true;},IntPtr.Zero);return r;}
 static IntPtr target=IntPtr.Zero;
 static System.Collections.Generic.Dictionary<long,string> rects=new System.Collections.Generic.Dictionary<long,string>();
 static bool Front(string sub){target=FindT(sub);if(target==IntPtr.Zero)return false;for(int i=0;i<10&&GetForegroundWindow()!=target;i++){keybd_event(0x12,0,0,UIntPtr.Zero);keybd_event(0x12,0,2,UIntPtr.Zero);ShowWindow(target,9);SetForegroundWindow(target);Thread.Sleep(150);}return GetForegroundWindow()==target;}
 static void Key(char c,uint up){var i=new INPUT[1];i[0].type=1;i[0].ki.scan=c;i[0].ki.flags=4|up;SendInput(1,i,Marshal.SizeOf(typeof(INPUT)));}
 static IntPtr Edit(){IntPtr r=IntPtr.Zero;EnumChildWindows(target,(h,l)=>{var c=new StringBuilder(64);GetClassName(h,c,64);if(c.ToString().Contains("RichEdit")||c.ToString()=="Edit"){r=h;return false;}return true;},IntPtr.Zero);return r;}
 static string Type(int n,int ms){int sent=0,lost=0;for(int i=0;i<n;i++){if(GetForegroundWindow()!=target){lost++;if(lost==1||lost%50==0)L("TYPE foreground not target, char "+i);Thread.Sleep(ms);continue;}Key((char)120,0);Key((char)120,2);sent++;Thread.Sleep(ms);}return "sent="+sent+" lost="+lost;}
 static void Combo(byte v){keybd_event(0x11,0,0,UIntPtr.Zero);keybd_event(v,0,0,UIntPtr.Zero);keybd_event(v,0,2,UIntPtr.Zero);keybd_event(0x11,0,2,UIntPtr.Zero);}
 static void Main(string[] a){timeBeginPeriod(1);Console.OutputEncoding=Encoding.UTF8;Console.InputEncoding=Encoding.UTF8;log=new StreamWriter(a[0],false,new UTF8Encoding(false));new Thread(Mon){IsBackground=true,Priority=ThreadPriority.AboveNormal}.Start();
  string line;while((line=Console.ReadLine())!=null){var p=line.Split(new[]{' '},2);string r="ok";L("CMD "+line);
   if(p[0]=="front")r=Front(p[1]).ToString();
   else if(p[0]=="type"){var q=p[1].Split(' ');r=Type(int.Parse(q[0]),int.Parse(q[1]));}
   else if(p[0]=="len"){var e=Edit();r=e==IntPtr.Zero?"noedit":SendMessage(e,0x0E,IntPtr.Zero,IntPtr.Zero).ToString();}
   else if(p[0]=="clear"){if(GetForegroundWindow()==target){Combo(0x41);keybd_event(0x2E,0,0,UIntPtr.Zero);keybd_event(0x2E,0,2,UIntPtr.Zero);Thread.Sleep(150);}else r="notfront";}
   else if(p[0]=="frontwait"){var sw2=Stopwatch.StartNew();r="False";while(sw2.ElapsedMilliseconds<40000){if(FindT(p[1])!=IntPtr.Zero){r=Front(p[1]).ToString();break;}Thread.Sleep(5);}}
   else if(p[0]=="clicktoast"){var sw3=Stopwatch.StartNew();r="notoast";while(sw3.ElapsedMilliseconds<30000){var h=FindT("ASN 提示");if(h!=IntPtr.Zero){Thread.Sleep(1500);R rc;GetWindowRect(h,out rc);PT old;GetCursorPos(out old);SetCursorPos((rc.a+rc.c)/2,(rc.b+rc.d)/2);Thread.Sleep(100);mouse_event(2,0,0,0,UIntPtr.Zero);Thread.Sleep(40);mouse_event(4,0,0,0,UIntPtr.Zero);L("CLICK toast "+h.ToInt64().ToString("X"));Thread.Sleep(700);SetCursorPos(old.x,old.y);bool al=IsWindow(h);var sw4=Stopwatch.StartNew();bool ch=false;while(sw4.ElapsedMilliseconds<3500){if(FindT("對話")!=IntPtr.Zero){ch=true;break;}Thread.Sleep(20);}r="closed="+(!al)+" chat="+ch+" chatms="+(sw4.ElapsedMilliseconds+700)+" fg="+D(GetForegroundWindow());break;}Thread.Sleep(5);}}
   else if(p[0]=="winstat"){var h=FindT(p[1]);r=h==IntPtr.Zero?"gone":("up "+h.ToInt64().ToString("X")+" ex="+GetWindowLong(h,-20).ToString("X")+" fg="+D(GetForegroundWindow()));}
   else if(p[0]=="shotwin"){var q=p[1].Split('|');var h=FindT(q[0]);if(h==IntPtr.Zero)r="gone";else{R rc;GetWindowRect(h,out rc);using(var bm=new System.Drawing.Bitmap(rc.c-rc.a,rc.d-rc.b)){using(var g=System.Drawing.Graphics.FromImage(bm))g.CopyFromScreen(rc.a,rc.b,0,0,bm.Size);bm.Save(q[1]);}r="saved "+(rc.c-rc.a)+"x"+(rc.d-rc.b)+" at "+rc.a+","+rc.b;}}
   else if(p[0]=="clickwin"){var q=p[1].Split('|');var h=FindT(q[0]);if(h==IntPtr.Zero)r="gone";else{R rc;GetWindowRect(h,out rc);double sf=(rc.c-rc.a)/360.0;PT old;GetCursorPos(out old);SetCursorPos(rc.c-(int)(double.Parse(q[1])*sf),rc.d-(int)(double.Parse(q[2])*sf));Thread.Sleep(150);mouse_event(2,0,0,0,UIntPtr.Zero);Thread.Sleep(40);mouse_event(4,0,0,0,UIntPtr.Zero);Thread.Sleep(150);SetCursorPos(old.x,old.y);L("CLICKWIN "+p[1]);}}
   else if(p[0]=="clickat"){var q=p[1].Split('|');var h=FindT(q[0]);if(h==IntPtr.Zero)r="gone";else{R rc;GetWindowRect(h,out rc);PT old;GetCursorPos(out old);SetCursorPos(rc.a+int.Parse(q[1]),rc.b+int.Parse(q[2]));Thread.Sleep(150);mouse_event(2,0,0,0,UIntPtr.Zero);Thread.Sleep(40);mouse_event(4,0,0,0,UIntPtr.Zero);Thread.Sleep(150);SetCursorPos(old.x,old.y);L("CLICKAT "+p[1]);}}
   else if(p[0]=="vk"){foreach(var t in p[1].Split(' ')){var ks=t.Split('+');foreach(var k in ks)keybd_event(byte.Parse(k),0,0,UIntPtr.Zero);Thread.Sleep(30);for(int i=ks.Length-1;i>=0;i--)keybd_event(byte.Parse(ks[i]),0,2,UIntPtr.Zero);Thread.Sleep(120);}}
   else if(p[0]=="text"){foreach(char c in p[1]){Key(c,0);Key(c,2);Thread.Sleep(8);}}
   else if(p[0]=="wheel"){var q=p[1].Split('|');var h=FindT(q[0]);R rc;GetWindowRect(h,out rc);PT old;GetCursorPos(out old);SetCursorPos((rc.a+rc.c)/2,(rc.b+rc.d)/2);Thread.Sleep(100);int n=int.Parse(q[1]);for(int i=0;i<Math.Abs(n);i++){mouse_event(0x800,0,0,(uint)(n>0?120:-120),UIntPtr.Zero);Thread.Sleep(40);}SetCursorPos(old.x,old.y);}
   else if(p[0]=="mark"){L("MARK "+p[1]);}
   else if(p[0]=="fg"){r=D(GetForegroundWindow());}
   else if(p[0]=="closewin"){if(target!=IntPtr.Zero)SendMessage(target,0x10,IntPtr.Zero,IntPtr.Zero);}
   else if(p[0]=="quit")return;
   L("RES "+r);Console.WriteLine(r);}
 }}
