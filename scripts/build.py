"""Build an offline Zotero XPI and desktop runtime without npm build dependencies."""
from pathlib import Path
from html.parser import HTMLParser
from html import escape
import base64, hashlib, json, os, re, shutil, tarfile, uuid, zipfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / 'dist'
ADDON = DIST / 'addon-1.0.0'

class XHTML(HTMLParser):
    void = {'meta','link','input','br','img','hr','source','wbr','area','base','col','embed','param','track'}
    def __init__(self): super().__init__(convert_charrefs=True); self.out=['<?xml version="1.0" encoding="UTF-8"?>\n']
    def handle_decl(self, decl): pass
    def handle_starttag(self, tag, attrs):
        if tag == 'html': attrs.append(('xmlns','http://www.w3.org/1999/xhtml'))
        attr=''.join(' '+k+'="'+escape(v if v is not None else k,quote=True)+'"' for k,v in attrs)
        self.out.append('<'+tag+attr+(' />' if tag in self.void else '>'))
    def handle_startendtag(self,tag,attrs): self.handle_starttag(tag,attrs)
    def handle_endtag(self,tag):
        if tag not in self.void:self.out.append('</'+tag+'>')
    def handle_data(self,data): self.out.append(escape(data))
    def handle_comment(self,data): self.out.append('<!--'+data+'-->')

def main():
    vendor=ROOT/'ui/vendor/katex'
    package=ROOT/'reference/katex.tgz'
    if package.exists():
        metadata=json.loads((ROOT/'reference/katex-metadata.json').read_text(encoding='utf-8-sig'))
        algorithm,expected=metadata['dist']['integrity'].split('-',1)
        actual=base64.b64encode(hashlib.new(algorithm,package.read_bytes()).digest()).decode()
        if actual!=expected:raise RuntimeError('KaTeX npm integrity mismatch')
        vendor.mkdir(parents=True,exist_ok=True)
        with tarfile.open(package) as tar:
            for member in tar.getmembers():
                if not member.isfile() or not member.name.startswith('package/dist/'):continue
                name=member.name.removeprefix('package/dist/')
                if name not in {'katex.min.js','katex.min.css'} and not name.startswith('fonts/'):continue
                dest=vendor/name
                if '..' in Path(name).parts:raise RuntimeError('Invalid package path')
                dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(tar.extractfile(member).read())
        license_data=tarfile.open(package).extractfile('package/LICENSE').read()
        (vendor/'LICENSE').write_bytes(license_data)
    if not (vendor/'katex.min.js').exists():raise RuntimeError('Run the official KaTeX asset download first')
    if ADDON.exists():
        target=ADDON.resolve();dist=DIST.resolve()
        if target.parent!=dist or target.name!='addon-1.0.0':raise RuntimeError('Unsafe build target')
        shutil.rmtree(target)
    ADDON.mkdir(parents=True,exist_ok=True)
    for source in (ROOT/'plugin').rglob('*'):
        if source.is_file():dest=ADDON/source.relative_to(ROOT/'plugin');dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,dest)
    shutil.copytree(ROOT/'ui',ADDON/'ui',dirs_exist_ok=True)
    raw_html=(ROOT/'ui/index.html').read_text(encoding='utf-8')
    for asset in ['app.css','app.js']:
        digest=hashlib.sha256((ROOT/'ui'/asset).read_bytes()).hexdigest()[:12]
        raw_html=re.sub(re.escape(asset)+r'(?:\?v=[^\"]*)?',asset+'?v='+digest,raw_html)
    (ADDON/'ui/index.html').write_text(raw_html,encoding='utf-8')
    html=XHTML();html.feed(raw_html)
    xhtml=''.join(html.out);ET.fromstring(xhtml);(ADDON/'ui/window.xhtml').write_text(xhtml,encoding='utf-8')
    translation_html=(ROOT/'ui/translation.html').read_text(encoding='utf-8')
    for asset in ['translation.css','translation.js']:
        digest=hashlib.sha256((ROOT/'ui'/asset).read_bytes()).hexdigest()[:12]
        translation_html=translation_html.replace(asset,asset+'?v='+digest)
    (ADDON/'ui/translation.html').write_text(translation_html,encoding='utf-8')
    translation=XHTML();translation.feed(translation_html);translation_xml=''.join(translation.out);ET.fromstring(translation_xml);(ADDON/'ui/translation.xhtml').write_text(translation_xml,encoding='utf-8')
    shutil.copytree(ROOT/'runtime',ADDON/'runtime',dirs_exist_ok=True,ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
    (ADDON/'runtime/native-terminal.ps1').unlink(missing_ok=True)
    assets=ROOT/'release-assets'
    def verify(file,algorithm,expected):
        digest=hashlib.new(algorithm)
        with file.open('rb') as stream:
            for block in iter(lambda:stream.read(1024*1024),b''):digest.update(block)
        if digest.hexdigest()!=expected:raise RuntimeError('Release asset checksum mismatch: '+file.name)
    node_asset=assets/'node-v24.22.1-win-x64.exe'
    codex_asset=assets/'codex-0.165.0-win32-x64.tgz'
    uv_asset=assets/'uv-0.13.6.whl'
    verify(node_asset,'sha256','d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5')
    verify(codex_asset,'sha512',base64.b64decode('f5LMyugPSnAovnTnR1N+SNHSTfWZ+ym5A4H3zZHz/zhuMGMGZD8IxUdlSUlEbiENYyPXrJ8G3Jh+CLyzTfQB6Q==').hex())
    verify(uv_asset,'sha256','7c9bc35ccb65932d8dc10a0669f9c805eaa3c9827ce18ecbecb1bd67944b2cdf')
    vendor=ADDON/'runtime/vendor'
    vendor.mkdir(parents=True,exist_ok=True)
    for source,name in [(node_asset,'node.exe'),(assets/'NODE-LICENSE.txt','node-LICENSE.txt'),(assets/'CODEX-LICENSE.txt','codex-LICENSE.txt'),(assets/'ripgrep-LICENSE-MIT.txt','ripgrep-LICENSE-MIT.txt'),(assets/'ripgrep-UNLICENSE.txt','ripgrep-UNLICENSE.txt')]:shutil.copy2(source,vendor/name)
    with zipfile.ZipFile(uv_asset) as z:
        for source,name in [('uv-0.13.6.data/scripts/uv.exe','uv.exe'),('uv-0.13.6.dist-info/licenses/LICENSE-MIT','uv-LICENSE-MIT.txt'),('uv-0.13.6.dist-info/licenses/LICENSE-APACHE','uv-LICENSE-APACHE.txt')]:
            (vendor/name).write_bytes(z.read(source))
    with tarfile.open(codex_asset,'r:gz') as t:
        for member in t:
            prefix='package/vendor/x86_64-pc-windows-msvc/'
            if not member.name.startswith(prefix) or not member.isfile():continue
            relative=Path(member.name[len(prefix):])
            if not relative.parts or '..' in relative.parts:raise RuntimeError('Invalid Codex archive path')
            target=vendor/'codex'/relative;target.parent.mkdir(parents=True,exist_ok=True)
            with t.extractfile(member) as source,target.open('wb') as dest:shutil.copyfileobj(source,dest)
    runtime_binary=[p.relative_to(ADDON/'runtime').as_posix() for p in vendor.rglob('*') if p.is_file()]
    machine={'nodePath':'','agents':{},'proxy':'','bundledNode':'vendor/node.exe','bundledCodex':'vendor/codex/bin/codex.exe','bundledUv':'vendor/uv.exe','translationEngine':{'bundled':True,'pythonRelative':'translation-env/Scripts/python.exe'},'buildId':str(uuid.uuid4()),'uiFiles':[p.relative_to(ADDON/'ui').as_posix() for p in (ADDON/'ui').rglob('*') if p.is_file()],'runtimeBinaryFiles':runtime_binary}
    machine['engineFiles']=[p.relative_to(ROOT/'runtime').as_posix() for p in (ROOT/'runtime/engine').rglob('*') if p.is_file() and '__pycache__' not in p.parts]
    (ADDON/'runtime/machine.json').write_text(json.dumps(machine,ensure_ascii=False,indent=2),encoding='utf-8')
    version=json.loads((ROOT/'plugin/manifest.json').read_text(encoding='utf-8'))['version']
    output=DIST/f'zotagent-local-{version}.xpi'
    with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as archive:
        for p in ADDON.rglob('*'):
            if p.is_file():archive.write(p,p.relative_to(ADDON).as_posix())
    ET.parse(ADDON/'preferences.xhtml')
    # The source bundle intentionally excludes personal profiles, test outputs,
    # credentials and machine-generated binaries. Release assets are reproducible.
    source_zip=DIST/'ZotAgent-Local-1.0.0-source.zip'
    with zipfile.ZipFile(source_zip,'w',zipfile.ZIP_DEFLATED) as archive:
        for folder in ['plugin','runtime','ui','test']:
            for p in (ROOT/folder).rglob('*'):
                if p.is_file() and '__pycache__' not in p.parts and p.name!='machine.json':archive.write(p,'ZotAgent-Local/'+p.relative_to(ROOT).as_posix())
        for name in ['scripts/build.py','scripts/fetch-release-assets.py','README-OPEN-SOURCE.md','LICENSE','package.json','gitignore.release']:
            p=ROOT/name
            if p.exists():archive.write(p,'ZotAgent-Local/'+('README.md' if name=='README-OPEN-SOURCE.md' else '.gitignore' if name=='gitignore.release' else name))
        for name in ['USER-GUIDE.md','TROUBLESHOOTING.md','PRIVACY.md','THIRD-PARTY.md','TESTING-1.0.0.md','RELEASE-NOTES.md']:
            p=ROOT/'docs'/name
            if p.exists():archive.write(p,'ZotAgent-Local/docs/'+name)
        for folder in ['media/screenshots','media/gifs','.github']:
            for p in (ROOT/folder).rglob('*'):
                if p.is_file():archive.write(p,'ZotAgent-Local/'+p.relative_to(ROOT).as_posix())
    print(json.dumps({'xpi':str(output),'bytes':output.stat().st_size,'addon':str(ADDON),'uiFiles':len(machine['uiFiles'])},ensure_ascii=False))

if __name__=='__main__':main()
