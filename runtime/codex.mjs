import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import path from 'node:path';

export function launchAgent(config,args,options={}) {
  if(!config.command)throw new Error('没有找到 Agent 程序，请在设置中填写可执行文件路径。');
  const allArgs=[...(config.args||[]),...args];if(config.command.toLowerCase().endsWith('vendor\\codex\\bin\\codex.exe')){const env={...(options.env||process.env)};env.PATH=path.join(path.dirname(path.dirname(config.command)),'codex-path')+path.delimiter+(env.PATH||'');options={...options,env};}
  if(config.proxy)options={...options,env:{...(options.env||process.env),HTTPS_PROXY:config.proxy,HTTP_PROXY:config.proxy,NO_PROXY:'127.0.0.1,localhost,::1'}};
  if(config.environment==='wsl')return spawn('wsl.exe',['-d',config.distribution||'Ubuntu','--cd',options.cwd||'~','--exec',config.command,...allArgs],{...options,cwd:undefined,windowsHide:true,shell:false});
  return spawn(config.command,allArgs,{...options,windowsHide:true,shell:false});
}
export class CodexClient extends EventEmitter {
  constructor(config,cwd){super();this.config=config;this.cwd=cwd;this.pending=new Map();this.counter=0;this.stderr='';this.closed=false;}
  async start(){
    this.child=launchAgent(this.config,['app-server','--listen','stdio://'],{cwd:this.cwd,env:process.env,stdio:['pipe','pipe','pipe']});
    this.child.stdin.on('error',e=>this.fail(e));
    this.exitPromise=new Promise(resolve=>this.child.once('close',resolve));
    this.child.stderr.on('data',b=>{this.stderr=(this.stderr+b).slice(-6000);});
    this.child.on('error',e=>this.fail(e));this.child.on('exit',(code)=>this.fail(new Error(`Codex 进程已退出 (${code}) ${this.stderr.slice(-1000)}`)));
    this.lines=createInterface({input:this.child.stdout});this.lines.on('line',line=>{let msg;try{msg=JSON.parse(line);}catch{return;}
      if(Object.hasOwn(msg,'id')&&!msg.method){const p=this.pending.get(msg.id);if(p){this.pending.delete(msg.id);clearTimeout(p.timer);msg.error?p.reject(new Error(msg.error.message||JSON.stringify(msg.error))):p.resolve(msg.result);}return;}
      this.emit('message',msg);
    });
    await this.call('initialize',{clientInfo:{name:'zotagent_local',title:'ZotAgent Local',version:'1.0.0'},capabilities:{experimentalApi:false}});
    this.notify('initialized',{});return this;
  }
  send(msg){if(this.closed)throw new Error('Codex 连接已关闭');this.child.stdin.write(JSON.stringify(msg)+'\n');}
  notify(method,params){this.send({method,params});}
  call(method,params,timeout=45000){const id=++this.counter;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`Codex ${method} 请求超时`));},timeout);this.pending.set(id,{resolve,reject,timer});try{this.send({id,method,params});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}});}
  respond(id,result){this.send({id,result});}
  fail(e){if(this.closed)return;this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(e);}this.pending.clear();this.emit('failure',e);}
  close(){if(this.closingPromise)return this.closingPromise;this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('连接已关闭'));}this.pending.clear();this.lines?.close();this.child?.stdin.end();this.closingPromise=(async()=>{if(!this.child)return;const timer=setTimeout(()=>this.child.kill(),2000);timer.unref();try{await this.exitPromise;}finally{clearTimeout(timer);}})();return this.closingPromise;}
}
