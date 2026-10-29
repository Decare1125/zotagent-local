# SPDX-License-Identifier: AGPL-3.0-or-later
# License text: https://www.gnu.org/licenses/agpl-3.0.txt
"""Launch an installed PDF2zh service with pipe-safe Windows progress capture.
The external engine stays separate; this adapter contains no engine implementation.
"""
import codecs
import os
from pathlib import Path
import runpy
import subprocess
import sys
import threading

engine = Path(sys.argv[1]).resolve()
if engine.name != 'server.py' or not engine.is_file():
    raise SystemExit('Installed PDF2zh server.py is required')
sys.argv = [str(engine), *sys.argv[2:]]
sys.path.insert(0, str(engine.parent))
os.chdir(engine.parent)
os.environ['PYTHONUTF8'] = '1'
os.environ['PYTHONIOENCODING'] = 'utf-8'
import utils.execute as execution

# Keep cancellation scoped to the exact subprocess of one ZotAgent task.
_cancel_lock = threading.Lock()
_children = {}
_cancelled = set()
_error_hints = {}
def cancel_task(task_id):
    if sys.platform != 'win32':
        raise RuntimeError('当前平台暂不支持停止正在翻译的任务。')
    with _cancel_lock:
        _cancelled.add(task_id)
        child = _children.get(task_id)
        if child and child.poll() is None:
            result = subprocess.run(['taskkill', '/PID', str(child.pid), '/T', '/F'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            if result.returncode and child.poll() is None:
                _cancelled.discard(task_id)
                raise RuntimeError('无法停止翻译进程，请稍后重试。')
    return True

def forget_task(task_id):
    with _cancel_lock:
        _cancelled.discard(task_id)
        _children.pop(task_id, None)
        _error_hints.pop(task_id, None)
def error_hint(task_id):
    with _cancel_lock:
        return _error_hints.get(task_id)
execution.zotagent_error_hint = error_hint
execution.zotagent_cancel_task = cancel_task
execution.zotagent_forget_task = forget_task

def pipe_progress(command, environment, task_id, cols):
    if Path(command[0]).stem.lower() in {'pdf2zh', 'pdf2zh_next'}:
        entry = Path(command[0]).stem.lower()
        bootstrap = "import sys; from importlib.metadata import entry_points; name=sys.argv.pop(1); e=next(e for e in entry_points(group='console_scripts') if e.name==name); sys.exit(e.load()())"
        command = [sys.executable, '-u', '-c', bootstrap, entry, *command[1:]]
    env = dict(environment, PYTHONUTF8='1', PYTHONIOENCODING='utf-8')
    with _cancel_lock:
        if task_id in _cancelled:
            raise RuntimeError('任务已停止')
        child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 stdin=subprocess.DEVNULL, env=env, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        _children[task_id] = child
    decoder = codecs.getincrementaldecoder('utf-8')('replace')
    tail = ''
    saw_google_limit = False
    while True:
        chunk = os.read(child.stdout.fileno(), 4096)
        if not chunk:
            break
        text = decoder.decode(chunk)
        sys.stdout.write(text)
        sys.stdout.flush()
        tail = (tail + text)[-12000:]
        if '--google' in command and ('429 client error' in tail.lower() or 'error code: 429' in tail.lower()):
            saw_google_limit = True
        for line in text.replace('\r', '\n').splitlines():
            execution._parse_progress(line, task_id)
        # Percentages describe actual parsed engine output; completion is reported by server.py.
    code = child.wait()
    with _cancel_lock:
        stopped = task_id in _cancelled
        _children.pop(task_id, None)
    if stopped:
        raise RuntimeError('任务已停止')
    if saw_google_limit:
        with _cancel_lock:
            _error_hints[task_id] = 'Google 暂时限制了当前请求（HTTP 429），请稍后再试或更换翻译源。'
    if code:
        lower = tail.lower()
        if saw_google_limit:
            message = 'Google 暂时限制了当前请求（HTTP 429），请稍后再试或更换翻译源。'
        elif 'api key is required' in lower or 'api_key is required' in lower:
            message = '翻译源缺少 API 密钥，请在翻译设置中填写。'
        elif 'authenticationerror' in lower or 'error code: 401' in lower:
            message = '翻译源身份验证失败，请检查 API 密钥。'
        elif 'ratelimiterror' in lower or 'error code: 429' in lower:
            message = '翻译源额度或请求频率受限，请检查账户额度后重试。'
        elif 'connectionerror' in lower or 'connection error' in lower:
            message = '无法连接翻译源，请检查网络与服务地址。'
        else:
            message = '翻译处理失败，请检查翻译源、模型和网络；详细信息保存在本地运行日志。'
        raise RuntimeError(message)

execution._execute_with_inherit = pipe_progress
runpy.run_path(str(engine), run_name='__main__')
