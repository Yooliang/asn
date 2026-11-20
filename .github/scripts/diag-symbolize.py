# 診斷用：以 dbghelp 對重建版 exe + pdb 查 RVA 對應的函式名與原始檔行號。
import ctypes, struct, sys
from ctypes import wintypes as w

exe, pdbdir = sys.argv[1], sys.argv[2]
rvas = [int(x, 16) for x in sys.argv[3:]]
d = ctypes.WinDLL('dbghelp.dll')
d.SymSetOptions(0x2 | 0x4 | 0x10000000 | 0x200)  # UNDNAME|DEFERRED_LOADS... |LOAD_LINES
h = ctypes.c_void_p(1)
d.SymInitializeW.argtypes = [ctypes.c_void_p, w.LPCWSTR, w.BOOL]
assert d.SymInitializeW(h, pdbdir, False), 'SymInitialize'
data = open(exe, 'rb').read(4096)
pe = struct.unpack_from('<I', data, 0x3c)[0]
base = struct.unpack_from('<Q', data, pe + 24 + 24)[0]
size = struct.unpack_from('<I', data, pe + 24 + 56)[0]
d.SymLoadModuleExW.restype = ctypes.c_uint64
d.SymLoadModuleExW.argtypes = [ctypes.c_void_p, ctypes.c_void_p, w.LPCWSTR, w.LPCWSTR, ctypes.c_uint64, w.DWORD, ctypes.c_void_p, w.DWORD]
m = d.SymLoadModuleExW(h, None, exe, None, base, size, None, 0)
print('module loaded', hex(m), 'base', hex(base))

class SYM(ctypes.Structure):
    _fields_ = [('SizeOfStruct', w.ULONG), ('TypeIndex', w.ULONG), ('Reserved', ctypes.c_uint64 * 2),
                ('Index', w.ULONG), ('Size', w.ULONG), ('ModBase', ctypes.c_uint64), ('Flags', w.ULONG),
                ('Value', ctypes.c_uint64), ('Address', ctypes.c_uint64), ('Register', w.ULONG),
                ('Scope', w.ULONG), ('Tag', w.ULONG), ('NameLen', w.ULONG), ('MaxNameLen', w.ULONG),
                ('Name', ctypes.c_char * 2048)]
class LINE(ctypes.Structure):
    _fields_ = [('SizeOfStruct', w.DWORD), ('Key', ctypes.c_void_p), ('LineNumber', w.DWORD),
                ('FileName', ctypes.c_char_p), ('Address', ctypes.c_uint64)]
d.SymFromAddr.argtypes = [ctypes.c_void_p, ctypes.c_uint64, ctypes.POINTER(ctypes.c_uint64), ctypes.POINTER(SYM)]
d.SymGetLineFromAddr64.argtypes = [ctypes.c_void_p, ctypes.c_uint64, ctypes.POINTER(w.DWORD), ctypes.POINTER(LINE)]
for r in rvas:
    s = SYM(); s.SizeOfStruct = 88; s.MaxNameLen = 2048
    disp = ctypes.c_uint64(0)
    ok = d.SymFromAddr(h, base + r, ctypes.byref(disp), ctypes.byref(s))
    name = s.Name[:s.NameLen].decode('utf8', 'replace') if ok else '?'
    ln = LINE(); ln.SizeOfStruct = ctypes.sizeof(LINE); d2 = w.DWORD(0)
    lok = d.SymGetLineFromAddr64(h, base + r, ctypes.byref(d2), ctypes.byref(ln))
    src = f'{ln.FileName.decode(errors="replace")}:{ln.LineNumber}' if lok else '(no line)'
    print(f'RVA 0x{r:x} -> {name} +0x{disp.value:x}  {src}', flush=True)
