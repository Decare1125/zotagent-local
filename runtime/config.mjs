import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const exec=promisify(execFile);
export const defaultDataDir=process.env.ZOTAGENT_DATA_DIR||path.join(os.homedir(),'.zotagent-local');
export async function findExecutable(name) {
  try { const {stdout}=await exec(process.platform==='win32'?'where.exe':'which',[name],{windowsHide:true,timeout:5000});return stdout.trim().split(/\r?\n/)[0]||''; }catch{return '';}
}
export async function loadConfig(directory=defaultDataDir) {
  await fs.mkdir(directory,{recursive:true});const file=path.join(directory,'config.json');let saved={},recoveryNotice=null;
  const read=async source=>{const value=JSON.parse(await fs.readFile(source,'utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('设置格式无效');if(value.agents!=null&&(!value.agents||typeof value.agents!=='object'||Array.isArray(value.agents)))throw new Error('智能体设置格式无效');for(const agent of Object.values(value.agents||{})){if(!agent||typeof agent!=='object'||Array.isArray(agent))throw new Error('智能体设置格式无效');for(const k of ['command','environment','model','distribution'])if(agent[k]!=null&&typeof agent[k]!=='string')throw new Error('智能体字段格式无效');if(agent.args!=null&&(!Array.isArray(agent.args)||agent.args.some(a=>typeof a!=='string')))throw new Error('启动参数格式无效');}if(value.cwd!=null&&(typeof value.cwd!=='string'||!path.isAbsolute(value.cwd)))throw new Error('工作目录格式无效');if(value.port!=null&&(!Number.isInteger(value.port)||value.port<0||value.port>65535))throw new Error('端口格式无效');if(value.token!=null&&(typeof value.token!=='string'||!value.token))throw new Error('连接信息格式无效');return value;};
  try{saved=await read(file);}catch(e){if(e.code!=='ENOENT'){await fs.copyFile(file,path.join(directory,'config.corrupt-'+Date.now()+'.json'));try{saved=await read(file+'.bak');recoveryNotice='运行设置已从备份恢复，损坏文件已保留。';}catch{recoveryNotice='运行设置异常，已恢复默认设置，原文件已保留。';}}}

  const detected=await Promise.all(['codex','claude','opencode'].map(findExecutable));
  let machine={};try{machine=JSON.parse(await fs.readFile(new URL('./machine.json',import.meta.url),'utf8'));}catch{}
  for(const [i,name]of ['codex','claude','opencode'].entries()){if(name==='codex'&&process.platform==='win32'&&/\.(cmd|bat)$/i.test(detected[i]||''))detected[i]='';if(!detected[i]){if(name==='codex'&&machine.bundledCodex){const bundled=path.join(path.dirname(fileURLToPath(import.meta.url)),...machine.bundledCodex.split('/'));try{await fs.access(bundled);detected[i]=bundled;}catch{}}if(!detected[i])detected[i]=machine.agents?.[name]?.command||'';}}
  const config={port:24159,token:randomBytes(32).toString('hex'),cwd:path.join(directory,'workspace'),nodePath:process.execPath,proxy:machine.proxy||'',agents:{codex:{command:detected[0],environment:'windows',model:''},claude:{command:detected[1],environment:'windows',model:''},opencode:{command:detected[2],environment:'windows',model:''}},...saved};
  for(const [i,name]of ['codex','claude','opencode'].entries())config.agents[name]={command:detected[i],environment:'windows',model:'',...config.agents[name]};
  await fs.mkdir(config.cwd,{recursive:true});await saveConfig(directory,config,!recoveryNotice);Object.defineProperty(config,'recoveryNotice',{value:recoveryNotice,enumerable:false});return config;
}
export async function saveConfig(directory,config,backup=true) {const file=path.join(directory,'config.json');await fs.writeFile(file+'.tmp',JSON.stringify(config,null,2),{mode:0o600});if(backup)try{await fs.copyFile(file,file+'.bak');}catch(e){if(e.code!=='ENOENT')throw e;}await fs.rename(file+'.tmp',file);}
export function publicConfig(c) {const {token,...safe}=c;return safe;}
