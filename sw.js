/* خِدمة service worker: network-first (updates always win), cached copy only when offline. */
const CACHE = 'khidma-shell-v17';
const META = 'khidma-meta';      // tiny note the app leaves here: which church + member this phone belongs to
const SUPABASE_URL = 'https://owpkjnbnyfldnmubfzsy.supabase.co';
const SUPABASE_KEY = 'sb_publishable_FeyMhWVyMkFYhOzXllF9ig_08zVqWC8';
const VAPID_PUBLIC_KEY = 'BCgogBtQZl5k7toCZ6lBxo3vxiVLKdXW5bIClCrpsX7Q5xfglbx9Y2HDjlQUKTxIeg1wGVamNiWGzSO4Dl1q_lo';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== META).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);
  // Bootstrap + fonts from their CDNs: keep a copy so the layout still works offline
  if(/^(cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|api\.getbible\.net)$/.test(url.hostname)){
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res;
    })));
    return;
  }
  if(url.origin !== self.location.origin) return;           // never touch the database
  e.respondWith(
    fetch(req).then(res => {
      if(res && res.ok){ const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});

/* ---- push notifications: arrive even when the app is closed ---- */
self.addEventListener('push', e => {
  let d = {};
  try{ d = e.data ? e.data.json() : {}; }catch(err){ d = { body: e.data ? e.data.text() : '' }; }
  // every message gets its own tag + renotify, so a new one always makes a sound instead of silently replacing the last
  const tag = d.tag || ('khidma-' + Date.now());
  e.waitUntil((async () => {
    // a new reading message replaces the old reading messages in the tray (announcements are never removed)
    if(tag.startsWith('psalm-') || tag.startsWith('read-')){
      try{ (await self.registration.getNotifications()).filter(n => (n.tag || '').startsWith('psalm-') || (n.tag || '').startsWith('read-')).forEach(n => n.close()); }catch(err){}
    }
    return self.registration.showNotification(d.title || 'خِدمة', {
    body: d.body || '', icon: 'icon-192.png', badge: 'favicon.png', dir: 'rtl', lang: 'ar',
    tag, renotify: true, vibrate: [150, 80, 150], timestamp: Date.now(),
    data: { url: d.url || './#today' }
  });
  })());
});

/* If the browser changes this phone's push address, register the new one by ourselves
   (without this the server keeps sending to the old address and notifications silently stop). */
function b64ToU8(b){ const s = (b + '='.repeat((4 - b.length % 4) % 4)).replace(/-/g,'+').replace(/_/g,'/'); const raw = atob(s); return Uint8Array.from([...raw].map(ch => ch.charCodeAt(0))); }
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil((async () => {
    try{
      const old = e.oldSubscription;
      const key = (old && old.options && old.options.applicationServerKey) || b64ToU8(VAPID_PUBLIC_KEY);
      const sub = e.newSubscription || await self.registration.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey:key });
      const hit = await (await caches.open(META)).match('push-identity');
      const who = hit ? await hit.json() : null;
      if(!who || !who.church || !who.member) return;   // the app will save it the next time it is opened
      await fetch(SUPABASE_URL + '/rest/v1/rpc/save_push_subscription', {
        method:'POST',
        headers:{ 'apikey':SUPABASE_KEY, 'Authorization':'Bearer ' + SUPABASE_KEY, 'Content-Type':'application/json' },
        body: JSON.stringify({ p_church: who.church, p_member: who.member, p_sub: sub.toJSON() })
      });
    }catch(err){ /* nothing else to do here */ }
  })());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(list => {
    for(const c of list){ if('focus' in c){ if('navigate' in c) c.navigate(target).catch(()=>{}); return c.focus(); } }
    return self.clients.openWindow(target);
  }));
});
