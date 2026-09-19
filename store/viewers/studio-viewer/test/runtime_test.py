"""Workspace safety and success/failure contracts for every copied runner."""
import contextlib
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

STORE = Path(__file__).resolve().parents[3]
coverage = None
if os.environ.get('STUDIO_COVERAGE'):
    from coverage import Coverage
    coverage = Coverage(branch=True, data_file=None, include=[str(STORE/'tools/studio_runtime.py')])
    coverage.start()
sys.path.insert(0, str(STORE/'tools'))
import studio_runtime as runtime

CONFIG = {'title':'Test studio', 'controls':[
    {'id':'steps','label':'Steps','type':'number','value':2,'min':1,'max':5,'integer':True},
    {'id':'shape','label':'Shape','type':'select','value':'round','options':[{'value':'round'},{'value':'square'}]},
    {'id':'text','label':'Text','type':'text','value':'hello','maxLength':8}], 'actions':[{'id':'make'}]}

class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='studio-runtime-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.workspace = self.root/'workspace'; self.workspace.mkdir()
        self.package = self.root/'package'; self.package.mkdir()
        (self.package/'studio.config.json').write_text(json.dumps(CONFIG))
        (self.package/'upstream.lock.json').write_text('[]')
        (self.workspace/'studio.json').write_text(json.dumps({'parameters':{}}))
        self.enterContext(patch.dict(os.environ, HARNESS_WORKSPACE=str(self.workspace)))
        self.enterContext(patch.object(runtime,'__file__',str(self.package/'toolchain/studio_runtime.py')))
        self.enterContext(patch.object(sys,'argv',['run']))

    def call(self, action=None):
        def make(p, out):
            (out/'hello.txt').write_text('A real artifact')
            return {'title':'Done', 'engine':'Test', 'metrics':[runtime.metric('Count',2)],
                    'files':[{'label':'Text','name':'hello.txt'}]}
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            runtime.execute({'make':action or make})

    def test_successful_runs_are_immutable_and_failed_runs_preserve_latest(self):
        self.call()
        first=(self.workspace/'out/latest.json').read_bytes()
        result=json.loads(first)
        self.assertTrue((self.workspace/result['artifacts'][0]['path']).is_file())
        self.assertEqual(result['parameters'],{'steps':2,'shape':'round','text':'hello'})
        self.assertTrue(json.loads((self.workspace/'.harness/verdict.json').read_text())['ready'])
        def fail(p,out): raise RuntimeError('Please choose another idea')
        with self.assertRaises(SystemExit): self.call(fail)
        self.assertEqual((self.workspace/'out/latest.json').read_bytes(), first)
        verdict=json.loads((self.workspace/'.harness/verdict.json').read_text())
        self.assertFalse(verdict['ready']); self.assertIn('choose another',verdict['summary'])
        self.call()
        self.assertEqual(len(runtime.previous_runs()),2)
        broken=self.workspace/'out/runs/broken'; broken.mkdir(); (broken/'result.json').write_text('partial')
        (self.root/'secret').write_text('{}')
        outside=self.workspace/'out/runs/outside'; outside.mkdir(); (outside/'result.json').symlink_to(self.root/'secret')
        self.assertEqual(len(runtime.previous_runs()),2)

    def test_input_failures_produce_actionable_verdicts(self):
        for argv,content in [(['run','unknown'],'{}'), (['run'],'x'*16385), (['run'],'broken'),
                             (['run'],'{}'), (['run'],'{"parameters":{"steps":false}}')]:
            with self.subTest(argv=argv,content=content[:30]):
                (self.workspace/'studio.json').write_text(content)
                with patch.object(sys,'argv',argv), self.assertRaises(SystemExit): self.call()
                self.assertFalse(json.loads((self.workspace/'.harness/verdict.json').read_text())['ready'])
        (self.workspace/'studio.json').unlink()
        with self.assertRaises(SystemExit): self.call()

    def test_rejects_missing_empty_and_escaping_artifacts(self):
        for name in ['missing.txt','../outside.txt','../../../outside.txt']:
            with self.subTest(name=name), self.assertRaises(SystemExit):
                self.call(lambda p,out: {'files':[{'label':'Output','name':name}]})
        def empty(p,out):
            (out/'empty').touch()
            return {'files':[{'label':'Empty','name':'empty'}]}
        with self.assertRaises(SystemExit): self.call(empty)
        self.assertFalse((self.workspace/'out/latest.json').exists())

    def test_confinement_and_atomic_writes(self):
        target=self.workspace/'state.json'
        runtime.atomic_json(target,{'value':1})
        with self.assertRaises(ValueError): runtime.atomic_json(target,{'value':math.nan})
        self.assertEqual(json.loads(target.read_text()),{'value':1})
        self.assertEqual(list(self.workspace.glob('.studio-*')),[])
        with self.assertRaises(ValueError): runtime.contained(self.root/'secret')
        (self.workspace/'escape').symlink_to(self.root,target_is_directory=True)
        with self.assertRaises(ValueError): runtime.atomic_json(self.workspace/'escape/secret',{})
        (self.workspace/'.harness').symlink_to(self.root,target_is_directory=True)
        with self.assertRaises(SystemExit): self.call()
        self.assertFalse((self.root/'verdict.json').exists())

    def test_control_types_and_boundaries(self):
        self.assertEqual(runtime.parameters(CONFIG,{'steps':1})['steps'],1)
        self.assertEqual(runtime.parameters(CONFIG,{'steps':5})['steps'],5)
        for value in [[],None,{'extra':1},{'steps':True},{'steps':None},{'steps':'2'},
                      {'steps':math.inf},{'steps':0},{'steps':2.5},{'shape':'other'},{'text':1},{'text':'a'*9}]:
            with self.subTest(value=value), self.assertRaises(ValueError): runtime.parameters(CONFIG,value)
        self.assertEqual(runtime.metric('X',1,'m'),{'label':'X','value':1,'unit':'m'})

    def test_commands_capture_logs_and_bound_runtime(self):
        self.assertEqual(runtime.command([sys.executable,'-c','print("hello")']).strip(),'hello')
        for code in ['import sys;print("helpful",file=sys.stderr);sys.exit(2)','import sys;print("output");sys.exit(2)','raise SystemExit(3)']:
            with self.assertRaises(RuntimeError): runtime.command([sys.executable,'-c',code])
        with self.assertRaises(subprocess.TimeoutExpired):
            runtime.command([sys.executable,'-c','import time;time.sleep(10)'],timeout=.05)

if __name__=='__main__':
    result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(RunnerTests))
    if coverage:
        coverage.stop(); coverage.json_report(outfile=str(Path(__file__).resolve().parent.parent/'test-results/runtime-python-coverage.json'))
    sys.exit(not result.wasSuccessful())
