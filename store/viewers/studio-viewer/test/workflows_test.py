"""Measured local artifacts plus isolated contracts for optional native integrations.

Run once per package with that package's Python, preserving its actual native libraries.
Socket responders below are protocol fixtures, never evidence of a live application.
"""
import array
import base64
import contextlib
import csv
import hashlib
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import runpy
import shutil
import socket
import struct
import sys
import tempfile
import threading
import unittest
import wave
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

STORE = Path(__file__).resolve().parents[3]
NAME = os.environ['STUDIO_TEST_PACKAGE']
PACKAGE = STORE/'agents'/NAME
coverage = None
if os.environ.get('STUDIO_COVERAGE'):
    from coverage import Coverage
    coverage = Coverage(branch=True,data_file=None,include=[str(PACKAGE/'toolchain/workflow.py'),str(PACKAGE/'template/train.py')])
    coverage.start()
sys.path.insert(0,str(PACKAGE/'toolchain'))
import workflow as w

@contextlib.contextmanager
def tcp_responder(reply, framed=False):
    listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen();listener.settimeout(5)
    requests=[];errors=[]
    def receive(conn,n):
        data=b''
        while len(data)<n:
            chunk=conn.recv(n-len(data))
            if not chunk:raise RuntimeError('Incomplete fixture request')
            data+=chunk
        return data
    def serve():
        try:
            conn,_=listener.accept()
            with conn:
                conn.settimeout(5)
                payload=receive(conn,struct.unpack('>I',receive(conn,4))[0]) if framed else conn.recv(65536)
                request=json.loads(payload);requests.append(request)
                answer=reply(request);data=json.dumps(answer).encode()
                if framed:data=struct.pack('>I',len(data))+data
                # Fragment the reply to exercise the actual upstream transport.
                conn.sendall(data[:3]);conn.sendall(data[3:])
        except Exception as exc:errors.append(exc)
    thread=threading.Thread(target=serve,daemon=True);thread.start()
    try:yield listener.getsockname()[1],requests
    finally:
        listener.close();thread.join(6)
        if errors:raise errors[0]

class StudioCase(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory(prefix='studio-domain-');self.addCleanup(temp.cleanup)
        self.root=Path(temp.name).resolve();self.workspace=self.root/'workspace'
        shutil.copytree(PACKAGE/'template',self.workspace)
        self.p=json.loads((self.workspace/'studio.json').read_text())['parameters']
        self.enterContext(patch.dict(os.environ,HARNESS_WORKSPACE=str(self.workspace)))
        self.counter=0
    def output(self):
        self.counter+=1;out=self.workspace/'out'/f'check-{self.counter}';out.mkdir(parents=True);return out
    def action(self,name,**changes):
        p={**self.p,**changes};project=json.loads((self.workspace/'studio.json').read_text());project['parameters']=p
        (self.workspace/'studio.json').write_text(json.dumps(project));out=self.output()
        with contextlib.redirect_stdout(io.StringIO()):result=getattr(w,name)(p,out)
        for item in result['files']:self.assertGreater((out/item['name']).stat().st_size,0)
        json.dumps(result,allow_nan=False)
        return result,out
    def test_real_command_entry_point(self):
        with patch.object(sys,'argv',['run']),contextlib.redirect_stdout(io.StringIO()):
            runpy.run_path(str(PACKAGE/'toolchain/workflow.py'),run_name='__main__')
        verdict=json.loads((self.workspace/'.harness/verdict.json').read_text())
        self.assertTrue(verdict['ready']);self.assertTrue((self.workspace/verdict['artifact']).is_file())

class Instrument(StudioCase):
    def test_portable_cmake_adapter_keeps_paths_and_parameters_as_arguments(self):
        out=self.output();commands=[]
        def compiler(argv,**kwargs):
            commands.append(argv)
            if str(argv[0]).endswith('HarnessTone'):w.render(self.p,out)
            return ''
        with patch.object(w.platform,'system',return_value='Linux'),patch.object(w,'command',side_effect=compiler):
            result=w.juce(self.p,out)
        self.assertEqual(len(commands),3)
        self.assertIn('-DJUCE_ROOT='+str(PACKAGE/'juce'),commands[0])
        self.assertEqual(commands[-1][1],out/'phrase.wav')
        self.assertEqual(commands[-1][2],self.p['wave'])
        self.assertGreater(len(result['data']['waveform']),100)
    @unittest.skipUnless(os.environ.get('STUDIO_NATIVE_JUCE_WORKSPACE'),'Set STUDIO_NATIVE_JUCE_WORKSPACE for a real native compiler check')
    def test_native_juce_produces_measured_audio(self):
        native=Path(os.environ['STUDIO_NATIVE_JUCE_WORKSPACE']).resolve()
        with patch.dict(os.environ,HARNESS_WORKSPACE=str(native)),contextlib.redirect_stdout(io.StringIO()):
            out=native/'out/native-validation';out.mkdir(parents=True,exist_ok=True)
            for shape in ['sine','triangle','saw']:
                result=w.juce({**self.p,'wave':shape,'duration':1},out)
                self.assertEqual(result['engine'],'Native JUCE · offline instrument')
                self.assertGreater(max(abs(x) for x in result['data']['waveform']),.05)
    def test_waveforms_have_audio_and_correct_rate_without_clipping(self):
        digests=[]
        for shape in ['sine','triangle','saw']:
            result,out=self.action('render',wave=shape,duration=1)
            with wave.open(str(out/'phrase.wav')) as f:
                self.assertEqual((f.getnchannels(),f.getsampwidth(),f.getframerate(),f.getnframes()),(1,2,44100,44100))
                samples=array.array('h',f.readframes(f.getnframes()))
            self.assertGreater(max(samples),1000);self.assertLess(max(abs(x) for x in samples),32760)
            self.assertAlmostEqual(samples[0],0,delta=2);digests.append(hashlib.sha256((out/'phrase.wav').read_bytes()).hexdigest())
        self.assertEqual(len(set(digests)),3)
    def test_bad_audio_and_missing_native_source_fail(self):
        for channels,width,frames in [(2,2,b'\0'*8),(1,1,b'\0'*8),(1,2,b''),(1,2,struct.pack('<h',32767))]:
            out=self.output()
            with wave.open(str(out/'phrase.wav'),'wb') as f:
                f.setnchannels(channels);f.setsampwidth(width);f.setframerate(44100);f.writeframes(frames)
            with self.assertRaises(ValueError):w.summarize(self.p,out,'Test')
        (self.workspace/'CMakeLists.txt').unlink()
        with self.assertRaisesRegex(RuntimeError,'CMakeLists'):w.juce(self.p,self.output())

class Flow(StudioCase):
    def test_three_geometries_export_finite_fields_with_solid_boundaries(self):
        import numpy as np
        shapes=[]
        for shape in ['circle','square','ellipse']:
            r,out=self.action('simulate',shape=shape,steps=80)
            field=np.loadtxt(out/'flow.csv',delimiter=',',skiprows=1)
            self.assertEqual(field.shape,(120*56,6));self.assertTrue(np.isfinite(field).all())
            solid=field[:,5]==1;self.assertTrue(np.allclose(field[solid,2:4],0))
            self.assertGreater(field[~solid,2].max(),0);shapes.append(int(solid.sum()))
            self.assertEqual(r['data']['ux'],json.loads((out/'field.json').read_text())['ux'])
        self.assertEqual(len(set(shapes)),3)
    def test_instability_and_missing_openfoam_are_explicit(self):
        import numpy as np
        with patch.object(w.np,'isfinite',return_value=np.array([False])),self.assertRaisesRegex(RuntimeError,'unstable'):
            self.action('simulate',steps=80)
        with patch.object(w.shutil,'which',return_value=None),self.assertRaisesRegex(RuntimeError,'OpenFOAM'):
            w.openfoam(self.p,self.output())
    def test_openfoam_adapter_requires_final_field(self):
        def command(argv,**kwargs):
            if argv[0]=='icoFoam':
                final=Path(argv[-1])/'0.5';final.mkdir();(final/'U').write_text('fixture velocity field')
            return 'fixture solver log'
        with patch.object(w.shutil,'which',return_value='/fixture/tool'),patch.object(w,'command',side_effect=command):
            result,out=self.action('openfoam');self.assertTrue((out/'cavity.zip').is_file())
        with patch.object(w.shutil,'which',return_value='/fixture/tool'),patch.object(w,'command',return_value=''):
            with self.assertRaisesRegex(RuntimeError,'final velocity'):w.openfoam(self.p,self.output())
            shutil.rmtree(self.workspace/'openfoam-cavity')
            with self.assertRaisesRegex(RuntimeError,'benchmark'):w.openfoam(self.p,self.output())

class Research(StudioCase):
    def test_saved_model_is_independently_evaluated_and_comparisons_keep_data_fixed(self):
        import numpy as np
        result,out=self.action('train',steps=40)
        with np.load(out/'model.npz',allow_pickle=False) as model:
            score=w.evaluate(model,(self.workspace/'holdout.txt').read_text())
        self.assertAlmostEqual(score,result['data']['heldoutBpc'])
        self.assertGreater(result['data']['curve'][0][1],result['data']['curve'][-1][1])
        for prior,expected in [(score+1,'New best'),(score-1,'Keep exploring')]:
            r={**result,'action':'train','data':{**result['data'],'heldoutBpc':prior}}
            history=self.workspace/'out/runs/previous';history.mkdir(parents=True,exist_ok=True);(history/'result.json').write_text(json.dumps(r))
            next_result,_=self.action('train',steps=40);self.assertEqual(next_result['data']['status'],expected)
        (self.workspace/'holdout.txt').write_text('a different held out phrase')
        changed,_=self.action('train',steps=40);self.assertEqual(changed['data']['status'],'First baseline')
    def test_model_and_training_validation(self):
        import numpy as np
        source=runpy.run_path(str(PACKAGE/'template/train.py'));out=self.output()
        source['fit']('abcabcaabbcc'*4,{**self.p,'steps':11},out)
        old=Path.cwd()
        try:
            os.chdir(self.workspace)
            with patch.object(sys,'argv',['train.py',str(self.output())]):runpy.run_path(str(PACKAGE/'template/train.py'),run_name='__main__')
        finally:os.chdir(old)
        with np.load(out/'model.npz',allow_pickle=False) as model:
            data={key:model[key] for key in model.files}
            self.assertTrue(math.isfinite(w.evaluate(model,'abc!abc!')))
            with self.assertRaisesRegex(ValueError,'short'):w.evaluate(model,'')
        data['probabilities'][0,0]=-1
        with self.assertRaisesRegex(ValueError,'probabilities'):w.evaluate(data,'abc')
        result,out=self.action('train',steps=40)
        (out/'training.json').write_text('{"curve":[]}')
        with patch.object(w,'command',return_value=''),self.assertRaisesRegex(ValueError,'curve'):w.train(self.p,out)
        (self.workspace/'train.txt').unlink()
        with self.assertRaisesRegex(RuntimeError,'train.txt'):w.train(self.p,self.output())
    def test_native_mlx_adapter_gates_platform_preparation_and_metrics(self):
        with patch.object(w.platform,'system',return_value='Linux'),self.assertRaisesRegex(RuntimeError,'Apple Silicon'):w.mlx(self.p,self.output())
        with patch.object(w.platform,'system',return_value='Darwin'),patch.object(w.platform,'machine',return_value='arm64'):
            with self.assertRaisesRegex(RuntimeError,'Prepare'):w.mlx(self.p,self.output())
            root=self.workspace/'mlx';(root/'.venv/bin').mkdir(parents=True);(root/'.venv/bin/python').touch();(root/'train.py').touch()
            with patch.object(w,'command',return_value='val_bpb: 1.25'):
                r,_=self.action('mlx');self.assertEqual(r['metrics'][0]['value'],1.25)
            with patch.object(w,'command',return_value='no score'),self.assertRaisesRegex(RuntimeError,'val_bpb'):w.mlx(self.p,self.output())

class Music(StudioCase):
    def test_midi_and_wav_contain_the_saved_events(self):
        for scale in ['major','minor','pentatonic']:
            r,out=self.action('render',scale=scale,pattern='1001001001001001',swing=.3)
            midi=(out/'loop.mid').read_bytes();self.assertEqual(midi[:4],b'MThd');self.assertEqual(struct.unpack('>H',midi[12:14])[0],480)
            self.assertEqual(int.from_bytes(midi[18:22],'big'),len(midi)-22)
            self.assertEqual(r['data']['notes'],json.loads((out/'notes.json').read_text()))
            for n in r['data']['notes']:self.assertIn(bytes([0x90,n['note'],n['velocity']]),midi)
            with wave.open(str(out/'loop.wav')) as f:self.assertEqual(f.getframerate(),22050);self.assertGreater(f.getnframes(),22050)
        silent,out=self.action('render',pattern='0'*16);self.assertEqual(silent['data']['notes'],[])
        with wave.open(str(out/'loop.wav')) as f:self.assertEqual(set(f.readframes(f.getnframes())),{0})
        with self.assertRaisesRegex(ValueError,'sixteen'):w.notes({**self.p,'pattern':'x'})
        self.assertEqual(w.variable_length(0),b'\x00');self.assertEqual(w.variable_length(128),b'\x81\x00')
    def test_ableton_uses_pinned_transport_and_only_reads_session_state(self):
        for success in [True,False]:
            response=lambda request:{'status':'success','result':{'tempo':123,'tracks':[{'name':'Piano'}]}} if success else {'status':'error','message':'Fixture session unavailable'}
            with tcp_responder(response) as (port,requests),patch.dict(os.environ,ABLETON_HOST='127.0.0.1',ABLETON_PORT=str(port)):
                if success:
                    r,_=self.action('live');self.assertEqual(r['data']['session']['tempo'],123)
                else:
                    with self.assertRaisesRegex(RuntimeError,'Fixture session unavailable'):w.live(self.p,self.output())
            self.assertEqual(requests,[{'type':'get_session_info','params':{}}])

class Robot(StudioCase):
    def test_actual_dynamics_reach_open_goals_in_both_layouts(self):
        for layout,goal in [('office',(8,7)),('gallery',(8,5)),('office',(1,1))]:
            r,out=self.action('simulate',layout=layout,goal_x=goal[0],goal_y=goal[1])
            data=r['data'];self.assertTrue(data['success']);self.assertEqual(data['contacts'],0)
            self.assertLess(math.dist(data['positions'][-1][1:],goal),.13)
            self.assertEqual(ET.parse(out/'mission.xml').getroot().tag,'mujoco')
    def test_bad_goals_unreachable_routes_and_failed_dynamics(self):
        with self.assertRaisesRegex(ValueError,'inside a wall'):w.plan([4,3],w.obstacles('office'))
        with self.assertRaisesRegex(ValueError,'no clear route'):w.plan([8,8],[[5,5,20,1]])
        with patch.object(w.mujoco,'mj_step',return_value=None),self.assertRaisesRegex(RuntimeError,'budget'):
            w.simulate(self.p,self.output())
    def test_native_status_never_sends_motion(self):
        with patch.object(w.shutil,'which',return_value=None),self.assertRaisesRegex(RuntimeError,'not installed'):w.dimos(self.p,self.output())
        with patch.object(w.shutil,'which',return_value='/fixture/dimos'),patch.object(w,'command',return_value='Fixture daemon ready') as command:
            r,_=self.action('dimos');command.assert_called_once_with(['/fixture/dimos','status'],timeout=15)

class City(StudioCase):
    def test_measured_trips_and_light_phases_follow_the_selected_plan(self):
        summaries=[]
        for green in [10,70]:
            r,out=self.action('simulate',green=green,duration=120,demand=360)
            data=r['data'];self.assertGreater(data['finished'],0);self.assertGreater(len(data['frames']),10)
            with (out/'trips.csv').open() as f:rows=list(csv.DictReader(f))
            finished=[row for row in rows if row['finished']=='True']
            self.assertEqual(data['finished'],len(finished))
            self.assertAlmostEqual(r['metrics'][0]['value'],round(sum(float(row['time_loss']) for row in finished)/len(finished),1))
            network=ET.parse(out/'city.net.xml');links=[int(c.get('linkIndex')) for c in network.findall('connection') if c.get('tl')=='C' and c.get('from') in ['WC','EC'] and c.get('dir')=='s']
            self.assertTrue(links)
            for phase in data['phases']:
                if 'y' not in phase['state'].lower() and any(phase['state'][i] in 'Gg' for i in links):self.assertEqual(float(phase['duration']),green)
            summaries.append(data)
        self.assertNotEqual(summaries[0]['frames'],summaries[1]['frames'])
    def test_native_tool_failures_never_become_empty_successes(self):
        def broken(argv,**kwargs):
            out=Path(argv[argv.index('--output-file')+1]);out.write_text('<net/>');return ''
        with patch.object(w,'command',side_effect=broken),self.assertRaisesRegex(RuntimeError,'traffic light'):w.simulate(self.p,self.output())
        real=w.command
        def no_trips(argv,**kwargs):
            result=real(argv,**kwargs)
            if '--tripinfo-output' in argv:Path(argv[argv.index('--tripinfo-output')+1]).write_text('<tripinfos/>')
            return result
        with patch.object(w,'command',side_effect=no_trips),self.assertRaisesRegex(RuntimeError,'No trips'):w.simulate({**self.p,'duration':120},self.output())

class Building(StudioCase):
    def test_incomplete_ifc_readback_is_rejected(self):
        original=w.ifcopenshell.open
        def missing_space(path):
            model=original(path);model.remove(model.by_type('IfcSpace')[0]);return model
        with patch.object(w.ifcopenshell,'open',side_effect=missing_space),self.assertRaisesRegex(RuntimeError,'read-back'):self.action('build',storeys=1)
    def test_ifc_quantities_openings_and_spaces_survive_readback(self):
        for use,storeys in [('studio',1),('home',3)]:
            r,out=self.action('build',use=use,storeys=storeys)
            f=w.ifcopenshell.open(out/'building.ifc')
            self.assertEqual(f.schema,'IFC4');self.assertEqual(len(f.by_type('IfcSpace')),storeys*2)
            self.assertEqual(len(f.by_type('IfcWall')),storeys*5);self.assertEqual(len(f.by_type('IfcRelFillsElement')),storeys)
            with (out/'quantities.csv').open() as stream:rows=list(csv.DictReader(stream))
            total=sum(float(row['net_area_m2']) for row in rows)
            self.assertAlmostEqual(total,r['data']['area']);self.assertGreater(total,0)
            # Tessellation independently checks that the saved products have usable geometry.
            import ifcopenshell.geom
            settings=ifcopenshell.geom.settings()
            shape=ifcopenshell.geom.create_shape(settings,f.by_type('IfcWall')[0]);self.assertGreater(len(shape.geometry.verts),0)
    def test_bonsai_framed_transport_is_read_only_and_reports_errors(self):
        for success in [True,False]:
            def response(request):return {'id':request['id'],'success':success,'result':{'objects':[{'name':'Wall'}]},'error':None if success else 'Fixture bridge failed'}
            with tcp_responder(response,framed=True) as (port,requests),patch.dict(os.environ,BONSAI_MCP_PORT=str(port),BONSAI_MCP_HOST='127.0.0.1'):
                if success:
                    r,_=self.action('bonsai');self.assertEqual(r['data']['scene']['objects'][0]['name'],'Wall')
                else:
                    with self.assertRaisesRegex(RuntimeError,'Fixture bridge failed'):w.bonsai(self.p,self.output())
            self.assertEqual(requests[0]['command'],'get_scene_info');self.assertEqual(requests[0]['params'],{'limit':50})

class Images(StudioCase):
    def test_every_palette_has_reproducible_valid_artwork_and_hashes(self):
        for palette in ['orchard','dusk','citrus']:
            r,out=self.action('generate',palette=palette,variations=2)
            recipe=json.loads((out/'recipe.json').read_text());self.assertEqual(len(recipe['images']),2)
            for image in recipe['images']:
                content=(out/image['name']).read_bytes();self.assertEqual(hashlib.sha256(content).hexdigest(),image['sha256'])
                self.assertEqual(ET.fromstring(content).get('viewBox'),'0 0 640 640')
                self.assertEqual(content.decode(),w.artwork(recipe['parameters'],image['seed']))
    def test_comfy_validation_and_connection_errors(self):
        for url in ['https://127.0.0.1:8188','http://example.com','http://u:p@localhost:8188','http://localhost:8188/path','http://localhost:8188?x=1','http://localhost:8188#fragment']:
            with patch.dict(os.environ,COMFYUI_URL=url),self.assertRaisesRegex(ValueError,'loopback'):w.comfy(self.p,self.output())
        for content in ['{}','[]','{"1":{}}',' '*1000001]:
            (self.workspace/'workflow.json').write_text(content)
            with self.assertRaises(ValueError):w.comfy(self.p,self.output())
        shutil.copy(PACKAGE/'template/workflow.json',self.workspace/'workflow.json')
        listener=socket.socket();listener.bind(('127.0.0.1',0));port=listener.getsockname()[1];listener.close()
        with patch.dict(os.environ,COMFYUI_URL=f'http://127.0.0.1:{port}'),self.assertRaisesRegex(RuntimeError,'Start local ComfyUI'):w.comfy(self.p,self.output())
    def test_comfy_real_http_job_contract(self):
        test=self;scenario={'mode':'success'};requests=[]
        png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jT1sAAAAASUVORK5CYII=')
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_POST(self):
                requests.append((self.path,json.loads(self.rfile.read(int(self.headers['Content-Length'])))))
                if scenario['mode']=='reject':self.reply({'node_errors':{'1':'unknown node'}})
                elif scenario['mode']=='redirect':self.send_response(302);self.send_header('Location','http://example.com/');self.end_headers()
                else:self.reply({'prompt_id':'fixture-job','node_errors':{}})
            def do_GET(self):
                if self.path.startswith('/history/'):
                    mode=scenario['mode']
                    if mode=='timeout':self.reply({})
                    elif mode=='pending':self.reply({'fixture-job':{'status':{'status_str':'running'},'outputs':{}}})
                    elif mode=='execution':self.reply({'fixture-job':{'status':{'status_str':'error','messages':['fixture error']}}})
                    else:self.reply({'fixture-job':{'status':{'status_str':'success'},'outputs':{'2':{'images':[] if mode=='empty' else [{'filename':'fixture.png','subfolder':'','type':'output'}]}}}})
                else:
                    content=b'x'*(32*1024*1024+1) if scenario['mode']=='oversize' else b'not a PNG' if scenario['mode']=='invalid' else png
                    self.send_response(200);self.end_headers();self.wfile.write(content)
            def reply(self,data):self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps(data).encode())
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        with patch.dict(os.environ,COMFYUI_URL=f'http://127.0.0.1:{server.server_port}',STUDIO_COMFY_TIMEOUT='.1'):
            result,out=self.action('comfy');self.assertEqual((out/'comfy-1.png').read_bytes(),png)
            self.assertEqual(requests[0][0],'/prompt');self.assertEqual(requests[0][1]['prompt'],json.loads((self.workspace/'workflow.json').read_text()))
            for mode,message in [('reject','rejected'),('execution','execution failed'),('timeout','time limit'),('pending','time limit'),('empty','no images'),('invalid','PNG'),('redirect','redirect'),('oversize','download limit')]:
                scenario['mode']=mode
                with self.subTest(mode=mode),self.assertRaisesRegex(RuntimeError,message):w.comfy(self.p,self.output())

CASES={'juce-agent-toolkit':Instrument,'foam-agent':Flow,'autoresearch-mlx':Research,
       'ableton-ai':Music,'dimos':Robot,'simskill':City,'bonsai-mcp':Building,'comfy-mcp':Images}
if __name__=='__main__':
    result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(CASES[NAME]))
    if coverage:
        coverage.stop();coverage.json_report(outfile=str(Path(__file__).resolve().parent.parent/f'test-results/{NAME}-python-coverage.json'))
    sys.exit(not result.wasSuccessful())
