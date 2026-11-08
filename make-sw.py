"""Rebuilds sw.js (the offline cache list). Run it after you change any file:  python3 make-sw.py
The version number changes automatically, so installed copies refresh themselves."""
import hashlib, os, json
root = os.path.dirname(os.path.abspath(__file__))
skip_dirs = {'Files', 'node_modules', 'docs', 'downloads', 'dist'}
files = ['./', 'Lectern.html', 'manifest.webmanifest']
h = hashlib.sha1()
for d, dirs, names in os.walk(root):
    dirs[:] = sorted(x for x in dirs if x not in skip_dirs and not x.startswith('.'))
    for n in sorted(names):
        rel = os.path.relpath(os.path.join(d, n), root).replace(os.sep, '/')
        if rel in ('sw.js', 'sw.template.js', 'make-sw.py', 'make-flash.py', 'README.md', 'vercel.json') or n.startswith('.') or n.endswith(('.txt', '.md')):
            continue
        if rel not in files:
            files.append(rel)
        h.update(rel.encode()); h.update(open(os.path.join(d, n), 'rb').read())
version = h.hexdigest()[:10]
template = open(os.path.join(root, 'sw.template.js')).read()
open(os.path.join(root, 'sw.js'), 'w').write(
    template.replace('__VERSION__', version).replace('__FILES__', json.dumps(files, indent=2)))
print('sw.js written:', len(files), 'files, version', version)
