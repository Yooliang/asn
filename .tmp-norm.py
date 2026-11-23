import subprocess,sys
files=subprocess.check_output(['git','diff','--name-only']).decode().split()
for f in files:
    b=open(f,'rb').read()
    n=b.replace(b'\r\n',b'\n')
    print(f, b.count(b'\r\n'))
    if n!=b: open(f,'wb').write(n)
b=open('relay/asn/ui/lib/report-reload.mjs','rb').read(); print('rr crlf', b.count(b'\r\n'))
