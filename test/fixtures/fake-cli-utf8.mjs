// Test fixture only; never used by the production agent launcher.
const text='中文回答：分子动力学与 PDF 对照翻译。';
const messages=[{type:'stream_event',event:{type:'content_block_delta',delta:{text}}},{type:'result',result:text}];
const bytes=Buffer.from(messages.map(m=>JSON.stringify(m)+'\n').join(''));
for(let i=0;i<bytes.length;i++){process.stdout.write(bytes.subarray(i,i+1));await new Promise(r=>setTimeout(r,1));}
