// List execution contexts + console/exception events for the Twitch page.
const PORT = '9333';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
class CDP {
  constructor(url) {
    this.ws = new WebSocket(url); this.id=0; this.pending=new Map(); this.handlers=new Map();
    this.ready = new Promise((res,rej)=>{this.ws.onopen=res;this.ws.onerror=rej;});
    this.ws.onmessage = ev => { let m; try{m=JSON.parse(ev.data);}catch{return;}
      if(m.id!==undefined&&this.pending.has(m.id)){const{resolve,reject,timer}=this.pending.get(m.id);clearTimeout(timer);this.pending.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);}
      else if(m.method&&this.handlers.has(m.method))for(const cb of this.handlers.get(m.method))cb(m.params,m.sessionId);
    };
  }
  async send(method,params={},sessionId,timeout=30000){await this.ready;const id=++this.id;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(method+': timeout'));},timeout);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify(sessionId?{id,method,params,sessionId}:{id,method,params}));});}
  on(m,cb){if(!this.handlers.has(m))this.handlers.set(m,[]);this.handlers.get(m).push(cb);}
}
const v=await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const cdp=new CDP(v.webSocketDebuggerUrl);
const pages=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page=pages.find(t=>t.type==='page'&&/twitch\.tv\/rodil/.test(t.url));
const {sessionId}=await cdp.send('Target.attachToTarget',{targetId:page.id,flatten:true});
const ctxs=[];
cdp.on('Runtime.executionContextCreated',p=>{ctxs.push(p.context);console.log('CTX',p.context.id,p.context.origin,p.context.name,p.context.auxData);});
cdp.on('Runtime.exceptionThrown',p=>{console.log('EXC',JSON.stringify(p.exceptionDetails).slice(0,1000));});
cdp.on('Runtime.consoleAPICalled',p=>{console.log('CONSOLE',p.type,p.args.map(a=>a.value??a.description).join(' ').slice(0,1000));});
await cdp.send('Runtime.enable',{},sessionId);
await cdp.send('Page.enable',{},sessionId);
await cdp.send('Page.reload',{ignoreCache:true},sessionId);
await sleep(9000);
for(const c of ctxs){
  try{
    const r=await cdp.send('Runtime.evaluate',{expression:'({ko:typeof KO, href:location.href, keys:typeof KO!=="undefined"?Object.keys(KO).slice(0,5):null})',contextId:c.id,returnByValue:true},sessionId);
    console.log('EVAL',c.id,c.origin,JSON.stringify(r.result?.value));
  }catch(e){console.log('EVALERR',c.id,c.origin,String(e).slice(0,200));}
}
cdp.ws.close();process.exit(0);
