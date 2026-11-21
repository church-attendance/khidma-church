/* =======================================================================
   خِدمة — Church Community App (interactive click-through prototype)
   Client-only demo: persistence via localStorage on this device only.
   ======================================================================= */

const APP_VERSION = 'v15.2 · steadier refresh + chat fixes';
const STORAGE_PREFIX = 'khidma_church_app_v3_';
const CHURCH_CODE_KEY = 'khidma_church_code';

/* ---- Supabase sync (shared database, one row per church, keyed by `code`) ---- */
const SUPABASE_URL = 'https://owpkjnbnyfldnmubfzsy.supabase.co';
const SUPABASE_KEY = 'sb_publishable_FeyMhWVyMkFYhOzXllF9ig_08zVqWC8';
const SUPA_HEADERS = { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer '+SUPABASE_KEY, 'Content-Type':'application/json' };
let lastSyncedAt = null;   // updated_at of the last remote state we applied
let syncing = false;       // true while a push is in flight, to avoid overlapping writes

// All database access goes through secure SQL functions (rpc). The tables themselves are locked.
async function rpc(fn, params){
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method:'POST', headers: SUPA_HEADERS, body: JSON.stringify(params || {}) });
  if(!res.ok){
    let d = ''; try{ const j = await res.json(); d = j.message || j.hint || ''; }catch(e){}
    const err = new Error(d || ('HTTP '+res.status)); err.status = res.status; throw err;
  }
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}
function rpcFail(e){
  lastSaveError = (e instanceof TypeError)
    ? 'لا يوجد اتصال بالإنترنت (أو الاتصال محجوب).'
    : `خطأ من قاعدة البيانات${e.status ? ' ('+e.status+')' : ''}${e.message ? ': '+e.message : ''}`;
}
let directorCreds = null;   // Director email+password, kept in memory only while logged in

async function fetchRemoteState(code){
  try{ const row = await rpc('get_church', { p_code: code }); return row || null; }
  catch(e){ console.warn('Supabase fetch failed (offline or blocked):', e); return null; }
}
async function createRemoteChurch(code, s){
  const nowIso = new Date().toISOString();
  if(!directorCreds){ lastSaveError = 'سجّل دخول المدير أولًا.'; return { ok:false, updatedAt: nowIso }; }
  try{
    const ok = await rpc('director_create_church', { p_email: directorCreds.email, p_pass: directorCreds.pass, p_code: code, p_data: s });
    return { ok: !!ok, updatedAt: nowIso };
  }catch(e){ rpcFail(e); return { ok:false, updatedAt: nowIso }; }
}
let lastSaveError = '';
/* ---- sync: the login session stays on THIS device; pushes are merged with the server and never dropped ---- */
let baseState = null;      // last state known to match the server (used for 3-way merge)
let dirty = false;         // local changes not yet confirmed on the server
let pushQueued = false;
const clone = o => JSON.parse(JSON.stringify(o));
const sameJSON = (a,b)=> JSON.stringify(a)===JSON.stringify(b);
const isDemo = ()=> churchCode === 'DEMO';
function adoptRemote(data, updatedAt){
  const keep = (state && state.session) ? state.session : { userId:null };
  state = data;
  if(!state.stages) state.stages = [];
  if(!state.exams) state.exams = [];
  if(!state.examResponses) state.examResponses = [];
  state.session = keep;            // never take someone else's login from the server
  lastSyncedAt = updatedAt;
  baseState = clone(state);
  saveState(state);
}
function mergeChat(b, l, r){
  const noMsgs = c=>{ const {messages, ...rest} = c || {}; return rest; };
  const seen = new Set(), msgs = [];
  [...(r.messages||[]), ...(l.messages||[])].forEach(m=>{
    const k = m.time+'|'+m.sender+'|'+m.text;
    if(!seen.has(k)){ seen.add(k); msgs.push(m); }
  });
  msgs.sort((x,y)=> new Date(x.time)-new Date(y.time));
  const rank = { unclaimed:0, claimed:1, closed:2 };
  let side;
  if(l.status !== r.status) side = (rank[l.status] >= rank[r.status]) ? l : r;                 // the furthest stage wins: closed > claimed > unclaimed
  else if(l.status === 'claimed' && l.claimedById !== r.claimedById){                            // two servants claimed it at the same time:
    const kl = (l.claimedAt || '9') + '|' + l.claimedById, kr = (r.claimedAt || '9') + '|' + r.claimedById;
    side = kl <= kr ? l : r;                                                                    // the first one keeps it (every device decides the same way)
  }
  else side = (b && sameJSON(noMsgs(l), noMsgs(b))) ? r : l;   // otherwise whoever changed it wins
  return { ...side, messages: msgs };
}
function mergeById(base, local, remote, both){
  const B = new Map((base||[]).map(x=>[x.id,x])), L = new Map((local||[]).map(x=>[x.id,x])), R = new Map((remote||[]).map(x=>[x.id,x]));
  const out = [];
  for(const id of new Set([...R.keys(), ...L.keys()])){
    const l = L.get(id), r = R.get(id), b = B.get(id);
    if(l && r) out.push(both ? both(b,l,r) : (b && sameJSON(l,b) ? r : l));
    else if(l && !r){ if(!b) out.push(l); }      // new here (if it was in base, it was deleted elsewhere)
    else if(r && !l){ if(!b) out.push(r); }      // new elsewhere (if it was in base, we deleted it)
  }
  return out;
}
function mergeStates(base, local, remote){
  const out = { ...remote };
  ['users','classrooms','stages','sectors','attendance','assignments','exams','examResponses','news','chats','pointsLog','auditLog'].forEach(k=>{
    if(local[k] || remote[k]) out[k] = mergeById(base && base[k], local[k], remote[k], k==='chats' ? mergeChat : null);
  });
  ['settings','emergency'].forEach(k=>{ out[k] = (base && sameJSON(local[k], base[k])) ? remote[k] : local[k]; });
  out.auditLog = (out.auditLog||[]).sort((a,b)=> new Date(b.time)-new Date(a.time)).slice(0,80);
  out.pointsLog = (out.pointsLog||[]).sort((a,b)=> new Date(b.time)-new Date(a.time)).slice(0,150);
  out.session = local.session;
  return out;
}
async function flushPush(){
  if(!churchCode || directorSession || isDemo()) return;
  if(syncing){ pushQueued = true; return; }
  syncing = true;
  let replaced = false;
  try{
    do{
      pushQueued = false;
      const row = await rpc('get_church', { p_code: churchCode });
      const remote = row && row.data;
      let toPush = state;
      if(remote && Array.isArray(remote.users) && remote.users.length) toPush = mergeStates(baseState, state, remote);
      const nowIso = new Date().toISOString();
      const ok = await rpc('save_church', { p_code: churchCode, p_data: { ...toPush, session:{userId:null} }, p_updated: nowIso });
      if(!ok) throw new Error('write refused');
      lastSyncedAt = nowIso;
      baseState = clone(toPush);
      if(toPush !== state && !pushQueued && !sameJSON({...toPush,session:0}, {...state,session:0})){
        const keep = state.session; state = toPush; state.session = keep; saveState(state); replaced = true;
      }
      if(!pushQueued) dirty = false;
    } while(pushQueued);
  }catch(e){ console.warn('Supabase push failed (will retry):', e); }
  finally{ syncing = false; }
  if(replaced) softRefresh();
}
/* order-insensitive comparison (the database re-orders the keys of what it stores) */
function deepEqual(a, b){
  if(a === b) return true;
  if(a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if(Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if(ka.length !== kb.length) return false;
  return ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}
/* two timestamps from the database / the app: equal even if one has microseconds, and safe where Date.parse cannot read one */
function sameStamp(a, b){
  const x = Date.parse(a), y = Date.parse(b);
  return (isNaN(x) || isNaN(y)) ? String(a).slice(0,23) === String(b).slice(0,23) : x === y;
}
// Poll for changes made by other people/devices, and merge them in.
async function pollRemoteState(){
  if(!churchCode || directorSession || isDemo()) return;
  fetchGlobalNews(); // fire-and-forget; refreshes globalNewsCache for the next render
  if(dirty || syncing){ flushPush(); return; }
  const row = await fetchRemoteState(churchCode);
  if(dirty || syncing) return;   // something changed locally while we were fetching
  if(!row || !row.data || !Array.isArray(row.data.users) || !row.data.users.length) return;
  if(!lastSyncedAt || !sameStamp(row.updated_at, lastSyncedAt)){
    if(deepEqual({ ...row.data, session:0 }, { ...state, session:0 })){      // new time stamp, same content: nothing to show, nothing to redraw
      lastSyncedAt = row.updated_at; baseState = clone(state);
      return;
    }
    adoptRemote(row.data, row.updated_at);
    softRefresh();
  }
}
// Run once at startup: if this church's row already has data, adopt it (so every
// device converges on the same data instead of each keeping its own demo copy).
async function initialSync(){
  if(!churchCode || isDemo()) return;
  fetchGlobalNews();
  const row = await fetchRemoteState(churchCode);
  if(row && row.data && Array.isArray(row.data.users) && row.data.users.length){
    adoptRemote(row.data, row.updated_at);
    render();
  } else {
    baseState = clone(state);   // no server copy (yet): keep working from this device's copy
  }
}

function uid(prefix){ return prefix + '_' + Math.random().toString(36).slice(2,9); }
function nowISO(){ return new Date().toISOString(); }
function todayStr(){ return new Date().toISOString().slice(0,10); }

function seedState(){
  const sec1 = uid('sec'), sec2 = uid('sec');
  const st1 = uid('stg'), st2 = uid('stg');
  const c1 = uid('cls'), c2 = uid('cls'), c3 = uid('cls');
  const uAdmin = uid('u'), uSuper = uid('u'), uKh1 = uid('u'), uKh2 = uid('u'),
        uMem1 = uid('u'), uMem2 = uid('u'), uMem3 = uid('u'), uPending = uid('u');
  const a1 = uid('asg');
  return {
    session: { userId: null },
    users: [
      { id:uAdmin, name:'مينا جرجس', email:'admin@demo.com', mobile:'01000000001', address:'شارع الكنيسة، القاهرة',
        password:'admin123', role:'senior_admin', status:'approved', classroomId:null, stageId:null, sectorId:null, points:0, createdAt: nowISO() },
      { id:uSuper, name:'فادي رمزي', email:'super@demo.com', mobile:'01000000008', address:'المهندسين',
        password:'super123', role:'super_admin', status:'approved', classroomId:null, stageId:null, sectorId:sec1, points:0, createdAt: nowISO() },
      { id:uKh1, name:'مريم صموئيل', email:'khadim@demo.com', mobile:'01000000002', address:'شارع النصر، الجيزة',
        password:'123456', role:'khadim', status:'approved', classroomId:null, stageId:null, sectorId:null, points:0, createdAt: nowISO() },
      { id:uKh2, name:'أندرو فوزي', email:'khadim2@demo.com', mobile:'01000000003', address:'مدينة نصر',
        password:'123456', role:'khadim', status:'approved', classroomId:null, stageId:null, sectorId:null, points:0, createdAt: nowISO() },
      { id:uMem1, name:'بيشوي عادل', email:'member@demo.com', mobile:'01000000004', address:'المعادي',
        password:'123456', role:'makhdoum', status:'approved', classroomId:c1, stageId:st1, points:15, createdAt: nowISO() },
      { id:uMem2, name:'مارينا سامح', email:'member2@demo.com', mobile:'01000000005', address:'حلوان',
        password:'123456', role:'makhdoum', status:'approved', classroomId:c1, stageId:st1, points:5, createdAt: nowISO() },
      { id:uMem3, name:'كيرلس ناجي', email:'member3@demo.com', mobile:'01000000006', address:'شبرا',
        password:'123456', role:'makhdoum', status:'approved', classroomId:c1, stageId:st1, points:0, createdAt: nowISO() },
      { id:uPending, name:'جرجس فايز', email:'pending@demo.com', mobile:'01000000007', address:'عين شمس',
        password:'123456', role:'makhdoum', status:'pending', classroomId:null, stageId:st1, points:0, createdAt: nowISO() },
    ],
    sectors: [
      { id:sec1, name:'قطاع الأطفال' },
      { id:sec2, name:'قطاع الشباب' },
    ],
    stages: [
      { id:st1, name:'ابتدائي', sectorId:sec1 },
      { id:st2, name:'إعدادي وثانوي', sectorId:sec2 },
    ],
    classrooms: [
      { id:c1, name:'فصل يوسف الرسول', stageId:st1, servantIds:[uKh1, uKh2] },
      { id:c2, name:'فصل مارمرقس', stageId:st1, servantIds:[uKh2] },
      { id:c3, name:'فصل الأنبا أنطونيوس', stageId:st2, servantIds:[] },
    ],
    attendance: [
      { id:uid('att'), memberId:uMem1, classroomId:c1, date: todayStr(), quddas:true, ijtimaa:false, markedBy:uKh1 },
    ],
    assignments: [
      { id:a1, title:'حفظ مزمور ١٥٠', description:'حفظ المزمور كاملًا وتسميعه للخادم.', points:10, classroomId:c1, createdBy:uKh1, createdAt: nowISO(), completions:{} },
    ],
    news: [
      { id:uid('news'), title:'اجتماع الخدام الشهري', content:'يُرجى حضور جميع الخدام اجتماع الخدمة يوم الجمعة القادم بعد صلاة العشية مباشرة.', authorName:'مينا جرجس', authorId:uAdmin, createdAt: nowISO() },
    ],
    chats: [
      { id:uid('chat'), memberId:uMem2, memberName:'مارينا سامح', status:'unclaimed', claimedById:null, claimedByName:null,
        messages:[ {sender:'member', senderName:'مارينا سامح', text:'سلام أبونا، عايزة أستأذن غياب الأحد الجاي بسبب سفر.', time: nowISO()} ],
        createdAt: nowISO() },
    ],
    exams: [], examResponses: [],
    settings: { pointsQuddas:5, pointsIjtimaa:5 },
    pointsLog: [],
    emergency: { active:false, byUserId:null, originalRole:null, grantedAt:null, log:[] },
    auditLog: [
      { id:uid('log'), time: nowISO(), actor:'النظام', action:'تم إنشاء التطبيق وتحميل البيانات التجريبية.' },
    ],
  };
}

function freshChurchState(adminName, adminEmail, adminPass){
  const uAdmin = uid('u');
  return {
    session: { userId: null },
    users: [
      { id:uAdmin, name:adminName, email:adminEmail.toLowerCase(), mobile:'', address:'',
        password:adminPass, role:'senior_admin', status:'approved', classroomId:null, stageId:null, sectorId:null, points:0, createdAt: nowISO() },
    ],
    sectors: [],
    stages: [],
    classrooms: [],
    attendance: [],
    assignments: [],
    news: [],
    chats: [],
    exams: [], examResponses: [],
    settings: { pointsQuddas:5, pointsIjtimaa:5 },
    pointsLog: [],
    emergency: { active:false, byUserId:null, originalRole:null, grantedAt:null, log:[] },
    auditLog: [ { id:uid('log'), time: nowISO(), actor:'النظام', action:'تم إنشاء الكنيسة.' } ],
  };
}

function loadState(code){
  try{
    const raw = localStorage.getItem(STORAGE_PREFIX+code);
    if(raw){
      const s = JSON.parse(raw);
      if(!s.assignments) s.assignments = [];
      if(!s.settings) s.settings = { pointsQuddas:5, pointsIjtimaa:5 };
      if(!s.pointsLog) s.pointsLog = [];
      if(!s.stages) s.stages = [];
      if(!s.exams) s.exams = [];
      if(!s.examResponses) s.examResponses = [];
      if(!s.sectors) s.sectors = [];
      s.classrooms.forEach(c=>{ if(!c.servantIds) c.servantIds = c.servantId ? [c.servantId] : []; if(c.stageId===undefined) c.stageId = null; });
      s.stages.forEach(st=>{ if(st.sectorId===undefined) st.sectorId = null; });
      s.users.forEach(u=>{ if(typeof u.points !== 'number') u.points = 0; if(u.stageId===undefined) u.stageId = null; if(u.sectorId===undefined) u.sectorId = null; });
      return s;
    }
  }catch(e){ /* fall through */ }
  return null;
}
function saveState(s){
  if(!churchCode || !s) return;
  try{ localStorage.setItem(STORAGE_PREFIX+churchCode, JSON.stringify(s)); }catch(e){ console.warn('storage failed', e); }
}

let churchCode = localStorage.getItem(CHURCH_CODE_KEY) || null;
let directorSession = false;
let directorChurches = [];
let directorGlobalNews = [];
let globalNewsCache = []; // read-only copy any church's app polls, for displaying Director broadcasts
async function fetchGlobalNews(){
  try{ const arr = await rpc('get_global_news'); if(Array.isArray(arr)) globalNewsCache = arr; }
  catch(e){ /* keep the last copy */ }
}

// One-time migration: a device that used this app before church codes existed
// keeps its real data by moving it under a fixed code, 'MAIN', instead of losing it.
(function migrateLegacyStorage(){
  if(churchCode) return;
  const legacy = localStorage.getItem('khidma_church_app_v2');
  if(legacy){
    localStorage.setItem(STORAGE_PREFIX+'MAIN', legacy);
    localStorage.setItem(CHURCH_CODE_KEY, 'MAIN');
    churchCode = 'MAIN';
  }
})();

const emptyShellState = ()=>({ session:{userId:null}, users:[], sectors:[], stages:[], classrooms:[], attendance:[], assignments:[], exams:[], examResponses:[], news:[], chats:[], settings:{pointsQuddas:5,pointsIjtimaa:5}, pointsLog:[], emergency:{active:false,byUserId:null,originalRole:null,grantedAt:null,log:[]}, auditLog:[] });
let state = churchCode ? (loadState(churchCode) || emptyShellState()) : emptyShellState();
let ui = { authTab:'login', activeTab:'today', openChatId:null,
           adminAttClassroom:null, ministrySub:'attendance', adminSub:'pending', toast:null, scanning:false, confirm:null,
           gateCode:'', gateError:'', gateBusy:false, showDirectorLogin:false, directorError:'',
           dirNewName:'', dirNewAdminName:'', dirNewAdminEmail:'', dirNewAdminPass:'', resetPwFor:null };

function persist(){ saveState(state); if(churchCode && !directorSession && !isDemo()){ dirty = true; flushPush(); } }
function log(actor, action){
  state.auditLog.unshift({ id:uid('log'), time: nowISO(), actor, action });
  state.auditLog = state.auditLog.slice(0,80);
}
let toastTimer = null;
function hideToast(){ clearTimeout(toastTimer); const el = document.getElementById('appToast'); if(el) el.remove(); }
function showToast(msg){
  render();   // many callers rely on this to refresh the screen after they changed something
  let el = document.getElementById('appToast');
  if(!el){ el = document.createElement('div'); el.id = 'appToast'; el.className = 'app-toast'; el.setAttribute('role','status'); document.body.appendChild(el); }
  el.textContent = msg;                     // plain text: safe even if a name contains < or >
  el.onclick = hideToast;                   // tap it to close it at once
  el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';   // replay the little pop
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 2600); // always closes by itself, even if a redraw fails
}
function askConfirm(message, onYes){
  ui.confirm = { message, onYes };
  render();
}
function awardPoints(member, delta, reason, byName){
  member.points = Math.max(0, (member.points||0) + delta);
  state.pointsLog.unshift({ id:uid('pl'), time: nowISO(), memberId:member.id, memberName:member.name, delta, reason, by:byName });
  state.pointsLog = state.pointsLog.slice(0,150);
}

/* ---------- emergency access ---------- */
function mulberry32(seed){
  return function(){
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function currentHourBucket(){ return Math.floor(Date.now() / 3600000); }
function getEmergencyCredential(){
  const bucket = currentHourBucket();
  const rand = mulberry32(bucket * 2654435761 % 2147483647);
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = ''; for(let i=0;i<6;i++) code += chars[Math.floor(rand()*chars.length)];
  let pass = ''; for(let i=0;i<6;i++) pass += Math.floor(rand()*10);
  const nextRefresh = (bucket+1) * 3600000;
  return { code, pass, nextRefresh };
}
function checkEmergencyExpiry(){
  if(state.emergency.active){
    const grantedAt = new Date(state.emergency.grantedAt).getTime();
    if(Date.now() - grantedAt > 24*3600*1000) revertEmergency('انتهت صلاحية الوصول الطارئ تلقائيًا بعد ٢٤ ساعة.');
  }
}
function revertEmergency(reason){
  const u = state.users.find(x=>x.id===state.emergency.byUserId);
  if(u && state.emergency.originalRole){ u.role = state.emergency.originalRole; }
  log('النظام', reason || 'تم إنهاء وضع الوصول الطارئ.');
  state.emergency = { active:false, byUserId:null, originalRole:null, grantedAt:null, log: state.emergency.log };
  persist();
}

/* ---------- helpers ---------- */
function currentUser(){ return state.users.find(u=>u.id===state.session.userId) || null; }
function classroomOf(id){ return state.classrooms.find(c=>c.id===id); }
function stageOf(id){ return state.stages.find(s=>s.id===id); }
function classroomsInStage(sid){ return state.classrooms.filter(c=>c.stageId===sid); }
function sectorOf(id){ return state.sectors.find(s=>s.id===id); }
function stagesInSector(sectorId){ return state.stages.filter(s=>s.sectorId===sectorId); }
function classroomsInSectorStages(sectorId){ const ids = stagesInSector(sectorId).map(s=>s.id); return state.classrooms.filter(c=>ids.includes(c.stageId)); }
function membersOfClassroom(cid){ return state.users.filter(u=>u.role==='makhdoum' && u.status==='approved' && u.classroomId===cid); }
function isAdminish(u){ return u && (u.role==='khadim' || u.role==='senior_admin' || u.role==='super_admin'); }
function myClassrooms(u){
  if(u.role==='senior_admin') return state.classrooms;
  if(u.role==='super_admin') return classroomsInSectorStages(u.sectorId);
  return state.classrooms.filter(c=>c.servantIds.includes(u.id));
}
function initials(name){ return (name||'?').trim().split(' ')[0].slice(0,1); }
/* ---------- shared look: a coloured hero on top of every tab + icon-headed cards + chips ---------- */
function heroHTML(key, ic, title, sub, extra){
  return `<div class="hero hero-${key}"><div class="hero-ic">${ic}</div><div class="hero-txt"><h2>${title}</h2>${sub ? `<div class="hero-sub">${sub}</div>` : ''}</div>${extra ? `<div class="hero-extra">${extra}</div>` : ''}</div>`;
}
function cardHead(ic, title, sub){
  return `<div class="card-head"><span class="bub">${ic}</span><div class="ch-txt"><b>${title}</b>${sub ? `<div class="muted">${sub}</div>` : ''}</div></div>`;
}
function fmtTime(iso){ const d=new Date(iso); return d.toLocaleTimeString('ar-EG',{hour:'2-digit',minute:'2-digit'}); }
function fmtDate(iso){ const d=new Date(iso); return d.toLocaleDateString('ar-EG',{day:'numeric',month:'short'}); }
function escapeHtml(s){
  return String(s==null?'':s).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

/* ---------- Self-contained QR code encoder (Model 2, byte mode, EC level L) ----------
   No external library — built directly from the ISO/IEC 18004 spec and round-trip
   verified offline before use, so it doesn't depend on any CDN loading correctly. */
const QR_GF_EXP = new Array(512), QR_GF_LOG = new Array(256);
(function initQRGF(){
  let x = 1;
  for(let i=0;i<255;i++){ QR_GF_EXP[i]=x; QR_GF_LOG[x]=i; x<<=1; if(x&0x100) x^=0x11D; }
  for(let i=255;i<512;i++) QR_GF_EXP[i]=QR_GF_EXP[i-255];
})();
function qrGfMul(a,b){ if(a===0||b===0) return 0; return QR_GF_EXP[QR_GF_LOG[a]+QR_GF_LOG[b]]; }
function qrRsGenPoly(degree){
  let poly=[1];
  for(let i=0;i<degree;i++){
    const root = QR_GF_EXP[i];
    const res = new Array(poly.length+1).fill(0);
    for(let j=0;j<poly.length;j++){ res[j]^=poly[j]; res[j+1]^=qrGfMul(poly[j],root); }
    poly = res;
  }
  return poly;
}
function qrRsEncode(dataCw, ecCount){
  const gen = qrRsGenPoly(ecCount);
  const res = dataCw.concat(new Array(ecCount).fill(0));
  for(let i=0;i<dataCw.length;i++){
    const coef = res[i];
    if(coef!==0){ for(let j=0;j<gen.length;j++){ res[i+j]^=qrGfMul(gen[j],coef); } }
  }
  return res.slice(dataCw.length);
}
const QR_VERSION_INFO = {
  1:{size:21,dataCodewords:19,ecCodewords:7}, 2:{size:25,dataCodewords:34,ecCodewords:10},
  3:{size:29,dataCodewords:55,ecCodewords:15}, 4:{size:33,dataCodewords:80,ecCodewords:20},
};
function qrChooseVersion(byteLen){
  for(const v of [1,2,3,4]){
    const info = QR_VERSION_INFO[v];
    const countBits = v<=9?8:16;
    if(4+countBits+byteLen*8 <= info.dataCodewords*8) return v;
  }
  return 4; // will overflow/truncate for extremely long text, not expected here
}
function qrBuildDataBits(bytes, version){
  const countBits = version<=9?8:16;
  let bits = '0100' + bytes.length.toString(2).padStart(countBits,'0');
  for(const b of bytes) bits += b.toString(2).padStart(8,'0');
  const capacityBits = QR_VERSION_INFO[version].dataCodewords*8;
  bits += '0'.repeat(Math.max(0, Math.min(4, capacityBits-bits.length)));
  while(bits.length % 8 !== 0) bits += '0';
  const padBytes=[0xEC,0x11]; let pi=0;
  while(bits.length < capacityBits){ bits += padBytes[pi%2].toString(2).padStart(8,'0'); pi++; }
  const cws=[]; for(let i=0;i<bits.length;i+=8) cws.push(parseInt(bits.slice(i,i+8),2));
  return cws;
}
function qrIsFunctionModule(size, r, c, version){
  if(r<=7 && c<=7) return true;
  if(r<=7 && c>=size-8) return true;
  if(r>=size-8 && c<=7) return true;
  if(r===6 || c===6) return true;
  if(r===size-8 && c===8) return true;
  if((r===8 && (c<9 || c>=size-8)) || (c===8 && (r<9 || r>=size-7))) return true;
  if(version>=2){ const pos=size-7; if(Math.abs(r-pos)<=2 && Math.abs(c-pos)<=2) return true; }
  return false;
}
function qrPlaceFinder(matrix, r0, c0){
  for(let r=-1;r<=7;r++) for(let c=-1;c<=7;c++){
    const rr=r0+r, cc=c0+c;
    if(rr<0||cc<0||rr>=matrix.length||cc>=matrix.length) continue;
    let dark=false;
    if(r>=0&&r<=6&&c>=0&&c<=6){ if(r===0||r===6||c===0||c===6) dark=true; else if(r>=2&&r<=4&&c>=2&&c<=4) dark=true; }
    matrix[rr][cc]=dark?1:0;
  }
}
function qrPlaceAlignment(matrix, r0, c0){
  for(let r=-2;r<=2;r++) for(let c=-2;c<=2;c++){
    matrix[r0+r][c0+c] = (Math.max(Math.abs(r),Math.abs(c))!==1)?1:0;
  }
}
function qrBuildMatrix(version, dataCodewords, ecCodewords){
  const size = QR_VERSION_INFO[version].size;
  const matrix = Array.from({length:size},()=>new Array(size).fill(null));
  qrPlaceFinder(matrix,0,0); qrPlaceFinder(matrix,0,size-7); qrPlaceFinder(matrix,size-7,0);
  for(let i=8;i<size-8;i++){ matrix[6][i]=(i%2===0)?1:0; matrix[i][6]=(i%2===0)?1:0; }
  matrix[size-8][8]=1;
  if(version>=2) qrPlaceAlignment(matrix, size-7, size-7);
  for(let i=0;i<9;i++){ if(matrix[8][i]===null) matrix[8][i]=0; if(matrix[i][8]===null) matrix[i][8]=0; }
  for(let i=0;i<8;i++){ if(matrix[8][size-1-i]===null) matrix[8][size-1-i]=0; if(matrix[size-1-i][8]===null) matrix[size-1-i][8]=0; }

  const bitStream=[];
  for(const cw of dataCodewords.concat(ecCodewords)){ for(let b=7;b>=0;b--) bitStream.push((cw>>b)&1); }
  let bitIndex=0, col=size-1, dir=-1;
  while(col>0){
    if(col===6) col--;
    for(let i=0;i<size;i++){
      const row = dir===-1 ? size-1-i : i;
      for(const c of [col,col-1]){
        if(qrIsFunctionModule(size,row,c,version)) continue;
        if(matrix[row][c]!==null) continue;
        const bit = bitIndex<bitStream.length ? bitStream[bitIndex] : 0; bitIndex++;
        matrix[row][c] = ((row+c)%2===0) ? (bit^1) : bit;
      }
    }
    dir*=-1; col-=2;
  }
  // format info: EC level L + mask pattern 0
  const fmtVal = parseInt('01000',2); // 2 bits EC-level field + 3 bits mask
  let g2 = fmtVal<<10;
  const genPoly = 0b10100110111;
  for(let i=14;i>=10;i--){ if((g2>>i)&1) g2 ^= genPoly<<(i-10); }
  let fmtBits15 = ((fmtVal<<10)|g2) ^ 0b101010000010010;
  fmtBits15 &= 0x7FFF;
  const fmtArr=[]; for(let i=14;i>=0;i--) fmtArr.push((fmtBits15>>i)&1);
  const posA=[[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],[7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]];
  for(let i=0;i<15;i++){ matrix[posA[i][0]][posA[i][1]] = fmtArr[i]; }
  for(let i=0;i<8;i++){ matrix[8][size-1-i] = fmtArr[i]; }
  for(let i=8;i<15;i++){ matrix[size-15+i][8] = fmtArr[i]; }
  return matrix;
}
function generateQRSvg(text){
  const bytes = Array.from(new TextEncoder().encode(text));
  const version = qrChooseVersion(bytes.length);
  const info = QR_VERSION_INFO[version];
  const dataCodewords = qrBuildDataBits(bytes, version);
  const ecCodewords = qrRsEncode(dataCodewords, info.ecCodewords);
  const matrix = qrBuildMatrix(version, dataCodewords, ecCodewords);
  const cell=6, margin=14, dim = info.size*cell + margin*2;
  let rects='';
  for(let r=0;r<info.size;r++) for(let c=0;c<info.size;c++) if(matrix[r][c]) rects += `<rect x="${c*cell+margin}" y="${r*cell+margin}" width="${cell}" height="${cell}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}"><rect width="${dim}" height="${dim}" fill="#fff"/><g fill="#4A1220">${rects}</g></svg>`;
}


/* =========================================================================
   RENDER
   ========================================================================= */
/* ---------------- THEME: light (baby blue) / dark / auto ---------------- */
const THEME_KEY = 'khidma_theme';
function currentTheme(){ try{ return localStorage.getItem(THEME_KEY) || 'light'; }catch(e){ return 'light'; } }
function applyTheme(t){
  const root = document.documentElement;
  if(t==='auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', t);
  const dark = t==='dark' || (t==='auto' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  const m = document.querySelector('meta[name="theme-color"]'); if(m) m.setAttribute('content', dark ? '#2A0C15' : '#245F94');
}
function setTheme(t){ try{ localStorage.setItem(THEME_KEY, t); }catch(e){} applyTheme(t); render(); }
function themeSwitcherHTML(){
  const t = currentTheme();
  const b = (k,label)=>`<button type="button" class="theme-btn ${t===k?'active':''}" data-theme-set="${k}">${label}</button>`;
  return `<div class="theme-switch" role="group" aria-label="المظهر">${b('light','☀️ فاتح')}${b('dark','🌙 داكن')}${b('auto','🖥 تلقائي')}</div>`;
}
function bindThemeButtons(){ document.querySelectorAll('[data-theme-set]').forEach(b=>{ b.onclick = ()=> setTheme(b.dataset.themeSet); }); }
applyTheme(currentTheme());

let lastRenderAt = 0;
const renderLog = [];       // the last redraws and who asked for them (shown by the hidden diagnostic pill)
function logRender(){
  const why = (new Error().stack || '').split('\n').slice(3,6).map(l=>{ const m = /^\s*(?:at\s+)?(?:async\s+)?([A-Za-z_$][\w$.]*)/.exec(l); return m ? m[1] : ''; }).filter(Boolean).join(' ← ');
  renderLog.push({ t: Date.now(), why }); if(renderLog.length > 40) renderLog.shift();
}
function render(){ lastRenderAt = Date.now(); logRender(); renderCore(); bindThemeButtons(); if(typeof ensureReminders==='function') ensureReminders(); if(typeof syncPush==='function') syncPush(); }
let lastThreadId = null, lastScreenKey = null;
function renderCore(){
  checkEmergencyExpiry();
  const root = document.getElementById('root');
  const box0 = document.querySelector('.thread-msgs');
  const keep = box0 ? { top: box0.scrollTop, atBottom: box0.scrollHeight - box0.scrollTop - box0.clientHeight < 60, id: lastThreadId } : null;
  const chatEl = document.getElementById('chatInput');
  const typed = chatEl ? chatEl.value : null, hadFocus = chatEl && document.activeElement === chatEl;
  const ae = document.activeElement;
  const fkey = (ae && ae !== document.body) ? ((ae.dataset && ae.dataset.fkey) || null) : null;
  const selS = fkey ? ae.selectionStart : null, selE = fkey ? ae.selectionEnd : null;

  if(directorSession){ root.className = 'wide-shell'; root.innerHTML = renderDirector(); bindDirectorEvents(); return; }
  if(!churchCode){ root.className = 'auth-shell'; root.innerHTML = renderChurchGate(); bindChurchGateEvents(); return; }

  const u = currentUser();
  if(!u){ root.className = 'auth-shell'; root.innerHTML = renderAuth(); bindAuthEvents(); return; }
  if(u.status === 'banned'){ root.className = 'auth-shell'; root.innerHTML = renderBanned(u); bindPendingEvents(); return; }
  if(u.status === 'pending'){ root.className = 'auth-shell'; root.innerHTML = renderPending(u); bindPendingEvents(); return; }
  if(u.status === 'rejected'){ root.className = 'auth-shell'; root.innerHTML = renderRejected(u); bindPendingEvents(); return; }

  root.className = 'app-shell'; root.innerHTML = renderApp(u);
  const screenKey = [ui.activeTab, ui.ministrySub, ui.adminSub, ui.openChatId, ui.takingExam, ui.openPsalm, ui.lib && ui.lib.open].join('|');
  if(root.querySelector){ const sc = root.querySelector('.screen'); if(sc && screenKey === lastScreenKey) sc.classList.add('still'); }
  lastScreenKey = screenKey;
  if(root.insertAdjacentHTML && localStorage.getItem('khidma_debug') === '1'){
    const now = Date.now(), recent = renderLog.filter(r => now - r.t < 10000);
    root.insertAdjacentHTML('beforeend', `<div class="debug-pill">↻ ${recent.length} / 10s · ${recent.slice(-3).map(r=>escapeHtml(r.why)).join(' | ')}</div>`);
  }
  bindAppEvents(u);
  if(fkey){ const el = document.querySelector(`[data-fkey="${fkey}"]`); if(el){ el.focus(); try{ el.setSelectionRange(selS, selE); }catch(e){} } }
  if(typed){ const el = document.getElementById('chatInput'); if(el){ el.value = typed; if(hadFocus) el.focus(); } }
  const box1 = document.querySelector('.thread-msgs');
  if(box1){   // a chat just opened, or the reader was at the bottom -> show the newest message; otherwise stay where they were
    box1.scrollTop = (!keep || keep.id !== ui.openChatId || keep.atBottom) ? box1.scrollHeight : keep.top;
    lastThreadId = ui.openChatId;
  } else lastThreadId = null;
  if(ui.scanning) startScanner();
}

/* ---------------- CHURCH GATE (entry code) & DIRECTOR ---------------- */
function renderChurchGate(){
  return `
  <div class="auth-wrap">
    <div class="auth-crest">${crestSVG(64)}</div>
    <h1 class="auth-title">خِدمة</h1>
    <p class="auth-sub">تطبيق مجتمع الكنيسة — خدام ومخدومين</p>
    ${!ui.showDirectorLogin ? `
      <div class="mb-3"><label class="form-label">كود الكنيسة</label><input class="form-control" type="text" id="gateCodeInput" placeholder="أدخل كود كنيستك" value="${escapeHtml(ui.gateCode||'')}" style="text-transform:uppercase;"></div>
      ${ui.gateError ? `<div class="muted" style="color:var(--bad);margin-bottom:10px;">${escapeHtml(ui.gateError)}</div>` : ''}
      <button class="btn btn-primary" id="gateSubmitBtn" ${ui.gateBusy?'disabled':''}>${ui.gateBusy?'جاري التحقق...':'دخول'}</button>
      <div class="text-center" style="margin-top:16px;"><button class="btn-ghost" id="toDirectorLogin" type="button">دخول كمدير</button></div>
    ` : `
      <h3 style="font-size:14px;color:var(--text-soft);margin-bottom:12px;">دخول المدير</h3>
      <div class="mb-3"><label class="form-label">البريد الإلكتروني</label><input class="form-control" type="email" id="dirEmail" placeholder="example@email.com"></div>
      <div class="mb-3"><label class="form-label">كلمة المرور</label><input class="form-control" type="password" id="dirPass" placeholder="••••••••"></div>
      ${ui.directorError ? `<div class="muted" style="color:var(--bad);margin-bottom:10px;">${escapeHtml(ui.directorError)}</div>` : ''}
      <button class="btn btn-primary" id="dirSubmitBtn">دخول</button>
      <div class="text-center" style="margin-top:16px;"><button class="btn-ghost" id="toChurchGate" type="button">رجوع لتسجيل الدخول بكود الكنيسة</button></div>
    `}
    ${isInstalled() ? '' : `<div class="text-center" style="margin-top:10px;"><button class="btn btn-outline btn-sm install-app-btn" onclick="triggerInstall()">📲 تثبيت التطبيق على الشاشة الرئيسية</button></div>`}
    ${themeSwitcherHTML()}
    <div class="text-center muted" style="margin-top:14px;font-size:11px;">الإصدار ${APP_VERSION}</div>
  </div>`;
}
function bindChurchGateEvents(){
  const toDir = document.getElementById('toDirectorLogin'); if(toDir) toDir.onclick = ()=>{ ui.showDirectorLogin=true; ui.directorError=''; render(); };
  const toGate = document.getElementById('toChurchGate'); if(toGate) toGate.onclick = ()=>{ ui.showDirectorLogin=false; ui.gateError=''; render(); };
  const gateBtn = document.getElementById('gateSubmitBtn');
  if(gateBtn) gateBtn.onclick = async ()=>{
    const input = document.getElementById('gateCodeInput');
    const code = input.value.trim().toUpperCase();
    ui.gateCode = code;
    if(!code){ ui.gateError='أدخل كود الكنيسة.'; render(); return; }
    if(code==='DEMO'){
      churchCode = 'DEMO';
      localStorage.setItem(CHURCH_CODE_KEY, 'DEMO');
      state = loadState('DEMO') || seedState();
      saveState(state);
      render();
      return;
    }
    ui.gateBusy = true; ui.gateError=''; render();
    const row = await fetchRemoteState(code);
    ui.gateBusy = false;
    if(!row || !row.data || !Array.isArray(row.data.users) || !row.data.users.length){
      ui.gateError = 'كود الكنيسة غير صحيح.'; render(); return;
    }
    churchCode = code;
    localStorage.setItem(CHURCH_CODE_KEY, code);
    state = emptyShellState();
    adoptRemote(row.data, row.updated_at);
    render();
  };
  const dirBtn = document.getElementById('dirSubmitBtn');
  if(dirBtn) dirBtn.onclick = async ()=>{
    const email = document.getElementById('dirEmail').value.trim().toLowerCase();
    const pass = document.getElementById('dirPass').value;
    dirBtn.disabled = true; dirBtn.textContent = 'جاري التحقق...';
    try{
      const ok = await rpc('director_login', { p_email: email, p_pass: pass });
      if(!ok){ ui.directorError = 'بيانات الدخول غير صحيحة.'; render(); return; }
      const data = (await rpc('director_get', { p_email: email, p_pass: pass })) || {};
      directorCreds = { email, pass };
      directorSession = true; ui.directorError = '';
      directorChurches = Array.isArray(data.churches) ? data.churches : [];
      directorGlobalNews = Array.isArray(data.globalNews) ? data.globalNews : [];
      render();
    }catch(e){
      ui.directorError = (e instanceof TypeError) ? 'لا يوجد اتصال بالإنترنت.' : 'تعذّر تسجيل الدخول: '+(e.message||'');
      render();
    }
  };
}
function genChurchCode(){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code; let tries=0;
  do{ code=''; for(let i=0;i<6;i++) code+=chars[Math.floor(Math.random()*chars.length)]; tries++; }
  while(directorChurches.some(c=>c.code===code) && tries<50);
  return code;
}
function renderDirector(){
  return `
  <div class="screen">
    <div class="topbar"><div class="titles"><h1>لوحة المدير</h1><div class="sub">إدارة الكنائس</div></div>
      <button class="logoutbtn" id="dirLogoutBtn">خروج</button></div>
    <h3 style="font-size:13.5px;color:var(--text-soft);margin:14px 0 8px;">📢 رسالة عامة لكل الكنائس</h3>
    <div class="card p-3 mb-3" style="border:2px solid var(--gold, #C79A3D);">
      <div class="mb-3"><label class="form-label">العنوان</label><input class="form-control" type="text" id="dirNewsTitle" placeholder="عنوان الرسالة"></div>
      <div class="mb-3"><label class="form-label">النص</label><textarea class="form-control" id="dirNewsBody" placeholder="نص الرسالة..."></textarea></div>
      <div id="dirNewsError" class="muted" style="color:var(--bad);display:none;margin-bottom:10px;"></div>
      <button class="btn btn-gold" id="dirSendNewsBtn">إرسال للجميع</button>
    </div>
    ${directorGlobalNews.length ? directorGlobalNews.slice().reverse().map(n=>`
      <div class="card px-3 py-2 mb-3">
        <div class="d-flex justify-content-between align-items-start gap-2"><b>📢 ${escapeHtml(n.title)}</b><button class="btn-ghost" data-del-globalnews="${n.id}" style="color:var(--bad);">حذف</button></div>
        <p class="muted" style="margin-top:4px;">${escapeHtml(n.content)}</p>
        <div class="muted">${fmtDate(n.createdAt)}</div>
      </div>`).join('') : ''}
    <h3 style="font-size:13.5px;color:var(--text-soft);margin:18px 0 8px;">إنشاء كنيسة جديدة</h3>
    <div class="card p-3 mb-3">
      <div class="mb-3"><label class="form-label">اسم الكنيسة</label><input class="form-control" type="text" id="dirNewChurchName" placeholder="مثال: كنيسة الأنبا أنطونيوس"></div>
      <div class="mb-3"><label class="form-label">اسم مدير الكنيسة المؤسس</label><input class="form-control" type="text" id="dirNewAdminName"></div>
      <div class="mb-3"><label class="form-label">بريده الإلكتروني</label><input class="form-control" type="email" id="dirNewAdminEmail"></div>
      <div class="mb-3"><label class="form-label">كلمة مروره</label><input class="form-control" type="password" id="dirNewAdminPass" minlength="4"></div>
      <div id="dirCreateError" class="muted" style="color:var(--bad);display:none;margin-bottom:10px;"></div>
      <button class="btn btn-gold" id="dirCreateBtn">إنشاء الكنيسة</button>
    </div>
    <h3 style="font-size:13.5px;color:var(--text-soft);margin:18px 0 8px;">الكنائس الحالية (${directorChurches.length})</h3>
    ${directorChurches.length===0 ? `<p class="muted">لا توجد كنائس بعد.</p>` : directorChurches.slice().reverse().map(c=>`
      <div class="card px-3 py-2 mb-3">
        <div class="d-flex justify-content-between align-items-center"><b>${escapeHtml(c.name)}</b><span class="badge rounded-pill badge-gold" style="letter-spacing:2px;">${escapeHtml(c.code)}</span></div>
        <div class="muted" style="margin-top:4px;">أُنشئت: ${new Date(c.createdAt).toLocaleDateString('ar-EG')}</div>
        ${c.synced===false ? `<div class="muted" style="color:var(--bad);margin-top:6px;">⚠ لم يتم حفظها على الإنترنت بعد.</div><button class="btn-ghost" data-retry-sync="${c.code}">إعادة محاولة الحفظ</button>` : ''}
        <div class="d-flex justify-content-end"><button class="btn-ghost" data-del-church="${c.code}" style="color:var(--bad);">🗑 حذف الكنيسة</button></div>
      </div>`).join('')}
  ${ui.confirm ? `<div class="confirm-overlay"><div class="confirm-box"><p>${escapeHtml(ui.confirm.message)}</p><div class="d-flex gap-2 equal-cols"><button class="btn btn-outline btn-sm" id="confirmNo" style="flex:1;">إلغاء</button><button class="btn btn-danger btn-sm" id="confirmYes" style="flex:1;">تأكيد الحذف</button></div></div></div>` : ''}
  </div>`;
}
async function deleteRemoteChurch(code){
  if(!directorCreds){ lastSaveError = 'سجّل دخول المدير أولًا.'; return { ok:false }; }
  try{ const ok = await rpc('director_delete_church', { p_email: directorCreds.email, p_pass: directorCreds.pass, p_code: code }); return { ok: !!ok }; }
  catch(e){ rpcFail(e); return { ok:false }; }
}
async function saveDirectorData(){
  const nowIso = new Date().toISOString();
  if(!directorCreds){ lastSaveError = 'سجّل دخول المدير أولًا.'; return { ok:false, updatedAt: nowIso }; }
  try{
    const ok = await rpc('director_save', { p_email: directorCreds.email, p_pass: directorCreds.pass,
      p_data: { churches: directorChurches.map(({pendingState, ...c})=>c), globalNews: directorGlobalNews } });
    return { ok: !!ok, updatedAt: nowIso };
  }catch(e){ rpcFail(e); return { ok:false, updatedAt: nowIso }; }
}
function bindDirectorEvents(){
  const confirmYes = document.getElementById('confirmYes');
  if(confirmYes) confirmYes.onclick = ()=>{ const action = ui.confirm && ui.confirm.onYes; ui.confirm = null; if(action) action(); else render(); };
  const confirmNo = document.getElementById('confirmNo');
  if(confirmNo) confirmNo.onclick = ()=>{ ui.confirm = null; render(); };
  document.querySelectorAll('[data-del-church]').forEach(b=>{
    b.onclick = ()=>{
      const code = b.dataset.delChurch;
      const entry = directorChurches.find(c=>c.code===code);
      askConfirm(`حذف كنيسة "${entry.name}" (${code}) نهائيًا؟ سيتم مسح كل أعضائها وبياناتها ولا يمكن التراجع.`, async ()=>{
        const r = await deleteRemoteChurch(code);
        if(!r.ok){ showToast('لم يتم الحذف. '+lastSaveError); render(); return; }
        directorChurches = directorChurches.filter(c=>c.code!==code);
        const s = await saveDirectorData();
        showToast(s.ok ? 'تم حذف الكنيسة.' : 'حُذفت بياناتها لكن تعذّر تحديث القائمة. '+lastSaveError);
        render();
      });
    };
  });
  const logout = document.getElementById('dirLogoutBtn'); if(logout) logout.onclick = ()=>{ directorSession=false; directorCreds=null; ui.showDirectorLogin=false; render(); };
  const sendNewsBtn = document.getElementById('dirSendNewsBtn');
  if(sendNewsBtn) sendNewsBtn.onclick = async ()=>{
    const title = document.getElementById('dirNewsTitle').value.trim();
    const body = document.getElementById('dirNewsBody').value.trim();
    const err = document.getElementById('dirNewsError');
    if(!title || !body){ err.textContent='أدخل العنوان والنص.'; err.style.display='block'; return; }
    err.style.display='none';
    sendNewsBtn.disabled = true; sendNewsBtn.textContent = 'جاري الإرسال...';
    directorGlobalNews.push({ id: uid('gnews'), title, content: body, createdAt: nowISO() });
    const res = await saveDirectorData();
    showToast(res.ok ? 'تم إرسال الرسالة لكل الكنائس 🔔 مع إشعار.' : 'لم تُحفظ الرسالة. '+lastSaveError);
    render();
  };
  document.querySelectorAll('[data-del-globalnews]').forEach(b=>{
    b.onclick = async ()=>{
      directorGlobalNews = directorGlobalNews.filter(n=>n.id!==b.dataset.delGlobalnews);
      await saveDirectorData();
      render();
    };
  });
  const createBtn = document.getElementById('dirCreateBtn');
  if(createBtn) createBtn.onclick = async ()=>{
    const name = document.getElementById('dirNewChurchName').value.trim();
    const adminName = document.getElementById('dirNewAdminName').value.trim();
    const adminEmail = document.getElementById('dirNewAdminEmail').value.trim();
    const adminPass = document.getElementById('dirNewAdminPass').value;
    const err = document.getElementById('dirCreateError');
    if(!name || !adminName || !adminEmail || !adminPass){ err.textContent='من فضلك أكمل كل الحقول.'; err.style.display='block'; return; }
    err.style.display='none';
    createBtn.disabled = true; createBtn.textContent = 'جاري الحفظ على الإنترنت...';
    const code = genChurchCode();
    const newState = freshChurchState(adminName, adminEmail, adminPass);
    const churchRes = await createRemoteChurch(code, newState);
    const entry = { code, name, createdAt: nowISO(), synced: churchRes.ok };
    if(!churchRes.ok) entry.pendingState = newState;
    directorChurches.push(entry);
    const listRes = await saveDirectorData();
    if(churchRes.ok && listRes.ok){
      showToast(`تم إنشاء الكنيسة وحفظها على الإنترنت. الكود: ${code}`);
    } else {
      showToast(`تم إنشاء الكود ${code}، لكن لم يُحفظ. ${lastSaveError}`);
    }
    render();
  };
  document.querySelectorAll('[data-retry-sync]').forEach(b=>{
    b.onclick = async ()=>{
      const code = b.dataset.retrySync;
      const entry = directorChurches.find(c=>c.code===code);
      b.textContent = 'جاري إعادة المحاولة...'; b.disabled = true;
      let churchOk = true;
      if(entry.pendingState){
        const r = await createRemoteChurch(code, entry.pendingState);
        churchOk = r.ok;
        if(r.ok) delete entry.pendingState;
      }
      const listRes = churchOk ? await saveDirectorData() : { ok:false };
      if(churchOk && listRes.ok){ entry.synced = true; showToast('تم الحفظ بنجاح.'); }
      else { showToast('لم يُحفظ بعد. '+lastSaveError); }
      render();
    };
  });
}

/* ---------------- AUTH ---------------- */
function crestSVG(size){
  return `<svg width="${size}" height="${size}" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
    <circle cx="32" cy="32" r="30" fill="none" stroke="currentColor" stroke-width="2"/>
    <g fill="currentColor">
      <path d="M28 10 H36 V26 H52 V34 H36 V54 H28 V34 H12 V26 H28 Z"/>
      <circle cx="32" cy="6" r="4"/><circle cx="26.5" cy="11" r="3.2"/><circle cx="37.5" cy="11" r="3.2"/>
      <circle cx="32" cy="58" r="4"/><circle cx="26.5" cy="53" r="3.2"/><circle cx="37.5" cy="53" r="3.2"/>
      <circle cx="6" cy="32" r="4"/><circle cx="11" cy="26.5" r="3.2"/><circle cx="11" cy="37.5" r="3.2"/>
      <circle cx="58" cy="32" r="4"/><circle cx="53" cy="26.5" r="3.2"/><circle cx="53" cy="37.5" r="3.2"/>
    </g>
  </svg>`;
}

function renderAuth(){
  const tab = ui.authTab;
  return `
  <div class="auth-wrap">
    <div class="auth-crest">${crestSVG(64)}</div>
    <h1 class="auth-title">خِدمة</h1>
    <p class="auth-sub">تطبيق مجتمع الكنيسة — خدام ومخدومين</p>
    <div class="authtabs">
      <button data-authtab="login" class="${tab==='login'?'active':''}">تسجيل الدخول</button>
      <button data-authtab="signup" class="${tab==='signup'?'active':''}">حساب جديد</button>
    </div>
    ${tab==='login' ? renderLoginForm() : renderSignupForm()}
    <div class="text-center" style="margin-top:10px;"><button class="btn-ghost" id="leaveChurchBtn" type="button" style="font-size:11.5px;color:var(--text-soft);">كود كنيسة مختلف؟</button></div>
    ${themeSwitcherHTML()}
    <div class="text-center muted" style="margin-top:8px;font-size:11px;">الإصدار ${APP_VERSION}</div>
  </div>`;
}
function renderLoginForm(){
  return `
  <form id="loginForm">
    <div class="mb-3"><label class="form-label">البريد الإلكتروني</label><input class="form-control" type="email" id="li_email" required placeholder="example@email.com"></div>
    <div class="mb-3"><label class="form-label">كلمة المرور</label><input class="form-control" type="password" id="li_pass" required placeholder="••••••••"></div>
    <div id="loginError" class="muted" style="color:var(--bad);display:none;margin-bottom:10px;"></div>
    <button type="submit" class="btn btn-primary">دخول</button>
  </form>
  <div class="text-center" style="margin-top:14px;">
    <button class="btn-ghost" id="toggleEmergency" type="button">دخول بكود الطوارئ</button>
  </div>
  <div id="emergencyBox" style="display:none;margin-top:10px;">
    <div class="card px-3 py-2 mb-3">
      <div class="mb-3"><label class="form-label">البريد الإلكتروني (لخادم موجود)</label><input class="form-control" type="email" id="em_email" placeholder="example@email.com"></div>
      <div class="d-flex gap-2 equal-cols">
        <div class="mb-3"><label class="form-label">كود الطوارئ</label><input class="form-control" type="text" id="em_code" placeholder="XXXXXX"></div>
        <div class="mb-3"><label class="form-label">كلمة مرور الطوارئ</label><input class="form-control" type="text" id="em_pass" placeholder="000000"></div>
      </div>
      <button class="btn btn-danger" id="emergencyBtn" type="button">تفعيل الوصول الطارئ (٢٤ ساعة)</button>
      <p class="muted" style="margin-top:8px;">يمنحك صلاحيات مدير الكنيسة مؤقتًا، ويعود حسابك تلقائيًا لدوره الأصلي بعد ٢٤ ساعة.</p>
    </div>
  </div>`;
}
function renderSignupForm(){
  return `
  <form id="signupForm">
    <div class="mb-3"><label class="form-label">الاسم بالكامل</label><input class="form-control" type="text" id="su_name" required></div>
    <div class="mb-3"><label class="form-label">البريد الإلكتروني</label><input class="form-control" type="email" id="su_email" required></div>
    <div class="mb-3"><label class="form-label">رقم الموبايل</label><input class="form-control" type="tel" id="su_mobile" required></div>
    <div class="mb-3"><label class="form-label">العنوان</label><input class="form-control" type="text" id="su_address" required></div>
    <div class="mb-3"><label class="form-label">كلمة المرور</label><input class="form-control" type="password" id="su_pass" required minlength="4"></div>
    ${state.stages.length ? `
    <div class="mb-3"><label class="form-label">المرحلة</label>
      <select class="form-select" id="su_stage" required>
        <option value="">اختر المرحلة</option>
        ${state.stages.map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}
      </select>
    </div>` : `<p class="muted" style="margin-bottom:12px;">لم يتم إعداد المراحل العمرية لهذه الكنيسة بعد. يمكنك إرسال الطلب وسيتم تصنيفك لاحقًا.</p>`}
    <div id="signupError" class="muted" style="color:var(--bad);display:none;margin-bottom:10px;"></div>
    <button type="submit" class="btn btn-gold">إرسال طلب الانضمام</button>
    <p class="muted" style="margin-top:10px;text-align:center;">سيتم تسجيلك كـ"مخدوم"، وسيحتاج طلبك موافقة أحد الخدام أو مديري الكنيسة قبل الدخول.</p>
  </form>`;
}
function bindAuthEvents(){
  document.querySelectorAll('[data-authtab]').forEach(b=>{ b.onclick = ()=>{ ui.authTab = b.dataset.authtab; render(); }; });
  const loginForm = document.getElementById('loginForm');
  if(loginForm) loginForm.onsubmit = (e)=>{
    e.preventDefault();
    const email = document.getElementById('li_email').value.trim().toLowerCase();
    const pass = document.getElementById('li_pass').value;
    const u = state.users.find(x=>x.email.toLowerCase()===email && x.password===pass);
    const err = document.getElementById('loginError');
    if(!u){ err.textContent='البريد الإلكتروني أو كلمة المرور غير صحيحة.'; err.style.display='block'; return; }
    if(u.status==='rejected'){ err.textContent='تم رفض هذا الحساب سابقًا. تواصل مع أحد الخدام.'; err.style.display='block'; return; }
    if(u.status==='banned'){ err.textContent='هذا الحساب محظور. تواصل مع مدير الكنيسة.'; err.style.display='block'; return; }
    state.session.userId = u.id; persist(); render();
  };
  const signupForm = document.getElementById('signupForm');
  if(signupForm) signupForm.onsubmit = (e)=>{
    e.preventDefault();
    const email = document.getElementById('su_email').value.trim().toLowerCase();
    const mobile = document.getElementById('su_mobile').value.trim();
    const normMobile = mobile.replace(/\D/g,'');
    const err = document.getElementById('signupError');
    if(state.users.some(x=>x.email.toLowerCase()===email)){ err.textContent='هذا البريد الإلكتروني مسجّل من قبل.'; err.style.display='block'; return; }
    if(normMobile && state.users.some(x=>x.mobile.replace(/\D/g,'')===normMobile)){ err.textContent='رقم الموبايل هذا مسجّل من قبل بحساب آخر.'; err.style.display='block'; return; }
    const nu = { id: uid('u'), name: document.getElementById('su_name').value.trim(), email,
      mobile, address: document.getElementById('su_address').value.trim(),
      password: document.getElementById('su_pass').value, role:'makhdoum', status:'pending', classroomId:null,
      stageId: (document.getElementById('su_stage') ? document.getElementById('su_stage').value : null) || null, points:0, createdAt: nowISO() };
    state.users.push(nu);
    log(nu.name, 'أرسل طلب انضمام جديد (بانتظار الموافقة).');
    state.session.userId = nu.id; persist(); render();
  };
  const leaveBtn = document.getElementById('leaveChurchBtn');
  if(leaveBtn) leaveBtn.onclick = ()=>{
    churchCode = null; localStorage.removeItem(CHURCH_CODE_KEY);
    state = emptyShellState(); render();
  };
  const toggleEm = document.getElementById('toggleEmergency');
  if(toggleEm) toggleEm.onclick = ()=>{ const box = document.getElementById('emergencyBox'); box.style.display = box.style.display==='none' ? 'block' : 'none'; };
  const emBtn = document.getElementById('emergencyBtn');
  if(emBtn) emBtn.onclick = ()=>{
    const email = document.getElementById('em_email').value.trim().toLowerCase();
    const code = document.getElementById('em_code').value.trim().toUpperCase();
    const pass = document.getElementById('em_pass').value.trim();
    const cred = getEmergencyCredential();
    const u = state.users.find(x=>x.email.toLowerCase()===email && (x.role==='khadim'||x.role==='senior_admin') && x.status==='approved');
    if(!u){ showToast('لا يوجد خادم بهذا البريد الإلكتروني.'); return; }
    if(code !== cred.code || pass !== cred.pass){ showToast('كود أو كلمة مرور الطوارئ غير صحيحة.'); return; }
    if(u.role !== 'senior_admin'){
      state.emergency = { active:true, byUserId:u.id, originalRole:u.role, grantedAt: nowISO(), log: state.emergency.log };
      u.role = 'senior_admin';
      log(u.name, 'استخدم كود الطوارئ للحصول على صلاحيات مدير الكنيسة لمدة ٢٤ ساعة.');
      state.emergency.log.unshift({ id:uid('elog'), time: nowISO(), who:u.name });
    }
    state.session.userId = u.id; persist(); showToast('تم تفعيل الوصول الطارئ لمدة ٢٤ ساعة.'); render();
  };
}
function renderPending(u){
  return `<div class="auth-wrap"><div class="auth-crest">${crestSVG(64)}</div>
    <h1 class="auth-title" style="font-size:22px;">بانتظار الموافقة</h1>
    <p class="auth-sub">أهلًا ${escapeHtml(u.name)}، تم إرسال طلبك بنجاح.<br>سيصلك إشعار بمجرد موافقة أحد الخدام أو مديري الكنيسة على انضمامك.</p>
    <button class="btn btn-outline" id="logoutBtn2">تسجيل الخروج</button></div>`;
}
function renderRejected(u){
  return `<div class="auth-wrap"><div class="auth-crest">${crestSVG(64)}</div>
    <h1 class="auth-title" style="font-size:22px;">تعذّر قبول الطلب</h1>
    <p class="auth-sub">${escapeHtml(u.name)}، لم تتم الموافقة على هذا الحساب. للاستفسار برجاء التواصل مباشرة مع أحد الخدام.</p>
    <button class="btn btn-outline" id="logoutBtn2">تسجيل الخروج</button></div>`;
}
function renderBanned(u){
  return `<div class="auth-wrap"><div class="auth-crest">${crestSVG(64)}</div>
    <h1 class="auth-title" style="font-size:22px;color:var(--bad);">الحساب محظور</h1>
    <p class="auth-sub">${escapeHtml(u.name)}، تم حظر هذا الحساب من الدخول إلى التطبيق. للاستفسار برجاء التواصل مباشرة مع مدير الكنيسة.</p>
    <button class="btn btn-outline" id="logoutBtn2">تسجيل الخروج</button></div>`;
}
function bindPendingEvents(){ const b = document.getElementById('logoutBtn2'); if(b) b.onclick = ()=>{ state.session.userId=null; persist(); render(); }; }

/* ---------------- APP SHELL ---------------- */
function tabsFor(role){
  if(role==='makhdoum') return [
    {id:'today', label:'اليوم', ic:'📖'}, {id:'news', label:'الأخبار', ic:'📰'}, {id:'mine', label:'حضوري', ic:'⭐'}, {id:'chat', label:'الدردشة', ic:'💬'}, {id:'settings', label:'الإعدادات', ic:'⚙️'},
  ];
  const base = [
    {id:'today', label:'اليوم', ic:'📖'}, {id:'news', label:'الأخبار', ic:'📰'}, {id:'ministry', label:'الخدمة', ic:'🏫'}, {id:'chat', label:'الدردشة', ic:'💬'},
  ];
  if(role==='senior_admin' || role==='super_admin') base.push({id:'admin', label:'الإدارة', ic:'🛡️'});
  base.push({id:'settings', label:'الإعدادات', ic:'⚙️'});
  return base;
}
function roleLabel(r){ return r==='senior_admin' ? 'مدير الكنيسة' : r==='super_admin' ? 'سوبر أدمن' : r==='khadim' ? 'خادم' : 'مخدوم'; }

function renderApp(u){
  const tabs = tabsFor(u.role);
  if(!tabs.find(t=>t.id===ui.activeTab)) ui.activeTab = 'today';
  let emergencyBanner = '';
  if(state.emergency.active && state.emergency.byUserId===u.id){
    const grantedAt = new Date(state.emergency.grantedAt).getTime();
    const remaining = Math.max(0, 24*3600*1000 - (Date.now()-grantedAt));
    const h = Math.floor(remaining/3600000), m = Math.floor((remaining%3600000)/60000);
    emergencyBanner = `<div class="emergency-banner"><span>⚠️ وضع الوصول الطارئ نشط — يتبقّى ${h} س ${m} د</span><button id="endEmergencyNow">إنهاء الآن</button></div>`;
  }
  return `
  <div class="topbar">
    ${crestSVG(32)}
    <div class="titles"><h1>خِدمة</h1><div class="sub">${roleLabel(u.role)} · ${escapeHtml(u.name.split(' ')[0])}</div></div>
  </div>
  ${emergencyBanner}
  <div class="content" id="contentArea">${renderTab(u, ui.activeTab)}</div>
  <div class="tabbar">${tabs.map(t=>`<button class="tab ${ui.activeTab===t.id?'active':''}" data-tab="${t.id}" ${ui.activeTab===t.id?'aria-current="page"':''}><span class="ic">${t.ic}</span><span class="lb">${t.label}</span></button>`).join('')}</div>
  ${ui.scanning ? renderScanOverlay() : ''}
  ${ui.confirm ? `<div class="confirm-overlay"><div class="confirm-box"><p>${escapeHtml(ui.confirm.message)}</p><div class="d-flex gap-2 equal-cols"><button class="btn btn-outline btn-sm" id="confirmNo" style="flex:1;">إلغاء</button><button class="btn btn-danger btn-sm" id="confirmYes" style="flex:1;">تأكيد</button></div></div></div>` : ''}
  `;
}
function renderTab(u, tab){
  if(tab==='today') return renderToday(u);
  if(tab==='news') return renderNews(u);
  if(tab==='mine') return renderMine(u);
  if(tab==='ministry') return renderMinistry(u);
  if(tab==='chat') return renderChat(u);
  if(tab==='admin') return renderAdmin(u);
  if(tab==='settings') return renderSettings(u);
  return '';
}

/* ---------------- TODAY: 3 Bible chapters a day + a word of encouragement + reminders ---------------- */
const VAPID_PUBLIC_KEY = 'BCgogBtQZl5k7toCZ6lBxo3vxiVLKdXW5bIClCrpsX7Q5xfglbx9Y2HDjlQUKTxIeg1wGVamNiWGzSO4Dl1q_lo';   // public half of the push key (safe to be in the file)
const PSALM_SLOTS = [ { name:'قراءة الصباح', ic:'🌅' }, { name:'قراءة الظهر', ic:'☀️' }, { name:'قراءة المساء', ic:'🌙' } ];   // (name kept for old code; they are Bible readings now)
const WORDS = [
  { t:'أستطيع كل شيء في المسيح الذي يقويني.', r:'فيلبي ٤ : ١٣' },
  { t:'لا تخف لأني معك. لا تتلفت لأني إلهك. قد أيدتك وأعنتك وعضدتك بيمين بري.', r:'إشعياء ٤١ : ١٠' },
  { t:'تشدد وتشجع! لا ترهب ولا ترتعب لأن الرب إلهك معك حيثما تذهب.', r:'يشوع ١ : ٩' },
  { t:'تعالوا إلي يا جميع المتعبين والثقيلي الأحمال وأنا أريحكم.', r:'متى ١١ : ٢٨' },
  { t:'سلاما أترك لكم. سلامي أعطيكم. ليس كما يعطي العالم أعطيكم أنا. لا تضطرب قلوبكم ولا ترهب.', r:'يوحنا ١٤ : ٢٧' },
  { t:'إن كان الله معنا فمن علينا؟', r:'رومية ٨ : ٣١' },
  { t:'لأن الله لم يعطنا روح الفشل بل روح القوة والمحبة والنصح.', r:'٢ تيموثاوس ١ : ٧' },
  { t:'توكل على الرب بكل قلبك وعلى فهمك لا تعتمد.', r:'أمثال ٣ : ٥' },
  { t:'فلا نفشل في عمل الخير لأننا سنحصد في وقته إن كنا لا نكل.', r:'غلاطية ٦ : ٩' },
  { t:'كونوا راسخين غير متزعزعين، مكثرين في عمل الرب كل حين، عالمين أن تعبكم ليس باطلا في الرب.', r:'١ كورنثوس ١٥ : ٥٨' },
  { t:'اقتربوا إلى الله فيقترب إليكم.', r:'يعقوب ٤ : ٨' },
  { t:'ملقين كل همكم عليه لأنه هو يعتني بكم.', r:'١ بطرس ٥ : ٧' },
  { t:'اطلبوا أولا ملكوت الله وبره وهذه كلها تزاد لكم.', r:'متى ٦ : ٣٣' },
  { t:'الرب يقاتل عنكم وأنتم تصمتون.', r:'خروج ١٤ : ١٤' },
  { t:'في العالم سيكون لكم ضيق، ولكن ثقوا: أنا قد غلبت العالم.', r:'يوحنا ١٦ : ٣٣' },
  { t:'كل شيء مستطاع للمؤمن.', r:'مرقس ٩ : ٢٣' },
  { t:'يسوع المسيح هو هو أمسا واليوم وإلى الأبد.', r:'عبرانيين ١٣ : ٨' },
  { t:'الذي فيكم أعظم من الذي في العالم.', r:'١ يوحنا ٤ : ٤' },
  { t:'فرحين في الرجاء، صابرين في الضيق، مواظبين على الصلاة.', r:'رومية ١٢ : ١٢' },
  { t:'كل ما فعلتم فاعملوا من القلب كما للرب ليس للناس.', r:'كولوسي ٣ : ٢٣' },
  { t:'افرحوا كل حين. صلوا بلا انقطاع. اشكروا في كل شيء.', r:'١ تسالونيكي ٥ : ١٦-١٨' },
  { t:'ليس شيء غير ممكن لدى الله.', r:'لوقا ١ : ٣٧' },
  { t:'وها أنا معكم كل الأيام إلى انقضاء الدهر.', r:'متى ٢٨ : ٢٠' },
  { t:'ألق على الرب أعمالك فتثبت أفكارك.', r:'أمثال ١٦ : ٣' },
  { t:'تقووا في الرب وفي شدة قوته.', r:'أفسس ٦ : ١٠' },
  { t:'إنه من إحسانات الرب أننا لم نفن لأن مراحمه لا تزول. هي جديدة في كل صباح. كثيرة أمانتك.', r:'مراثي إرميا ٣ : ٢٢-٢٣' },
  { t:'منتظرو الرب يجددون قوة. يرفعون أجنحة كالنسور. يركضون ولا يتعبون. يمشون ولا يعيون.', r:'إشعياء ٤٠ : ٣١' },
  { t:'لأني عرفت الأفكار التي أنا مفتكر بها عنكم، يقول الرب، أفكار سلام لا شر، لأعطيكم آخرة ورجاء.', r:'إرميا ٢٩ : ١١' },
  { t:'لا تخافوا ولا ترهبوا... لأن الرب إلهك سائر معك. لا يهملك ولا يتركك.', r:'تثنية ٣١ : ٦' },
  { t:'خطوة صغيرة كل يوم تصنع فرقًا كبيرًا مع الوقت.', r:'' },
  { t:'من يخدم بمحبة لا يضيع تعبه أبدًا.', r:'' },
  { t:'ابدأ يومك بصلاة قصيرة، وسترى قلبك أهدأ وخطواتك أثبت.', r:'' },
  { t:'لا تقارن بدايتك بنهاية غيرك؛ لكل واحد رحلته مع الله.', r:'' },
  { t:'الأمانة في الصغير هي أول الطريق إلى الكبير.', r:'' },
  { t:'كل مرة تقوم فيها بعد السقوط هي انتصار صغير.', r:'' },
  { t:'قلبك أغلى ما تملك؛ احرسه بالصلاة وكلمة الله.', r:'' },
  { t:'اليوم فرصة جديدة، فلا تؤجلها.', r:'' },
  { t:'ابتسامتك لإخوتك قد تكون صلاة مستجابة لهم.', r:'' },
  { t:'اجتهد اليوم، والله يتمم الباقي.', r:'' },
  { t:'الصلاة ليست هروبًا من الحياة بل قوة لمواجهتها.', r:'' },
  { t:'كن نورًا صغيرًا في مكانك، وسترى الظلام يتراجع.', r:'' },
  { t:'الاستمرار أهم من الكمال؛ واصل ولا تتوقف.', r:'' },
  { t:'تذكّر أن الله لم يبدأ فيك عملًا ليتركه ناقصًا.', r:'' },
  { t:'كل خدمة صغيرة تقدمها لله تُحسب عظيمة عنده.', r:'' },
  { t:'اختر الشكر اليوم، وسيتغير شكل يومك.', r:'' },
];
/* The day is always counted by Cairo's calendar, so the whole church (and the push messages) read the same chapters. */
function cairoParts(d = new Date()){
  const f = new Intl.DateTimeFormat('en-GB', { timeZone:'Africa/Cairo', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false });
  const p = {}; f.formatToParts(d).forEach(x=>{ p[x.type] = x.value; });
  return { y:+p.year, m:+p.month, d:+p.day, h:(+p.hour)%24, min:+p.minute };
}
function dayNumber(c){ return Math.floor(Date.UTC(c.y, c.m-1, c.d) / 86400000); }
function wordOfDay(dn){ return WORDS[dn % WORDS.length]; }
function dateKeyOf(dn){ const d = new Date(dn*86400000); return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`; }

/* ---------------- THE WHOLE BIBLE: 3 chapters a day, Genesis → Revelation ---------------- */
/* [name, number of chapters] — the position in this list (1…66) is the book number used by the text source (Arabic Van Dyck). */
const BIBLE_BOOKS = [
  ['التكوين',50],['الخروج',40],['اللاويين',27],['العدد',36],['التثنية',34],['يشوع',24],['القضاة',21],['راعوث',4],
  ['صموئيل الأول',31],['صموئيل الثاني',24],['الملوك الأول',22],['الملوك الثاني',25],['أخبار الأيام الأول',29],['أخبار الأيام الثاني',36],
  ['عزرا',10],['نحميا',13],['أستير',10],['أيوب',42],['المزامير',150],['الأمثال',31],['الجامعة',12],['نشيد الأنشاد',8],
  ['إشعياء',66],['إرميا',52],['مراثي إرميا',5],['حزقيال',48],['دانيال',12],['هوشع',14],['يوئيل',3],['عاموس',9],['عوبديا',1],
  ['يونان',4],['ميخا',7],['ناحوم',3],['حبقوق',3],['صفنيا',3],['حجي',2],['زكريا',14],['ملاخي',4],
  ['متى',28],['مرقس',16],['لوقا',24],['يوحنا',21],['أعمال الرسل',28],['رومية',16],['كورنثوس الأولى',16],['كورنثوس الثانية',13],
  ['غلاطية',6],['أفسس',6],['فيلبي',4],['كولوسي',4],['تسالونيكي الأولى',5],['تسالونيكي الثانية',3],['تيموثاوس الأولى',6],
  ['تيموثاوس الثانية',4],['تيطس',3],['فليمون',1],['العبرانيين',13],['يعقوب',5],['بطرس الأولى',5],['بطرس الثانية',3],
  ['يوحنا الأولى',5],['يوحنا الثانية',1],['يوحنا الثالثة',1],['يهوذا',1],['رؤيا يوحنا',22],
];
const BIBLE_TOTAL = BIBLE_BOOKS.reduce((n, b) => n + b[1], 0);          // 1189 chapters
const PLAN_DAYS = Math.ceil(BIBLE_TOTAL / 3);                           // 397 days for one full round
/* Day 1 of the plan (Genesis 1-3) is this date, by Cairo's calendar. Before it, everyone sees day 1. Change the date here (and in the push function) to restart the plan. */
const PLAN_START_DAY = Math.floor(Date.UTC(2026, 10, 22) / 86400000);   // Sunday 22 November 2026  (month 10 = November)
function planDay(dn){ return Math.max(0, dn - PLAN_START_DAY); }
function readingForSlot(dn, slot){
  let idx = (planDay(dn) * 3 + slot) % BIBLE_TOTAL;
  for(let b = 0; b < BIBLE_BOOKS.length; b++){
    if(idx < BIBLE_BOOKS[b][1]) return { book: b + 1, chap: idx + 1, name: BIBLE_BOOKS[b][0], label: BIBLE_BOOKS[b][0] + ' ' + (idx + 1) };
    idx -= BIBLE_BOOKS[b][1];
  }
}

/* The text comes from the free Arabic Van Dyck Bible service (the same one the app already used) and is kept on the phone,
   so a chapter that was opened once also opens offline. Psalms are numbered the Van Dyck (Hebrew) way. */
async function loadChapterText(book, chap){
  const key = 'khidma_bible_v1_' + book + '_' + chap;
  try{ const cached = localStorage.getItem(key); if(cached) return JSON.parse(cached); }catch(e){}
  const res = await fetch(`https://api.getbible.net/v2/arabicsv/${book}/${chap}.json`);
  if(!res.ok) throw new Error('HTTP '+res.status);
  const data = await res.json();
  let vs = data.verses; if(vs && !Array.isArray(vs)) vs = Object.values(vs);
  if(!Array.isArray(vs) || !vs.length) throw new Error('unexpected format');
  const out = vs.map(v=>String(v.text||'').trim()).filter(Boolean);
  if(!out.length) throw new Error('empty');
  rememberChapter(key, out);
  return out;
}
function rememberChapter(key, out){   // only the 60 most recent chapters stay on the phone, so storage never fills up
  try{
    const idx = JSON.parse(localStorage.getItem('khidma_bible_idx') || '[]').filter(k=>k!==key); idx.push(key);
    while(idx.length > 60){ localStorage.removeItem(idx.shift()); }
    localStorage.setItem(key, JSON.stringify(out)); localStorage.setItem('khidma_bible_idx', JSON.stringify(idx));
  }catch(e){}
}
(function dropOldPsalmCache(){ try{ Object.keys(localStorage).filter(k=>k.startsWith('khidma_psalm_v1_')).forEach(k=>localStorage.removeItem(k)); }catch(e){} })();

const chapKey = (b, c) => b + ':' + c;
function ensureChapter(book, chap){
  const key = chapKey(book, chap);
  ui.bibleData = ui.bibleData || {}; ui.bibleErr = ui.bibleErr || {};
  if(ui.bibleData[key]) return;
  delete ui.bibleErr[key];
  loadChapterText(book, chap).then(v=>{ ui.bibleData[key] = v; render(); }).catch(e=>{ console.warn(e); ui.bibleErr[key] = true; render(); });
}
function stepChapter(book, chap, delta){      // next / previous chapter, crossing from one book to the next
  chap += delta;
  if(chap < 1){ if(book === 1) return { book, chap:1 }; book--; chap = BIBLE_BOOKS[book-1][1]; }
  else if(chap > BIBLE_BOOKS[book-1][1]){ if(book === BIBLE_BOOKS.length) return { book, chap: BIBLE_BOOKS[book-1][1] }; book++; chap = 1; }
  return { book, chap };
}
function chapterBodyHTML(book, chap){
  const key = chapKey(book, chap);
  const verses = ui.bibleData && ui.bibleData[key];
  if(verses) return `<div class="psalm-text">${verses.map((t,k)=>`<p><span class="vn">${k+1}</span>${escapeHtml(t)}</p>`).join('')}</div>`;
  if(ui.bibleErr && ui.bibleErr[key]) return `<div class="muted" style="margin:10px 0;">تعذّر تحميل النص الآن (تحتاج اتصالًا بالإنترنت أول مرة). <a href="https://www.google.com/search?q=${encodeURIComponent(BIBLE_BOOKS[book-1][0]+' '+chap+' الكتاب المقدس')}" target="_blank" rel="noopener" style="color:var(--teal);font-weight:700;">افتح الإصحاح في المتصفح</a></div>`;
  return `<div class="muted" style="margin:10px 0;">جاري تحميل الإصحاح…</div>`;
}
function libraryCardHTML(){
  const lib = ui.lib || (ui.lib = { book:1, chap:1, open:false });
  const opt = (i) => `<option value="${i+1}" ${lib.book===i+1?'selected':''}>${BIBLE_BOOKS[i][0]}</option>`;
  const books = `<optgroup label="العهد القديم">${BIBLE_BOOKS.slice(0,39).map((_,i)=>opt(i)).join('')}</optgroup><optgroup label="العهد الجديد">${BIBLE_BOOKS.slice(39).map((_,i)=>opt(i+39)).join('')}</optgroup>`;
  const chaps = Array.from({ length: BIBLE_BOOKS[lib.book-1][1] }, (_,i)=>`<option value="${i+1}" ${lib.chap===i+1?'selected':''}>${i+1}</option>`).join('');
  return `
    <div class="card p-3 mb-3">
      ${cardHead('📚','الكتاب المقدس كله','اقرأ أي سفر وأي إصحاح، في أي وقت.')}
      <div class="d-flex gap-2 mb-2">
        <select class="form-select" id="libBook" style="flex:1;" aria-label="السفر">${books}</select>
        <select class="form-select" id="libChap" style="width:96px;" aria-label="الإصحاح">${chaps}</select>
      </div>
      ${lib.open ? `<div class="muted" style="font-weight:700;">${escapeHtml(BIBLE_BOOKS[lib.book-1][0])} ${lib.chap}</div>${chapterBodyHTML(lib.book, lib.chap)}
        <div class="d-flex gap-2 equal-cols"><button class="btn btn-outline btn-sm" data-lib-step="-1">السابق</button><button class="btn btn-outline btn-sm" data-lib-step="1">التالي</button><button class="btn btn-gold btn-sm" data-lib-open>إخفاء</button></div>`
        : `<button class="btn btn-teal btn-sm" data-lib-open>📖 اقرأ</button>`}
    </div>`;
}

/* reading progress (kept on this device) */
const readKey = u => `khidma_read_${churchCode}_${u.id}`;
function readLog(u){ try{ return JSON.parse(localStorage.getItem(readKey(u)) || '{}'); }catch(e){ return {}; } }
function setRead(u, dk, slot, val){
  const log = readLog(u); const row = log[dk] || [false,false,false]; row[slot] = !!val; log[dk] = row;
  const keys = Object.keys(log).sort(); while(keys.length > 400) delete log[keys.shift()];
  try{ localStorage.setItem(readKey(u), JSON.stringify(log)); }catch(e){}
}
function streakOf(u, dn){
  const log = readLog(u); const full = k => (log[dateKeyOf(k)] || []).filter(Boolean).length === 3;
  let k = full(dn) ? dn : dn-1, n = 0;
  while(full(k) && n < 3650){ n++; k--; }
  return n;
}

/* reminders */
const REMIND_KEY = 'khidma_remind';
function getRemind(){ try{ const r = JSON.parse(localStorage.getItem(REMIND_KEY)||'null'); if(r && Array.isArray(r.times) && r.times.length===3) return r; }catch(e){} return { on:false, times:['07:00','14:00','21:00'] }; }
function saveRemind(r){ try{ localStorage.setItem(REMIND_KEY, JSON.stringify(r)); }catch(e){} }
const notifSupported = () => ('Notification' in window) && ('serviceWorker' in navigator);
async function showLocalNotification(title, body, tag){
  try{
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(title, { body, icon:'icon-192.png', badge:'favicon.png', dir:'rtl', lang:'ar', tag, data:{ url:'./#today' } });
  }catch(e){ console.warn('notification failed', e); }
}
function fireReminder(slot){
  const u = currentUser(); if(!u) return;
  const c = cairoParts(), dn = dayNumber(c), dk = dateKeyOf(dn);
  if((readLog(u)[dk] || [])[slot]) return;                              // already read — stay quiet
  const sk = `khidma_notified_${dk}_${slot}`; if(localStorage.getItem(sk)) return;
  try{ localStorage.setItem(sk, '1'); }catch(e){}
  showLocalNotification(`📖 ${PSALM_SLOTS[slot].name}`, `${readingForSlot(dn, slot).label} — ${wordOfDay(dn).t}`, `read-${slot}`);
}
let reminderTimers = [], reminderArmedFor = undefined;
function scheduleReminders(){
  reminderTimers.forEach(clearTimeout); reminderTimers = [];
  const cfg = getRemind();
  if(!cfg.on || !notifSupported() || Notification.permission!=='granted' || !currentUser()) return;
  const now = new Date();
  cfg.times.forEach((tm, slot)=>{
    const [h,m] = tm.split(':').map(Number); const at = new Date(); at.setHours(h, m, 0, 0);
    if(at <= now) at.setDate(at.getDate()+1);
    reminderTimers.push(setTimeout(()=>{ fireReminder(slot); scheduleReminders(); }, at - now));
  });
}
function catchUpReminders(){
  const cfg = getRemind(); if(!cfg.on || !notifSupported() || Notification.permission!=='granted' || !currentUser()) return;
  const now = new Date();
  cfg.times.forEach((tm, slot)=>{ const [h,m] = tm.split(':').map(Number); const at = new Date(); at.setHours(h, m, 0, 0); const late = now - at; if(late >= 0 && late < 3*3600*1000) fireReminder(slot); });
}
function ensureReminders(){
  const u = currentUser(), id = u ? u.id : null;
  if(id === reminderArmedFor) return; reminderArmedFor = id; scheduleReminders();
}
document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='visible'){ scheduleReminders(); catchUpReminders(); } });

/* push (works even when the app is closed — needs the one-time server setup) */
const urlB64ToUint8Array = b => { const s = (b + '='.repeat((4 - b.length%4)%4)).replace(/-/g,'+').replace(/_/g,'/'); const raw = atob(s); return Uint8Array.from([...raw].map(ch=>ch.charCodeAt(0))); };
const pushSupported = () => notifSupported() && ('PushManager' in window);
async function enablePush(u){
  if(!pushSupported()){ showToast('متصفحك لا يدعم الإشعارات الفورية. على الآيفون ثبّت التطبيق أولًا.'); return; }
  const perm = await Notification.requestPermission();
  if(perm !== 'granted'){ showToast('لم يتم السماح بالإشعارات.'); render(); return; }
  try{
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if(!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey: urlB64ToUint8Array(VAPID_PUBLIC_KEY) });
    const ok = await rpc('save_push_subscription', { p_church: churchCode, p_member: u.id, p_sub: sub.toJSON() });
    if(!ok) throw new Error('رُفض الحفظ');
    try{ localStorage.setItem('khidma_push_on','1'); }catch(e){}
    rememberPushIdentity(u); pushSyncedFor = churchCode + '|' + u.id;
    showToast('تم تفعيل الإشعارات الفورية ✓');
  }catch(e){ console.warn(e); showToast('تعذّر التفعيل: ' + (e.message||'') ); }
  render();
}
/* the reminder card shows only if notifications can work here, are not on yet, and were not dismissed in the last 3 days */
function pushNudgeVisible(){
  try{
    if(!pushSupported() || !('Notification' in window) || Notification.permission === 'denied' || pushIsOn()) return false;
    return Number(localStorage.getItem('khidma_nudge_until') || 0) < Date.now();
  }catch(e){ return false; }
}
const pushIsOn = () => ('Notification' in window) && Notification.permission==='granted' && localStorage.getItem('khidma_push_on')==='1';
/* the service worker reads this to re-register this phone by itself if the browser changes its push address */
async function rememberPushIdentity(u){
  try{ const c = await caches.open('khidma-meta'); await c.put('push-identity', new Response(JSON.stringify({ church:churchCode, member:u.id }))); }catch(e){}
}
/* A phone's push address can change or be dropped. Every time the app opens (and every time it comes back to the
   screen) we check it and re-save it, so notifications keep arriving instead of working only once. */
let pushSyncedFor = null;
async function syncPush(){
  try{
    const u = currentUser();
    if(!u || !churchCode || directorSession || !pushIsOn() || !pushSupported()) return;
    const key = churchCode + '|' + u.id;
    if(pushSyncedFor === key) return;
    pushSyncedFor = key;
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if(!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey: urlB64ToUint8Array(VAPID_PUBLIC_KEY) });
    const ok = await rpc('save_push_subscription', { p_church: churchCode, p_member: u.id, p_sub: sub.toJSON() });
    if(!ok) throw new Error('save refused');
    rememberPushIdentity(u);
  }catch(e){ pushSyncedFor = null; console.warn('push sync failed (will retry):', e); }
}
document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='visible'){ pushSyncedFor = null; syncPush(); } });
async function disablePush(){
  try{
    const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription();
    if(sub){ try{ await rpc('delete_push_subscription', { p_endpoint: sub.endpoint }); }catch(e){} await sub.unsubscribe(); }
  }catch(e){}
  try{ localStorage.removeItem('khidma_push_on'); }catch(e){}
  showToast('تم إيقاف الإشعارات الفورية.'); render();
}

function renderToday(u){
  const c = cairoParts(), dn = dayNumber(c), dk = dateKeyOf(dn);
  const done = readLog(u)[dk] || [false,false,false];
  const count = done.filter(Boolean).length, streak = streakOf(u, dn), w = wordOfDay(dn);
  const cfg = getRemind();
  const perm = ('Notification' in window) ? Notification.permission : 'unsupported';
  const pushOn = localStorage.getItem('khidma_push_on')==='1' && perm==='granted';
  const remindOn = cfg.on && perm==='granted';
  const greet = c.h < 12 ? 'صباح الخير' : c.h < 18 ? 'نهارك سعيد' : 'مساء الخير';
  const heroIc = c.h < 12 ? '🌅' : c.h < 18 ? '☀️' : '🌙';
  const first = escapeHtml(u.name.split(' ')[0]);
  const readingCard = (s, i)=>{
    const r = readingForSlot(dn, i), open = ui.openPsalm === i, read = !!done[i];
    let body = '';
    if(open){
      body = chapterBodyHTML(r.book, r.chap);
      body += `<button class="btn ${read?'btn-outline':'btn-teal'} btn-sm" data-read-psalm="${i}">${read?'↩︎ إلغاء علامة القراءة':'✓ قرأته'}</button>`;
    }
    return `
    <div class="card read-card slot-${i} ${read?'done':''} mb-3">
      <div class="read-main">
        <div class="read-ic">${s.ic}${read ? '<span class="read-tick">✓</span>' : ''}</div>
        <div class="read-txt"><b>${s.name}</b><div class="muted">${escapeHtml(r.label)}</div></div>
        <button class="btn btn-gold btn-sm" data-open-psalm="${i}">${open?'إخفاء':'📖 اقرأ'}</button>
      </div>
      ${body}
    </div>`;
  };
  const planNote = dn < PLAN_START_DAY
    ? `تبدأ الخطة يوم ${new Date(PLAN_START_DAY*86400000).toLocaleDateString('ar-EG', { timeZone:'UTC', weekday:'long', day:'numeric', month:'long' })}`
    : `اليوم ${(planDay(dn) % PLAN_DAYS) + 1} من ${PLAN_DAYS} في قراءة الكتاب المقدس كله`;
  const timeRow = PSALM_SLOTS.map((s,i)=>`<div class="d-flex justify-content-between align-items-center mb-2"><label class="form-label m-0">${s.ic} ${s.name}</label><input class="form-control" type="time" style="width:150px;" value="${cfg.times[i]}" data-remind-time="${i}"></div>`).join('');
  return `
  <div class="screen tab-today">
    ${heroHTML('today', heroIc, 'اليوم', `${greet} يا ${first} 👋`, streak ? `<span class="hero-chip">🔥 ${streak}</span>` : '')}
    <div class="card quote-card p-3">
      <div class="quote-label">✨ كلمة اليوم</div>
      <p class="quote-text">«${escapeHtml(w.t)}»</p>
      ${w.r ? `<div class="quote-ref">${escapeHtml(w.r)}</div>` : ''}
    </div>
    <div class="card p-3 mb-3">
      <div class="d-flex justify-content-between align-items-center mb-3"><b class="card-title">قراءات اليوم</b><span class="badge rounded-pill badge-gold">${count} / 3</span></div>
      <div class="sum-dots">${PSALM_SLOTS.map((sl,i)=>`<div class="sum-slot"><div class="sum-dot ${done[i]?'on':''}">${done[i]?'✓':sl.ic}</div><small>${['الصباح','الظهر','المساء'][i]}</small></div>`).join('')}</div>
      <div class="muted mt-3" style="text-align:center;">${count===3 ? '🎉 أحسنت! أكملت قراءات اليوم' : (streak ? `🔥 ${streak} ${streak===1?'يوم':'أيام'} متتالية — لا تقطع السلسلة` : 'ابدأ سلسلتك اليوم 🔥')} · ${planNote}</div>
    </div>
    ${PSALM_SLOTS.map(readingCard).join('')}
    ${libraryCardHTML()}
    <div class="card p-3 mb-3">
      ${cardHead('🔔','تذكير بالقراءات','اختر مواعيدك. التذكير يعمل والتطبيق مفتوح أو في الخلفية.')}
      <div class="mb-3">${timeRow}</div>
      ${perm==='denied' ? `<div class="muted" style="color:var(--bad);">الإشعارات محظورة من إعدادات المتصفح لهذا الموقع.</div>`
        : `<button class="btn ${remindOn?'btn-outline':'btn-teal'} btn-sm" data-remind-toggle>${remindOn?'إيقاف التذكير':'تفعيل التذكير'}</button>`}
      <hr style="border-color:var(--line);margin:16px 0;">
      <b>📲 إشعارات حتى والتطبيق مغلق</b>
      <div class="muted mb-2">${pushOn ? '✅ مفعّلة: ستصلك رسالة بقراءة كل وقت مع كلمة تشجيع.' : 'تصلك رسالة بقراءة الصباح والظهر والمساء مع كلمة تشجيع. على الآيفون: ثبّت التطبيق على الشاشة الرئيسية أولًا.'}</div>
      ${pushOn ? `<button class="btn btn-outline btn-sm" data-push-toggle="off">إيقاف الإشعارات الفورية</button>` : `<button class="btn btn-gold btn-sm" data-push-toggle="on">تفعيل الإشعارات الفورية</button>`}
    </div>
  </div>`;
}
function bindTodayEvents(u){
  document.querySelectorAll('[data-open-psalm]').forEach(b=>{
    b.onclick = ()=>{
      const i = Number(b.dataset.openPsalm);
      ui.openPsalm = (ui.openPsalm===i) ? null : i;
      if(ui.openPsalm !== null){ const r = readingForSlot(dayNumber(cairoParts()), i); ensureChapter(r.book, r.chap); }
      render();
    };
  });
  document.querySelectorAll('[data-read-psalm]').forEach(b=>{
    b.onclick = ()=>{
      const i = Number(b.dataset.readPsalm), dn = dayNumber(cairoParts()), dk = dateKeyOf(dn);
      const was = !!(readLog(u)[dk] || [])[i]; setRead(u, dk, i, !was);
      if(!was && (readLog(u)[dk]||[]).filter(Boolean).length===3) showToast('🎉 أحسنت! أكملت قراءات اليوم');
      render();
    };
  });
  /* the library: any book, any chapter */
  const libBook = document.getElementById('libBook'), libChap = document.getElementById('libChap');
  if(libBook) libBook.onchange = ()=>{ ui.lib.book = Number(libBook.value); ui.lib.chap = 1; if(ui.lib.open) ensureChapter(ui.lib.book, 1); render(); };
  if(libChap) libChap.onchange = ()=>{ ui.lib.chap = Number(libChap.value); if(ui.lib.open) ensureChapter(ui.lib.book, ui.lib.chap); render(); };
  document.querySelectorAll('[data-lib-open]').forEach(b=>{ b.onclick = ()=>{ ui.lib.open = !ui.lib.open; if(ui.lib.open) ensureChapter(ui.lib.book, ui.lib.chap); render(); }; });
  document.querySelectorAll('[data-lib-step]').forEach(b=>{ b.onclick = ()=>{ const n = stepChapter(ui.lib.book, ui.lib.chap, Number(b.dataset.libStep)); ui.lib.book = n.book; ui.lib.chap = n.chap; ui.lib.open = true; ensureChapter(n.book, n.chap); render(); }; });
  document.querySelectorAll('[data-remind-time]').forEach(el=>{
    el.addEventListener('change', ()=>{ const cfg = getRemind(); cfg.times[Number(el.dataset.remindTime)] = el.value || cfg.times[Number(el.dataset.remindTime)]; saveRemind(cfg); scheduleReminders(); showToast('تم حفظ المواعيد.'); });
  });
  document.querySelectorAll('[data-remind-toggle]').forEach(b=>{
    b.onclick = async ()=>{
      const cfg = getRemind();
      if(cfg.on && Notification.permission==='granted'){ cfg.on = false; saveRemind(cfg); scheduleReminders(); showToast('تم إيقاف التذكير.'); render(); return; }
      if(!notifSupported()){ showToast('متصفحك لا يدعم الإشعارات.'); return; }
      const perm = await Notification.requestPermission();
      if(perm !== 'granted'){ showToast('لم يتم السماح بالإشعارات.'); render(); return; }
      cfg.on = true; saveRemind(cfg); scheduleReminders(); showToast('تم تفعيل التذكير ✓');
      showLocalNotification('📖 قراءات اليوم', 'سنذكّرك في المواعيد التي اخترتها 🙏', 'read-welcome');
      render();
    };
  });
  document.querySelectorAll('[data-enable-push]').forEach(b=>{ b.onclick = ()=> enablePush(u); });
  document.querySelectorAll('[data-dismiss-nudge]').forEach(b=>{ b.onclick = ()=>{ try{ localStorage.setItem('khidma_nudge_until', String(Date.now() + 3*24*3600*1000)); }catch(e){} render(); }; });
  document.querySelectorAll('[data-push-toggle]').forEach(b=>{ b.onclick = ()=>{ if(b.dataset.pushToggle==='on') enablePush(u); else disablePush(); }; });
}

/* ---------------- SETTINGS ---------------- */
function renderSettings(u){
  const cls = classroomOf(u.classroomId);
  return `
  <div class="screen tab-settings">
    ${heroHTML('settings', escapeHtml(initials(u.name)), escapeHtml(u.name), `${roleLabel(u.role)}${cls ? ' · '+escapeHtml(cls.name) : ''}`)}

    <div class="card p-3 mb-3">
      ${cardHead('👤','البيانات الشخصية')}
      <div class="mb-3" style="margin-top:10px;"><label class="form-label">الاسم بالكامل</label><input class="form-control" type="text" id="set_name" value="${escapeHtml(u.name)}"></div>
      <div class="mb-3"><label class="form-label">البريد الإلكتروني</label><input class="form-control" type="email" id="set_email" value="${escapeHtml(u.email)}"></div>
      <div class="mb-3"><label class="form-label">رقم الموبايل</label><input class="form-control" type="tel" id="set_mobile" value="${escapeHtml(u.mobile)}"></div>
      <div class="mb-3"><label class="form-label">العنوان</label><input class="form-control" type="text" id="set_address" value="${escapeHtml(u.address)}"></div>
      <div id="settingsProfileError" class="muted" style="color:var(--bad);display:none;margin-bottom:8px;"></div>
      <button class="btn btn-gold" id="saveProfileBtn">حفظ التعديلات</button>
    </div>

    <div class="card p-3 mb-3" style="text-align:center;">
      <div style="text-align:start;">${cardHead('🎨','المظهر','فاتح أو داكن أو تلقائي')}</div>
      ${themeSwitcherHTML()}
    </div>

    ${isInstalled() ? '' : `<div class="card px-3 py-2 mb-3" style="text-align:center;">
      <button class="btn btn-teal install-app-btn" onclick="triggerInstall()">📲 تثبيت التطبيق على الشاشة الرئيسية</button>
    </div>`}

    <div class="card p-3 mb-3">
      ${cardHead('🔒','تغيير كلمة المرور')}
      <div class="mb-3" style="margin-top:10px;"><label class="form-label">كلمة المرور الحالية</label><input class="form-control" type="password" id="set_pass_current"></div>
      <div class="mb-3"><label class="form-label">كلمة المرور الجديدة</label><input class="form-control" type="password" id="set_pass_new" minlength="4"></div>
      <div id="settingsPassError" class="muted" style="color:var(--bad);display:none;margin-bottom:8px;"></div>
      <button class="btn btn-outline" id="changePasswordBtn">تحديث كلمة المرور</button>
    </div>

    <div class="card p-3 mb-3" style="border-color:var(--bad);">
      ${cardHead('⚠️','<span style="color:var(--bad);">منطقة الخطر</span>')}
      <p class="muted" style="margin:8px 0 12px;">حذف الحساب نهائي ولا يمكن التراجع عنه.</p>
      <div class="d-flex gap-2 equal-cols">
        <button class="btn btn-outline" id="settingsLogoutBtn">تسجيل الخروج</button>
        <button class="btn btn-danger" id="settingsDeleteBtn">حذف حسابي نهائيًا</button>
      </div>
    </div>
  </div>`;
}

/* ---------------- NEWS ---------------- */
function renderNews(u){
  const canPost = isAdminish(u);
  let items = [...state.news].sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt));
  if(!isAdminish(u)) items = items.filter(n=> !n.stageId || n.stageId===u.stageId);
  const globals = [...globalNewsCache].sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt));
  const total = items.length + globals.length;
  const aud = n => (n.stageId && stageOf(n.stageId)) ? '🎯 '+escapeHtml(stageOf(n.stageId).name) : '🌍 للجميع';
  return `
  <div class="screen tab-news">
    ${heroHTML('news', '📣', 'الأخبار والإعلانات', total ? `${total} ${total===1?'إعلان':'إعلانات'}` : 'كل جديد في خدمتنا')}
    ${pushNudgeVisible() ? `<div class="card p-3 mb-3 push-nudge"><div class="mb-2">🔔 فعّل الإشعارات لتصلك الإعلانات الجديدة فورًا، حتى والتطبيق مغلق.</div><div class="d-flex gap-2"><button class="btn btn-gold btn-sm" data-enable-push>تفعيل الإشعارات</button><button class="btn btn-outline btn-sm" data-dismiss-nudge>لاحقًا</button></div></div>` : ''}
    ${canPost ? `<div class="card p-3 mb-3">
      ${cardHead('✍️','إعلان جديد','يصل للجميع كإشعار')}
      <div class="mb-3"><input class="form-control" type="text" id="news_title" placeholder="عنوان الخبر"></div>
      <div class="mb-3"><textarea class="form-control" id="news_body" placeholder="تفاصيل الإعلان..."></textarea></div>
      <div class="mb-3"><label class="form-label">موجّه إلى</label>
        <select class="form-select" id="news_stage">
          ${u.role!=='super_admin' ? `<option value="">الجميع (كل المراحل والفصول في كنيستك)</option>` : ''}
          ${(u.role==='super_admin' ? stagesInSector(u.sectorId) : state.stages).map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}
        </select>
      </div>
      <button class="btn btn-gold" id="postNewsBtn">نشر الإعلان</button>
    </div>` : ''}
    ${globals.map(n=>`
      <div class="card news-card global mb-3">
        <div class="news-ic">📢</div>
        <div class="news-body">
          <b class="news-title">${escapeHtml(n.title)}</b>
          <p class="news-text">${escapeHtml(n.content)}</p>
          <div class="news-meta"><span class="chip chip-gold">رسالة عامة من إدارة النظام</span><span class="chip">📅 ${fmtDate(n.createdAt)}</span></div>
        </div>
      </div>`).join('')}
    ${items.length===0 && globals.length===0 ? `<div class="empty"><div class="big">📭</div>لا توجد إعلانات بعد.</div>` :
      items.map(n=>`
      <div class="card news-card mb-3">
        <div class="news-ic ${n.stageId?'stage':''}">${n.stageId?'🎯':'📰'}</div>
        <div class="news-body">
          <div class="d-flex justify-content-between align-items-start gap-2">
            <b class="news-title">${escapeHtml(n.title)}</b>
            ${(u.role==='senior_admin' || n.authorId===u.id) ? `<button class="btn-ghost" data-del-news="${n.id}" style="color:var(--bad);">حذف</button>` : ''}
          </div>
          <p class="news-text">${escapeHtml(n.content)}</p>
          <div class="news-meta"><span class="chip">👤 ${escapeHtml(n.authorName)}</span><span class="chip">📅 ${fmtDate(n.createdAt)}</span><span class="chip">${aud(n)}</span></div>
        </div>
      </div>`).join('')}
  </div>`;
}

/* ---------------- MINE (member: attendance + points + QR) ---------------- */
function renderMine(u){
  if(ui.takingExam && examOf(ui.takingExam)) return renderExamTake(u);
  const records = state.attendance.filter(a=>a.memberId===u.id).sort((a,b)=> b.date.localeCompare(a.date));
  const totalQ = records.filter(r=>r.quddas).length, totalI = records.filter(r=>r.ijtimaa).length;
  const cls = classroomOf(u.classroomId);
  const myAssignments = state.assignments.filter(a=> !a.classroomId || a.classroomId===u.classroomId);
  const doneA = myAssignments.filter(a=>a.completions[u.id]).length;
  return `
  <div class="screen tab-mine">
    ${heroHTML('mine', '⭐', 'حضوري ونقاطي', `الفصل: ${cls ? escapeHtml(cls.name) : '— غير محدد —'}`, `<span class="hero-chip big">${u.points||0}<small>نقطة</small></span>`)}
    <div class="stat-grid">
      <div class="stat"><div class="stat-ic">⛪</div><div class="stat-n">${totalQ}</div><div class="stat-l">حضور قداس</div></div>
      <div class="stat"><div class="stat-ic">🤝</div><div class="stat-n">${totalI}</div><div class="stat-l">حضور اجتماع</div></div>
      <div class="stat"><div class="stat-ic">✅</div><div class="stat-n">${doneA}<small>/${myAssignments.length}</small></div><div class="stat-l">تكليفات منجزة</div></div>
    </div>
    <div class="card qr-card p-3 mb-3">
      ${cardHead('🔳','رمز حضوري','أظهر هذا الرمز لأحد الخدام لتسجيل حضورك بالمسح')}
      <div id="qrHolder" class="qr-holder"></div>
    </div>
    <h3 class="sub-title">📋 تكليفاتي</h3>
    ${myAssignments.length===0 ? `<p class="muted">لا توجد تكليفات حاليًا.</p>` :
      myAssignments.map(a=>{
        const done = !!a.completions[u.id];
        return `<div class="card asg-card ${done?'done':''} mb-3">
          <div class="asg-ic">${done?'✅':'📋'}</div>
          <div class="asg-body"><b>${escapeHtml(a.title)}</b><div class="muted">${escapeHtml(a.description||'')}</div></div>
          <span class="badge rounded-pill ${done?'badge-ok':'badge-gold'}">${done? '✓ '+a.points+' نقطة' : a.points+' نقطة'}</span>
        </div>`;
      }).join('')
    }
    ${(()=>{
      const myExams = state.exams.filter(e=> (!e.classroomId || e.classroomId===u.classroomId) && (e.status==='open' || responseOf(e.id,u.id)));
      if(!myExams.length) return '';
      return `<h3 class="sub-title">📝 الامتحانات</h3>` + myExams.map(e=>{
        const r = responseOf(e.id,u.id); const s = r ? scoreResponse(e,r) : null;
        return `<div class="card asg-card mb-3">
          <div class="asg-ic">📝</div>
          <div class="asg-body"><b>${escapeHtml(e.title)}</b><div class="muted">${e.questions.length} سؤال</div></div>
          ${r ? `<button class="btn btn-outline btn-sm" data-take-exam="${e.id}">${e.showScore && s.total ? '✓ '+s.got+'/'+s.total : '✓ تم التسليم'}</button>` : `<button class="btn btn-gold btn-sm" data-take-exam="${e.id}">ابدأ الامتحان</button>`}
        </div>`;}).join('');
    })()}
    <h3 class="sub-title">🗓️ سجل الحضور</h3>
    ${records.length===0 ? `<div class="empty"><div class="big">🗒️</div>لا يوجد سجل حضور بعد.</div>` :
      `<div class="card p-3 mb-3"><ul class="plain">${records.map(r=>`
        <li class="log-row">
          <span class="chip">📅 ${fmtDate(r.date)}</span>
          <span class="log-badges">
            <span class="badge rounded-pill ${r.quddas?'badge-ok':'badge-bad'}">قداس ${r.quddas?'✓':'✗'}</span>
            <span class="badge rounded-pill ${r.ijtimaa?'badge-ok':'badge-bad'}">اجتماع ${r.ijtimaa?'✓':'✗'}</span>
          </span>
        </li>`).join('')}</ul></div>`}
  </div>`;
}


/* ---------------- EXAMS (like Google Forms) ---------------- */
const QTYPES = { short:'إجابة قصيرة', paragraph:'فقرة', choice:'اختيار واحد', multi:'مربعات اختيار (أكثر من إجابة)', dropdown:'قائمة منسدلة' };
const EXAM_STATUS = { draft:'مسودة', open:'مفتوح', closed:'مغلق' };
const isChoiceType = t => t==='choice' || t==='multi' || t==='dropdown';
function newQuestion(){ return { id:uid('q'), type:'choice', text:'', required:false, points:1, options:['الخيار ١','الخيار ٢'], correct:[] }; }
function examOf(id){ return state.exams.find(e=>e.id===id); }
function responseOf(examId, memberId){ return state.examResponses.find(r=>r.examId===examId && r.memberId===memberId); }
function questionAutoPoints(q, ans){
  if(!isChoiceType(q.type) || !q.correct.length) return null;           // not auto-graded
  if(q.type==='multi'){
    const a = Array.isArray(ans) ? ans.slice().sort() : [], c = q.correct.slice().sort();
    return (a.length===c.length && a.every((v,i)=>v===c[i])) ? q.points : 0;
  }
  return (ans!==undefined && ans!==null && ans!=='' && q.correct.includes(Number(ans))) ? q.points : 0;
}
function scoreResponse(exam, resp){
  let got = 0, total = 0, pending = 0;
  exam.questions.forEach(q=>{
    const auto = questionAutoPoints(q, resp.answers[q.id]);
    if(auto!==null){ got += auto; total += q.points; }
    else if(!isChoiceType(q.type) && q.points>0){
      total += q.points;
      if(resp.manual && resp.manual[q.id]!==undefined) got += resp.manual[q.id]; else pending++;
    }
  });
  return { got, total, pending };
}
function answerText(q, ans){
  if(isChoiceType(q.type) && q.type!=='multi') return (ans!==undefined && ans!=='' && q.options[ans]!==undefined) ? q.options[ans] : '—';
  if(q.type==='multi') return (Array.isArray(ans) && ans.length) ? ans.map(i=>q.options[i]).filter(x=>x!==undefined).join('، ') : '—';
  return (ans && String(ans).trim()) ? String(ans) : '—';
}
function examsVisibleTo(u){
  const editable = myClassrooms(u);
  return u.role==='senior_admin' ? state.exams : state.exams.filter(e=> !e.classroomId || editable.some(c=>c.id===e.classroomId));
}

function renderAssignments(u){
  const sub = ui.asgSub || 'tasks';
  return `
  <div class="segmented" style="margin-bottom:12px;">
    <button class="${sub==='tasks'?'active':''}" data-asgsub="tasks">التكليفات</button>
    <button class="${sub==='exams'?'active':''}" data-asgsub="exams">📝 الامتحانات</button>
  </div>
  ${sub==='exams' ? renderExamsAdmin(u) : renderTasks(u)}`;
}

function renderExamsAdmin(u){
  if(ui.examResults && examOf(ui.examResults)) return renderExamResults(u);
  if(ui.editExam && examOf(ui.editExam)) return renderExamEditor(u);
  const editable = u.role==='senior_admin' ? state.classrooms : myClassrooms(u);
  const list = examsVisibleTo(u);
  return `
  <div class="card p-3 mb-3">
    ${cardHead('📝','إنشاء امتحان جديد')}
    <div class="mb-3 mt-2"><input class="form-control" type="text" id="exam_title" placeholder="عنوان الامتحان"></div>
    <div class="mb-3"><select class="form-select" id="exam_cls"><option value="">كل الفصول</option>${editable.map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}</select></div>
    <button class="btn btn-gold" id="addExamBtn">إنشاء وإضافة الأسئلة</button>
  </div>
  ${list.length===0 ? `<div class="empty"><div class="big">📝</div>لا توجد امتحانات بعد.</div>` : list.slice().reverse().map(e=>{
    const cls = classroomOf(e.classroomId);
    const count = state.examResponses.filter(r=>r.examId===e.id).length;
    return `
    <div class="card p-3 mb-3">
      <div class="d-flex justify-content-between align-items-start gap-2">
        <div><b style="font-size:14.5px;">${escapeHtml(e.title)}</b><div class="muted">${escapeHtml(cls?cls.name:'كل الفصول')} · ${e.questions.length} سؤال · ${count} إجابة</div></div>
        <span class="badge rounded-pill ${e.status==='open'?'badge-ok':e.status==='closed'?'badge-bad':'badge-gold'}">${EXAM_STATUS[e.status]}</span>
      </div>
      <div class="d-flex flex-wrap gap-1 mt-2">
        <button class="btn-ghost" data-edit-exam="${e.id}">✏️ تعديل</button>
        <button class="btn-ghost" data-results-exam="${e.id}">📊 النتائج</button>
        ${e.status==='open' ? `<button class="btn-ghost" data-exam-status="${e.id}|closed">⏹ إغلاق</button>` : `<button class="btn-ghost" data-exam-status="${e.id}|open">▶ نشر</button>`}
        <button class="btn-ghost" data-del-exam="${e.id}" style="color:var(--bad);">🗑 حذف</button>
      </div>
    </div>`;}).join('')}`;
}

function renderQuestionEditor(e, q, i){
  const choice = isChoiceType(q.type);
  const kind = q.type==='multi' ? 'checkbox' : 'radio';
  return `
  <div class="card p-3 mb-3">
    <div class="d-flex justify-content-between align-items-center mb-2">
      <b>سؤال ${i+1}</b>
      <div class="d-flex gap-1">
        <button class="btn-ghost" data-qmove="${q.id}|-1" ${i===0?'disabled':''}>▲</button>
        <button class="btn-ghost" data-qmove="${q.id}|1" ${i===e.questions.length-1?'disabled':''}>▼</button>
        <button class="btn-ghost" data-qdel="${q.id}" style="color:var(--bad);">🗑</button>
      </div>
    </div>
    <div class="mb-3"><input class="form-control" type="text" data-qid="${q.id}" data-qf="text" data-fkey="${q.id}:text" placeholder="نص السؤال" value="${escapeHtml(q.text)}"></div>
    <div class="mb-3"><select class="form-select" data-qid="${q.id}" data-qtype>${Object.entries(QTYPES).map(([k,v])=>`<option value="${k}" ${q.type===k?'selected':''}>${v}</option>`).join('')}</select></div>
    ${choice ? `
    <div class="mb-3"><label class="form-label">الخيارات (خيار في كل سطر)</label><textarea class="form-control" rows="4" data-qid="${q.id}" data-qopts data-fkey="${q.id}:opts">${escapeHtml(q.options.join('\n'))}</textarea></div>
    <div class="mb-3"><label class="form-label">الإجابة الصحيحة (اختياري — للتصحيح التلقائي)</label>
      ${q.options.map((o,idx)=>`<div class="form-check"><input class="form-check-input" type="${kind}" name="c_${q.id}" id="c_${q.id}_${idx}" data-qid="${q.id}" data-qcorrect="${idx}" ${q.correct.includes(idx)?'checked':''}><label class="form-check-label" for="c_${q.id}_${idx}">${escapeHtml(o)}</label></div>`).join('')}
    </div>` : `<div class="muted mb-3">${'الأسئلة الكتابية يصحّحها الخادم يدويًا من صفحة النتائج.'}</div>`}
    <div class="d-flex gap-3 align-items-center flex-wrap">
      <div class="form-check"><input class="form-check-input" type="checkbox" id="req_${q.id}" data-qid="${q.id}" data-qreq ${q.required?'checked':''}><label class="form-check-label" for="req_${q.id}">مطلوب</label></div>
      <div class="d-flex align-items-center gap-2"><label class="form-label m-0">الدرجة</label><input class="form-control" type="number" min="0" style="width:84px;" data-qid="${q.id}" data-qf="points" data-fkey="${q.id}:pts" value="${q.points}"></div>
    </div>
  </div>`;
}

function renderExamEditor(u){
  const e = examOf(ui.editExam);
  const editable = u.role==='senior_admin' ? state.classrooms : myClassrooms(u);
  return `
  <button class="btn-ghost mb-2" data-exam-back>← رجوع للامتحانات</button>
  <div class="card p-3 mb-3">
    <div class="d-flex justify-content-between align-items-center mb-2"><b>إعدادات الامتحان</b><span class="badge rounded-pill ${e.status==='open'?'badge-ok':e.status==='closed'?'badge-bad':'badge-gold'}">${EXAM_STATUS[e.status]}</span></div>
    <div class="mb-3"><input class="form-control" type="text" data-efield="title" data-fkey="e:title" placeholder="عنوان الامتحان" value="${escapeHtml(e.title)}"></div>
    <div class="mb-3"><textarea class="form-control" rows="3" data-efield="description" data-fkey="e:desc" placeholder="وصف أو تعليمات (اختياري)">${escapeHtml(e.description||'')}</textarea></div>
    <div class="mb-3"><select class="form-select" data-efield="classroomId"><option value="">كل الفصول</option>${editable.map(c=>`<option value="${c.id}" ${e.classroomId===c.id?'selected':''}>${escapeHtml(c.name)}</option>`).join('')}</select></div>
    <div class="form-check"><input class="form-check-input" type="checkbox" id="exam_showscore" data-efield="showScore" ${e.showScore?'checked':''}><label class="form-check-label" for="exam_showscore">إظهار الدرجة للمخدوم بعد التسليم</label></div>
  </div>
  ${e.questions.map((q,i)=>renderQuestionEditor(e,q,i)).join('')}
  <button class="btn btn-outline mb-3" data-addq>＋ إضافة سؤال</button>
  ${e.status==='open'
    ? `<button class="btn btn-danger" data-exam-status="${e.id}|closed">⏹ إغلاق الامتحان</button>`
    : `<button class="btn btn-gold" data-exam-status="${e.id}|open">▶ نشر الامتحان للمخدومين</button>`}`;
}

function renderExamResults(u){
  const e = examOf(ui.examResults);
  const seen = new Set();
  const resps = state.examResponses.filter(r=>r.examId===e.id && !seen.has(r.memberId) && seen.add(r.memberId));
  const scored = resps.map(r=>({ r, s: scoreResponse(e, r) }));
  const avg = scored.length && scored[0].s.total ? Math.round(scored.reduce((a,x)=>a+x.s.got,0)/scored.length*10)/10 : null;
  return `
  <button class="btn-ghost mb-2" data-exam-back>← رجوع للامتحانات</button>
  <div class="card p-3 mb-3">
    <b style="font-size:15px;">${escapeHtml(e.title)}</b>
    <div class="muted">${resps.length} إجابة${avg!==null ? ` · المتوسط ${avg} من ${scored[0].s.total}` : ''}</div>
  </div>
  ${resps.length===0 ? `<div class="empty"><div class="big">📭</div>لا توجد إجابات بعد.</div>` : scored.map(({r,s})=>`
    <div class="card p-3 mb-3">
      <div class="d-flex justify-content-between align-items-center mb-2">
        <b>${escapeHtml(r.memberName)}</b>
        <span class="badge rounded-pill ${s.pending?'badge-gold':'badge-ok'}">${s.got} / ${s.total}${s.pending?' · '+s.pending+' بانتظار التصحيح':''}</span>
      </div>
      <div class="muted mb-2">${fmtDate(r.submittedAt)}</div>
      ${e.questions.map(q=>{
        const ans = r.answers[q.id];
        const auto = questionAutoPoints(q, ans);
        const mark = auto===null ? '' : (auto>0 ? '<span style="color:var(--ok);">✓</span> ' : '<span style="color:var(--bad);">✗</span> ');
        return `<div style="padding:8px 0;border-top:1px solid var(--line);">
          <div style="font-weight:700;font-size:13.5px;">${escapeHtml(q.text||'(بدون عنوان)')}</div>
          <div style="font-size:14px;">${mark}${escapeHtml(answerText(q,ans))}</div>
          ${(!isChoiceType(q.type) && q.points>0) ? `<div class="d-flex align-items-center gap-2 mt-1"><span class="muted">الدرجة (من ${q.points}):</span><input class="form-control" type="number" min="0" max="${q.points}" style="width:84px;" data-manual="${r.id}|${q.id}" value="${r.manual && r.manual[q.id]!==undefined ? r.manual[q.id] : ''}"></div>` : ''}
        </div>`;}).join('')}
    </div>`).join('')}`;
}

/* ----- member side ----- */
function renderExamTake(u){
  const e = examOf(ui.takingExam);
  const resp = responseOf(e.id, u.id);
  const draft = (ui.examDraft && ui.examDraft[e.id]) || {};
  if(resp){
    const s = scoreResponse(e, resp);
    return `
    <div class="screen">
      <button class="btn-ghost mb-2" data-exam-leave>← رجوع</button>
      <div class="card p-3 mb-3" style="text-align:center;">
        <div class="big">✅</div>
        <b style="font-size:16px;">${escapeHtml(e.title)}</b>
        <div class="muted mt-1">تم تسليم إجاباتك</div>
        ${e.showScore && s.total ? `<div style="font-size:32px;font-weight:800;color:var(--heading);margin-top:8px;">${s.got} / ${s.total}</div>${s.pending ? `<div class="muted">بعض الأسئلة الكتابية بانتظار تصحيح الخادم</div>` : ''}` : ''}
      </div>
      ${e.showScore ? e.questions.map(q=>{
        const ans = resp.answers[q.id]; const auto = questionAutoPoints(q, ans);
        const mark = auto===null ? '' : (auto>0 ? '<span style="color:var(--ok);">✓</span> ' : '<span style="color:var(--bad);">✗</span> ');
        return `<div class="card px-3 py-2 mb-3"><div style="font-weight:700;font-size:13.5px;">${escapeHtml(q.text||'(بدون عنوان)')}</div><div>${mark}${escapeHtml(answerText(q,ans))}</div></div>`;
      }).join('') : ''}
    </div>`;
  }
  if(e.status!=='open') return `<div class="screen"><button class="btn-ghost mb-2" data-exam-leave>← رجوع</button><div class="empty"><div class="big">🔒</div>هذا الامتحان مغلق.</div></div>`;
  return `
  <div class="screen">
    <button class="btn-ghost mb-2" data-exam-leave>← رجوع</button>
    <div class="card p-3 mb-3">
      <b style="font-size:16px;">${escapeHtml(e.title)}</b>
      ${e.description ? `<p class="muted mt-2 mb-0" style="white-space:pre-wrap;">${escapeHtml(e.description)}</p>` : ''}
    </div>
    ${e.questions.map((q,i)=>{
      const d = draft[q.id];
      let input = '';
      if(q.type==='short') input = `<input class="form-control" type="text" data-ans-text="${q.id}" data-fkey="a:${q.id}" value="${escapeHtml(d||'')}">`;
      else if(q.type==='paragraph') input = `<textarea class="form-control" rows="4" data-ans-text="${q.id}" data-fkey="a:${q.id}">${escapeHtml(d||'')}</textarea>`;
      else if(q.type==='choice') input = q.options.map((o,idx)=>`<div class="form-check"><input class="form-check-input" type="radio" name="a_${q.id}" id="a_${q.id}_${idx}" data-ans-radio="${q.id}|${idx}" ${d===idx?'checked':''}><label class="form-check-label" for="a_${q.id}_${idx}">${escapeHtml(o)}</label></div>`).join('');
      else if(q.type==='multi') input = q.options.map((o,idx)=>`<div class="form-check"><input class="form-check-input" type="checkbox" id="a_${q.id}_${idx}" data-ans-check="${q.id}|${idx}" ${Array.isArray(d)&&d.includes(idx)?'checked':''}><label class="form-check-label" for="a_${q.id}_${idx}">${escapeHtml(o)}</label></div>`).join('');
      else input = `<select class="form-select" data-ans-select="${q.id}"><option value="">اختر...</option>${q.options.map((o,idx)=>`<option value="${idx}" ${d===idx?'selected':''}>${escapeHtml(o)}</option>`).join('')}</select>`;
      return `<div class="card p-3 mb-3"><div style="font-weight:700;margin-bottom:8px;">${i+1}. ${escapeHtml(q.text||'(بدون عنوان)')}${q.required?' <span style="color:var(--bad);">*</span>':''}${q.points?` <span class="muted">(${q.points})</span>`:''}</div>${input}</div>`;
    }).join('')}
    <button class="btn btn-gold" data-submit-exam="${e.id}">تسليم الإجابات</button>
  </div>`;
}

function bindExamEvents(u){
  const E = ()=> examOf(ui.editExam);
  const Q = el => { const e = E(); return e && e.questions.find(x=>x.id===el.dataset.qid); };
  const live = (el, fn)=>{ el.addEventListener('input', ()=>{ fn(); dirty = true; }); el.addEventListener('change', ()=>{ fn(); persist(); }); };

  document.querySelectorAll('[data-asgsub]').forEach(b=>{ b.onclick = ()=>{ ui.asgSub = b.dataset.asgsub; ui.editExam = null; ui.examResults = null; render(); }; });
  const addBtn = document.getElementById('addExamBtn');
  if(addBtn) addBtn.onclick = ()=>{
    const title = document.getElementById('exam_title').value.trim();
    if(!title){ showToast('أدخل عنوان الامتحان.'); return; }
    const e = { id:uid('exam'), title, description:'', classroomId: document.getElementById('exam_cls').value || null, status:'draft', showScore:true, createdBy:u.id, createdAt:nowISO(), questions:[newQuestion()] };
    state.exams.push(e); log(u.name, `أنشأ امتحانًا: "${title}"`); ui.editExam = e.id; persist(); render();
  };
  document.querySelectorAll('[data-edit-exam]').forEach(b=>{ b.onclick = ()=>{ ui.editExam = b.dataset.editExam; render(); }; });
  document.querySelectorAll('[data-results-exam]').forEach(b=>{ b.onclick = ()=>{ ui.examResults = b.dataset.resultsExam; render(); }; });
  document.querySelectorAll('[data-exam-back]').forEach(b=>{ b.onclick = ()=>{ ui.editExam = null; ui.examResults = null; render(); }; });
  document.querySelectorAll('[data-exam-status]').forEach(b=>{
    b.onclick = ()=>{
      const [id, st] = b.dataset.examStatus.split('|'); const e = examOf(id);
      if(st==='open' && !e.questions.some(q=>q.text.trim())){ showToast('أضف سؤالًا واحدًا على الأقل قبل النشر.'); return; }
      e.status = st; log(u.name, `${st==='open'?'نشر':'أغلق'} امتحان "${e.title}".`); persist(); render();
    };
  });
  document.querySelectorAll('[data-del-exam]').forEach(b=>{
    b.onclick = ()=>{ const e = examOf(b.dataset.delExam);
      askConfirm(`حذف امتحان "${e.title}" وكل إجاباته؟`, ()=>{
        state.exams = state.exams.filter(x=>x.id!==e.id); state.examResponses = state.examResponses.filter(r=>r.examId!==e.id);
        log(u.name, `حذف امتحان "${e.title}".`); persist(); render(); }); };
  });

  // --- editor fields ---
  document.querySelectorAll('[data-efield]').forEach(el=>{
    const k = el.dataset.efield;
    if(el.type==='checkbox') el.addEventListener('change', ()=>{ E()[k] = el.checked; persist(); });
    else live(el, ()=>{ E()[k] = (k==='classroomId') ? (el.value || null) : el.value; });
  });
  document.querySelectorAll('[data-qf]').forEach(el=>{
    live(el, ()=>{ const q = Q(el); if(!q) return; q[el.dataset.qf] = el.dataset.qf==='points' ? Math.max(0, parseInt(el.value,10)||0) : el.value; });
  });
  document.querySelectorAll('[data-qreq]').forEach(el=>{ el.addEventListener('change', ()=>{ Q(el).required = el.checked; persist(); }); });
  document.querySelectorAll('[data-qtype]').forEach(el=>{
    el.addEventListener('change', ()=>{
      const q = Q(el); q.type = el.value;
      if(isChoiceType(q.type)){ if(!q.options.length) q.options = ['الخيار ١','الخيار ٢']; if(q.type!=='multi') q.correct = q.correct.slice(0,1); }
      else q.correct = [];
      persist(); render();
    });
  });
  document.querySelectorAll('[data-qopts]').forEach(el=>{
    el.addEventListener('change', ()=>{
      const q = Q(el); q.options = el.value.split('\n').map(s=>s.trim()).filter(Boolean);
      q.correct = q.correct.filter(i=>i<q.options.length); persist(); render();
    });
  });
  document.querySelectorAll('[data-qcorrect]').forEach(el=>{
    el.addEventListener('change', ()=>{
      const q = Q(el); const idx = Number(el.dataset.qcorrect);
      if(q.type==='multi') q.correct = el.checked ? [...new Set([...q.correct, idx])] : q.correct.filter(i=>i!==idx);
      else q.correct = [idx];
      persist();
    });
  });
  document.querySelectorAll('[data-qmove]').forEach(b=>{
    b.onclick = ()=>{
      const [id, d] = b.dataset.qmove.split('|'); const e = E(); const i = e.questions.findIndex(q=>q.id===id); const j = i + Number(d);
      if(j<0 || j>=e.questions.length) return;
      [e.questions[i], e.questions[j]] = [e.questions[j], e.questions[i]]; persist(); render();
    };
  });
  document.querySelectorAll('[data-qdel]').forEach(b=>{
    b.onclick = ()=>{ const e = E(); if(e.questions.length<=1){ showToast('لازم يبقى سؤال واحد على الأقل.'); return; }
      e.questions = e.questions.filter(q=>q.id!==b.dataset.qdel); persist(); render(); };
  });
  document.querySelectorAll('[data-addq]').forEach(b=>{ b.onclick = ()=>{ E().questions.push(newQuestion()); persist(); render(); }; });

  // --- manual grading ---
  document.querySelectorAll('[data-manual]').forEach(el=>{
    el.addEventListener('change', ()=>{
      const [rid, qid] = el.dataset.manual.split('|');
      const r = state.examResponses.find(x=>x.id===rid); const e = examOf(r.examId); const q = e.questions.find(x=>x.id===qid);
      if(!r.manual) r.manual = {};
      if(el.value==='') delete r.manual[qid]; else r.manual[qid] = Math.min(q.points, Math.max(0, parseInt(el.value,10)||0));
      persist(); render();
    });
  });

  // --- member: take exam ---
  const draftFor = ()=>{ ui.examDraft = ui.examDraft || {}; return (ui.examDraft[ui.takingExam] = ui.examDraft[ui.takingExam] || {}); };
  document.querySelectorAll('[data-take-exam]').forEach(b=>{ b.onclick = ()=>{ ui.takingExam = b.dataset.takeExam; render(); }; });
  document.querySelectorAll('[data-exam-leave]').forEach(b=>{ b.onclick = ()=>{ ui.takingExam = null; render(); }; });
  document.querySelectorAll('[data-ans-text]').forEach(el=>{ el.addEventListener('input', ()=>{ draftFor()[el.dataset.ansText] = el.value; }); });
  document.querySelectorAll('[data-ans-radio]').forEach(el=>{ el.addEventListener('change', ()=>{ const [qid, idx] = el.dataset.ansRadio.split('|'); draftFor()[qid] = Number(idx); }); });
  document.querySelectorAll('[data-ans-check]').forEach(el=>{
    el.addEventListener('change', ()=>{
      const [qid, idx] = el.dataset.ansCheck.split('|'); const d = draftFor(); const cur = Array.isArray(d[qid]) ? d[qid] : [];
      d[qid] = el.checked ? [...new Set([...cur, Number(idx)])] : cur.filter(i=>i!==Number(idx));
    });
  });
  document.querySelectorAll('[data-ans-select]').forEach(el=>{ el.addEventListener('change', ()=>{ draftFor()[el.dataset.ansSelect] = el.value==='' ? undefined : Number(el.value); }); });
  document.querySelectorAll('[data-submit-exam]').forEach(b=>{
    b.onclick = ()=>{
      const e = examOf(b.dataset.submitExam);
      if(e.status!=='open'){ showToast('هذا الامتحان مغلق.'); return; }
      if(responseOf(e.id, u.id)){ showToast('سلّمت هذا الامتحان من قبل.'); return; }
      const d = (ui.examDraft && ui.examDraft[e.id]) || {};
      for(const q of e.questions){
        const a = d[q.id];
        const empty = a===undefined || a===null || a==='' || (Array.isArray(a) && !a.length) || (typeof a==='string' && !a.trim());
        if(q.required && empty){ showToast(`السؤال "${q.text||'بدون عنوان'}" مطلوب.`); return; }
      }
      state.examResponses.push({ id:uid('resp'), examId:e.id, memberId:u.id, memberName:u.name, submittedAt:nowISO(), answers: JSON.parse(JSON.stringify(d)), manual:{} });
      if(ui.examDraft) delete ui.examDraft[e.id];
      log(u.name, `سلّم امتحان "${e.title}".`); persist(); render();
    };
  });
}

/* ---------------- MINISTRY (khadim/senior_admin: attendance + assignments + points) ---------------- */
function renderMinistry(u){
  const sub = ui.ministrySub || 'attendance';
  const mineCls = myClassrooms(u).map(c=>c.name);
  return `
  <div class="screen tab-ministry">
    ${heroHTML('ministry', '🏫', 'الخدمة', mineCls.length ? `فصلك: ${escapeHtml(mineCls.join('، '))}` : 'الحضور والتكليفات والنقاط')}
    <div class="segmented">
      <button class="${sub==='attendance'?'active':''}" data-ministry="attendance">✅ الحضور</button>
      <button class="${sub==='assignments'?'active':''}" data-ministry="assignments">📋 التكليفات</button>
      <button class="${sub==='points'?'active':''}" data-ministry="points">⭐ النقاط</button>
    </div>
    ${sub==='attendance' ? renderAttendanceAdmin(u) : ''}
    ${sub==='assignments' ? renderAssignments(u) : ''}
    ${sub==='points' ? renderPoints(u) : ''}
  </div>`;
}

function renderAttendanceAdmin(u){
  const viewClassrooms = state.classrooms;
  if(!ui.adminAttClassroom || !state.classrooms.find(c=>c.id===ui.adminAttClassroom)){
    ui.adminAttClassroom = (myClassrooms(u)[0] || viewClassrooms[0] || {}).id || null;
  }
  const activeCls = classroomOf(ui.adminAttClassroom);
  const canEdit = activeCls && myClassrooms(u).some(c=>c.id===activeCls.id);
  const members = activeCls ? membersOfClassroom(activeCls.id) : [];
  const date = todayStr();
  return `
    <div class="segmented">${viewClassrooms.map(c=>`<button class="${ui.adminAttClassroom===c.id?'active':''}" data-cls="${c.id}">${escapeHtml(c.name)}${c.servantIds.includes(u.id)?' (فصلي)':''}</button>`).join('')}</div>
    ${!activeCls ? `<div class="empty"><div class="big">🏫</div>لا توجد فصول بعد.</div>` : `
    <div class="card px-3 py-2 mb-3 date-strip">
      <span class="ds-ic">📅</span><div class="ds-txt"><b>${fmtDate(date)}</b><div class="muted">اليوم · ${members.length} ${members.length===1?'عضو':'أعضاء'}</div></div>
      ${canEdit ? `<button class="btn btn-teal btn-sm" id="openScanBtn">📷 مسح للحضور</button>` : `<span class="badge rounded-pill badge-ink">عرض فقط</span>`}
    </div>
    <div class="card p-3 mb-3">
      ${members.length===0 ? `<div class="empty">لا يوجد أعضاء في هذا الفصل بعد.</div>` :
        members.map(m=>{
          const rec = state.attendance.find(a=>a.memberId===m.id && a.date===date);
          const q = rec ? rec.quddas : false, i = rec ? rec.ijtimaa : false;
          return `<div class="member-row">
            <div class="avatar">${initials(m.name)}</div>
            <div class="m-name">${escapeHtml(m.name)}<small>${m.points||0} نقطة</small></div>
            <div class="check ${q?'on':''}" ${canEdit?'':'disabled'} data-att="${m.id}" data-field="quddas" title="القداس">${q?'✓':'⛪'}</div>
            <div class="check ${i?'on':''}" ${canEdit?'':'disabled'} data-att="${m.id}" data-field="ijtimaa" title="الاجتماع">${i?'✓':'🤝'}</div>
          </div>`;
        }).join('')}
    </div>
    <div class="legend"><span class="chip">⛪ القداس +${state.settings.pointsQuddas}</span><span class="chip">🤝 الاجتماع +${state.settings.pointsIjtimaa}</span><span class="chip">اضغط الدائرة لتسجيل الحضور</span></div>
    `}`;
}

/* ---------------- ASSIGNMENT PDF FILES (Supabase Storage bucket "assignment-files") ---------------- */
const ASG_BUCKET = 'assignment-files';
const STORAGE_HEADERS = { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer '+SUPABASE_KEY };
function validatePdf(file){
  if(!file) return null;
  if(!(file.type==='application/pdf' || /\.pdf$/i.test(file.name))) return 'الملف لازم يكون PDF.';
  if(file.size > 10*1024*1024) return 'حجم الملف أكبر من ١٠ ميجا.';
  return null;
}
async function uploadAssignmentPdf(file){
  const key = uid('f') + '.pdf';
  let res;
  try{
    res = await fetch(`${SUPABASE_URL}/storage/v1/object/${ASG_BUCKET}/${key}`, {
      method:'POST', headers:{ ...STORAGE_HEADERS, 'Content-Type':'application/pdf' }, body:file });
  }catch(e){ throw new Error('لا يوجد اتصال بالإنترنت.'); }
  if(!res.ok){
    let d=''; try{ const j = await res.json(); d = j.message || j.error || ''; }catch(e){}
    throw new Error(`فشل رفع الملف (${res.status})${d ? ': '+d : ''} — تأكد من تشغيل ملف SQL الخاص بالملفات.`);
  }
  return { name:file.name, size:file.size, key, url:`${SUPABASE_URL}/storage/v1/object/public/${ASG_BUCKET}/${key}` };
}
async function deleteAssignmentPdf(f){
  if(!f || !f.key) return;
  try{ await fetch(`${SUPABASE_URL}/storage/v1/object/${ASG_BUCKET}/${f.key}`, { method:'DELETE', headers: STORAGE_HEADERS }); }catch(e){}
}
function fileSizeLabel(n){ return n >= 1048576 ? (n/1048576).toFixed(1)+' MB' : Math.max(1,Math.round(n/1024))+' KB'; }

function renderTasks(u){
  const canCreate = isAdminish(u);
  const editableClassrooms = myClassrooms(u);
  const visible = u.role==='senior_admin' ? state.assignments : state.assignments.filter(a=> !a.classroomId || editableClassrooms.some(c=>c.id===a.classroomId));
  const list = visible.slice().sort((a,b)=> (b.pinned?1:0) - (a.pinned?1:0));   // pinned first, others keep their order
  return `
    ${canCreate ? `
    <div class="card p-3 mb-3">
      ${cardHead('📋','تكليف جديد')}
      <div class="mb-3" style="margin-top:10px;"><input class="form-control" type="text" id="asg_title" placeholder="عنوان التكليف"></div>
      <div class="mb-3"><textarea class="form-control" id="asg_desc" placeholder="وصف مختصر (اختياري)"></textarea></div>
      <div class="d-flex gap-2 equal-cols">
        <div class="mb-3"><label class="form-label">قيمة النقاط</label><input class="form-control" type="number" id="asg_points" value="10" min="0"></div>
        <div class="mb-3"><label class="form-label">الفصل</label>
          <select class="form-select" id="asg_cls">
            <option value="">كل الفصول</option>
            ${state.classrooms.map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="mb-3"><label class="form-label">ملف PDF (اختياري)</label><input class="form-control" type="file" id="asg_file" accept="application/pdf,.pdf"></div>
      <div class="form-check mb-3"><input class="form-check-input" type="checkbox" id="asg_pinned"><label class="form-check-label" for="asg_pinned">📌 تثبيت التكليف في الأعلى</label></div>
      <button class="btn btn-gold" id="addAssignmentBtn">إضافة التكليف</button>
    </div>` : ''}
    ${list.length===0 ? `<div class="empty"><div class="big">📋</div>لا توجد تكليفات بعد.</div>` :
      list.map(a=>{
        const cls = classroomOf(a.classroomId);
        const members = a.classroomId ? membersOfClassroom(a.classroomId) : state.users.filter(x=>x.role==='makhdoum'&&x.status==='approved');
        const doneCount = Object.keys(a.completions).length;
        return `
        <div class="card p-3 mb-3">
          <div class="d-flex justify-content-between align-items-start">
            <div><b style="font-size:14.5px;">${a.pinned ? '📌 ' : ''}${escapeHtml(a.title)}</b><div class="muted">${escapeHtml(cls?cls.name:'كل الفصول')} · أنجزها ${doneCount}/${members.length}</div></div>
            ${canCreate ? `<div class="d-flex gap-1"><button class="btn-ghost" data-pin-asg="${a.id}">${a.pinned ? 'إلغاء التثبيت' : '📌 تثبيت'}</button><button class="btn-ghost" data-del-asg="${a.id}" style="color:var(--bad);">حذف</button></div>` : ''}
          </div>
          ${a.file ? `<div class="d-flex align-items-center gap-2" style="margin:8px 0;"><a href="${escapeHtml(a.file.url)}" target="_blank" rel="noopener" style="font-weight:700;color:var(--teal);word-break:break-all;">📎 ${escapeHtml(a.file.name)}</a><span class="muted">(${fileSizeLabel(a.file.size||0)})</span>${canCreate ? `<button class="btn-ghost" data-remove-file="${a.id}" style="color:var(--bad);">إزالة</button>` : ''}</div>` : ''}
          ${canCreate ? `<div style="margin:4px 0;"><label class="btn-ghost" for="attach_${a.id}" style="cursor:pointer;">${a.file ? '🔄 استبدال ملف PDF' : '📎 إرفاق ملف PDF'}</label><input type="file" id="attach_${a.id}" data-attach-input="${a.id}" accept="application/pdf,.pdf" hidden></div>` : ''}
          ${a.description ? `<p class="muted" style="margin:6px 0;">${escapeHtml(a.description)}</p>` : ''}
          <div class="today-progress" style="margin:10px 0;"><span style="width:${members.length ? Math.round(doneCount/members.length*100) : 0}%"></span></div>
          <div class="d-flex gap-2 equal-cols" style="align-items:center;margin:8px 0 10px;">
            <span class="muted">قيمة النقاط:</span>
            ${canCreate ? `<input class="form-control" type="number" min="0" data-asg-points="${a.id}" value="${a.points}" style="width:70px;padding:6px 8px;border-radius:8px;border:1.5px solid var(--line);">` : `<b>${a.points}</b>`}
          </div>
          ${canCreate ? `<div class="checklist">
            ${members.map(m=>`<label><input type="checkbox" data-asg-check="${a.id}|${m.id}" ${a.completions[m.id]?'checked':''}> ${escapeHtml(m.name)} ${a.completions[m.id]?`<span class="badge rounded-pill badge-ok" style="margin-right:auto;">تم</span>`:''}</label>`).join('')}
          </div>` : ''}
        </div>`;
      }).join('')}
  `;
}

function renderPoints(u){
  const canEditSettings = u.role==='senior_admin';
  const scope = u.role==='senior_admin' ? state.classrooms : myClassrooms(u);
  const memberIds = new Set();
  scope.forEach(c=> membersOfClassroom(c.id).forEach(m=>memberIds.add(m.id)));
  const members = state.users.filter(m=>memberIds.has(m.id)).sort((a,b)=> (b.points||0)-(a.points||0));
  const top = members.filter(m=>(m.points||0)>0).slice(0,3);
  const podium = top.length ? `<div class="podium">${[1,0,2].map(k=>top[k]).filter(Boolean).map(m=>{ const rank = top.indexOf(m)+1; return `<div class="pod pod-${rank}"><div class="pod-medal">${['🥇','🥈','🥉'][rank-1]}</div><div class="avatar">${escapeHtml(initials(m.name))}</div><div class="pod-name">${escapeHtml(m.name.split(' ')[0])}</div><div class="pod-pts">${m.points||0}</div><div class="pod-step"></div></div>`; }).join('')}</div>` : '';
  return `
    <div class="card p-3 mb-3">
      ${cardHead('⚙️','إعدادات نقاط الحضور')}
      <div class="d-flex gap-2 equal-cols" style="margin-top:10px;">
        <div class="mb-3"><label class="form-label">نقاط حضور القداس</label><input class="form-control" type="number" id="pts_quddas" value="${state.settings.pointsQuddas}" min="0" ${canEditSettings?'':'disabled'}></div>
        <div class="mb-3"><label class="form-label">نقاط حضور الاجتماع</label><input class="form-control" type="number" id="pts_ijtimaa" value="${state.settings.pointsIjtimaa}" min="0" ${canEditSettings?'':'disabled'}></div>
      </div>
      ${canEditSettings ? `<button class="btn btn-teal" id="savePointsSettings">حفظ الإعدادات</button>` : `<p class="muted">مدير الكنيسة فقط يمكنه تعديل هذه القيم.</p>`}
    </div>
    ${podium}
    <h3 class="sub-title">⭐ نقاط الأعضاء</h3>
    ${members.length===0 ? `<p class="muted">لا يوجد أعضاء في نطاق فصولك بعد.</p>` :
      members.map(m=>`
      <div class="card px-3 py-2 mb-3" style="display:flex;justify-content:space-between;align-items:center;">
        <div class="m-name" style="flex:1;">${escapeHtml(m.name)}</div>
        <div class="points-pill">
          <button data-pts-adj="${m.id}|-1">−</button>
          <span class="val">${m.points||0}</span>
          <button data-pts-adj="${m.id}|1">+</button>
        </div>
      </div>`).join('')}
  `;
}

/* ---------------- CHAT ---------------- */
/* ---- chat helpers ---- */
function threadMessagesHTML(u, chat){
  const isMember = u.role==='makhdoum';
  return chat.messages.map(m=>{
    const cls = (isMember ? m.sender==='member' : m.sender==='admin') ? 'me' : 'them';
    return `<div class="bubble ${cls}">${escapeHtml(m.text)}<span class="t">${fmtTime(m.time)}${m.senderName?' · '+escapeHtml(m.senderName):''}</span></div>`;
  }).join('') || `<div class="muted" style="text-align:center;margin:auto;">ابدأ المحادثة بكتابة رسالتك 👋</div>`;
}
const threadSig = chat => chat.messages.length + '|' + (chat.messages.length ? chat.messages[chat.messages.length-1].time : '') + '|' + chat.status + '|' + (chat.claimedById || '');
/* Refresh the OPEN chat without rebuilding the whole screen: the keyboard stays open, the typed text stays, the scroll stays. */
function updateThreadInPlace(){
  const u = currentUser(), box = document.querySelector('.thread-msgs');
  const chat = state.chats.find(c=>c.id===ui.openChatId);
  if(!u || !box || !chat) return false;
  const canReply = (u.role==='makhdoum' || chat.claimedById===u.id) && chat.status!=='closed';
  if(!!document.getElementById('chatInput') !== canReply) return false;      // the layout changes (e.g. the chat was closed): needs a full redraw
  const sig = threadSig(chat);
  if(box.dataset.sig !== sig){
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    box.innerHTML = threadMessagesHTML(u, chat); box.dataset.sig = sig;
    if(atBottom) box.scrollTop = box.scrollHeight;
    const th = document.querySelector('.thread-head .th-txt'); if(th) th.innerHTML = threadHeadHTML(u, chat);
  }
  return true;
}
/* used by the timers and by the sync: never disturbs someone who is typing a chat message */
let softTimer = null;
function softRefresh(){
  const inp = document.getElementById('chatInput');
  if(inp && (document.activeElement === inp || inp.value) && updateThreadInPlace()) return;   // typing: update just the messages
  if(Date.now() - lastRenderAt < 2000){                       // we just redrew: never redraw again within 2 seconds because of a timer/sync
    if(!softTimer) softTimer = setTimeout(()=>{ softTimer = null; softRefresh(); }, 2100);
    return;
  }
  render();
}
function threadStatusBadge(u, chat){
  const isMember = u.role==='makhdoum';
  return chat.status==='unclaimed' ? `<span class="badge rounded-pill badge-gold">بانتظار استلام أحد الخدام</span>`
    : chat.status==='claimed' ? `<span class="badge rounded-pill badge-ok">${isMember ? 'يتحدث معك: '+escapeHtml(chat.claimedByName) : 'مستلمة بواسطتك'}</span>`
    : `<span class="badge rounded-pill badge-ink">تم إغلاق المحادثة</span>`;
}
function threadHeadHTML(u, chat){
  const isMember = u.role==='makhdoum';
  return `<b>${isMember ? 'محادثتي' : escapeHtml(chat.memberName)}</b><div>${threadStatusBadge(u, chat)}</div>`;
}

function renderChat(u){
  if(ui.openChatId){ const chat = state.chats.find(c=>c.id===ui.openChatId); if(chat) return renderChatThread(u, chat); ui.openChatId = null; }
  if(u.role==='makhdoum'){
    let myChat = [...state.chats].filter(c=>c.memberId===u.id).sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt))[0];
    if(!myChat || myChat.status==='closed'){
      return `<div class="screen tab-chat">${heroHTML('chat','💬','تواصل مع الخدمة','نحن هنا للمساعدة')}
        <div class="empty"><div class="big">💬</div>${myChat ? 'تم إغلاق محادثتك السابقة.' : 'ليس لديك محادثة حاليًا.'}<br>ابدأ محادثة جديدة مع أحد الخدام.</div>
        <button class="btn btn-gold" id="newChatBtn">بدء محادثة جديدة</button></div>`;
    }
    ui.openChatId = myChat.id;
    return renderChatThread(u, myChat);
  }
  const unclaimed = state.chats.filter(c=>c.status==='unclaimed');
  const mine = state.chats.filter(c=>c.claimedById===u.id && c.status==='claimed');
  return `
  <div class="screen tab-chat">
    ${heroHTML('chat','💬','الدردشات', `${unclaimed.length} بانتظار الاستلام · ${mine.length} محادثاتي`)}
    <h3 class="sub-title">🟡 غير مُستلمة <span class="chip">${unclaimed.length}</span></h3>
    ${unclaimed.length===0 ? `<p class="muted" style="margin-bottom:16px;">لا توجد محادثات بانتظار الاستلام.</p>` :
      unclaimed.map(c=>`<div class="chat-list-item" data-openchat="${c.id}">
        <div class="avatar">${initials(c.memberName)}</div>
        <div style="flex:1;min-width:0;"><b>${escapeHtml(c.memberName)}</b><div class="muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(c.messages[c.messages.length-1]?.text || 'محادثة جديدة — بدون رسائل بعد')}</div></div>
        <button class="btn btn-gold btn-sm" data-claim="${c.id}">استلام</button>
      </div>`).join('')}
    <h3 class="sub-title">💚 محادثاتي <span class="chip">${mine.length}</span></h3>
    ${mine.length===0 ? `<p class="muted">لا توجد محادثات مستلمة حاليًا.</p>` :
      mine.map(c=>`<div class="chat-list-item" data-openchat="${c.id}">
        <div class="avatar">${initials(c.memberName)}</div>
        <div style="flex:1;min-width:0;"><b>${escapeHtml(c.memberName)}</b><div class="muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(c.messages[c.messages.length-1]?.text || 'محادثة جديدة — بدون رسائل بعد')}</div></div>
      </div>`).join('')}
  </div>`;
}
function renderChatThread(u, chat){
  const isMember = u.role==='makhdoum';
  const canReply = isMember || chat.claimedById===u.id;
  return `
  <div class="screen tab-chat">
    <div class="card thread-head mb-3">
      ${isMember ? '' : `<button class="round-btn" id="backToChatList" aria-label="رجوع">›</button>`}
      <div class="avatar">${escapeHtml(initials(isMember ? (chat.claimedByName || 'خ') : chat.memberName))}</div>
      <div class="th-txt">${threadHeadHTML(u, chat)}</div>
      ${(!isMember && chat.status==='claimed' && chat.claimedById===u.id) ? `<button class="btn-ghost" id="closeChatBtn" style="color:var(--bad);">إنهاء</button>` : ''}
    </div>
    <div class="chat-thread">
      <div class="thread-msgs" data-sig="${escapeHtml(threadSig(chat))}">${threadMessagesHTML(u, chat)}</div>
      ${canReply && chat.status!=='closed' ? `<div class="thread-input"><input class="form-control" type="text" id="chatInput" placeholder="اكتب رسالتك..." enterkeyhint="send" autocomplete="off"><button class="btn btn-primary" id="sendChatBtn">إرسال</button></div>`
        : chat.status==='closed' ? `<p class="muted" style="text-align:center;padding-top:8px;">هذه المحادثة مغلقة.</p>`
        : `<p class="muted" style="text-align:center;padding-top:8px;">بانتظار استلام أحد الخدام قبل أن تتمكن من الرد.</p>`}
    </div>
  </div>`;
}

/* ---------------- ADMIN ---------------- */
/* ---------------- YEARLY PROMOTION: everyone moves up one class, in the order the church admin sets ---------------- */
/* The admin arranges the classes from youngest to oldest (the list can cross stages: the last class of one stage is followed by the first
   class of the next, e.g. last primary class -> first preparatory class). Each class's members move to the class right after it. */
function orderedClassrooms(){
  const ord = c => typeof c.order === 'number' ? c.order : 1e9;
  return state.classrooms.map((c,i)=>({ c, i })).sort((a,b)=> (ord(a.c) - ord(b.c)) || (a.i - b.i)).map(x=>x.c);
}
function moveClassInOrder(id, dir){
  const list = orderedClassrooms(), i = list.findIndex(c=>c.id===id), j = i + dir;
  if(i < 0 || j < 0 || j >= list.length) return false;
  [list[i], list[j]] = [list[j], list[i]];
  list.forEach((c,k)=>{ c.order = k; });
  return true;
}
function stageNameOf(c){ return (c && c.stageId && stageOf(c.stageId)) ? stageOf(c.stageId).name : 'بدون مرحلة'; }
function promotionPlan(lastMode){
  const list = orderedClassrooms();
  const moves = [];       // [memberId, fromClass, fromStage, toClass, toStage]
  state.users.filter(x=>x.role==='makhdoum' && x.status==='approved' && x.classroomId).forEach(m=>{
    const i = list.findIndex(c=>c.id===m.classroomId); if(i < 0) return;
    if(i < list.length - 1) moves.push([m.id, m.classroomId, m.stageId || null, list[i+1].id, list[i+1].stageId || null]);
    else if(lastMode === 'graduate') moves.push([m.id, m.classroomId, m.stageId || null, null, null]);
  });
  return { list, moves };
}
function runPromotion(u, lastMode, announce){
  const { moves } = promotionPlan(lastMode);
  if(!moves.length){ showToast('لا يوجد أعضاء للترقية.'); return; }
  moves.forEach(([id,,, to, toStage])=>{ const m = state.users.find(x=>x.id===id); if(m){ m.classroomId = to; m.stageId = toStage; } });
  state.settings.lastPromotion = { at: nowISO(), by: u.name, moves };      // kept so it can be undone
  log(u.name, `نفّذ ترقية الفصول: نُقل ${moves.length} عضوًا إلى الفصل التالي.`);
  if(announce) state.news.push({ id:uid('news'), title:'🎓 ترقية الفصول للعام الجديد', content:'تمت ترقية كل مخدوم إلى الفصل التالي. افتح التطبيق لتعرف فصلك الجديد.', stageId:null, authorName:u.name, authorId:u.id, createdAt: nowISO() });
  persist(); showToast(`🎓 تمت ترقية ${moves.length} عضوًا`);
}
function undoPromotion(u){
  const lp = state.settings.lastPromotion; if(!lp) return;
  let n = 0;
  lp.moves.forEach(([id, from, fromStage, to])=>{
    const m = state.users.find(x=>x.id===id);
    if(m && (m.classroomId || null) === (to || null)){        // only if nobody moved this member again since
      const back = from && classroomOf(from) ? from : null;
      m.classroomId = back; m.stageId = back ? fromStage : null; n++;
    }
  });
  delete state.settings.lastPromotion;
  log(u.name, `تراجع عن آخر ترقية للفصول: أُعيد ${n} عضوًا إلى فصولهم السابقة.`);
  persist(); showToast(`↩︎ أُعيد ${n} عضوًا إلى فصولهم`);
}
function renderAdminPromote(u){
  const mode = ui.promoLast || 'stay', announce = ui.promoAnnounce !== false;
  const { list, moves } = promotionPlan(mode);
  if(list.length < 2) return `<div class="empty"><div class="big">🎓</div>أضف فصلين على الأقل من تبويب «الخدام والفصول» ثم رتّبهم هنا.</div>`;
  const rows = list.map((c,i)=>{
    const next = list[i+1], n = membersOfClassroom(c.id).length;
    const crosses = next && (next.stageId || null) !== (c.stageId || null);
    const dest = next ? `↳ ينتقلون إلى: <b>${escapeHtml(next.name)}</b>${crosses ? ` <span class="badge rounded-pill badge-gold">مرحلة ${escapeHtml(stageNameOf(next))}</span>` : ''}`
                      : (mode === 'graduate' ? '🎓 يتخرجون (يصبحون بدون فصل)' : '↳ يبقون في هذا الفصل (آخر فصل)');
    return `<div class="card px-3 py-2 mb-2">
      <div class="d-flex justify-content-between align-items-center gap-2">
        <div style="min-width:0;"><b>${i+1}. ${escapeHtml(c.name)}</b><div class="muted">${escapeHtml(stageNameOf(c))} · ${n} ${n===1?'عضو':'أعضاء'}</div></div>
        <div class="d-flex gap-1">
          <button class="btn btn-outline btn-sm" data-move-class="${c.id}" data-dir="-1" ${i===0?'disabled':''} aria-label="إلى الأعلى">▲</button>
          <button class="btn btn-outline btn-sm" data-move-class="${c.id}" data-dir="1" ${i===list.length-1?'disabled':''} aria-label="إلى الأسفل">▼</button>
        </div>
      </div>
      <div class="muted" style="margin-top:6px;">${dest}</div>
    </div>`;
  }).join('');
  const lp = state.settings.lastPromotion;
  return `
    <div class="card p-3 mb-3">
      <b>🎓 ترقية الفصول للعام الجديد</b>
      <div class="muted" style="margin-top:6px;">رتّب الفصول من <b>الأصغر (فوق)</b> إلى <b>الأكبر (تحت)</b> بالأسهم. عند الترقية ينتقل كل مخدوم إلى الفصل الذي يليه في هذا الترتيب، وآخر فصل في مرحلة ينتقل أعضاؤه إلى أول فصل في المرحلة التالية. الخدام يبقون في فصولهم.</div>
    </div>
    ${rows}
    <div class="card p-3 mb-3">
      <label class="form-label">أعضاء آخر فصل في الترتيب</label>
      <select class="form-select mb-3" id="promoLast">
        <option value="stay" ${mode==='stay'?'selected':''}>يبقون في فصلهم</option>
        <option value="graduate" ${mode==='graduate'?'selected':''}>يتخرجون (يصبحون بدون فصل)</option>
      </select>
      <label class="d-flex align-items-center gap-2 mb-3" style="cursor:pointer;"><input type="checkbox" id="promoAnnounce" ${announce?'checked':''} style="width:18px;height:18px;accent-color:var(--ink);"> <span>نشر إعلان للجميع بالترقية (يصل كإشعار)</span></label>
      <div class="muted mb-2">سيتم نقل <b>${moves.length}</b> ${moves.length===1?'عضو':'عضوًا'}.</div>
      <button class="btn btn-danger" id="promoRunBtn" ${moves.length?'':'disabled'}>🎓 تنفيذ الترقية الآن</button>
    </div>
    ${lp ? `<div class="card p-3 mb-3">
      <b>آخر ترقية</b>
      <div class="muted" style="margin:6px 0 10px;">${fmtDate(lp.at)} · بواسطة ${escapeHtml(lp.by)} · ${lp.moves.length} عضوًا</div>
      <button class="btn btn-outline" id="promoUndoBtn">↩︎ التراجع عن آخر ترقية</button>
    </div>` : ''}`;
}

function renderAdmin(u){
  const sub = ui.adminSub || 'pending';
  const isDirector = u.role==='senior_admin';
  const pendingUsers = state.users.filter(x=>{
    if(x.status!=='pending') return false;
    if(isDirector) return true;
    return x.stageId && stageOf(x.stageId) && stageOf(x.stageId).sectorId===u.sectorId;
  });
  return `
  <div class="screen tab-admin">
    ${heroHTML('admin', '🛡️', 'لوحة الإدارة', !isDirector ? escapeHtml(sectorOf(u.sectorId) ? sectorOf(u.sectorId).name : 'قطاعك') : 'إدارة الكنيسة', pendingUsers.length ? `<span class="hero-chip">⏳ ${pendingUsers.length}</span>` : '')}
    <div class="segmented">
      <button class="${sub==='pending'?'active':''}" data-adminsub="pending">طلبات الانتظار ${pendingUsers.length?('('+pendingUsers.length+')'):''}</button>
      <button class="${sub==='people'?'active':''}" data-adminsub="people">الخدام والفصول</button>
      ${isDirector ? `<button class="${sub==='promote'?'active':''}" data-adminsub="promote">🎓 الترقية</button>` : ''}
      ${isDirector ? `<button class="${sub==='emergency'?'active':''}" data-adminsub="emergency">كود الطوارئ</button>` : ''}
      <button class="${sub==='log'?'active':''}" data-adminsub="log">سجل النشاط</button>
    </div>
    ${sub==='pending' ? renderAdminPending(pendingUsers, u) : ''}
    ${sub==='people' ? renderAdminPeople(u) : ''}
    ${sub==='promote' && isDirector ? renderAdminPromote(u) : ''}
    ${sub==='emergency' && isDirector ? renderAdminEmergency() : ''}
    ${sub==='log' ? renderAdminLog() : ''}
  </div>`;
}
function renderAdminPending(list, u){
  if(list.length===0) return `<div class="empty"><div class="big">✅</div>لا توجد طلبات بانتظار المراجعة.</div>`;
  const isDirector = u.role==='senior_admin';
  const visibleStages = isDirector ? state.stages : stagesInSector(u.sectorId);
  const unstagedClassrooms = isDirector ? state.classrooms.filter(c=>!c.stageId) : [];
  return list.map(p=>`
    <div class="card p-3 mb-3"><b>${escapeHtml(p.name)}</b>
      <div class="muted" style="margin:4px 0;">${escapeHtml(p.email)} · ${escapeHtml(p.mobile)}</div>
      <div class="muted" style="margin-bottom:10px;">${escapeHtml(p.address)}${p.stageId && stageOf(p.stageId) ? ' · طلب مرحلة: '+escapeHtml(stageOf(p.stageId).name) : ''}</div>
      <div class="mb-3" style="margin-bottom:10px;">
        <label class="form-label">الفصل</label>
        <select class="form-select" data-pending-cls="${p.id}" style="width:100%;padding:9px 10px;border-radius:8px;border:1.5px solid var(--line);">
          <option value="">بدون فصل (يمكن تعيينه لاحقًا)</option>
          ${visibleStages.map(s=>`<optgroup label="${escapeHtml(s.name)}">
            ${classroomsInStage(s.id).map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
          </optgroup>`).join('')}
          ${unstagedClassrooms.length ? `<optgroup label="بدون مرحلة">${unstagedClassrooms.map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}</optgroup>` : ''}
        </select>
      </div>
      <div class="d-flex gap-2 equal-cols"><button class="btn btn-gold btn-sm" data-approve="${p.id}">✓ قبول</button><button class="btn btn-outline btn-sm" data-reject="${p.id}" style="color:var(--bad);border-color:var(--bad);">✗ رفض</button></div>
    </div>`).join('');
}
function renderAdminPeople(u){
  const isDirector = u.role==='senior_admin';
  const mySectorId = u.role==='super_admin' ? u.sectorId : null;
  const visibleStages = isDirector ? state.stages : stagesInSector(mySectorId);
  const visibleStageIds = visibleStages.map(s=>s.id);
  const visibleClassrooms = isDirector ? state.classrooms : state.classrooms.filter(c=>visibleStageIds.includes(c.stageId));
  const relevantToMe = (x)=>{
    if(isDirector) return true;
    if(x.classroomId && visibleClassrooms.some(c=>c.id===x.classroomId)) return true;
    if(x.stageId && visibleStageIds.includes(x.stageId)) return true;
    if(x.role==='khadim' && state.classrooms.some(c=>visibleStageIds.includes(c.stageId) && c.servantIds.includes(x.id))) return true;
    return false;
  };
  const khadimAll = state.users.filter(x=>x.role==='khadim' && x.status==='approved');
  const khadim = khadimAll.filter(relevantToMe);
  const superAdmins = state.users.filter(x=>x.role==='super_admin' && x.status==='approved');
  const seniors = state.users.filter(x=>x.role==='senior_admin' && x.status==='approved');
  const makhdoumeen = state.users.filter(x=>x.role==='makhdoum' && x.status==='approved').filter(relevantToMe);
  const banned = state.users.filter(x=>x.status==='banned').filter(relevantToMe);
  const dangerButtons = (p)=> p.id===u.id ? `<span class="muted">(حسابك)</span>` : `
    <button class="btn-ghost" data-ban-user="${p.id}" style="color:var(--bad);">حظر</button>
    <button class="btn-ghost" data-delete-user="${p.id}" style="color:var(--bad);">حذف نهائي</button>`;
  const passwordResetBlock = (p)=> `
    <div style="margin-top:8px;">
      ${ui.resetPwFor===p.id ? `
        <div class="d-flex gap-2 equal-cols" style="gap:6px;">
          <input class="form-control" type="text" id="newPwInput_${p.id}" placeholder="كلمة مرور جديدة" style="flex:2;padding:8px 10px;border-radius:8px;border:1.5px solid var(--line);">
          <button class="btn btn-teal btn-sm" data-save-pw="${p.id}" style="flex:1;">حفظ</button>
          <button class="btn-ghost" data-cancel-pw="${p.id}">إلغاء</button>
        </div>` : `<button class="btn-ghost" data-reset-pw="${p.id}">🔑 تغيير كلمة المرور</button>`}
    </div>`;
  return `
  ${isDirector ? `
  <h3 style="font-size:13.5px;color:var(--text-soft);margin:4px 0 8px;">القطاعات</h3>
  <div class="card px-3 py-2 mb-3 d-flex flex-row gap-2 equal-cols" style="align-items:center;">
    <input class="form-control" type="text" id="newSectorName" placeholder="اسم القطاع الجديد" style="flex:2;padding:9px 10px;border-radius:8px;border:1.5px solid var(--line);">
    <button class="btn btn-gold btn-sm" id="addSectorBtn" style="flex:1;">إضافة</button>
  </div>
  ${state.sectors.map(sec=>`
    <div class="card px-3 py-2 mb-3">
      <div class="d-flex gap-2 equal-cols" style="align-items:center;gap:8px;">
        <input class="form-control" type="text" data-sector-name="${sec.id}" value="${escapeHtml(sec.name)}" style="flex:2;padding:8px 10px;border-radius:8px;border:1.5px solid var(--line);font-weight:700;">
        <button class="btn btn-teal btn-sm" data-save-sector-name="${sec.id}" style="flex:0;">حفظ</button>
        <button class="btn-ghost" data-del-sector="${sec.id}" style="color:var(--bad);">حذف</button>
      </div>
      <div class="muted" style="margin-top:6px;">عدد المراحل: ${stagesInSector(sec.id).length}</div>
    </div>`).join('')}
  ` : ''}
  <h3 style="font-size:13.5px;color:var(--text-soft);margin:18px 0 8px;">المراحل العمرية</h3>
  <div class="card px-3 py-2 mb-3">
    <input class="form-control" type="text" id="newStageName" placeholder="اسم المرحلة الجديدة" style="width:100%;padding:9px 10px;border-radius:8px;border:1.5px solid var(--line);margin-bottom:8px;">
    ${isDirector ? `<select class="form-select" id="newStageSector" style="width:100%;padding:9px 10px;border-radius:8px;border:1.5px solid var(--line);margin-bottom:8px;">
      <option value="">بدون قطاع</option>
      ${state.sectors.map(sec=>`<option value="${sec.id}">${escapeHtml(sec.name)}</option>`).join('')}
    </select>` : ''}
    <button class="btn btn-gold btn-sm" id="addStageBtn" style="width:100%;">إضافة</button>
  </div>
  ${visibleStages.map(s=>`
    <div class="card px-3 py-2 mb-3">
      <div class="d-flex gap-2 equal-cols" style="align-items:center;gap:8px;">
        <input class="form-control" type="text" data-stage-name="${s.id}" value="${escapeHtml(s.name)}" style="flex:2;padding:8px 10px;border-radius:8px;border:1.5px solid var(--line);font-weight:700;">
        <button class="btn btn-teal btn-sm" data-save-stage-name="${s.id}" style="flex:0;">حفظ</button>
        <button class="btn-ghost" data-del-stage="${s.id}" style="color:var(--bad);">حذف</button>
      </div>
      ${isDirector ? `<div class="mb-3" style="margin-top:8px;"><label class="form-label">القطاع</label>
        <select class="form-select" data-stage-sector="${s.id}" style="width:100%;padding:8px 10px;border-radius:8px;border:1.5px solid var(--line);">
          <option value="">بدون قطاع</option>
          ${state.sectors.map(sec=>`<option value="${sec.id}" ${s.sectorId===sec.id?'selected':''}>${escapeHtml(sec.name)}</option>`).join('')}
        </select>
      </div>` : ''}
      <div class="muted" style="margin-top:6px;">عدد الفصول: ${classroomsInStage(s.id).length}</div>
    </div>`).join('')}
  <h3 style="font-size:13.5px;color:var(--text-soft);margin:18px 0 8px;">إضافة فصل جديد</h3>
  <div class="card px-3 py-2 mb-3">
    <input class="form-control" type="text" id="newClassName" placeholder="اسم الفصل الجديد" style="width:100%;padding:9px 10px;border-radius:8px;border:1.5px solid var(--line);margin-bottom:8px;">
    <select class="form-select" id="newClassStage" style="width:100%;padding:9px 10px;border-radius:8px;border:1.5px solid var(--line);margin-bottom:8px;">
      <option value="">بدون مرحلة</option>
      ${visibleStages.map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}
    </select>
    <button class="btn btn-gold btn-sm" id="addClassroomBtn" style="width:100%;">إضافة الفصل</button>
  </div>
  <h3 style="font-size:13.5px;color:var(--text-soft);margin:18px 0 8px;">الفصول وتعيين الخدام (يمكن اختيار أكثر من خادم)</h3>
  ${visibleClassrooms.map(c=>`
    <div class="card p-3 mb-3">
      <div class="d-flex gap-2 equal-cols" style="align-items:center;gap:8px;">
        <input class="form-control" type="text" data-cls-name="${c.id}" value="${escapeHtml(c.name)}" style="flex:2;padding:9px 10px;border-radius:8px;border:1.5px solid var(--line);font-weight:700;">
        <button class="btn btn-teal btn-sm" data-save-cls-name="${c.id}" style="flex:0;">حفظ الاسم</button>
      </div>
      <div class="mb-3" style="margin-top:8px;">
        <label class="form-label">المرحلة</label>
        <select class="form-select" data-cls-stage="${c.id}" style="width:100%;padding:9px 10px;border-radius:8px;border:1.5px solid var(--line);">
          <option value="">بدون مرحلة</option>
          ${visibleStages.map(s=>`<option value="${s.id}" ${c.stageId===s.id?'selected':''}>${escapeHtml(s.name)}</option>`).join('')}
        </select>
      </div>
      <div class="d-flex justify-content-end" style="margin-top:8px;">
        <button class="btn-ghost" data-del-cls="${c.id}" style="color:var(--bad);">حذف الفصل</button>
      </div>
      <div class="checklist" style="margin-top:10px;">
        ${khadimAll.length===0 ? `<span class="muted">لا يوجد خدام معتمدون بعد.</span>` :
          khadimAll.map(k=>`<label><input type="checkbox" data-cls-servant="${c.id}|${k.id}" ${c.servantIds.includes(k.id)?'checked':''}> ${escapeHtml(k.name)}</label>`).join('')}
      </div>
      <div class="muted" style="margin-top:8px;">عدد الأعضاء: ${membersOfClassroom(c.id).length}</div>
    </div>`).join('')}
  ${isDirector ? `
  <h3 style="font-size:13.5px;color:var(--text-soft);margin:18px 0 8px;">مديرو الكنيسة (${seniors.length})</h3>
  ${seniors.map(s=>`
    <div class="card px-3 py-2 mb-3">
      <div class="d-flex justify-content-between align-items-center"><span>${escapeHtml(s.name)}</span><span class="badge rounded-pill badge-gold">مدير الكنيسة</span></div>
      <div class="d-flex gap-2 equal-cols" style="gap:6px;margin-top:8px;justify-content:flex-end;">
        ${s.id===u.id ? '' : `<button class="btn-ghost" data-demoteadmin="${s.id}">تخفيض لخادم</button>`}
        ${dangerButtons(s)}
      </div>
    </div>`).join('')}
  <h3 style="font-size:13.5px;color:var(--text-soft);margin:18px 0 8px;">السوبر أدمن (${superAdmins.length})</h3>
  ${superAdmins.length===0 ? `<p class="muted">لا يوجد سوبر أدمن بعد.</p>` : superAdmins.map(s=>`
    <div class="card px-3 py-2 mb-3">
      <div class="d-flex justify-content-between align-items-center"><span>${escapeHtml(s.name)}</span><span class="badge rounded-pill badge-gold">سوبر أدمن${s.sectorId && sectorOf(s.sectorId) ? ' — '+escapeHtml(sectorOf(s.sectorId).name) : ''}</span></div>
      <div class="mb-3" style="margin-top:8px;"><label class="form-label">القطاع</label>
        <select class="form-select" data-change-sector="${s.id}" style="width:100%;padding:8px 10px;border-radius:8px;border:1.5px solid var(--line);">
          <option value="">بدون قطاع</option>
          ${state.sectors.map(sec=>`<option value="${sec.id}" ${s.sectorId===sec.id?'selected':''}>${escapeHtml(sec.name)}</option>`).join('')}
        </select>
      </div>
      <div class="d-flex gap-2 equal-cols" style="gap:6px;margin-top:8px;justify-content:flex-end;">
        <button class="btn-ghost" data-demote-super="${s.id}">تخفيض لخادم</button>
        ${dangerButtons(s)}
      </div>
      ${passwordResetBlock(s)}
    </div>`).join('')}
  ` : ''}
  <h3 style="font-size:13.5px;color:var(--text-soft);margin:18px 0 8px;">الخدام (${khadim.length})</h3>
  ${khadim.map(k=>{
    const servedClasses = state.classrooms.filter(c=>c.servantIds.includes(k.id));
    return `
    <div class="card px-3 py-2 mb-3">
      <div class="d-flex justify-content-between align-items-center"><span>${escapeHtml(k.name)}</span>${isDirector ? `<button class="btn-ghost" data-promote="${k.id}">ترقية لمدير الكنيسة</button>` : ''}</div>
      <div class="muted" style="margin-top:6px;">${servedClasses.length ? 'يخدم في: ' + servedClasses.map(c=>`${escapeHtml(c.name)}${c.stageId && stageOf(c.stageId) ? ' ('+escapeHtml(stageOf(c.stageId).name)+')' : ''}`).join('، ') : 'لا يخدم في أي فصل حاليًا.'}</div>
      ${isDirector && state.sectors.length ? `
      <div class="d-flex gap-2 equal-cols" style="gap:6px;margin-top:8px;align-items:center;">
        <select class="form-select" data-superadmin-sector="${k.id}" style="flex:2;padding:7px 8px;border-radius:8px;border:1.5px solid var(--line);font-size:12.5px;">
          ${state.sectors.map(sec=>`<option value="${sec.id}">${escapeHtml(sec.name)}</option>`).join('')}
        </select>
        <button class="btn-ghost" data-promote-super="${k.id}" style="flex:1;">ترقية لسوبر أدمن</button>
      </div>` : ''}
      <div class="d-flex gap-2 equal-cols" style="gap:6px;margin-top:8px;justify-content:flex-end;">
        <button class="btn-ghost" data-demote="${k.id}">تخفيض لمخدوم</button>
        ${dangerButtons(k)}
      </div>
      ${passwordResetBlock(k)}
    </div>`;}).join('')}
  <h3 style="font-size:13.5px;color:var(--text-soft);margin:18px 0 8px;">المخدومين (${makhdoumeen.length})</h3>
  ${makhdoumeen.map(m=>`
    <div class="card px-3 py-2 mb-3">
      <div class="d-flex justify-content-between align-items-center"><span>${escapeHtml(m.name)}</span><button class="btn-ghost" data-promotekh="${m.id}">ترقية لخادم</button></div>
      <div class="mb-3" style="margin-top:8px;">
        <label class="form-label">الفصل</label>
        <select class="form-select" data-assign-cls="${m.id}" style="width:100%;padding:9px 10px;border-radius:8px;border:1.5px solid var(--line);">
          <option value="">بدون فصل</option>
          ${visibleStages.map(s=>`<optgroup label="${escapeHtml(s.name)}">
            ${classroomsInStage(s.id).map(c=>`<option value="${c.id}" ${m.classroomId===c.id?'selected':''}>${escapeHtml(c.name)}</option>`).join('')}
          </optgroup>`).join('')}
          ${isDirector && state.classrooms.filter(c=>!c.stageId).length ? `<optgroup label="بدون مرحلة">${state.classrooms.filter(c=>!c.stageId).map(c=>`<option value="${c.id}" ${m.classroomId===c.id?'selected':''}>${escapeHtml(c.name)}</option>`).join('')}</optgroup>` : ''}
        </select>
      </div>
      <div class="d-flex gap-2 equal-cols" style="gap:6px;margin-top:8px;justify-content:flex-end;">${dangerButtons(m)}</div>
      ${passwordResetBlock(m)}
    </div>`).join('')}
  <h3 style="font-size:13.5px;color:var(--text-soft);margin:18px 0 8px;">الحسابات المحظورة (${banned.length})</h3>
  ${banned.length===0 ? `<p class="muted">لا توجد حسابات محظورة حاليًا.</p>` :
    banned.map(b=>`
    <div class="card px-3 py-2 mb-3">
      <div class="d-flex justify-content-between align-items-center"><span>${escapeHtml(b.name)}</span><span class="badge rounded-pill badge-bad">محظور</span></div>
      <div class="muted" style="margin:4px 0;">${escapeHtml(b.email)} · ${roleLabel(b.role)}</div>
      <div class="d-flex gap-2 equal-cols" style="gap:6px;margin-top:6px;">
        <button class="btn btn-teal btn-sm" data-unban-user="${b.id}">إلغاء الحظر</button>
        <button class="btn btn-outline btn-sm" data-delete-user="${b.id}" style="color:var(--bad);border-color:var(--bad);">حذف نهائي</button>
      </div>
    </div>`).join('')}
  `;
}
function renderAdminEmergency(){
  const cred = getEmergencyCredential();
  const remaining = cred.nextRefresh - Date.now();
  const mm = Math.floor(remaining/60000), ss = Math.floor((remaining%60000)/1000);
  return `
  <div class="card p-3 mb-3">
    <div class="muted" style="margin-bottom:8px;">كود الوصول الطارئ الحالي (يتغيّر تلقائيًا كل ساعة)</div>
    <div class="d-flex" style="gap:10px;">
      <div class="text-center" style="flex:1;background:var(--parchment-2);border-radius:10px;padding:12px;"><div style="font-size:11px;color:var(--text-soft);">الكود</div><div style="font-size:20px;font-weight:800;letter-spacing:3px;color:var(--heading);">${cred.code}</div></div>
      <div class="text-center" style="flex:1;background:var(--parchment-2);border-radius:10px;padding:12px;"><div style="font-size:11px;color:var(--text-soft);">كلمة المرور</div><div style="font-size:20px;font-weight:800;letter-spacing:3px;color:var(--heading);">${cred.pass}</div></div>
    </div>
    <p class="muted" style="text-align:center;margin-top:10px;">يتغير الكود خلال ${mm} د ${ss} ث. يمنح صلاحيات مدير الكنيسة لمدة ٢٤ ساعة ثم يعود المستخدم تلقائيًا لدوره الأصلي.</p>
  </div>
  ${state.emergency.active ? `<div class="card px-3 py-2 mb-3" style="border-color:var(--oxblood);">
    <b style="color:var(--oxblood);">وضع طارئ نشط حاليًا</b>
    <div class="muted">بواسطة: ${escapeHtml((state.users.find(x=>x.id===state.emergency.byUserId)||{}).name || '—')}</div>
    <button class="btn btn-outline btn-sm" style="margin-top:8px;color:var(--bad);border-color:var(--bad);" id="forceEndEmergency">إنهاء الوصول الطارئ الآن</button>
  </div>` : ''}
  <h3 style="font-size:13.5px;color:var(--text-soft);margin:16px 0 8px;">سجل استخدام كود الطوارئ</h3>
  ${state.emergency.log.length===0 ? `<p class="muted">لم يُستخدم كود الطوارئ بعد.</p>` :
    state.emergency.log.map(e=>`<div class="card px-3 py-2 mb-3"><b>${escapeHtml(e.who)}</b><div class="muted">${new Date(e.time).toLocaleString('ar-EG')}</div></div>`).join('')}`;
}
function renderAdminLog(){
  return state.auditLog.map(l=>`<div class="card px-3 py-2 mb-3"><div class="d-flex justify-content-between"><b style="font-size:13px;">${escapeHtml(l.actor)}</b><span class="muted">${new Date(l.time).toLocaleString('ar-EG')}</span></div><div style="font-size:13px;margin-top:3px;">${escapeHtml(l.action)}</div></div>`).join('');
}

/* ---------------- SCANNER ---------------- */
function renderScanOverlay(){
  return `<div class="scan-overlay">
    <div class="scan-top"><span class="scan-count" id="scanCount">0 ✓</span><button id="closeScanBtn" aria-label="إغلاق">✕</button></div>
    <video id="scanVideo" playsinline muted autoplay></video>
    <div class="scan-frame"></div>
    <div class="scan-status" id="scanStatus">وجّه الكاميرا نحو رمز QR الخاص بالعضو</div>
  </div>`;
}
/* The scanner stays open so you can scan a whole class one after the other; press ✕ when you are done.
   While it is open nothing redraws the screen, so the camera never restarts or flickers. */
let scanStream = null, scanRAF = null, scanBusy = false, scanLast = { code:null, t:0 }, scanCount = 0, scanMsgTimer = null;
const SCAN_PROMPT = 'وجّه الكاميرا نحو رمز QR الخاص بالعضو';
function setScanStatus(text, state){
  const st = document.getElementById('scanStatus'); if(st) st.textContent = text;
  const fr = document.querySelector('.scan-frame'); if(fr){ fr.classList.toggle('ok', state==='ok'); fr.classList.toggle('bad', state==='bad'); }
}
function scanFeedback(ok, text){
  if(navigator.vibrate){ try{ navigator.vibrate(ok ? 80 : [60,40,60]); }catch(e){} }
  setScanStatus(text, ok ? 'ok' : 'bad');
  const c = document.getElementById('scanCount'); if(c) c.textContent = scanCount + ' ✓';
  clearTimeout(scanMsgTimer);
  scanMsgTimer = setTimeout(()=>setScanStatus(scanCount ? 'جاهز للعضو التالي — اضغط ✕ عند الانتهاء' : SCAN_PROMPT, null), 1800);
}
function startScanner(){
  const video = document.getElementById('scanVideo');
  if(!video || video.dataset.started) return;
  video.dataset.started = '1';
  if(scanStream){ video.srcObject = scanStream; video.play().catch(()=>{}); return; }   // the screen was redrawn: just re-attach the running camera
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){ setScanStatus('الكاميرا غير متاحة في هذا المتصفح.', 'bad'); return; }
  navigator.mediaDevices.getUserMedia({ video:{ facingMode:{ ideal:'environment' }, width:{ ideal:1280 }, height:{ ideal:720 } }, audio:false }).then(stream=>{
    if(!ui.scanning){ stream.getTracks().forEach(t=>t.stop()); return; }       // it was closed before the camera finished opening
    scanStream = stream;
    const v = document.getElementById('scanVideo'); if(v){ v.srcObject = stream; v.play().catch(()=>{}); }
    let detector = null;
    try{ if('BarcodeDetector' in window) detector = new BarcodeDetector({ formats:['qr_code'] }); }catch(e){ detector = null; }   // the phone's own fast QR reader
    const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d', { willReadFrequently:true });
    let last = 0;
    const tick = async (now)=>{
      if(!ui.scanning) return;
      scanRAF = requestAnimationFrame(tick);
      const vid = document.getElementById('scanVideo');
      if(!vid || vid.readyState < 2 || scanBusy || now - last < 140) return;   // look about 7 times a second, not 60
      last = now; scanBusy = true;
      try{
        let value = null;
        if(detector){ const r = await detector.detect(vid); if(r && r[0]) value = r[0].rawValue; }
        else if(window.jsQR && vid.videoWidth){
          const k = Math.min(1, 480 / Math.max(vid.videoWidth, vid.videoHeight));   // shrink the picture: 4x faster, still reads fine
          canvas.width = Math.round(vid.videoWidth*k); canvas.height = Math.round(vid.videoHeight*k);
          ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const c = window.jsQR(img.data, img.width, img.height, { inversionAttempts:'dontInvert' });
          if(c && c.data) value = c.data;
        }
        if(value) handleScanResult(value);
      }catch(e){ /* a bad frame: just try the next one */ }
      finally{ scanBusy = false; }
    };
    scanRAF = requestAnimationFrame(tick);
  }).catch(()=>{ setScanStatus('تعذّر الوصول إلى الكاميرا. تأكد من إذن الكاميرا.', 'bad'); });
}
function stopScanner(){
  ui.scanning = false;
  if(scanRAF) cancelAnimationFrame(scanRAF); scanRAF = null;
  clearTimeout(scanMsgTimer);
  if(scanStream){ scanStream.getTracks().forEach(t=>t.stop()); scanStream = null; }
  scanBusy = false;
}
function handleScanResult(data){
  const now = Date.now();
  if(data === scanLast.code && now - scanLast.t < 3000) return;     // same card still in front of the camera
  scanLast = { code:data, t:now };
  const u = currentUser();
  const match = /^khidma-member:(.+)$/.exec(String(data).trim());
  const member = match ? state.users.find(x=>x.id===match[1] && x.role==='makhdoum') : null;
  if(!member){ scanFeedback(false, 'رمز غير صالح'); return; }
  const cls = classroomOf(ui.adminAttClassroom);
  if(!cls || member.classroomId !== cls.id){ scanFeedback(false, member.name + ' ليس ضمن الفصل الحالي'); return; }
  const date = todayStr();
  let rec = state.attendance.find(a=>a.memberId===member.id && a.date===date);
  if(!rec){ rec = { id:uid('att'), memberId:member.id, classroomId:cls.id, date, quddas:false, ijtimaa:false, markedBy:u.id }; state.attendance.push(rec); }
  const already = !!rec.quddas;
  if(!already){ rec.quddas = true; awardPoints(member, state.settings.pointsQuddas, 'حضور القداس (مسح)', u.name); log(u.name, `سجّل حضور ${member.name} عبر المسح الضوئي.`); }
  rec.markedBy = u.id;
  persist();
  if(!already) scanCount++;
  scanFeedback(true, already ? member.name + ' مسجَّل مسبقًا ✓' : 'تم تسجيل حضور ' + member.name + ' ✓');
}

/* =========================================================================
   EVENT BINDING for app shell
   ========================================================================= */
function bindAppEvents(u){
  document.querySelectorAll('.tab').forEach(b=>{ b.onclick = ()=>{ ui.activeTab = b.dataset.tab; ui.openChatId=null; render(); }; });
  const settingsLogoutBtn = document.getElementById('settingsLogoutBtn');
  if(settingsLogoutBtn) settingsLogoutBtn.onclick = ()=>{ askConfirm('تسجيل الخروج؟', ()=>{ state.session.userId=null; persist(); render(); }); };
  const settingsDeleteBtn = document.getElementById('settingsDeleteBtn');
  if(settingsDeleteBtn) settingsDeleteBtn.onclick = ()=>{
    if(u.role==='senior_admin' && state.users.filter(x=>x.role==='senior_admin'&&x.status==='approved').length<=1){
      showToast('لا يمكنك حذف حسابك بصفتك مدير الكنيسة الوحيد المتبقي.'); return;
    }
    askConfirm('حذف حسابك نهائيًا؟ لا يمكن التراجع عن هذا الإجراء، وستُسجَّل خروجك فورًا.', ()=>{
      state.classrooms.forEach(c=>{ c.servantIds = c.servantIds.filter(id=>id!==u.id); });
      state.users = state.users.filter(x=>x.id!==u.id);
      log(u.name, 'حذف حسابه الخاص نهائيًا.');
      state.session.userId = null;
      persist(); render();
    });
  };
  const saveProfileBtn = document.getElementById('saveProfileBtn');
  if(saveProfileBtn) saveProfileBtn.onclick = ()=>{
    const name = document.getElementById('set_name').value.trim();
    const email = document.getElementById('set_email').value.trim().toLowerCase();
    const mobile = document.getElementById('set_mobile').value.trim();
    const address = document.getElementById('set_address').value.trim();
    const normMobile = mobile.replace(/\D/g,'');
    const err = document.getElementById('settingsProfileError');
    if(!name || !email || !mobile || !address){ err.textContent='يرجى تعبئة كل الحقول.'; err.style.display='block'; return; }
    if(state.users.some(x=>x.id!==u.id && x.email.toLowerCase()===email)){ err.textContent='هذا البريد الإلكتروني مستخدم بحساب آخر.'; err.style.display='block'; return; }
    if(normMobile && state.users.some(x=>x.id!==u.id && x.mobile.replace(/\D/g,'')===normMobile)){ err.textContent='رقم الموبايل هذا مسجّل بحساب آخر.'; err.style.display='block'; return; }
    err.style.display='none';
    u.name=name; u.email=email; u.mobile=mobile; u.address=address;
    log(u.name, 'حدّث بياناته الشخصية.'); persist(); showToast('تم حفظ التعديلات.'); render();
  };
  const changePasswordBtn = document.getElementById('changePasswordBtn');
  if(changePasswordBtn) changePasswordBtn.onclick = ()=>{
    const current = document.getElementById('set_pass_current').value;
    const next = document.getElementById('set_pass_new').value;
    const err = document.getElementById('settingsPassError');
    if(current !== u.password){ err.textContent='كلمة المرور الحالية غير صحيحة.'; err.style.display='block'; return; }
    if(!next || next.length<4){ err.textContent='كلمة المرور الجديدة يجب أن تكون ٤ أحرف على الأقل.'; err.style.display='block'; return; }
    err.style.display='none';
    u.password = next;
    log(u.name, 'غيّر كلمة المرور الخاصة به.'); persist(); showToast('تم تحديث كلمة المرور.'); render();
  };
  const confirmYes = document.getElementById('confirmYes');
  if(confirmYes) confirmYes.onclick = ()=>{ const action = ui.confirm && ui.confirm.onYes; ui.confirm = null; if(action) action(); else render(); };
  const confirmNo = document.getElementById('confirmNo');
  if(confirmNo) confirmNo.onclick = ()=>{ ui.confirm = null; render(); };
  const endEm = document.getElementById('endEmergencyNow');
  if(endEm) endEm.onclick = ()=>{ revertEmergency('تم إنهاء الوصول الطارئ يدويًا.'); persist(); render(); };

  // QR code render for member "mine" tab
  const qrHolder = document.getElementById('qrHolder');
  if(qrHolder){
    qrHolder.innerHTML = generateQRSvg('khidma-member:'+u.id);
  }

  // NEWS
  const postNewsBtn = document.getElementById('postNewsBtn');
  if(postNewsBtn) postNewsBtn.onclick = ()=>{
    const title = document.getElementById('news_title').value.trim();
    const body = document.getElementById('news_body').value.trim();
    const stageSel = document.getElementById('news_stage');
    const stageId = stageSel && stageSel.value ? stageSel.value : null;
    if(!title || !body){ showToast('يرجى إدخال العنوان والتفاصيل.'); return; }
    state.news.push({ id:uid('news'), title, content:body, stageId, authorName:u.name, authorId:u.id, createdAt: nowISO() });
    const stage = stageId ? stageOf(stageId) : null;
    log(u.name, stage ? `نشر إعلانًا لمرحلة "${stage.name}": "${title}"` : `نشر إعلانًا: "${title}"`); persist(); showToast('تم نشر الإعلان 🔔 وسيصل للجميع كإشعار');
  };
  document.querySelectorAll('[data-del-news]').forEach(b=>{ b.onclick = ()=>{ state.news = state.news.filter(n=>n.id!==b.dataset.delNews); log(u.name,'حذف إعلانًا.'); persist(); render(); }; });

  // MINISTRY sub nav
  document.querySelectorAll('[data-ministry]').forEach(b=>{ b.onclick = ()=>{ ui.ministrySub = b.dataset.ministry; render(); }; });
  bindExamEvents(u);
  bindTodayEvents(u);

  // ATTENDANCE
  document.querySelectorAll('[data-cls]').forEach(b=>{ b.onclick = ()=>{ ui.adminAttClassroom = b.dataset.cls; render(); }; });
  document.querySelectorAll('[data-att]').forEach(b=>{
    b.onclick = ()=>{
      const memberId = b.dataset.att, field = b.dataset.field, date = todayStr();
      let rec = state.attendance.find(a=>a.memberId===memberId && a.date===date);
      if(!rec){ rec = { id:uid('att'), memberId, classroomId: ui.adminAttClassroom, date, quddas:false, ijtimaa:false, markedBy:u.id }; state.attendance.push(rec); }
      const wasOn = rec[field];
      rec[field] = !rec[field]; rec.markedBy = u.id;
      const m = state.users.find(x=>x.id===memberId);
      const ptsVal = field==='quddas' ? state.settings.pointsQuddas : state.settings.pointsIjtimaa;
      if(m){ awardPoints(m, wasOn ? -ptsVal : ptsVal, (field==='quddas'?'حضور القداس':'حضور الاجتماع'), u.name); }
      log(u.name, `سجّل حضور ${m?m.name:''} (${field==='quddas'?'القداس':'الاجتماع'}: ${rec[field]?'حاضر':'غير حاضر'})`);
      persist(); render();
    };
  });
  const openScanBtn = document.getElementById('openScanBtn');
  if(openScanBtn) openScanBtn.onclick = ()=>{ scanCount = 0; scanLast = { code:null, t:0 }; ui.scanning = true; render(); };
  const closeScanBtn = document.getElementById('closeScanBtn');
  if(closeScanBtn) closeScanBtn.onclick = ()=>{ stopScanner(); render(); };

  // ASSIGNMENTS
  const addAsgBtn = document.getElementById('addAssignmentBtn');
  if(addAsgBtn) addAsgBtn.onclick = async ()=>{
    const title = document.getElementById('asg_title').value.trim();
    if(!title){ showToast('أدخل عنوان التكليف.'); return; }
    const points = parseInt(document.getElementById('asg_points').value,10) || 0;
    const clsId = document.getElementById('asg_cls').value || null;
    const desc = document.getElementById('asg_desc').value.trim();
    const pinned = document.getElementById('asg_pinned').checked;
    const file = document.getElementById('asg_file').files[0] || null;
    const bad = validatePdf(file); if(bad){ showToast(bad); return; }
    let fileInfo = null;
    if(file){
      addAsgBtn.disabled = true; addAsgBtn.textContent = 'جاري رفع الملف...';
      try{ fileInfo = await uploadAssignmentPdf(file); }
      catch(e){ showToast(e.message); addAsgBtn.disabled = false; addAsgBtn.textContent = 'إضافة التكليف'; return; }
    }
    state.assignments.push({ id:uid('asg'), title, description: desc, points, classroomId: clsId, createdBy:u.id, createdAt: nowISO(), completions:{}, pinned, file: fileInfo });
    log(u.name, `أضاف تكليفًا جديدًا: "${title}"`); persist(); render();
  };
  document.querySelectorAll('[data-pin-asg]').forEach(b=>{ b.onclick = ()=>{ const a = state.assignments.find(x=>x.id===b.dataset.pinAsg); a.pinned = !a.pinned; log(u.name, `${a.pinned?'ثبّت':'ألغى تثبيت'} تكليف "${a.title}".`); persist(); render(); }; });
  document.querySelectorAll('[data-attach-input]').forEach(inp=>{
    inp.onchange = async ()=>{
      const a = state.assignments.find(x=>x.id===inp.dataset.attachInput);
      const file = inp.files[0]; const bad = validatePdf(file); if(bad){ showToast(bad); return; }
      showToast('جاري رفع الملف...');
      try{ const info = await uploadAssignmentPdf(file); await deleteAssignmentPdf(a.file); a.file = info; }
      catch(e){ showToast(e.message); return; }
      log(u.name, `أرفق ملف PDF بتكليف "${a.title}".`); persist(); render();
    };
  });
  document.querySelectorAll('[data-remove-file]').forEach(b=>{
    b.onclick = ()=>{ const a = state.assignments.find(x=>x.id===b.dataset.removeFile);
      askConfirm('إزالة ملف الـPDF من هذا التكليف؟', async ()=>{ await deleteAssignmentPdf(a.file); a.file = null; log(u.name, `أزال ملف PDF من تكليف "${a.title}".`); persist(); render(); }); };
  });
  document.querySelectorAll('[data-del-asg]').forEach(b=>{ b.onclick = ()=>{ const a = state.assignments.find(x=>x.id===b.dataset.delAsg); if(a) deleteAssignmentPdf(a.file); state.assignments = state.assignments.filter(x=>x.id!==b.dataset.delAsg); log(u.name,'حذف تكليفًا.'); persist(); render(); }; });
  document.querySelectorAll('[data-asg-points]').forEach(inp=>{
    inp.onchange = ()=>{ const a = state.assignments.find(x=>x.id===inp.dataset.asgPoints); a.points = parseInt(inp.value,10)||0; log(u.name, `غيّر قيمة نقاط "${a.title}" إلى ${a.points}.`); persist(); render(); };
  });
  document.querySelectorAll('[data-asg-check]').forEach(chk=>{
    chk.onchange = ()=>{
      const [asgId, memberId] = chk.dataset.asgCheck.split('|');
      const a = state.assignments.find(x=>x.id===asgId); const m = state.users.find(x=>x.id===memberId);
      if(chk.checked){ a.completions[memberId] = nowISO(); awardPoints(m, a.points, `إنجاز تكليف: ${a.title}`, u.name); log(u.name, `اعتمد إنجاز ${m.name} لتكليف "${a.title}" (+${a.points} نقطة).`); }
      else { delete a.completions[memberId]; awardPoints(m, -a.points, `إلغاء تكليف: ${a.title}`, u.name); log(u.name, `ألغى إنجاز ${m.name} لتكليف "${a.title}".`); }
      persist(); render();
    };
  });

  // POINTS
  const savePtsSettings = document.getElementById('savePointsSettings');
  if(savePtsSettings) savePtsSettings.onclick = ()=>{
    state.settings.pointsQuddas = parseInt(document.getElementById('pts_quddas').value,10)||0;
    state.settings.pointsIjtimaa = parseInt(document.getElementById('pts_ijtimaa').value,10)||0;
    log(u.name, 'عدّل قيم نقاط الحضور الافتراضية.'); persist(); showToast('تم حفظ الإعدادات.'); render();
  };
  document.querySelectorAll('[data-pts-adj]').forEach(b=>{
    b.onclick = ()=>{
      const [memberId, delta] = b.dataset.ptsAdj.split('|');
      const m = state.users.find(x=>x.id===memberId);
      awardPoints(m, parseInt(delta,10), 'تعديل يدوي', u.name);
      log(u.name, `عدّل نقاط ${m.name} (${delta>0?'+':''}${delta}).`);
      persist(); render();
    };
  });

  // CHAT
  const newChatBtn = document.getElementById('newChatBtn');
  if(newChatBtn) newChatBtn.onclick = ()=>{ const chat = { id:uid('chat'), memberId:u.id, memberName:u.name, status:'unclaimed', claimedById:null, claimedByName:null, messages:[], createdAt: nowISO() }; state.chats.push(chat); ui.openChatId = chat.id; persist(); render(); };
  document.querySelectorAll('[data-claim]').forEach(b=>{ b.onclick = (ev)=>{
    if(ev && ev.stopPropagation) ev.stopPropagation();
    const chat = state.chats.find(c=>c.id===b.dataset.claim);
    if(!chat){ render(); return; }
    if(chat.status!=='unclaimed'){ showToast('سبقك أحد الخدام باستلام هذه المحادثة.'); return; }
    chat.status='claimed'; chat.claimedById=u.id; chat.claimedByName=u.name; chat.claimedAt=nowISO();
    log(u.name, `استلم محادثة مع ${chat.memberName}.`); ui.openChatId = chat.id; persist(); render();
  }; });
  document.querySelectorAll('[data-openchat]').forEach(b=>{ b.onclick = ()=>{ ui.openChatId = b.dataset.openchat; render(); }; });
  const backBtn = document.getElementById('backToChatList'); if(backBtn) backBtn.onclick = ()=>{ ui.openChatId=null; render(); };
  const closeChatBtn = document.getElementById('closeChatBtn');
  if(closeChatBtn) closeChatBtn.onclick = ()=>{ const chat = state.chats.find(c=>c.id===ui.openChatId); chat.status='closed'; log(u.name, `أنهى المحادثة مع ${chat.memberName}.`); ui.openChatId=null; persist(); render(); };
  const sendBtn = document.getElementById('sendChatBtn'), chatInput = document.getElementById('chatInput');
  const doSend = ()=>{
    const input = document.getElementById('chatInput'); if(!input) return;
    const text = input.value.trim(); if(!text) return;
    const chat = state.chats.find(c=>c.id===ui.openChatId); if(!chat || chat.status==='closed') return;
    const isMember = u.role==='makhdoum';
    chat.messages.push({ sender: isMember?'member':'admin', senderName:u.name, senderId:u.id, text, time: nowISO() });
    input.value = '';                                   // clear the box (it used to keep the sent text)
    persist();
    if(!updateThreadInPlace()) render();
    const box = document.querySelector('.thread-msgs'); if(box) box.scrollTop = box.scrollHeight;
    const again = document.getElementById('chatInput'); if(again) again.focus();   // keep the keyboard open for the next message
  };
  if(sendBtn) sendBtn.onclick = doSend;
  if(chatInput) chatInput.addEventListener('keydown', (e)=>{ if(e.key==='Enter' && !e.shiftKey && !e.isComposing){ e.preventDefault(); doSend(); } });

  // ADMIN
  document.querySelectorAll('[data-adminsub]').forEach(b=>{ b.onclick = ()=>{ ui.adminSub = b.dataset.adminsub; render(); }; });
  /* promotion */
  document.querySelectorAll('[data-move-class]').forEach(b=>{ b.onclick = ()=>{ if(moveClassInOrder(b.dataset.moveClass, Number(b.dataset.dir))){ log(u.name, 'غيّر ترتيب الفصول.'); persist(); } render(); }; });
  const promoLast = document.getElementById('promoLast'); if(promoLast) promoLast.onchange = ()=>{ ui.promoLast = promoLast.value; render(); };
  const promoAnnounce = document.getElementById('promoAnnounce'); if(promoAnnounce) promoAnnounce.onchange = ()=>{ ui.promoAnnounce = promoAnnounce.checked; render(); };
  const promoRunBtn = document.getElementById('promoRunBtn');
  if(promoRunBtn) promoRunBtn.onclick = ()=>{
    if(u.role !== 'senior_admin') return;
    const mode = ui.promoLast || 'stay', { moves } = promotionPlan(mode);
    if(!moves.length){ showToast('لا يوجد أعضاء للترقية.'); return; }
    askConfirm(`سيتم نقل ${moves.length} عضوًا إلى الفصل التالي حسب الترتيب المعروض. يمكنك التراجع بعد ذلك. هل تريد المتابعة؟`, ()=> runPromotion(u, mode, ui.promoAnnounce !== false));
  };
  const promoUndoBtn = document.getElementById('promoUndoBtn');
  if(promoUndoBtn) promoUndoBtn.onclick = ()=>{ if(u.role !== 'senior_admin') return; askConfirm('إعادة كل من نُقل في آخر ترقية إلى فصله السابق؟ (لن يتأثر من تغيّر فصله بعد ذلك)', ()=> undoPromotion(u)); };
  document.querySelectorAll('[data-approve]').forEach(b=>{ b.onclick = ()=>{ const p = state.users.find(x=>x.id===b.dataset.approve); const sel = document.querySelector(`[data-pending-cls="${p.id}"]`); const clsId = sel && sel.value ? sel.value : null; p.status='approved'; p.classroomId = clsId; const cls = clsId ? classroomOf(clsId) : null; if(cls) p.stageId = cls.stageId; log(u.name, cls ? `وافق على انضمام ${p.name} وعيّنه لفصل "${cls.name}".` : `وافق على انضمام ${p.name}.`); persist(); render(); }; });
  document.querySelectorAll('[data-reject]').forEach(b=>{ b.onclick = ()=>{ const p = state.users.find(x=>x.id===b.dataset.reject); p.status='rejected'; log(u.name, `رفض طلب انضمام ${p.name}.`); persist(); render(); }; });
  const addClassroomBtn = document.getElementById('addClassroomBtn');
  if(addClassroomBtn) addClassroomBtn.onclick = ()=>{
    const name = document.getElementById('newClassName').value.trim();
    const stageId = document.getElementById('newClassStage').value || null;
    if(!name){ showToast('أدخل اسم الفصل.'); return; }
    state.classrooms.push({ id:uid('cls'), name, stageId, servantIds:[] });
    log(u.name, `أضاف فصلًا جديدًا: "${name}".`); persist(); render();
  };
  const addStageBtn = document.getElementById('addStageBtn');
  if(addStageBtn) addStageBtn.onclick = ()=>{
    const name = document.getElementById('newStageName').value.trim();
    if(!name){ showToast('أدخل اسم المرحلة.'); return; }
    const sectorSel = document.getElementById('newStageSector');
    const sectorId = u.role==='super_admin' ? u.sectorId : (sectorSel ? (sectorSel.value || null) : null);
    state.stages.push({ id:uid('stg'), name, sectorId });
    log(u.name, `أضاف مرحلة جديدة: "${name}".`); persist(); render();
  };
  const addSectorBtn = document.getElementById('addSectorBtn');
  if(addSectorBtn) addSectorBtn.onclick = ()=>{
    const name = document.getElementById('newSectorName').value.trim();
    if(!name){ showToast('أدخل اسم القطاع.'); return; }
    state.sectors.push({ id:uid('sec'), name });
    log(u.name, `أضاف قطاعًا جديدًا: "${name}".`); persist(); render();
  };
  document.querySelectorAll('[data-save-sector-name]').forEach(b=>{
    b.onclick = ()=>{
      const secid = b.dataset.saveSectorName;
      const input = document.querySelector(`[data-sector-name="${secid}"]`);
      const newName = input.value.trim();
      if(!newName){ showToast('أدخل اسم القطاع.'); return; }
      const sec = sectorOf(secid); const oldName = sec.name; sec.name = newName;
      log(u.name, `غيّر اسم قطاع "${oldName}" إلى "${newName}".`); persist(); render();
    };
  });
  document.querySelectorAll('[data-del-sector]').forEach(b=>{
    b.onclick = ()=>{
      const secid = b.dataset.delSector; const sec = sectorOf(secid);
      askConfirm(`حذف قطاع "${sec.name}"؟ ستصبح مراحله بدون قطاع.`, ()=>{
        state.sectors = state.sectors.filter(x=>x.id!==secid);
        state.stages.forEach(s=>{ if(s.sectorId===secid) s.sectorId=null; });
        state.users.forEach(x=>{ if(x.role==='super_admin' && x.sectorId===secid) x.sectorId=null; });
        log(u.name, `حذف قطاع "${sec.name}".`); persist(); render();
      });
    };
  });
  document.querySelectorAll('[data-stage-sector]').forEach(sel=>{
    sel.onchange = ()=>{
      const s = stageOf(sel.dataset.stageSector);
      s.sectorId = sel.value || null;
      log(u.name, `غيّر قطاع مرحلة "${s.name}".`); persist(); render();
    };
  });
  document.querySelectorAll('[data-promote-super]').forEach(b=>{
    b.onclick = ()=>{
      const k = state.users.find(x=>x.id===b.dataset.promoteSuper);
      const sel = document.querySelector(`[data-superadmin-sector="${k.id}"]`);
      const sectorId = sel.value;
      const sec = sectorOf(sectorId);
      if(!sec){ showToast('اختر قطاعًا أولًا.'); return; }
      k.role='super_admin'; k.sectorId=sectorId; k.classroomId=null;
      log(u.name, `رقّى ${k.name} إلى سوبر أدمن لقطاع "${sec.name}".`); persist(); render();
    };
  });
  document.querySelectorAll('[data-change-sector]').forEach(sel=>{
    sel.onchange = ()=>{
      const s = state.users.find(x=>x.id===sel.dataset.changeSector);
      s.sectorId = sel.value || null;
      const sec = s.sectorId ? sectorOf(s.sectorId) : null;
      log(u.name, sec ? `نقل ${s.name} لقطاع "${sec.name}".` : `أزال ${s.name} من قطاعه.`); persist(); render();
    };
  });
  document.querySelectorAll('[data-demote-super]').forEach(b=>{
    b.onclick = ()=>{
      const s = state.users.find(x=>x.id===b.dataset.demoteSuper);
      askConfirm(`تخفيض "${s.name}" إلى خادم؟`, ()=>{
        s.role='khadim'; s.sectorId=null; s.classroomId=null;
        log(u.name, `خفّض ${s.name} إلى خادم.`); persist(); render();
      });
    };
  });
  document.querySelectorAll('[data-save-stage-name]').forEach(b=>{
    b.onclick = ()=>{
      const sid = b.dataset.saveStageName;
      const input = document.querySelector(`[data-stage-name="${sid}"]`);
      const newName = input.value.trim();
      if(!newName){ showToast('أدخل اسم المرحلة.'); return; }
      const s = stageOf(sid); const oldName = s.name; s.name = newName;
      log(u.name, `غيّر اسم مرحلة "${oldName}" إلى "${newName}".`); persist(); render();
    };
  });
  document.querySelectorAll('[data-del-stage]').forEach(b=>{
    b.onclick = ()=>{
      const sid = b.dataset.delStage; const s = stageOf(sid);
      askConfirm(`حذف مرحلة "${s.name}"؟ ستصبح فصولها بدون مرحلة.`, ()=>{
        state.stages = state.stages.filter(x=>x.id!==sid);
        state.classrooms.forEach(c=>{ if(c.stageId===sid) c.stageId=null; });
        state.users.forEach(x=>{ if(x.stageId===sid) x.stageId=null; });
        log(u.name, `حذف مرحلة "${s.name}".`); persist(); render();
      });
    };
  });
  document.querySelectorAll('[data-cls-stage]').forEach(sel=>{
    sel.onchange = ()=>{
      const c = classroomOf(sel.dataset.clsStage);
      c.stageId = sel.value || null;
      log(u.name, `غيّر مرحلة فصل "${c.name}".`); persist(); render();
    };
  });
  document.querySelectorAll('[data-reset-pw]').forEach(b=>{ b.onclick = ()=>{ ui.resetPwFor = b.dataset.resetPw; render(); }; });
  document.querySelectorAll('[data-cancel-pw]').forEach(b=>{ b.onclick = ()=>{ ui.resetPwFor = null; render(); }; });
  document.querySelectorAll('[data-save-pw]').forEach(b=>{
    b.onclick = ()=>{
      const pid = b.dataset.savePw;
      const input = document.getElementById(`newPwInput_${pid}`);
      const newPw = input.value;
      if(!newPw || newPw.length<4){ showToast('كلمة المرور يجب ألا تقل عن ٤ أحرف.'); return; }
      const p = state.users.find(x=>x.id===pid); p.password = newPw;
      log(u.name, `غيّر كلمة مرور ${p.name}.`); ui.resetPwFor=null; persist(); showToast('تم تحديث كلمة المرور.'); render();
    };
  });
  document.querySelectorAll('[data-del-cls]').forEach(b=>{
    b.onclick = ()=>{
      const cid = b.dataset.delCls; const cls = classroomOf(cid);
      askConfirm(`حذف "${cls.name}"؟ سيصبح أعضاؤه بدون فصل.`, ()=>{
        state.classrooms = state.classrooms.filter(c=>c.id!==cid);
        state.users.forEach(x=>{ if(x.classroomId===cid) x.classroomId=null; });
        log(u.name, `حذف فصل "${cls.name}".`); persist(); render();
      });
    };
  });
  document.querySelectorAll('[data-cls-servant]').forEach(chk=>{
    chk.onchange = ()=>{
      const [clsId, khId] = chk.dataset.clsServant.split('|');
      const c = classroomOf(clsId); const k = state.users.find(x=>x.id===khId);
      if(chk.checked){ if(!c.servantIds.includes(khId)) c.servantIds.push(khId); log(u.name, `أضاف ${k.name} كخادم لفصل "${c.name}".`); }
      else { c.servantIds = c.servantIds.filter(id=>id!==khId); log(u.name, `أزال ${k.name} من فصل "${c.name}".`); }
      persist(); render();
    };
  });
  document.querySelectorAll('[data-save-cls-name]').forEach(b=>{
    b.onclick = ()=>{
      const cid = b.dataset.saveClsName;
      const input = document.querySelector(`[data-cls-name="${cid}"]`);
      const newName = input.value.trim();
      if(!newName){ showToast('أدخل اسم الفصل.'); return; }
      const c = classroomOf(cid); const oldName = c.name; c.name = newName;
      log(u.name, `غيّر اسم فصل "${oldName}" إلى "${newName}".`); persist(); render();
    };
  });
  document.querySelectorAll('[data-demoteadmin]').forEach(b=>{
    b.onclick = ()=>{
      const s = state.users.find(x=>x.id===b.dataset.demoteadmin);
      if(state.users.filter(x=>x.role==='senior_admin'&&x.status==='approved').length<=1){ showToast('لا يمكن تخفيض مدير الكنيسة الوحيد المتبقي.'); return; }
      askConfirm(`تخفيض "${s.name}" إلى خادم؟`, ()=>{
        s.role='khadim'; s.classroomId=null;
        log(u.name, `خفّض ${s.name} إلى خادم.`); persist(); render();
      });
    };
  });
  document.querySelectorAll('[data-demote]').forEach(b=>{
    b.onclick = ()=>{
      const k = state.users.find(x=>x.id===b.dataset.demote);
      askConfirm(`تخفيض "${k.name}" إلى مخدوم؟ سيُزال من أي فصول يخدم فيها.`, ()=>{
        k.role='makhdoum'; k.classroomId=null;
        state.classrooms.forEach(c=>{ c.servantIds = c.servantIds.filter(id=>id!==k.id); });
        log(u.name, `خفّض ${k.name} إلى مخدوم.`); persist(); render();
      });
    };
  });
  document.querySelectorAll('[data-promote]').forEach(b=>{ b.onclick = ()=>{ const k = state.users.find(x=>x.id===b.dataset.promote); k.role='senior_admin'; k.classroomId=null; log(u.name, `رقّى ${k.name} إلى مدير الكنيسة.`); persist(); render(); }; });
  document.querySelectorAll('[data-promotekh]').forEach(b=>{ b.onclick = ()=>{ const m = state.users.find(x=>x.id===b.dataset.promotekh); m.role='khadim'; m.classroomId=null; log(u.name, `رقّى ${m.name} إلى خادم.`); persist(); render(); }; });
  document.querySelectorAll('[data-assign-cls]').forEach(sel=>{
    sel.onchange = ()=>{
      const m = state.users.find(x=>x.id===sel.dataset.assignCls);
      const newCls = sel.value ? classroomOf(sel.value) : null;
      m.classroomId = sel.value || null;
      log(u.name, newCls ? `عيّن ${m.name} إلى فصل "${newCls.name}".` : `أزال ${m.name} من فصله.`);
      persist(); render();
    };
  });
  document.querySelectorAll('[data-ban-user]').forEach(b=>{
    b.onclick = ()=>{
      const target = state.users.find(x=>x.id===b.dataset.banUser);
      if(target.role==='senior_admin' && state.users.filter(x=>x.role==='senior_admin'&&x.status==='approved').length<=1){ showToast('لا يمكن حظر مدير الكنيسة الوحيد المتبقي.'); return; }
      askConfirm(`حظر حساب "${target.name}"؟ لن يتمكن من الدخول حتى تُلغي الحظر.`, ()=>{
        target.status='banned';
        if(state.session.userId===target.id) state.session.userId=null;
        log(u.name, `حظر حساب ${target.name}.`); persist(); render();
      });
    };
  });
  document.querySelectorAll('[data-unban-user]').forEach(b=>{
    b.onclick = ()=>{
      const target = state.users.find(x=>x.id===b.dataset.unbanUser);
      target.status='approved';
      log(u.name, `ألغى حظر حساب ${target.name}.`); persist(); render();
    };
  });
  document.querySelectorAll('[data-delete-user]').forEach(b=>{
    b.onclick = ()=>{
      const target = state.users.find(x=>x.id===b.dataset.deleteUser);
      if(target.role==='senior_admin' && state.users.filter(x=>x.role==='senior_admin'&&x.status==='approved').length<=1){ showToast('لا يمكن حذف مدير الكنيسة الوحيد المتبقي.'); return; }
      askConfirm(`حذف حساب "${target.name}" نهائيًا؟ لا يمكن التراجع عن هذا الإجراء.`, ()=>{
        state.users = state.users.filter(x=>x.id!==target.id);
        state.classrooms.forEach(c=>{ c.servantIds = c.servantIds.filter(id=>id!==target.id); });
        if(state.session.userId===target.id) state.session.userId=null;
        log(u.name, `حذف حساب ${target.name} نهائيًا.`); persist(); render();
      });
    };
  });
}

render();
/* tapping a notification opens ./#news or ./#today: switch to that tab, then clear the hash */
function applyHashTab(){
  const h = (location.hash||'').replace('#','');
  const u = currentUser();
  if(!h || !u) return;
  if(tabsFor(u.role).some(t=>t.id===h)){ ui.activeTab = h; try{ history.replaceState(null,'',location.pathname+location.search); }catch(e){} render(); }
}
window.addEventListener('hashchange', applyHashTab);
/* hidden diagnostic: tap the cross in the blue top bar 5 times (within 3 s) to show / hide a small redraw counter */
let dbgTaps = [];
document.addEventListener('click', (e)=>{
  const t = e.target; if(!(t && t.closest && t.closest('.topbar > svg'))) return;
  const n = Date.now(); dbgTaps = dbgTaps.filter(x => n - x < 3000); dbgTaps.push(n);
  if(dbgTaps.length >= 5){ dbgTaps = []; try{ localStorage.setItem('khidma_debug', localStorage.getItem('khidma_debug') === '1' ? '0' : '1'); }catch(err){} render(); }
});
applyHashTab();
// Pull the latest shared state from the database once at startup, then keep polling
// periodically so changes made by other people/devices show up here too.
initialSync();
setInterval(()=>{ if(currentUser() && !ui.scanning) softRefresh(); }, 30000);
setInterval(()=>{ if(!ui.scanning) pollRemoteState(); }, 8000);

/* ---------------- PWA: make the app installable to the home screen ---------------- */
let deferredInstallPrompt = null;
(function setupPWA(){
  // manifest, icons and the service worker are real files next to index.html (Chrome requires that to install a real app)
  if('serviceWorker' in navigator){
    window.addEventListener('load', ()=>{ navigator.serviceWorker.register('sw.js').catch(e=>console.warn('Service worker registration failed:', e)); });
  }
})();
/* true when the app is already installed / opened from the home screen: then no install buttons are shown */
function isInstalled(){
  try{
    return (window.matchMedia && (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches))
      || window.navigator.standalone === true
      || localStorage.getItem('khidma_installed') === '1';
  }catch(e){ return false; }
}
window.addEventListener('beforeinstallprompt', (e)=>{
  e.preventDefault();
  deferredInstallPrompt = e;
  try{ localStorage.removeItem('khidma_installed'); }catch(err){}   // the browser offers to install again, so it is not installed (any more)
});
window.addEventListener('appinstalled', ()=>{ deferredInstallPrompt = null; try{ localStorage.setItem('khidma_installed','1'); }catch(e){} showToast('تم تثبيت التطبيق بنجاح ✓'); });
async function triggerInstall(){
  if(deferredInstallPrompt){
    deferredInstallPrompt.prompt();
    let choice = null;
    try{ choice = await deferredInstallPrompt.userChoice; }catch(e){}
    deferredInstallPrompt = null;
    if(choice && choice.outcome === 'accepted'){ try{ localStorage.setItem('khidma_installed','1'); }catch(e){} }
    render();
  } else {
    showToast('لتثبيت التطبيق: افتح قائمة المتصفح واختر "إضافة إلى الشاشة الرئيسية".');
  }
}
