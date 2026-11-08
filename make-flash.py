"""Builds the flash-drive archive:  python3 make-flash.py 1.1
   Result: dist/Lectern-V.1.1.zip containing  Lectern/Lectern.html, Lectern/app/ (with the icons inside), Lectern/Files/
   Add --howto to also put HOW-TO-USE.txt next to them (that is the copy offered for download on GitHub)."""
import os, re, shutil, sys, zipfile
root = os.path.dirname(os.path.abspath(__file__))
args = [a for a in sys.argv[1:] if not a.startswith('--')]
version = args[0] if args else '1.1'
howto = '--howto' in sys.argv
out_dir = os.path.join(root, 'dist'); stage = os.path.join(out_dir, 'Lectern')
shutil.rmtree(out_dir, ignore_errors=True)
os.makedirs(stage)
shutil.copytree(os.path.join(root, 'app'), os.path.join(stage, 'app'), ignore=shutil.ignore_patterns('.DS_Store'))
shutil.copytree(os.path.join(root, 'icons'), os.path.join(stage, 'app', 'icons'), ignore=shutil.ignore_patterns('.DS_Store'))
html = open(os.path.join(root, 'Lectern.html'), encoding='utf-8').read()
html = re.sub(r'(href=")icons/', r'\1app/icons/', html)      # the icons live inside app/ on the flash drive
open(os.path.join(stage, 'Lectern.html'), 'w', encoding='utf-8').write(html)
os.makedirs(os.path.join(stage, 'Files'))
shutil.copy(os.path.join(root, 'Files', 'Put your files here.txt'), os.path.join(stage, 'Files'))
if howto: shutil.copy(os.path.join(root, 'HOW-TO-USE.txt'), stage)
name = os.path.join(out_dir, 'Lectern-V.%s.zip' % version)
with zipfile.ZipFile(name, 'w', zipfile.ZIP_DEFLATED) as z:
    for d, dirs, files in os.walk(stage):
        dirs.sort()
        for f in sorted(files):
            full = os.path.join(d, f)
            z.write(full, os.path.relpath(full, out_dir))
print('written', name, round(os.path.getsize(name) / 1e6, 1), 'MB')
