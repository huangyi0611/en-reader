'use strict';
const $=s=>document.querySelector(s),LS=localStorage;
const J=(k,d)=>{try{return JSON.parse(LS.getItem(k))??d}catch{return d}},S=(k,v)=>LS.setItem(k,JSON.stringify(v));
const esc=s=>s.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function stripJunk(s){return String(s||'').replace(/[\u00AD\u200B-\u200D\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF\u180E]/g,'').replace(/[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/g,'')}
const cleanBase=s=>stripJunk(s).replace(/\s+/g,'').replace(/\/+$/,''),cleanKey=s=>stripJunk(s).replace(/\s+/g,''),cleanModel=s=>stripJunk(s).trim();
const asciiOk=s=>/^[\x20-\x7E]*$/.test(s);
const BAD_KEY='API Key 含有非法字符（如全角空格/中文引号），请重新粘贴';
const cfg=()=>{
  const c=Object.assign({base:'https://api.deepseek.com',model:'deepseek-chat',key:'',dict:true},J('er_cfg',{}));
  c.base=cleanBase(c.base)||'https://api.deepseek.com';c.model=modelFor(c.base,c.model)||'deepseek-chat';c.key=cleanKey(c.key);
  return c;
};
const PRESETS={
  deepseek:{base:'https://api.deepseek.com',model:'deepseek-chat'},
  openai:{base:'https://api.openai.com/v1',model:'gpt-4o-mini'},
  siliconflow:{base:'https://api.siliconflow.cn/v1'},
  kimi:{base:'https://api.moonshot.cn/v1',model:'kimi-k2.6'},
  'kimi-intl':{base:'https://api.moonshot.ai/v1',model:'kimi-k2.6'}
};
const LEGACY_MODELS=['moonshot-v1-8k'];
function presetModels(){return new Set([...Object.values(PRESETS).map(p=>p.model).filter(Boolean),...LEGACY_MODELS])}
function modelFor(base,model){
  const p=PRESETS[matchPreset(base)],cur=cleanModel(model);
  if(p&&p.model&&(!cur||presetModels().has(cur)))return p.model;
  return cur;
}
let docs=J('er_docs',[]),cur=null,tab='syntax',curSent=null;

// ---------- LLM ----------
function hash(s){let h=5381;for(let i=0;i<s.length;i++)h=(h*33^s.charCodeAt(i))>>>0;return h.toString(36)}
function endpoint(base){
  let b=cleanBase(base);
  if(/\/chat\/completions$/i.test(b))return b;
  b=b.replace(/(\/v\d+)(?:\1)+$/i,'$1');
  if(!/\/v\d+$/i.test(b))b+='/v1';
  return b+'/chat/completions';
}
function reqFail(msg,url,model,err){
  let s=msg+'：'+url+'（模型 '+model+'）';
  if(err)s+=' '+(err.name||'Error')+': '+(err.message||err);
  return new Error(s);
}
async function chat(c,messages,maxTokens){
  const test=!!(maxTokens&&typeof maxTokens==='object'&&maxTokens.test);
  const limit=typeof maxTokens==='number'&&maxTokens>=64?maxTokens:0;
  const key=cleanKey(c.key),base=cleanBase(c.base),model=cleanModel(c.model);
  if(!key)throw new Error('请先在「设置」中填写 API Key');
  if(!model)throw new Error('请填写模型名');
  if(!asciiOk(key))throw new Error(BAD_KEY);
  if(!asciiOk(base))throw new Error('Base URL 含有非法字符（如全角空格/中文引号），请重新粘贴');
  const url=endpoint(base);
  const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),60000);
  let r;
  try{
    const body={model,messages};
    if(limit)body.max_tokens=limit;
    r=await fetch(url,{method:'POST',credentials:'omit',signal:ac.signal,headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify(body)});
  }catch(e){
    if(e&&e.name==='AbortError')throw reqFail('请求超时',url,model);
    throw reqFail('网络或跨域失败',url,model,e);
  }finally{clearTimeout(timer)}
  if(!r.ok){
    let apiMsg='';
    try{const j=await r.json();const e=j&&j.error;apiMsg=(typeof e==='string'?e:e&&e.message)||j&&j.message||''}catch{}
    const map={401:'API Key 无效或与 Base URL 不匹配，请检查设置',402:'余额不足',404:'接口地址或模型名不存在',429:'请求过多'};
    const friendly=map[r.status]||('请求失败（'+r.status+'）');
    throw reqFail(apiMsg?friendly+' — '+apiMsg:friendly,url,model);
  }
  let data;try{data=await r.json()}catch{if(test)return '';throw reqFail('请求失败（响应无效）',url,model)}
  if(!data?.choices?.length){if(test)return '';throw reqFail('请求失败（响应无效）',url,model)}
  const msg=data.choices[0].message||{},raw=msg.content;
  const text=typeof raw==='string'?raw:Array.isArray(raw)?raw.map(p=>typeof p==='string'?p:(p&&typeof p.text==='string'?p.text:'')).join(''):'';
  return text.trim();
}
async function llm(prompt,sys){
  const c=cfg(),ck='er_c_'+hash(c.model+'|'+sys+'|'+prompt),hit=LS.getItem(ck);if(hit)return hit;
  const out=await chat(c,[{role:'system',content:sys},{role:'user',content:prompt}]);
  try{LS.setItem(ck,out)}catch{clearCache();try{LS.setItem(ck,out)}catch{}}
  return out;
}
window.__llm=llm;
function clearCache(){Object.keys(LS).filter(k=>k.startsWith('er_c_')).forEach(k=>LS.removeItem(k))}
const SYS={
 tr:'你是专业英译中译者。把用户给的英文段落翻译成自然流畅的简体中文，只输出译文。',
 syntax:'你是英语语法老师。用简体中文分析用户给的英文句子：1)句子主干（主语/谓语/宾语/表语）；2)各从句类型及作用；3)其他成分（定语、状语、同位语、插入语、非谓语等）；4)简明的中文翻译。用简洁的分条格式，不用 Markdown 表格。',
 slang:'你是英语俚语与地道表达专家。找出用户句子中的俚语、网络用语、口语、习语或文化梗，用简体中文解释含义、语气和使用场景。如果没有，说明“本句无明显俚语”，并指出任何口语化之处。分条列出。',
 phrase:'你是英语搭配专家。列出用户句子中值得学习的短语、固定搭配、动词短语和介词搭配，每条给出：搭配、中文意思、一个新例句(附中文)。分条列出。',
 word:'你是英汉词典。用户给出一个单词和它所在的句子。用简体中文输出：\n单词 /英式音标/ /美式音标/\n词性及常用释义（分条）\n本句中的含义\n2个例句（附中文）\n常见搭配或词形变化。简洁，不用 Markdown 表格。'
};

// ---------- text processing ----------
function splitSent(p){return (p.match(/[^.!?。！？]+(?:[.!?。！？]+["'”’)\]]*|$)\s*/g)||[p]).map(s=>s.trim()).filter(Boolean)}
function toParas(t){return t.replace(/\r/g,'').split(/\n\s*\n|\n(?=\s{2,}|\t)/).map(x=>x.replace(/\s+/g,' ').trim()).filter(Boolean).flatMap(p=>p.length>1500?chunk(p):[p])}
function chunk(p){const s=splitSent(p),o=[];let b='';for(const x of s){if((b+x).length>800&&b){o.push(b.trim());b=''}b+=x+' '}if(b.trim())o.push(b.trim());return o}
function isOnlyUrl(text){const s=String(text||'').trim();if(!s||/\s/.test(s))return false;try{const u=new URL(s);return u.protocol==='http:'||u.protocol==='https:'}catch{return false}}
const URL_HINT='无法直接读取链接内容，请复制帖子正文粘贴';
function addDoc(title,text){
  if(isOnlyUrl(text)){
    if($('#dlgImport').open)$('#impMsg').textContent=URL_HINT;
    else alert(URL_HINT);
    return false;
  }
  let ps=toParas(text);if(!ps.length){alert('没有可导入的文本');return false}
  if(ps.length===1&&text.includes('\n'))ps=text.split('\n').map(x=>x.trim()).filter(Boolean);
  const d={id:Date.now().toString(36),title:(title||ps[0].slice(0,30)).trim(),paras:ps.map(splitSent)};
  docs.unshift(d);saveDocs();open(d.id);return true;
}
function saveDocs(){try{S('er_docs',docs)}catch{alert('本地存储已满，请删除部分文档或清除缓存')}}
async function parseEpub(buf){
  if(!window.JSZip)throw new Error('JSZip 未加载（需联网一次）');
  const z=await JSZip.loadAsync(buf),P=new DOMParser();
  const cont=P.parseFromString(await z.file('META-INF/container.xml').async('text'),'application/xml');
  const opfPath=cont.querySelector('rootfile').getAttribute('full-path'),dir=opfPath.replace(/[^/]*$/,'');
  const opf=P.parseFromString(await z.file(opfPath).async('text'),'application/xml');
  const man={};opf.querySelectorAll('manifest > item').forEach(i=>man[i.getAttribute('id')]=i.getAttribute('href'));
  const title=opf.querySelector('title')?.textContent||'EPUB';let out=[];
  for(const r of opf.querySelectorAll('spine > itemref')){
    const h=man[r.getAttribute('idref')];if(!h)continue;const f=z.file(decodeURI(dir+h))||z.file(dir+h);if(!f)continue;
    const doc=P.parseFromString(await f.async('text'),'text/html');
    doc.querySelectorAll('p,h1,h2,h3,h4,li,blockquote,div:not(:has(p,div))').forEach(e=>{const t=e.textContent.trim();if(t)out.push(t)});
  }
  return {title,text:out.join('\n\n')};
}

// ---------- render ----------
function renderSel(){$('#docSel').innerHTML=docs.map(d=>`<option value="${d.id}">${esc(d.title)}</option>`).join('')||'<option>（无文档）</option>';if(cur)$('#docSel').value=cur.id}
let io;
function open(id){
  cur=docs.find(d=>d.id===id)||null;renderSel();S('er_last',id);const R=$('#reader');
  if(!cur){R.innerHTML='<div id="empty">点击「导入」粘贴英文、上传 .txt / .epub，或通过 ?text= 链接传入文本。</div>';return}
  io&&io.disconnect();io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){io.unobserve(e.target);translate(+e.target.dataset.p)}}),{rootMargin:'300px'});
  R.innerHTML=cur.paras.map((ss,p)=>`<div class="para" data-p="${p}"><div class="en">${ss.map((s,i)=>`<span class="s" data-p="${p}" data-s="${i}">${sentHtml(p,i)}</span>`).join(' ')}</div><div class="zh" id="zh${p}">…</div></div>`).join('');
  R.querySelectorAll('.para').forEach(e=>io.observe(e));
}
const hls=()=>J('er_hl_'+cur.id,[]);
function sentHtml(p,i){
  const t=cur.paras[p][i],hs=hls().filter(h=>h.p===p&&h.s===i).sort((a,b)=>a.a-b.a);let o='',pos=0;
  for(const h of hs){if(h.a<pos)continue;o+=esc(t.slice(pos,h.a))+`<mark class="${h.c}">${esc(t.slice(h.a,h.b))}</mark>`;pos=h.b}
  return o+esc(t.slice(pos));
}
function rerenderSent(p,i){const e=document.querySelector(`.s[data-p="${p}"][data-s="${i}"]`);if(e)e.innerHTML=sentHtml(p,i)}
async function translate(p){
  const el=$('#zh'+p);if(!el)return;el.textContent='翻译中…';
  try{el.textContent=await llm(cur.paras[p].join(' '),SYS.tr)}catch(e){el.innerHTML=`<span class="mu">${esc(e.message)}</span> <button onclick="translate(${p})">重试</button>`}
}
window.translate=translate;
async function fillSide(){
  const B=$('#sideBody');if(!curSent){B.textContent='点击左侧任一句子进行分析。';return}
  const s=cur.paras[curSent.p][curSent.s],t=tab;B.textContent='分析中…\n\n'+s;
  try{const r=await llm(s,SYS[t]);if(t===tab)B.textContent=r}catch(e){B.textContent=e.message}
}

// ---------- word popover ----------
function wordAt(x,y){
  let r=document.caretRangeFromPoint?document.caretRangeFromPoint(x,y):null;
  if(!r&&document.caretPositionFromPoint){const c=document.caretPositionFromPoint(x,y);if(c){r=document.createRange();r.setStart(c.offsetNode,c.offset)}}
  if(!r||r.startContainer.nodeType!==3)return null;const t=r.startContainer.textContent;let a=r.startOffset,b=a;
  while(a>0&&/[A-Za-z'’-]/.test(t[a-1]))a--;while(b<t.length&&/[A-Za-z'’-]/.test(t[b]))b++;
  const w=t.slice(a,b).replace(/^['’-]+|['’-]+$/g,'');return /[A-Za-z]/.test(w)?w:null;
}
async function lookup(w,ctx){
  const P=$('#pop');P.hidden=false;P.textContent='查询 '+w+' …';
  try{P.textContent=await llm(`单词：${w}\n句子：${ctx}`,SYS.word)}catch(e){
    if(!cfg().dict){P.textContent=e.message;return}
    try{const r=await fetch('https://api.dictionaryapi.dev/api/v2/entries/en/'+encodeURIComponent(w.toLowerCase()));if(!r.ok)throw 0;const d=(await r.json())[0];
      P.textContent=`${d.word} ${d.phonetic||d.phonetics?.find(x=>x.text)?.text||''}\n（LLM 不可用，显示英文词典：${e.message}）\n\n`+d.meanings.map(m=>`【${m.partOfSpeech}】\n`+m.definitions.slice(0,3).map((x,i)=>`${i+1}. ${x.definition}${x.example?'\n   例：'+x.example:''}`).join('\n')).join('\n\n');
    }catch{P.textContent=e.message+'\n（词典也未找到该词）'}}
}

// ---------- highlight ----------
function selInfo(){
  const sel=getSelection();if(!sel.rangeCount||sel.isCollapsed)return null;const r=sel.getRangeAt(0);
  const sp=(n=>(n.nodeType===3?n.parentElement:n).closest('.s'))(r.startContainer);
  if(!sp||sp!==(n=>(n.nodeType===3?n.parentElement:n).closest('.s'))(r.endContainer))return null;
  const pre=document.createRange();pre.selectNodeContents(sp);pre.setEnd(r.startContainer,r.startOffset);
  const a=pre.toString().length,b=a+r.toString().length;return b>a?{p:+sp.dataset.p,s:+sp.dataset.s,a,b,r}:null;
}
let pend=null;
document.addEventListener('selectionchange',()=>{const i=selInfo(),H=$('#hlBar');if(!i){setTimeout(()=>{if(!selInfo())H.hidden=true},200);return}
  pend=i;const b=i.r.getBoundingClientRect();H.hidden=false;H.style.left=Math.max(4,Math.min(innerWidth-260,b.left))+'px';H.style.top=(b.top>60?b.top-48:b.bottom+60)+'px'});
$('#hlBar').addEventListener('pointerdown',e=>e.preventDefault());
$('#hlBar').addEventListener('click',e=>{const c=e.target.dataset.c;if(!c||!pend)return;let h=hls();const{p,s,a,b}=pend;
  h=h.filter(x=>!(x.p===p&&x.s===s&&x.a<b&&x.b>a));if(c!=='x')h.push({p,s,a,b,c});S('er_hl_'+cur.id,h);rerenderSent(p,s);getSelection().removeAllRanges();$('#hlBar').hidden=true;pend=null});

// ---------- events ----------
$('#reader').addEventListener('click',e=>{
  if(!getSelection().isCollapsed)return;const sp=e.target.closest('.s');if(!sp)return;
  document.querySelectorAll('.s.cur').forEach(x=>x.classList.remove('cur'));sp.classList.add('cur');
  curSent={p:+sp.dataset.p,s:+sp.dataset.s};fillSide();
  const w=wordAt(e.clientX,e.clientY);if(w)lookup(w,cur.paras[curSent.p][curSent.s]);
});
document.addEventListener('click',e=>{if(!e.target.closest('#pop,#reader'))$('#pop').hidden=true});
$('#pop').addEventListener('click',()=>$('#pop').hidden=true);
document.querySelectorAll('#side nav button').forEach(b=>b.onclick=()=>{document.querySelectorAll('#side nav button').forEach(x=>x.classList.toggle('on',x===b));tab=b.dataset.tab;fillSide()});
$('#docSel').onchange=e=>{curSent=null;fillSide();open(e.target.value)};
$('#btnImport').onclick=()=>{$('#impMsg').textContent='';$('#dlgImport').showModal()};
$('#impOk').onclick=()=>{const t=$('#paste').value;if(!t.trim())return;if(!addDoc($('#title').value,t))return;$('#paste').value=$('#title').value='';$('#dlgImport').close()};
$('#impDel').onclick=()=>{if(!cur||!confirm('删除「'+cur.title+'」？'))return;LS.removeItem('er_hl_'+cur.id);docs=docs.filter(d=>d!==cur);saveDocs();open(docs[0]?.id);$('#dlgImport').close()};
$('#file').onchange=async e=>{const f=e.target.files[0];if(!f)return;$('#impMsg').textContent='解析中…';
  try{const parsed=/\.epub$/i.test(f.name)?await parseEpub(await f.arrayBuffer()):{title:f.name.replace(/\.txt$/i,''),text:await f.text()};if(addDoc(parsed.title,parsed.text))$('#dlgImport').close()}
  catch(x){$('#impMsg').textContent='导入失败：'+x.message}e.target.value=''};
function matchPreset(base){const b=cleanBase(base).toLowerCase();return Object.keys(PRESETS).find(id=>cleanBase(PRESETS[id].base).toLowerCase()===b)||'custom'}
function readForm(){
  const base=cleanBase($('#sBase').value)||'https://api.deepseek.com';
  let model=cleanModel($('#sModel').value);
  const chosen=PRESETS[$('#sPreset').value];
  if(!model&&chosen&&chosen.model)model=chosen.model;
  else if(!model&&$('#sPreset').value!=='siliconflow')model='deepseek-chat';
  const c={base,model,key:cleanKey($('#sKey').value),dict:$('#sDict').checked};
  $('#sBase').value=c.base;$('#sKey').value=c.key;if(model)$('#sModel').value=model;
  return c;
}
function fillSet(){
  const c=cfg();$('#sBase').value=c.base;$('#sModel').value=c.model;$('#sKey').value=c.key;$('#sDict').checked=c.dict;$('#sPreset').value=matchPreset(c.base);$('#setMsg').textContent='';
}
$('#sPreset').onchange=()=>{
  const p=PRESETS[$('#sPreset').value];$('#setMsg').textContent='';if(!p)return;
  $('#sBase').value=p.base;
  const cur=cleanModel($('#sModel').value);
  if(p.model&&(!cur||presetModels().has(cur)))$('#sModel').value=p.model;
};
$('#sBase').oninput=()=>{$('#sPreset').value=matchPreset($('#sBase').value)};
$('#btnSet').onclick=()=>{fillSet();$('#dlgSet').showModal()};
$('#setOk').onclick=()=>{const c=readForm();if(!c.model){$('#setMsg').textContent='请填写模型名';return}S('er_cfg',c);$('#dlgSet').close();if(cur)open(cur.id)};
$('#btnTest').onclick=async()=>{
  const msg=$('#setMsg'),btn=$('#btnTest'),c=readForm();
  if(!c.key){msg.textContent='请先填写 API Key';return}
  if(!c.model){msg.textContent='请填写模型名';return}
  btn.disabled=true;msg.textContent='测试中…';
  try{await chat(c,[{role:'user',content:'ping'}],{test:true});msg.textContent='连接成功'}
  catch(e){msg.textContent=e.message}
  finally{btn.disabled=false}
};
$('#clrCache').onclick=()=>{clearCache();alert('已清除缓存')};

// ---------- boot ----------
(function(){const q=new URLSearchParams(location.search),t=q.get('text');
  if(t){const ok=addDoc(q.get('title')||'',t);history.replaceState(null,'',location.pathname);if(!ok){renderSel();open(J('er_last',null)||docs[0]?.id)}}else{renderSel();open(J('er_last',null)||docs[0]?.id)}
  if('serviceWorker' in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});})();
