import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class Store {
  constructor(directory) { this.directory = directory; this.sessions = new Map(); this.projects = new Map(); this.writes = Promise.resolve(); }
  async init() {
    await fs.mkdir(this.directory, {recursive:true});
    const file=path.join(this.directory,'sessions.json');
    const read=async name=>{const values=JSON.parse(await fs.readFile(name,'utf8'));if(!Array.isArray(values)||values.some(v=>!v||typeof v.id!=='string'||!Array.isArray(v.messages)))throw new Error('会话文件结构无效');return values;};
    let values=[];
    try{values=await read(file);}catch(e){
      if(e.code!=='ENOENT'){
        try{values=await read(file+'.bak');await fs.copyFile(file,path.join(this.directory,'sessions.corrupt-'+Date.now()+'.json'));this.recoveryNotice='会话文件读取异常，已从最近备份恢复，原文件已保留。';await fs.writeFile(file,JSON.stringify(values,null,2),{mode:0o600});}
        catch(backupError){throw new Error('会话文件无法读取，已保留原文件：'+e.message);}
      }
    }
    for(const v of values){v.threadIds??={};this.sessions.set(v.id,v);}
    const projectFile=path.join(this.directory,'projects.json');
    const readProjects=async file=>{const list=JSON.parse(await fs.readFile(file,'utf8'));if(!Array.isArray(list)||list.some(p=>!p||typeof p.id!=='string'||typeof p.name!=='string'))throw new Error('项目文件结构无效');return list;};
    let projects=[];try{projects=await readProjects(projectFile);}catch(e){if(e.code!=='ENOENT'){try{projects=await readProjects(projectFile+'.bak');await fs.copyFile(projectFile,path.join(this.directory,'projects.corrupt-'+Date.now()+'.json'));this.recoveryNotice='项目列表读取异常，已从备份恢复，原文件已保留。';await fs.writeFile(projectFile,JSON.stringify(projects));}catch{throw new Error('项目列表无法读取，原文件已保留：'+e.message);}}}for(const project of projects)this.projects.set(project.id,project);
    for(const session of this.sessions.values()) for(const m of session.messages) if(m.status==='running') {m.status='interrupted'; m.error='上次运行已中断，可继续提问。';}
    return this;
  }
  get(id) { const s=this.sessions.get(id); if(!s) throw Object.assign(new Error('会话不存在'),{status:404}); return s; }
  list() { return [...this.sessions.values()].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).map(({messages,context,...s})=>({...s,context:context?.primary?{primary:context.primary}:null,messageCount:messages.length,preview:messages.filter(x=>x.role==='user').at(-1)?.text.slice(0,100)||''})); }
  async create(input={}) { validateFields(input);const now=new Date().toISOString(); const s={id:randomUUID(),title:input.title?.trim().slice(0,160)||'新对话',titleIsCustom:Boolean(input.title?.trim()&&!['新对话','新的阅读会话'].includes(input.title.trim())),projectId:this.validProject(input.projectId),agent:input.agent||'codex',model:input.model||'',reasoningEffort:input.reasoningEffort||'',cwd:input.cwd||'',context:input.context||null,threadIds:{},createdAt:now,updatedAt:now,messages:[]};this.sessions.set(s.id,s);await this.save();return s; }
  async save() { const snapshots=[['projects.json',JSON.stringify([...this.projects.values()],null,2)],['sessions.json',JSON.stringify([...this.sessions.values()],null,2)]];this.writes=this.writes.catch(()=>{}).then(async()=>{for(const [name,body] of snapshots){const file=path.join(this.directory,name);await fs.writeFile(file+'.tmp',body,{mode:0o600});try{await fs.copyFile(file,file+'.bak');}catch(e){if(e.code!=='ENOENT')throw e;}await fs.rename(file+'.tmp',file);}});await this.writes; }
  validProject(id){if(id==null||id==='')return null;if(typeof id!=='string'||!this.projects.has(id))throw new Error('项目不存在，请重新选择。');return id;}
  listProjects(){return [...this.projects.values()].sort((a,b)=>a.createdAt.localeCompare(b.createdAt));}
  async createProject(name){name=this.projectName(name);if([...this.projects.values()].some(p=>p.name.toLowerCase()===name.toLowerCase()))throw new Error('已存在同名项目，请使用其他名称。');const now=new Date().toISOString(),project={id:randomUUID(),name,createdAt:now,updatedAt:now};this.projects.set(project.id,project);await this.save();return project;}
  projectName(value){if(typeof value!=='string'||!value.trim()||value.trim().length>80)throw new Error('项目名称请输入 1 至 80 个字符。');return value.trim();}
  async renameProject(id,name){const p=this.projects.get(id);if(!p)throw new Error('项目不存在');name=this.projectName(name);if([...this.projects.values()].some(p=>p.id!==id&&p.name.toLowerCase()===name.toLowerCase()))throw new Error('已存在同名项目');p.name=name;p.updatedAt=new Date().toISOString();await this.save();return p;}
  async update(id,patch) { validateFields(patch);const s=this.get(id);if(Object.hasOwn(patch,'projectId'))patch.projectId=this.validProject(patch.projectId);if(Object.hasOwn(patch,'title')){patch.title=patch.title.trim();if(!patch.title||patch.title.length>160)throw new Error('对话名称请输入 1 至 160 个字符。');s.titleIsCustom=true;}for(const key of ['title','projectId','agent','model','reasoningEffort','cwd','context']) if(Object.hasOwn(patch,key)){if(key==='context'&&s.context?.primary)patch[key]={...patch[key],primary:s.context.primary};s[key]=patch[key];}s.updatedAt=new Date().toISOString();await this.save();return s; }
  exportMarkdown(id) {const s=this.get(id);return `# ${s.title}\n\n${s.context?.primary?.title?`主文献：${s.context.primary.title}\n\n`:''}${s.messages.map(m=>`## ${m.role==='user'?'问题':'Agent · '+(m.agent||s.agent)}\n\n${m.text}\n\n${m.error?'> '+m.error+'\n\n':''}`).join('')}`;}
}

function validateFields(input){for(const key of ['title','agent','model','reasoningEffort','cwd'])if(Object.hasOwn(input,key)&&(typeof input[key]!=='string'||input[key].length>4000))throw new Error('会话字段无效：'+key);}
