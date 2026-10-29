import http from 'node:http';
import {TranslationManager} from './translation.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { loadConfig, saveConfig, publicConfig, defaultDataDir } from './config.mjs';
import { Store } from './store.mjs';
import { TaskManager } from './tasks.mjs';
import { validateContext } from './context.mjs';
import { CodexClient } from './codex.mjs';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
export async function createServer({dataDir=defaultDataDir,port,token,uiDirectory=path.join(ROOT,'../ui'),onShutdown}={}){
  let config=await loadConfig(dataDir);if(port!==undefined)config.port=port;if(token)config.token=token;
  const store=await new Store(dataDir).init();const tasks=new TaskManager(store,()=>config);const bridgeJobs=new Map();let plugin={seen:0,context:null,version:null};
  let loginClient=null,loginState={status:'idle'},loginTimer=null,loginStarting=null;
  async function endLogin(){clearTimeout(loginTimer);const client=loginClient;loginClient=null;if(client)await client.close();}
  async function startLogin(){if(loginStarting)return loginStarting;loginStarting=performLogin().finally(()=>loginStarting=null);return loginStarting;}
  async function performLogin(){if(loginClient&&loginState.status==='pending')return loginState;await endLogin();const client=new CodexClient({...config.agents.codex,proxy:config.proxy},config.cwd);loginClient=client;try{await client.start();const account=await client.call('account/read',{refreshToken:false});if(account.account||account.requiresOpenaiAuth===false){loginState={status:'signed_in'};await endLogin();return loginState;}client.on('message',msg=>{if(msg.method==='account/login/completed'&&loginClient===client){loginState=msg.params?.success?{status:'signed_in'}:{status:'failed',message:'登录未完成，请重新尝试。'};endLogin().catch(()=>{});}});const result=await client.call('account/login/start',{type:'chatgpt'});if(loginClient!==client)return loginState;const url=new URL(result.authUrl);if(url.protocol!=='https:'||!['auth.openai.com','chatgpt.com'].includes(url.hostname)||url.username||url.password)throw new Error('登录地址无效');loginState={status:'pending',url:url.href};loginTimer=setTimeout(()=>{if(loginClient===client){loginState={status:'failed',message:'登录已超时，请重新尝试。'};endLogin().catch(()=>{});}},600000);loginTimer.unref?.();return loginState;}catch(e){loginState={status:'failed',message:'无法启动 Codex 登录，请检查 Codex 是否已安装。'};await endLogin();throw e;}}
  let configQueue=Promise.resolve();
  const connected=()=>Date.now()-plugin.seen<6000;
  function bridge(method,args={}){if(!connected())throw Object.assign(new Error('请先打开 Zotero 并启用 ZotAgent Local 插件。'),{status:503});return new Promise((resolve,reject)=>{const id=randomUUID(),timer=setTimeout(()=>{bridgeJobs.delete(id);reject(Object.assign(new Error('Zotero 操作超时，请确认插件仍在运行。'),{status:504}));},['fulltext','importTranslation'].includes(method)?120000:15000);bridgeJobs.set(id,{id,method,args,resolve,reject,timer,sent:false});});}
  const translations=await new TranslationManager(dataDir,bridge).init();
  const server=http.createServer(async(req,res)=>{
    try{
      const host=req.headers.host||'';if(!/^127\.0\.0\.1:\d+$/.test(host))return json(res,403,{error:'仅允许本机回环连接'});
      const url=new URL(req.url,'http://'+host),route=url.pathname;
      const origin=req.headers.origin;if(origin&&!['http://'+host,'null'].includes(origin)&&!origin.startsWith('chrome://'))return json(res,403,{error:'来源不允许'});
      if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');
      if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Headers','Authorization,Content-Type,Last-Event-ID');res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,OPTIONS');res.writeHead(204);return res.end();}
      if(route==='/health')return json(res,200,{ok:true,name:'zotagent-local',version:'1.0.0'});
      if(route==='/updates.json')return json(res,200,{addons:{'zotagent-local@research.local':{updates:[]}}});
      if(route.startsWith('/api/')){
        const supplied=String(req.headers.authorization||'').replace(/^Bearer /,'');const a=Buffer.from(supplied),b=Buffer.from(config.token);if(a.length!==b.length||!timingSafeEqual(a,b))return json(res,401,{error:'连接令牌无效，请使用插件或启动入口打开。'});
        if(req.method==='GET'&&route==='/api/status')return json(res,200,{ok:true,version:'1.0.0',pluginConnected:connected(),zoteroVersion:plugin.version,recoveryNotice:[store.recoveryNotice,config.recoveryNotice].filter(Boolean).join("；")||null,agents:Object.fromEntries(await Promise.all(Object.entries(config.agents).map(async([name,c])=>{let installed=Boolean(c.command);if(c.command&&c.environment!=='wsl')try{await fs.access(c.command);}catch{installed=false;}return [name,{installed,environment:c.environment,command:c.command,model:c.model}];}))),activeTranslations:translations.active,activeTasks:[...tasks.tasks.values()].filter(t=>t.status==='running').map(t=>({id:t.id,sessionId:t.sessionId,agent:t.agent}))});
        if(req.method==='GET'&&route==='/api/config')return json(res,200,{...publicConfig(config),storage:{sessions:path.join(dataDir,'sessions.json'),attachments:path.join(dataDir,'attachments')}});
        if(req.method==='POST'&&route==='/api/runtime/shutdown'){
          if(translations.active||[...tasks.tasks.values()].some(t=>t.status==='running'))throw Object.assign(new Error('有回答或 PDF 翻译任务正在运行，请等待完成或取消排队任务。'),{status:409});
          json(res,200,{ok:true});setTimeout(async()=>{translations.close();await endLogin();await tasks.shutdown();server.close(()=>onShutdown?.());},100);return;
        }
        if(req.method==='PATCH'&&route==='/api/config'){
          const input=await body(req);const apply=configQueue.catch(()=>{}).then(async()=>{const next=structuredClone(config);if(input.fontSize!=null){if(!['small','medium','large'].includes(input.fontSize))throw new Error('字号无效');next.fontSize=input.fontSize;}if(input.cwd!=null){if(typeof input.cwd!=='string'||!path.isAbsolute(input.cwd))throw new Error('工作目录必须是绝对路径');await fs.access(input.cwd);next.cwd=input.cwd;}
          if(input.proxy!=null){if(input.proxy&&!/^https?:\/\//.test(input.proxy))throw new Error('代理地址必须是 http:// 或 https://');next.proxy=String(input.proxy);}
          if(input.agents)for(const name of ['codex','claude','opencode'])if(input.agents[name]){const c=input.agents[name];if(!['windows','wsl'].includes(c.environment))throw new Error('Agent 环境必须是 Windows 或 WSL');if(typeof c.command!=='string'||c.command.length>3000)throw new Error('程序路径无效');next.agents[name]={...config.agents[name],command:c.command,environment:c.environment,distribution:String(c.distribution||'Ubuntu'),model:String(c.model||'').slice(0,200)};}
          await saveConfig(dataDir,next);config=next;return {...publicConfig(config),storage:{sessions:path.join(dataDir,'sessions.json'),attachments:path.join(dataDir,'attachments')}};});configQueue=apply;return json(res,200,await apply);
        }
        if(route==='/api/translations'&&req.method==='GET')return json(res,200,{jobs:translations.jobs,settings:translations.settings,providers:translations.providerStatus(),recoveryNotice:translations.recoveryNotice});
        if(route==='/api/translations'&&req.method==='POST')return json(res,202,await translations.add(await body(req)));
        if(route==='/api/translations/settings'&&req.method==='PATCH')return json(res,200,await translations.configure(await body(req)));
        if(route==='/api/translations/provider'&&req.method==='PATCH')return json(res,200,await translations.configureProvider(await body(req)));
        if(route==='/api/translations/setup'&&req.method==='GET')return json(res,200,await translations.engineSetupStatus());
        if(route==='/api/translations/setup'&&req.method==='POST')return json(res,202,translations.startEngineSetup());
        if(route==='/api/translations/probe'&&req.method==='GET')return json(res,200,await translations.probe());
        const translationRoute=route.match(/^\/api\/translations\/([\w-]+)\/(cancel|retry|import|file)$/);
        if(translationRoute){const [,id,action]=translationRoute;if(req.method==='POST'&&action!=='file')return json(res,200,await translations.action(id,action));if(req.method==='GET'&&action==='file'){const j=translations.get(id),i=Number(url.searchParams.get('index')||0);if(j.status!=='completed'||!Number.isInteger(i)||!j.files[i])throw new Error('翻译结果不存在');res.setHeader('Content-Type','application/pdf');return res.end(await fs.readFile(path.join(translations.dir,id,'result-'+i+'.pdf')));}}
        if(req.method==='GET'&&route==='/api/codex/login')return json(res,200,loginState.status==='pending'?{status:'pending'}:loginState);
        if(req.method==='POST'&&route==='/api/codex/login')return json(res,200,await startLogin());
        if(req.method==='GET'&&route==='/api/models'){
          const client=new CodexClient({...config.agents.codex,proxy:config.proxy},config.cwd);try{await client.start();const r=await client.call('model/list',{limit:100});return json(res,200,r);}finally{client.close();}
        }
        if(req.method==='GET'&&route==='/api/projects')return json(res,200,store.listProjects());
        if(req.method==='POST'&&route==='/api/projects'){const input=await body(req);return json(res,201,await store.createProject(input.name));}
        const projectMatch=route.match(/^\/api\/projects\/([\w-]+)$/);if(projectMatch&&req.method==='PATCH'){const input=await body(req);return json(res,200,await store.renameProject(projectMatch[1],input.name));}
        if(req.method==='GET'&&route==='/api/sessions')return json(res,200,store.list());
        if(req.method==='POST'&&route==='/api/sessions'){const input=await body(req);if(input.reasoningEffort&&!['low','medium','high','xhigh','ultra','max'].includes(input.reasoningEffort))throw new Error('思考强度无效');input.context=validateContext(input.context);if(input.agent&&!['codex','claude','opencode'].includes(input.agent))throw new Error('无效 Agent');return json(res,201,await store.create(input));}
        const sessionMatch=route.match(/^\/api\/sessions\/([\w-]+)(\/export|\/messages)?$/);
        if(sessionMatch){const [,id,action]=sessionMatch;
          if(req.method==='GET'&&action==='/export'){res.setHeader('Content-Type','text/markdown; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="zotagent-${id}.md"`);return res.end(store.exportMarkdown(id));}
          if(req.method==='GET'&&!action)return json(res,200,store.get(id));
          if(req.method==='PATCH'&&!action){const input=await body(req);if(['agent','model','reasoningEffort','cwd','context'].some(k=>Object.hasOwn(input,k))&&[...tasks.tasks.values()].some(t=>t.sessionId===id&&t.status==='running'))throw Object.assign(new Error('回答正在生成，完成后才能修改会话设置。'),{status:409});if(input.agent&&!['codex','claude','opencode'].includes(input.agent))throw new Error('无效 Agent');if(input.reasoningEffort&&!['low','medium','high','xhigh','ultra','max'].includes(input.reasoningEffort))throw new Error('思考强度无效');input.context=Object.hasOwn(input,'context')?validateContext(input.context):store.get(id).context;return json(res,200,await store.update(id,input));}
          if(req.method==='POST'&&action==='/messages'){const input=await body(req);const task=await tasks.start(id,input.question,validateContext(input.context)||{});return json(res,202,{taskId:task.id,messageId:task.assistant.id});}

        }
        const taskMatch=route.match(/^\/api\/tasks\/([\w-]+)(\/events|\/stop|\/approve)?$/);
        if(taskMatch){const [,id,action]=taskMatch,t=tasks.get(id);
          if(req.method==='GET'&&action==='/events'){
            res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Connection':'keep-alive'});const after=Number(req.headers['last-event-id']||url.searchParams.get('after')||0);const write=e=>res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);for(const e of t.events)if(e.id>after)write(e);if(t.status!=='running')return res.end();
            const handle=e=>{write(e);if(e.type==='completed')res.end();};t.bus.on('event',handle);const heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),15000);res.on('close',()=>{clearInterval(heartbeat);t.bus.off('event',handle);});return;
          }
          if(req.method==='POST'&&action==='/stop'){await tasks.stop(id);return json(res,200,{ok:true});}
          if(req.method==='POST'&&action==='/approve'){const input=await body(req);await tasks.approve(id,String(input.approvalId),input.decision,input.answers);return json(res,200,{ok:true});}
          if(req.method==='GET'&&!action)return json(res,200,{id:t.id,status:t.status,sessionId:t.sessionId,events:t.events});
        }
        if(req.method==='POST'&&route==='/api/files'){
          const input=await body(req);if(typeof input.data!=='string'||typeof input.name!=='string')throw new Error('附件格式无效');const ext=path.extname(input.name).toLowerCase();if(!['.pdf','.png','.jpg','.jpeg','.webp','.txt','.md','.epub','.html'].includes(ext))throw new Error('支持 PDF、图片、文本、EPUB 或 HTML');const bytes=Buffer.from(input.data,'base64');if(bytes.length>20*1024*1024)throw new Error('单个附件不能超过 20MB');const dir=path.join(dataDir,'attachments');await fs.mkdir(dir,{recursive:true});const file=path.join(dir,randomUUID()+ext);await fs.writeFile(file,bytes);return json(res,201,{id:path.basename(file),path:file,name:path.basename(input.name),type:String(input.type||'application/octet-stream'),size:bytes.length});
        }
        const fileMatch=route.match(/^\/api\/files\/([0-9a-f-]{36}\.(?:png|jpg|jpeg|webp|pdf|txt|md|epub|html))$/i);
        if(req.method==='GET'&&fileMatch){const file=path.join(dataDir,'attachments',fileMatch[1]);const bytes=await fs.readFile(file);res.setHeader('Content-Type',({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'})[path.extname(file).toLowerCase()]||'application/octet-stream');return res.end(bytes);}
        if(req.method==='POST'&&route==='/api/plugin/heartbeat'){const input=await body(req);plugin={seen:Date.now(),context:validateContext(input.context),version:input.version};return json(res,200,{ok:true});}
        if(req.method==='GET'&&route==='/api/plugin/requests')return json(res,200,[...bridgeJobs.values()].filter(j=>!j.sent).map(j=>{j.sent=true;return {id:j.id,method:j.method,args:j.args};}));
        if(req.method==='POST'&&route==='/api/plugin/result'){const input=await body(req),j=bridgeJobs.get(input.id);if(j){clearTimeout(j.timer);bridgeJobs.delete(input.id);input.error?j.reject(new Error(input.error)):j.resolve(input.result);}return json(res,200,{ok:true});}
        if(req.method==='GET'&&route==='/api/zotero/context')return json(res,200,connected()?plugin.context:null);
        if(req.method==='POST'&&route==='/api/zotero/action'){const input=await body(req);if(!['context','fulltext','search','selectedReferences','saveNote','openItem','insertNote','writeAnnotation','capture','clipboard','annotations','translationCandidates','translationSource','importTranslation','openTranslationResult'].includes(input.method))throw new Error('不支持的 Zotero 操作');return json(res,200,await bridge(input.method,input.args));}
        return json(res,404,{error:'接口不存在'});
      }
      if(req.method!=='GET')return json(res,405,{error:'方法不支持'});
      const pathname=decodeURIComponent(route==='/'?'/index.html':route);const file=path.resolve(uiDirectory,'.'+pathname);if(!file.startsWith(path.resolve(uiDirectory)+path.sep))return json(res,403,{error:'路径不允许'});const bytes=await fs.readFile(file);res.setHeader('Content-Type',mime(file));res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'");res.end(bytes);
    }catch(e){json(res,e.status||((e.code==='ENOENT')?404:400),{error:e.message});}
  });
  return {server,store,tasks,get config(){return config;},async listen(){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,'127.0.0.1',resolve);});return server.address();},async close(){translations.close();await endLogin();for(const j of bridgeJobs.values()){clearTimeout(j.timer);j.reject(new Error('服务已停止'));}await tasks.shutdown();await new Promise(resolve=>server.close(resolve));}};
}
function json(res,status,value){if(res.headersSent)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));}
async function body(req){let size=0,parts=[];for await(const b of req){size+=b.length;if(size>32*1024*1024)throw new Error('请求超过 32MB');parts.push(b);}try{const value=JSON.parse(Buffer.concat(parts).toString('utf8')||'{}');if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('object required');return value;}catch{throw new Error('请求必须是有效 JSON');}}
function mime(file){return ({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'})[path.extname(file)]||'application/octet-stream';}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const index=process.argv.indexOf('--data-dir'),uiIndex=process.argv.indexOf('--ui-dir');const app=await createServer({dataDir:index>=0?process.argv[index+1]:defaultDataDir,...(uiIndex>=0?{uiDirectory:process.argv[uiIndex+1]}:{}),onShutdown:()=>process.exit(0)});const address=await app.listen();console.log(JSON.stringify({event:'ready',port:address.port,pid:process.pid,version:'1.0.0'}));for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>app.close().finally(()=>process.exit(0)));
}
