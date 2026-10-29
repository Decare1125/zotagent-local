import os, subprocess, sys, tempfile, unittest
from pathlib import Path

HOST=Path(__file__).resolve().parents[1]/'runtime/pdf-engine-host.py'
class EngineDiagnostics(unittest.TestCase):
 def test_google_rate_limit_is_retained_even_if_process_exits_zero(self):
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp);(root/'utils').mkdir();(root/'utils/__init__.py').write_text('');(root/'utils/execute.py').write_text('def _parse_progress(text,task_id): pass\n')
   (root/'server.py').write_text("""import os,sys
import utils.execute as e
e._execute_with_inherit([sys.executable,'-c','print(\"HTTPError: 429 Client Error: Too Many Requests\")','--google'],dict(os.environ),'task',80)
assert 'HTTP 429' in e.zotagent_error_hint('task')
e.zotagent_forget_task('task')
assert e.zotagent_error_hint('task') is None
""",encoding='utf8')
   result=subprocess.run([sys.executable,'-X','utf8',str(HOST),str(root/'server.py')],capture_output=True,text=True,encoding='utf8')
   self.assertEqual(result.returncode,0,result.stderr)

if __name__=='__main__':unittest.main()
