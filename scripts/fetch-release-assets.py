"""Fetch version-pinned upstream Windows release assets and verify their digests."""
from pathlib import Path
import base64,hashlib,shutil,tarfile,urllib.request,zipfile
root=Path(__file__).resolve().parents[1]/'release-assets';root.mkdir(exist_ok=True)
def download(url,name,algorithm,expected):
 p=root/name
 if not p.exists() or getattr(hashlib,algorithm)(p.read_bytes()).hexdigest()!=expected:
  temp=p.with_suffix(p.suffix+'.download');urllib.request.urlretrieve(url,temp)
  if getattr(hashlib,algorithm)(temp.read_bytes()).hexdigest()!=expected:raise RuntimeError('Checksum mismatch: '+name)
  temp.replace(p)
 return p
node=download('https://nodejs.org/dist/v24.22.1/win-x64/node.exe','node-v24.22.1-win-x64.exe','sha256','d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5')
codexhash=base64.b64decode('f5LMyugPSnAovnTnR1N+SNHSTfWZ+ym5A4H3zZHz/zhuMGMGZD8IxUdlSUlEbiENYyPXrJ8G3Jh+CLyzTfQB6Q==').hex()
codex=download('https://registry.npmjs.org/@openai/codex/-/codex-0.165.0-win32-x64.tgz','codex-0.165.0-win32-x64.tgz','sha512',codexhash)
uv=download('https://files.pythonhosted.org/packages/7c/9d/714523188aea3054644d8e69ae8089aac70325a3cee2d3d05509d4f23398/uv-0.13.6-py3-none-win_amd64.whl','uv-0.13.6.whl','sha256','7c9bc35ccb65932d8dc10a0669f9c805eaa3c9827ce18ecbecb1bd67944b2cdf')
for url,name in [('https://raw.githubusercontent.com/nodejs/node/v24.22.1/LICENSE','NODE-LICENSE.txt'),('https://raw.githubusercontent.com/openai/codex/rust-v0.165.0/LICENSE','CODEX-LICENSE.txt'),('https://raw.githubusercontent.com/BurntSushi/ripgrep/15.2.0/LICENSE-MIT','ripgrep-LICENSE-MIT.txt'),('https://raw.githubusercontent.com/BurntSushi/ripgrep/15.2.0/UNLICENSE','ripgrep-UNLICENSE.txt')]:
 (root/name).write_bytes(urllib.request.urlopen(url,timeout=60).read())
out=root/'codex-vendor';out.mkdir(exist_ok=True)
with tarfile.open(codex,'r:gz') as t:
 for m in t:
  prefix='package/vendor/x86_64-pc-windows-msvc/'
  if not m.name.startswith(prefix) or not m.isfile():continue
  rel=Path(m.name[len(prefix):])
  if not rel.parts or '..' in rel.parts:raise RuntimeError('Invalid archive member')
  dest=out/rel;dest.parent.mkdir(parents=True,exist_ok=True)
  with t.extractfile(m) as f,dest.open('wb') as w:shutil.copyfileobj(f,w)
with zipfile.ZipFile(uv) as z:
 for src,dest in [('uv-0.13.6.data/scripts/uv.exe','uv.exe'),('uv-0.13.6.dist-info/licenses/LICENSE-MIT','uv-LICENSE-MIT.txt'),('uv-0.13.6.dist-info/licenses/LICENSE-APACHE','uv-LICENSE-APACHE.txt')]: (root/dest).write_bytes(z.read(src))
print('Release assets downloaded and verified')
