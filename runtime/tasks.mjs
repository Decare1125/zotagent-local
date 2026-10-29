import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CodexClient, launchAgent } from './codex.mjs';
import { buildPrompt } from './context.mjs';

export class TaskManager {
  constructor(store,getConfig){this.store=store;this.getConfig=getConfig;this.tasks=new Map();this.starting=new Set();}
  publish(task,type,data={}){const event={id:task.events.length+1,type,...data};task.events.push(event);task.bus.emit('event',event);return event;}
  async start(sessionId,question,context){
    if(this.starting.has(sessionId))throw Object.assign(new Error('正在发送本次问题，请勿重复点击。'),{status:409});
    const finished=[...this.tasks.values()].filter(t=>t.status!=='running');for(const old of finished.slice(0,Math.max(0,finished.length-99)))this.tasks.delete(old.id);this.starting.add(sessionId);try{return await this._start(sessionId,question,context);}finally{this.starting.delete(sessionId);}
  }
  async _start(sessionId,question,context){
    const session=this.store.get(sessionId);if([...this.tasks.values()].some(t=>t.sessionId===sessionId&&t.status==='running'))throw Object.assign(new Error('当前会话正在生成，请先停止或等待完成。'),{status:409});
    if(typeof question!=='string'||!question.trim()||question.length>200000)throw new Error('请输入有效的问题（最多 200000 字符）。');
    const cfg=this.getConfig();const agent=session.agent;if(!['codex','claude','opencode'].includes(agent))throw new Error('不支持的 Agent');
    const selected=cfg.agents[agent];if(!selected?.command)throw new Error(`${agent} 尚未配置，请先在设置里填写已安装的程序路径。`);
    const cwd=session.cwd||cfg.cwd;if(selected.environment!=='wsl')await fs.access(cwd);
    const priorContext=structuredClone(session.context);
    // The primary paper is fixed at session creation; selected references can change per question.
    context={...context,primary:session.context?.primary||context?.primary};
    const promptContext=structuredClone(context),fulltextDigest=context.fulltext?createHash('sha256').update(context.fulltext).digest('hex'):null;
    const snapshot=structuredClone(context);if(snapshot.fulltext){snapshot.fulltextCharacters=snapshot.fulltext.length;delete snapshot.fulltext;}
    if(fulltextDigest&&session.contextDigests?.[agent]===fulltextDigest&&session.threadIds[agent]){delete promptContext.fulltext;promptContext.fulltextPreviouslyProvided=true;}
    else if(promptContext.fulltext?.length>80000){const contextDirectory=path.join(this.store.directory,'context');await fs.mkdir(contextDirectory,{recursive:true});const textPath=path.join(contextDirectory,'paper-'+fulltextDigest.slice(0,16)+'.md');await fs.writeFile(textPath,promptContext.fulltext);promptContext.fulltext='全文已保存为本地文件，请按需读取相关章节：'+agentPath(textPath,selected.environment)+'\n\n文档开头预览：\n'+promptContext.fulltext.slice(0,5000);}
    if(selected.environment==='wsl'){for(const p of [promptContext.primary,...(promptContext.references||[])])for(const a of p?.attachments||[])if(a.path)a.path=agentPath(a.path,'wsl');for(const f of promptContext.files||[])f.agentPath=agentPath(f.path,'wsl');}
    if(!session.context?.primary&&context.primary)session.context={...session.context,primary:context.primary};
    if(context.fulltext)session.context={...session.context,fulltext:context.fulltext};
    const user={id:randomUUID(),role:'user',text:question.trim(),context:snapshot,createdAt:new Date().toISOString()};
    const assistant={id:randomUUID(),role:'assistant',agent,model:session.model||selected.model||'',text:'',status:'running',createdAt:new Date().toISOString()};
    const before={title:session.title,updatedAt:session.updatedAt};session.messages.push(user,assistant);if(session.messages.length===2&&!session.titleIsCustom&&['新对话','新的阅读会话'].includes(session.title))session.title=question.trim().slice(0,60);session.updatedAt=new Date().toISOString();try{await this.store.save();}catch(e){session.messages.splice(-2);session.context=priorContext;session.title=before.title;session.updatedAt=before.updatedAt;throw new Error('问题未发送：会话保存失败，请检查磁盘空间后重试。');}
    const task={id:randomUUID(),sessionId,agent,status:'running',events:[],bus:new EventEmitter(),approvals:new Map(),session,assistant,cwd,fulltextDigest};task.bus.setMaxListeners(30);this.tasks.set(task.id,task);task.checkpoint=setInterval(()=>{if(task.status==='running')this.store.save().catch(e=>{task.persistenceError=e.message;});},3000);task.checkpoint.unref();
    this.publish(task,'started',{sessionId,messageId:assistant.id});
    const runtimeConfig={...selected,proxy:cfg.proxy};
    const run=agent==='codex'?this.runCodex(task,runtimeConfig,buildPrompt(question,promptContext),promptContext):this.runCLI(task,runtimeConfig,buildPrompt(question,promptContext),promptContext);
    run.catch(e=>this.finish(task,'failed',e.message));return task;
  }
  async finish(task,status,error){if(task.status!=='running')return;clearInterval(task.checkpoint);task.status=status;task.assistant.status=status;task.assistant.completedAt=new Date().toISOString();if(error)task.assistant.error=error;if(status==='completed'&&task.fulltextDigest){task.session.contextDigests??={};task.session.contextDigests[task.agent]=task.fulltextDigest;}task.session.updatedAt=new Date().toISOString();for(const approval of task.approvals.values())approval.resolve?.('cancel');task.approvals.clear();try{await this.store.save();}catch(e){error=(error?error+'；':'')+'会话保存失败：'+e.message;task.assistant.error=error;}finally{this.publish(task,'completed',{status,error,text:task.assistant.text});await task.client?.close();}}
  async runCodex(task,config,prompt,context){
    const client=task.client=new CodexClient(config,task.cwd);const textByItem=new Map();let settle;const done=new Promise(resolve=>{settle=resolve;});let hasTurn=false;
    client.on('failure',e=>{if(task.status==='running')this.finish(task,'failed',e.message).finally(settle);});
    client.on('message',msg=>{
      if(task.status!=='running')return;const p=msg.params||{};
      if(msg.id!=null&&msg.method){
        if(['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(msg.method)){
          const id=String(msg.id);task.approvals.set(id,{method:msg.method,params:p});this.publish(task,'approval',{approvalId:id,kind:msg.method.includes('commandExecution')?'command':'file',details:p});return;
        }
        if(msg.method==='item/tool/requestUserInput') {const id=String(msg.id);task.approvals.set(id,{method:msg.method,params:p});this.publish(task,'question',{approvalId:id,questions:p.questions});return;}
        client.send({id:msg.id,error:{code:-32601,message:'ZotAgent does not support this interactive operation; choose another supported method.'}});this.publish(task,'activity',{text:'当前工作台暂不支持此交互操作，请选择其他处理方式：'+msg.method});return;
      }
      if(p.threadId&&task.threadId&&p.threadId!==task.threadId)return;
      if(msg.method==='item/agentMessage/delta'){
        textByItem.set(p.itemId,(textByItem.get(p.itemId)||'')+p.delta);task.assistant.text=[...textByItem.values()].join('\n\n');this.publish(task,'delta',{itemId:p.itemId,delta:p.delta});
      }else if(msg.method==='item/completed'&&p.item?.type==='agentMessage'){
        textByItem.set(p.item.id,p.item.text||textByItem.get(p.item.id)||'');task.assistant.text=[...textByItem.values()].join('\n\n');this.publish(task,'replace',{itemId:p.item.id,itemText:textByItem.get(p.item.id),text:task.assistant.text});
      }else if(msg.method==='item/started'&&p.item?.type!=='agentMessage')this.publish(task,'activity',{text:activityLabel(p.item),item:p.item});
      else if(msg.method==='item/commandExecution/outputDelta')this.publish(task,'terminal',{text:p.delta||''});
      else if(msg.method==='item/reasoning/summaryTextDelta')this.publish(task,'thinking',{text:p.delta||''});
      else if(msg.method==='turn/started'){task.turnId=p.turn?.id;hasTurn=true;}
      else if(msg.method==='turn/completed'){
        const turn=p.turn||{};this.finish(task,turn.status==='completed'?'completed':turn.status==='interrupted'?'interrupted':'failed',turn.error?.message).finally(settle);
      }else if(msg.method==='error')this.publish(task,'activity',{text:p.message||p.error?.message||'Agent 报告了一个错误'});
    });
    await client.start();if(task.status!=='running'){await client.close();return;}const common={cwd:task.cwd,approvalPolicy:'on-request',sandbox:'workspace-write',...(task.assistant.model?{model:task.assistant.model}:{})};
    const saved=task.session.threadIds.codex;const result=saved?await client.call('thread/resume',{...common,threadId:saved,excludeTurns:true}):await client.call('thread/start',common);
    if(task.status!=='running'){await client.close();return;}task.threadId=result.thread.id;task.session.threadIds.codex=task.threadId;await this.store.save();this.publish(task,'thread',{threadId:task.threadId});
    const input=[{type:'text',text:prompt,text_elements:[]}];
    for(const file of context.files||[])if(file.type?.startsWith('image/')&&(file.agentPath||file.path))input.push({type:'localImage',path:file.agentPath||file.path});
    if(task.status!=='running'){await client.close();return;}const turn=await client.call('turn/start',{threadId:task.threadId,input,...(task.session.reasoningEffort?{effort:task.session.reasoningEffort}:{})});task.turnId=turn.turn.id;hasTurn=true;
    // A completed/failed/interrupted event is authoritative, not an empty text delta.
    await done;
  }
  async runCLI(task,config,prompt,context){
    const model=task.assistant.model;const saved=task.session.threadIds[task.agent];let args;
    if(task.agent==='claude')args=['-p',prompt,'--output-format','stream-json','--verbose','--include-partial-messages',...(saved?['--resume',saved]:[]),...(model?['--model',model]:[])];
    else args=['run','--format','json',...(saved?['--session',saved]:[]),...(model?['--model',model]:[]),...(context.files||[]).flatMap(f=>['--file',f.agentPath||f.path]),prompt];
    const child=task.child=launchAgent(config,args,{cwd:task.cwd,env:process.env,stdio:['ignore','pipe','pipe']});let stderr='',buffer='';let finalText='';
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');const onLine=line=>{if(task.status!=='running'||!line.trim())return;let e;try{e=JSON.parse(line);}catch{this.publish(task,'terminal',{text:line+'\n'});return;}
      const sid=e.session_id||e.sessionID;if(sid){task.session.threadIds[task.agent]=sid;task.threadId=sid;}
      let delta='';
      if(task.agent==='claude'){
        if(e.type==='stream_event'&&e.event?.type==='content_block_delta')delta=e.event.delta?.text||'';
        if(e.type==='assistant')finalText=(e.message?.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
        if(e.type==='result'){if(e.is_error)throw new Error(e.result||'Claude 调用失败');finalText=e.result||finalText;}
      }else if(e.type==='text')delta=e.part?.text||'';
      if(delta){task.assistant.text+=delta;this.publish(task,'delta',{itemId:'cli',delta});}
      if(['tool_use','tool_result','step_start','step_finish'].includes(e.type))this.publish(task,'activity',{text:e.type,item:e.part||e});
      if(e.type==='error')throw new Error(e.error?.data?.message||e.error?.message||JSON.stringify(e));
    };
    child.stderr.on('data',d=>{stderr=(stderr+d).slice(-8000);this.publish(task,'terminal',{text:String(d)});});
    child.stdout.on('data',d=>{buffer+=d;let pos;while((pos=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,pos);buffer=buffer.slice(pos+1);try{onLine(line);}catch(e){this.finish(task,'failed',e.message);child.kill();}}});
    await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code)=>{try{if(buffer)onLine(buffer);if(finalText&&task.status==='running')task.assistant.text=finalText;if(task.status==='running')this.finish(task,code===0?'completed':'failed',code===0?undefined:stderr||`进程退出码 ${code}`).finally(resolve);else resolve();}catch(e){reject(e);}});});
  }
  get(id){const t=this.tasks.get(id);if(!t)throw Object.assign(new Error('任务不存在'),{status:404});return t;}
  async stop(id){const t=this.get(id);if(t.status!=='running')return;if(t.client&&t.threadId&&t.turnId){await t.client.call('turn/interrupt',{threadId:t.threadId,turnId:t.turnId});}else{t.child?.kill();await this.finish(t,'interrupted');}}
  async approve(id,approvalId,decision,answers){const t=this.get(id),a=t.approvals.get(approvalId);if(!a)throw new Error('此审批已结束');if(a.method==='item/tool/requestUserInput'){const result={answers:{}};for(const q of a.params.questions||[])result.answers[q.id]={answers:[String(answers?.[q.id]||'')]};t.client.respond(Number.isNaN(Number(approvalId))?approvalId:Number(approvalId),result);}else{if(!['accept','decline','cancel'].includes(decision))throw new Error('无效审批决定');t.client.respond(Number.isNaN(Number(approvalId))?approvalId:Number(approvalId),{decision});}t.approvals.delete(approvalId);this.publish(t,'approvalResolved',{approvalId,decision});}
  async shutdown(){for(const t of this.tasks.values()){if(t.status==='running'){t.child?.kill();await this.finish(t,'interrupted','运行服务已停止');}await t.client?.close();}}
}
function activityLabel(item={}){return item.type==='commandExecution'?('运行命令：'+(item.command||'')):item.type==='fileChange'?'正在修改工作目录中的文件':item.type==='mcpToolCall'?`调用工具：${item.server||''} / ${item.tool||''}`:item.type==='reasoning'?'正在分析文献…':item.type||'处理中…';}
function agentPath(value,environment){return environment==='wsl'&&/^[A-Za-z]:[\\/]/.test(value)?'/mnt/'+value[0].toLowerCase()+value.slice(2).replaceAll('\\','/'):value;}
