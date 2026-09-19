"""A clean install and pin updates against actual isolated Git repositories."""
import contextlib
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest

STORE=Path(__file__).resolve().parents[3]
coverage=None
if os.environ.get('STUDIO_COVERAGE'):
    from coverage import Coverage
    coverage=Coverage(branch=True,data_file=None,include=[str(STORE/'tools/studio_fetch.py')]);coverage.start()
sys.path.insert(0,str(STORE/'tools'))
from studio_fetch import fetch_sources

class FetchTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='studio-fetch-');self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve();self.package=self.root/'package';self.package.mkdir();self.source=self.root/'source';self.source.mkdir()
        self.git(self.source,'init','-q')
        self.git(self.source,'config','user.name','Local fixture');self.git(self.source,'config','user.email','fixture@example.invalid')
        self.git(self.source,'config','uploadpack.allowFilter','true')
        for name in ['included','excluded']:
            (self.source/name).mkdir();(self.source/name/'readme.txt').write_text(name)
        (self.source/'README.md').write_text('Original pinned fixture')
        self.git(self.source,'add','.');self.git(self.source,'commit','-qm','first')
        self.first=self.git(self.source,'rev-parse','HEAD')
        self.pin={'name':'Local source','url':self.source.as_uri(),'commit':self.first,'directory':'upstream','sparse':['included']}
        self.save()
    def git(self,path,*args):return subprocess.check_output(['git','-C',str(path),*args],text=True,stderr=subprocess.PIPE).strip()
    def save(self): (self.package/'upstream.lock.json').write_text(json.dumps([self.pin]))
    def fetch(self):
        with contextlib.redirect_stdout(io.StringIO()):fetch_sources(self.package)
    def test_fresh_sparse_fetch_is_idempotent_and_updates_clean_sources(self):
        self.fetch();target=self.package/'upstream'
        self.assertEqual(self.git(target,'rev-parse','HEAD'),self.first)
        self.assertTrue((target/'included/readme.txt').exists());self.assertFalse((target/'excluded').exists())
        self.fetch();self.assertEqual(self.git(target,'status','--porcelain'),'')
        (self.source/'README.md').write_text('Second source revision')
        self.git(self.source,'commit','-qam','second');self.pin['commit']=self.git(self.source,'rev-parse','HEAD');self.save();self.fetch()
        self.assertEqual((target/'README.md').read_text(),'Second source revision')
    def test_dirty_edits_and_remote_mismatches_are_preserved(self):
        self.fetch();target=self.package/'upstream';(target/'README.md').write_text('My local changes')
        (self.source/'README.md').write_text('New pin');self.git(self.source,'commit','-qam','second');self.pin['commit']=self.git(self.source,'rev-parse','HEAD');self.save()
        with self.assertRaisesRegex(SystemExit,'Save your edits'):self.fetch()
        self.assertEqual((target/'README.md').read_text(),'My local changes')
        self.git(target,'remote','set-url','origin','file:///not-the-source')
        with self.assertRaisesRegex(SystemExit,'Unexpected upstream'):self.fetch()
    def test_full_checkout_and_invalid_pins(self):
        self.pin['sparse']=[];self.save();self.fetch();self.assertTrue((self.package/'upstream/excluded/readme.txt').is_file())
        for directory,commit in [('../escape',self.first),('upstream','main'),('upstream','short')]:
            self.pin.update(directory=directory,commit=commit);self.save()
            with self.assertRaises(ValueError):self.fetch()
        self.pin.update(directory='outside',commit=self.first);self.save();(self.package/'outside').symlink_to(self.source,target_is_directory=True)
        with self.assertRaises(ValueError):self.fetch()
    def test_setup_entry_point_uses_its_own_package_location(self):
        # Execute the canonical source with a package-local filename, as the synchronized copy does.
        code=compile((STORE/'tools/studio_fetch.py').read_text(),str(STORE/'tools/studio_fetch.py'),'exec')
        with contextlib.redirect_stdout(io.StringIO()):exec(code,{'__name__':'__main__','__file__':str(self.package/'toolchain/studio_fetch.py')})
        self.assertEqual(self.git(self.package/'upstream','rev-parse','HEAD'),self.first)

if __name__=='__main__':
    result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(FetchTests))
    if coverage:
        coverage.stop();coverage.json_report(outfile=str(Path(__file__).resolve().parent.parent/'test-results/fetch-python-coverage.json'))
    sys.exit(not result.wasSuccessful())
