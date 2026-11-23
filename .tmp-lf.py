import sys
for f in sys.argv[1:]:
    b=open(f,'rb').read(); n=b.replace(b'\r\n',b'\n')
    if n!=b: open(f,'wb').write(n); print('lf',f)
