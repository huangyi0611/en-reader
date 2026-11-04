const C='en-reader-v9',F=['./','./index.html','./app.js','./app.js?v=9','./style.css','./style.css?v=9','./manifest.json','./icon.svg'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(F)));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))));self.clients.claim()});
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.origin!==location.origin)return;
  e.respondWith((async()=>{
    try{
      const res=await fetch(e.request);
      if(res&&res.ok){try{const cache=await caches.open(C);await cache.put(e.request,res.clone())}catch{}}
      return res;
    }catch{
      return (await caches.match(e.request))||(await caches.match(e.request,{ignoreSearch:true}))||Promise.reject(new Error('offline'));
    }
  })());
});
