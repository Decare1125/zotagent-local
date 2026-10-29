// Protocol fixture only. Production never selects or loads this transport.
import readline from 'node:readline';
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');let turn=0,pending=null;
readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);const response=result=>send({id:r.id,result});
  if(r.method==='initialize'){if(process.argv.includes('--slow-init'))setTimeout(()=>response({userAgent:'fixture'}),150);else response({userAgent:'fixture'});}
  else if(r.method==='account/read')response({account:null,requiresOpenaiAuth:true});
  else if(r.method==='account/login/start'){response({type:'chatgpt',loginId:'fixture',authUrl:'https://auth.openai.com/authorize?state=fixture'});setTimeout(()=>send({method:'account/login/completed',params:{loginId:'fixture',success:true,error:null}}),100);}
  else if(r.method==='model/list')response({data:[{model:'gpt-6.1-sol',displayName:'GPT-6.1 Sol',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:['low','medium','high','xhigh','max','ultra'].map(reasoningEffort=>({reasoningEffort}))}]});
  else if(r.method==='thread/start'||r.method==='thread/resume')response({thread:{id:'fixture-thread'}});
  else if(r.method==='turn/start'){
    turn++;response({turn:{id:'turn-'+turn,status:'inProgress'}});send({method:'turn/started',params:{threadId:'fixture-thread',turn:{id:'turn-'+turn}}});
    const prompt=r.params.input[0].text;
    if(prompt.includes('EFFORT_EXPECT_ULTRA')&&r.params.effort!=='ultra'){send({method:'turn/completed',params:{threadId:'fixture-thread',turn:{id:'turn-'+turn,status:'failed',error:{message:'Ultra was not forwarded'}}}});return;}
    if(prompt.includes('EFFORT_EXPECT_MAX')&&r.params.effort!=='max'){send({method:'turn/completed',params:{threadId:'fixture-thread',turn:{id:'turn-'+turn,status:'failed',error:{message:'Reasoning effort was not forwarded'}}}});return;}
    if(prompt.includes('APPROVAL_TEST')){pending=()=>complete();send({id:99,method:'item/commandExecution/requestApproval',params:{threadId:'fixture-thread',turnId:'turn-'+turn,command:'fixture-command',cwd:process.cwd()}});}
    else if(prompt.includes('MULTI_STREAM_TEST')){const chunks=Array.from({length:20},(_,i)=>'chunk-'+i+' ');chunks.forEach((delta,i)=>setTimeout(()=>send({method:'item/agentMessage/delta',params:{threadId:'fixture-thread',itemId:'long-answer',delta}}),i*50));setTimeout(()=>{send({method:'item/completed',params:{threadId:'fixture-thread',item:{id:'long-answer',type:'agentMessage',text:chunks.join('')}}});send({method:'turn/completed',params:{threadId:'fixture-thread',turn:{id:'turn-'+turn,status:'completed'}}});},1100);}
    else if(prompt.includes('CHECKPOINT_TEST')){send({method:'item/agentMessage/delta',params:{threadId:'fixture-thread',itemId:'answer-'+turn,delta:'Checkpointed partial answer'}});}
    else if(prompt.includes('STOP_TEST')){}
    else setTimeout(complete,20);
  }else if(r.method==='turn/interrupt'){response({});send({method:'turn/completed',params:{threadId:'fixture-thread',turn:{id:'turn-'+turn,status:'interrupted'}}});}
  else if(r.id===99){if(r.result?.decision==='accept')pending?.();else send({method:'turn/completed',params:{threadId:'fixture-thread',turn:{id:'turn-'+turn,status:'interrupted'}}});}
});
function complete(){send({method:'item/agentMessage/delta',params:{threadId:'fixture-thread',itemId:'answer-'+turn,delta:'协议测试通过'}});send({method:'item/completed',params:{threadId:'fixture-thread',item:{id:'answer-'+turn,type:'agentMessage',text:'协议测试通过'}}});send({method:'turn/completed',params:{threadId:'fixture-thread',turn:{id:'turn-'+turn,status:'completed'}}});}
