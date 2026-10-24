const CACHE='ubicaciones-v15';
const ASSETS=['./','./index.html','./manifest.webmanifest','./icon-192.png','./icon-512.png'];
const STATIC_URLS=new Set(ASSETS.map(path=>new URL(path,self.registration.scope).href));
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('ubicaciones-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',event=>{
  const request=event.request;
  const url=new URL(request.url);
  // Auth y datos operativos van a la red. Nunca guardar tokens, sesiones,
  // respuestas del Worker ni solicitudes POST/PUT/DELETE en Cache Storage.
  if(request.method!=='GET'||url.origin!==self.location.origin||request.headers.has('Authorization'))return;
  const navigation=request.mode==='navigate';
  if(!navigation&&!STATIC_URLS.has(url.href))return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    try{
      const response=await fetch(request);
      if(response.ok&&response.type==='basic'&&STATIC_URLS.has(url.href)){
        event.waitUntil(cache.put(request,response.clone()).catch(()=>{}));
      }
      return response;
    }catch{
      const cached=await cache.match(request)||(navigation?await cache.match(new URL('./index.html',self.registration.scope).href):null);
      return cached||Response.error();
    }
  })());
});
