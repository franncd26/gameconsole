"""ZIP I/O uses Python's maintained stdlib, never a custom decompressor."""
import json, os, re, shutil, stat, sys, zipfile
from pathlib import Path

def unpack(archive, destination):
    root = Path(destination).resolve()
    with zipfile.ZipFile(archive) as z:
        entries = z.infolist()
        if not entries or len(entries) > 2048:
            raise ValueError()
        seen, folders, total = set(), set(), 0
        for e in entries:
            name = e.filename
            parts = (name[:-1] if e.is_dir() else name).split('/')
            if len(parts) > 20 or any(not re.fullmatch(r'[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}', p)
                or p.endswith('.') or p.split('.')[0].upper() in ['CON','PRN','AUX','NUL',*[f'COM{i}' for i in range(10)],*[f'LPT{i}' for i in range(10)]] for p in parts):
                raise ValueError()
            if '\\' in name or name.startswith('/') or name.casefold().rstrip('/') in seen or e.flag_bits & 1 or e.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                raise ValueError()
            seen.add(name.casefold().rstrip('/')); folders.add(parts[0])
            kind = stat.S_IFMT(e.external_attr >> 16)
            if kind not in (0, stat.S_IFREG, stat.S_IFDIR):
                raise ValueError()
            total += e.file_size
            if e.file_size > 4 * 1024 * 1024 or total > 32 * 1024 * 1024:
                raise ValueError()
        if len(folders) != 1 or not any(e.filename == next(iter(folders)) + '/game.json' for e in entries):
            raise ValueError()
        # All names and sizes are checked before writing. CRC is checked while reading.
        for e in entries:
            target = root.joinpath(*e.filename.rstrip('/').split('/'))
            if e.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with z.open(e) as source, target.open('xb') as dest:
                    remaining = e.file_size
                    while chunk := source.read(65536):
                        remaining -= len(chunk)
                        if remaining < 0: raise ValueError()
                        dest.write(chunk)
                    if remaining: raise ValueError()
        print(json.dumps({'folder': next(iter(folders))}))

def pack(source, output):
    source = Path(source)
    with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED) as z:
        for file in sorted(source.rglob('*')):
            if file.is_symlink(): raise ValueError()
            if file.is_file(): z.write(file, source.name + '/' + file.relative_to(source).as_posix())

try:
    if sys.argv[1] == 'extract': unpack(sys.argv[2], sys.argv[3])
    elif sys.argv[1] == 'pack': pack(sys.argv[2], sys.argv[3])
    else: raise ValueError()
except Exception:
    print('INVALID_ARCHIVE', file=sys.stderr)
    sys.exit(1)
