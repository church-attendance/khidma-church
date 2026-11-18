// السجل — application logic
const CYCLE_LENGTH = 8;
const GROUPS = [
  {id:'sat_tue', days:[6,2]},
  {id:'sun_wed', days:[0,3]},
  {id:'mon_thu', days:[1,4]}
];
const FONT_SCALES = {small: 0.9, medium: 1, large: 1.2};
const DEFAULT_SETTINGS = {fee: 50, fontSize: 'medium', highContrast: false, cycleMode: 'personal', lang: 'ar', lastSeenMonth: '', hourSlots: {sat_tue: [], sun_wed: [], mon_thu: []}, grades: [], slotGrades: {sat_tue:{}, sun_wed:{}, mon_thu:{}}, schoolYear: {start:'',end:''}, pauses: [], teacherPassword: '', payPlan: 'sessions', terms: {sat_tue: {start:'',end:''}, sun_wed: {start:'',end:''}, mon_thu: {start:'',end:''}}};


function onSearchInput(el){
  // redrawing replaces the input, so put the cursor back where it was or typing would stop after one letter
  const pos = el.selectionStart;
  state.search = el.value;
  render();
  const n = document.querySelector('.att-search input');
  if(n){ n.focus(); try{ n.setSelectionRange(pos, pos); }catch(e){} }
}
function applyBootstrapDirection(){
  // Both Bootstrap files are loaded; the matching one is switched on through `media`
  // (re-enabling a disabled stylesheet is unreliable in Chrome).
  const rtl = (state.settings && state.settings.lang === 'en') ? false : true;
  const r = document.getElementById('bs-rtl'), l = document.getElementById('bs-ltr');
  if(r) r.media = rtl ? 'all' : 'not all';
  if(l) l.media = rtl ? 'not all' : 'all';
}

function lang(){ return state.settings.lang === 'en' ? 'en' : 'ar'; }
function t(key){ return T[lang()][key]; }

function todayISO(){
  const d = new Date();
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function shiftDay(iso,delta){
  const [y,mo,da] = iso.split('-').map(Number);
  const d = new Date(y, mo-1, da);
  d.setDate(d.getDate()+delta);
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function formatDateAr(iso){ const d=new Date(iso+'T00:00:00'); const L=lang(); return DAY_NAMES[L][d.getDay()]+(L==='ar'?'، ':', ')+d.getDate()+' '+MONTH_NAMES[L][d.getMonth()]; }
function groupDaysLabel(g){ return g.days.map(d=>DAY_NAMES[lang()][d]).join(lang()==='ar'?' و ':' & '); }
function esc(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function loadLocal(key, fallback){ try{ const v=localStorage.getItem('att_'+key); return v?JSON.parse(v):fallback; } catch(e){ return fallback; } }
function saveLocal(key, value){ try{ localStorage.setItem('att_'+key, JSON.stringify(value)); } catch(e){ console.error(e); } }

let state = {
  members: [], attendance: {}, payments: {},
  settings: DEFAULT_SETTINGS, ready: false,
  teacherCode: null, authScreen: null, authMode: 'create', joinRole: 'teacher', joinCodeDraft: '', authError: '',
  license: null, licenseMsg: '', licenseOk: false, adminSecret: null,
  adm: {plan:'monthly', count:1, note:'', query:'', result:[], resultNote:'', accounts:[], codes:[], stats:null, msg:''}, welcomeMsg: '', monthlySummaryMsg: '', dismissedSevere: false,
  screen: 'main', selectedMemberId: null, selectedGroup: GROUPS[0].id, selectedHourSlot: 'all',
  tab: 'attendance', sortDir: 'asc', search: '', selectedDate: todayISO(),
  adding: false, draftGroup: GROUPS[0].id, draftHourSlot: null, draftGrade: null, draftManual: false, amountDrafts: {},
  bulkSelected: {}, bulkTargetGroup: GROUPS[0].id, syncStatus: '', importStatus: '', newHourSlotDraft: {}, advanceDrafts: {},
  showGrades: false, selectedGrade: 'all', gradesEditMode: false, renamingGrade: null
};

const SUPABASE_URL = 'https://kcarkkmuludbmdlakkxd.supabase.co/rest/v1';
const SUPABASE_KEY = 'sb_publishable_LnDpH8NgNADbQ8dzLW4NlA_SkpPFoSC';
const DB_TABLE = 'sejjel_data';
function dbHeaders(extra){
  return Object.assign({'apikey': SUPABASE_KEY, 'Authorization': 'Bearer '+SUPABASE_KEY}, extra||{});
}
function generateTeacherCode(){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c=''; for(let i=0;i<6;i++) c += chars[Math.floor(Math.random()*chars.length)];
  return c;
}
async function fetchByCode(code){
  const res = await fetch(SUPABASE_URL+'/'+DB_TABLE+'?id=eq.'+encodeURIComponent(code)+'&select=payload', { headers: dbHeaders() });
  if(!res.ok) throw new Error('fetch failed: '+res.status);
  const rows = await res.json();
  return (rows && rows[0] && rows[0].payload) || null;
}
async function pushByCode(code, payload){ await rpc('push_data', {p_id: code, p_payload: payload}); }
// ---- Licensing (trial + activation codes) ----
// Fill in your prices (EGP) here; leave null to hide a price.
const PAY = {
  card: '5078086720588263',
  instapay: '01277235553',
  whatsapp: '201223425616',            // 01223425616 in international form, for the wa.me link
  whatsappDisplay: '01223425616',
  prices: {monthly: null, yearly: null, lifetime: null}
};
async function rpc(name, args){
  const res = await fetch(SUPABASE_URL+'/rpc/'+name, {
    method: 'POST', headers: dbHeaders({'Content-Type':'application/json'}), body: JSON.stringify(args)
  });
  if(!res.ok){
    let msg = ''; try{ const j = await res.json(); msg = (j && j.message) || ''; }catch(e){}
    const err = new Error(msg || ('rpc failed: '+res.status)); err.code = msg; throw err;
  }
  const txt = await res.text(); return txt ? JSON.parse(txt) : null;
}
function normPhone(s){
  let d = String(s||'').replace(/[٠-٩]/g, function(c){ return '٠١٢٣٤٥٦٧٨٩'.indexOf(c); }).replace(/\D/g,'');
  if(d.indexOf('0020')===0) d = d.slice(2);
  if(d.indexOf('20')===0 && d.length===12) d = '0'+d.slice(2);
  return d;
}
function saveLicense(){ saveLocal('license', state.license ? {code: state.teacherCode, s: state.license} : null); }
async function refreshLicense(){
  if(!state.teacherCode){ state.license = null; return; }
  try {
    state.license = await rpc('account_status', {p_id: state.teacherCode});
    saveLicense();
  } catch(e){
    // offline: fall back to the last answer we got from the server
    const c = loadLocal('license', null);
    state.license = (c && c.code === state.teacherCode && c.s) ? c.s : {state: 'unknown'};
    if(state.license.until && new Date(state.license.until).getTime() <= Date.now()) state.license = {state: 'expired'};
  }
}
function isExpired(){ return !!(state.license && state.license.state === 'expired'); }
function licenseDaysLeft(){
  const l = state.license;
  if(!l || !l.until) return null;
  return Math.max(0, Math.ceil((new Date(l.until).getTime() - Date.now()) / 86400000));
}
function onResume(){
  if(!state.teacherCode) return;
  const before = JSON.stringify(state.license);
  refreshLicense().then(function(){
    trySyncPending();
    if(JSON.stringify(state.license) !== before) render();
  });
}
async function redeemCode(raw){
  const code = (raw||'').trim();
  state.licenseOk = false;
  if(!code){ state.licenseMsg = t('enterActivation'); render(); return; }
  try {
    state.license = await rpc('redeem_code', {p_id: state.teacherCode, p_code: code});
    saveLicense();
    state.licenseMsg = t('activatedOk'); state.licenseOk = true;
    trySyncPending();
  } catch(e){
    state.licenseMsg = e.code === 'code_invalid' ? t('codeInvalid') : e.code === 'code_used' ? t('codeUsed') : t('activateFail');
  }
  render();
}
function copyText(s, btn){
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(s).then(function(){ if(btn) btn.textContent = t('payCopied'); }).catch(function(){});
  }
}
function waLink(){
  return 'https://wa.me/'+PAY.whatsapp+'?text='+encodeURIComponent(t('waText')(state.teacherCode||''));
}
function submitSignup(){
  const v = function(id){ return document.getElementById(id).value; };
  createNewCode(v('newPasswordInput'), v('newPasswordConfirmInput'), v('newEmailInput'), v('newPhoneInput'));
}

function cloudConfig(){
  return {fee: state.settings.fee, cycleMode: state.settings.cycleMode, hourSlots: state.settings.hourSlots, grades: state.settings.grades, slotGrades: state.settings.slotGrades, schoolYear: state.settings.schoolYear, pauses: state.settings.pauses, teacherPassword: state.settings.teacherPassword, payPlan: state.settings.payPlan, terms: state.settings.terms};
}
function buildPayload(){
  return {members: state.members, attendance: state.attendance, payments: state.payments, config: cloudConfig()};
}
function markSyncPending(pending){
  state.pendingSync = pending;
  saveLocal('pendingSync', pending);
}
function pushNow(){
  if(!state.teacherCode) return Promise.resolve();
  return pushByCode(state.teacherCode, buildPayload()).then(function(){
    markSyncPending(false);
    state.syncStatus = t('syncSuccess');
    render();
  }).catch(function(e){
    markSyncPending(true);
    if(e && e.code === 'subscription_expired'){ state.license = {state: 'expired'}; saveLicense(); state.syncStatus = t('readOnlySync'); }
    else state.syncStatus = t('offlineSaved');
    render();
  });
}
function persistAll(){
  saveLocal('members', state.members);
  saveLocal('attendance', state.attendance);
  saveLocal('payments', state.payments);
  if(state.teacherCode){ pushNow(); }
}
function persistSettings(){
  saveLocal('settings', state.settings);
  if(state.teacherCode){ pushNow(); }
}
function trySyncPending(){
  if(!state.teacherCode || !state.pendingSync) return;
  pushNow();
}
function isTeacher(){ return state.role !== 'assistant'; }

// ---- Auth ----
function checkNotices(){
  const overdueCount = state.members.filter(function(m){return severity(m.id)==='red';}).length;
  const curMonth = todayISO().slice(0,7);
  if(state.settings.lastSeenMonth && state.settings.lastSeenMonth !== curMonth){
    const prevMonth = state.settings.lastSeenMonth;
    let total = 0;
    state.members.forEach(function(m){
      Object.values(state.payments[m.id]||{}).forEach(function(rec){
        if(rec && rec.paid && rec.paidAt && rec.paidAt.slice(0,7)===prevMonth) total += rec.amount;
      });
    });
    const label = MONTH_NAMES[lang()][Number(prevMonth.slice(5,7))-1];
    state.monthlySummaryMsg = t('monthlySummary')(label, total);
  }
  state.settings.lastSeenMonth = curMonth;
  persistSettings();
}

async function initLoad(){
  state.settings = loadLocal('settings', DEFAULT_SETTINGS);
  state.settings = Object.assign({}, DEFAULT_SETTINGS, state.settings);
  document.documentElement.classList.toggle('hc', !!state.settings.highContrast);
  document.documentElement.style.setProperty('--scale', FONT_SCALES[state.settings.fontSize] || 1);
  document.documentElement.dir = state.settings.lang==='en' ? 'ltr' : 'rtl';
  document.documentElement.lang = state.settings.lang==='en' ? 'en' : 'ar';
  applyBootstrapDirection();

  state.teacherCode = loadLocal('teacherCode', null);
  state.role = loadLocal('role', 'teacher');
  state.pendingSync = loadLocal('pendingSync', false);
  if(state.teacherCode) await refreshLicense();

  if(state.teacherCode){
    state.members = loadLocal('members', []);
    state.attendance = loadLocal('attendance', {});
    state.payments = loadLocal('payments', {});

    if(state.pendingSync){
      try { await pushByCode(state.teacherCode, buildPayload()); markSyncPending(false); }
      catch(e){ /* still offline — keep local data, skip the remote pull below */ }
    }

    if(!state.pendingSync){
      try {
        const remote = await fetchByCode(state.teacherCode);
        state.members = (remote && remote.members) || state.members;
        state.attendance = (remote && remote.attendance) || state.attendance;
        state.payments = (remote && remote.payments) || state.payments;
        if(remote && remote.config){
          state.settings.fee = remote.config.fee != null ? remote.config.fee : state.settings.fee;
          state.settings.cycleMode = remote.config.cycleMode || state.settings.cycleMode;
      state.settings.payPlan = remote.config.payPlan || state.settings.payPlan || 'sessions'; state.settings.terms = remote.config.terms || state.settings.terms;
          state.settings.hourSlots = remote.config.hourSlots || state.settings.hourSlots;
          state.settings.grades = remote.config.grades || state.settings.grades;
      state.settings.slotGrades = remote.config.slotGrades || state.settings.slotGrades || {};
      state.settings.schoolYear = remote.config.schoolYear || state.settings.schoolYear; state.settings.pauses = remote.config.pauses || state.settings.pauses || [];
          state.settings.teacherPassword = remote.config.teacherPassword || '';
          saveLocal('settings', state.settings);
        }
        saveLocal('members', state.members); saveLocal('attendance', state.attendance); saveLocal('payments', state.payments);
      } catch(e){
        markSyncPending(true);
      }
    }
    state.authScreen = null;
    checkNotices();
  } else {
    state.members = loadLocal('members', []);
    state.attendance = loadLocal('attendance', {});
    state.payments = loadLocal('payments', {});
    state.authScreen = 'start';
  }
  state.ready = true;
  render();
  window.addEventListener('online', onResume);
  document.addEventListener('visibilitychange', function(){ if(!document.hidden) onResume(); });
}

async function createNewCode(password, confirm, email, phone){
  password = (password||'').trim();
  email = (email||'').trim().toLowerCase();
  phone = normPhone(phone);
  if(!password || !email || !phone){ state.authError = t('fillAllFields'); render(); return; }
  if(password !== confirm){ state.authError = t('passwordMismatch'); render(); return; }
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){ state.authError = t('badEmail'); render(); return; }
  if(!/^01[0125]\d{8}$/.test(phone)){ state.authError = t('badPhone'); render(); return; }
  state.authError = '';
  state.settings.teacherPassword = password;
  const payload = {members: [], attendance: {}, payments: {}, config: cloudConfig()};
  let code = null, err = null;
  for(let i=0; i<3 && !code; i++){
    const c = generateTeacherCode();
    try {
      state.license = await rpc('create_account', {p_code: c, p_email: email, p_phone: phone, p_payload: payload});
      code = c;
    } catch(e){ err = e; if(e.code !== 'code_taken') break; }
  }
  if(!code){
    state.settings.teacherPassword = '';
    state.authError = err && err.code === 'contact_taken' ? t('contactTaken')
                    : err && err.code === 'bad_email' ? t('badEmail')
                    : err && err.code === 'bad_phone' ? t('badPhone') : t('codeCreateFail');
    render(); return;
  }
  state.teacherCode = code;
  state.role = 'teacher';
  saveLocal('teacherCode', code); saveLocal('role', 'teacher'); saveLocal('settings', state.settings); saveLicense();
  state.members = []; state.attendance = {}; state.payments = {};
  saveLocal('members', []); saveLocal('attendance', {}); saveLocal('payments', {});
  markSyncPending(false);
  state.authScreen = null;
  state.welcomeMsg = t('newCodeCreated')(code)+' '+t('trialStarted');
  checkNotices();
  render();
}
async function joinWithCode(codeInput, passwordInput){
  const code = (codeInput||'').trim().toUpperCase();
  if(!code){ state.authError = t('enterCode'); render(); return; }
  const role = state.joinRole === 'assistant' ? 'assistant' : 'teacher';
  state.authError = '';
  try {
    const remote = await fetchByCode(code);
    if(!remote){ state.authError = t('codeNotFound'); render(); return; }
    const storedPw = (remote.config && remote.config.teacherPassword) || '';
    if(role === 'teacher' && storedPw && (passwordInput||'').trim() !== storedPw){
      state.authError = t('wrongPassword'); render(); return;
    }
    state.teacherCode = code;
    state.role = role;
    saveLocal('teacherCode', code); saveLocal('role', role);
    state.members = remote.members || []; state.attendance = remote.attendance || {}; state.payments = remote.payments || {};
    if(remote.config){
      state.settings.fee = remote.config.fee != null ? remote.config.fee : state.settings.fee;
      state.settings.cycleMode = remote.config.cycleMode || state.settings.cycleMode;
      state.settings.payPlan = remote.config.payPlan || state.settings.payPlan || 'sessions'; state.settings.terms = remote.config.terms || state.settings.terms;
      state.settings.hourSlots = remote.config.hourSlots || state.settings.hourSlots;
      state.settings.grades = remote.config.grades || state.settings.grades;
      state.settings.slotGrades = remote.config.slotGrades || state.settings.slotGrades || {};
      state.settings.schoolYear = remote.config.schoolYear || state.settings.schoolYear; state.settings.pauses = remote.config.pauses || state.settings.pauses || [];
      state.settings.teacherPassword = storedPw;
      saveLocal('settings', state.settings);
    }
    saveLocal('members', state.members); saveLocal('attendance', state.attendance); saveLocal('payments', state.payments);
    markSyncPending(false);
    await refreshLicense();
    state.authScreen = null;
    checkNotices();
    render();
  } catch(e){
    state.authError = t('joinFail');
    render();
  }
}
function copyTeacherCode(){
  if(!state.teacherCode) return;
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(state.teacherCode).then(function(){ state.syncStatus = t('codeCopied'); render(); }).catch(function(){});
  }
}
function doLogout(){
  saveLocal('teacherCode', null);
  saveLocal('role', null);
  saveLocal('license', null);
  state.license = null; state.licenseMsg = '';
  state.teacherCode = null;
  state.role = 'teacher';
  markSyncPending(false);
  state.authScreen = 'start';
  state.screen = 'main';
  render();
}

function addMember(name, phone, parentPhone){
  name = name.trim();
  if(!name) return;
  const id = 'm_'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
  state.members.push({id, name, group: state.draftGroup, exempt:false, joined: todayISO(), hourSlot: state.draftHourSlot || null, grade: state.draftGrade || null, phone: (phone||'').trim(), parentPhone: (parentPhone||'').trim()});
  persistAll();
  state.welcomeMsg = t('memberAddedAt')(name, timeText(state.draftGroup, state.draftHourSlot));
  state.selectedGroup = state.draftGroup; state.selectedHourSlot = 'all';
  state.adding = false; state.draftHourSlot = null; state.draftGrade = null; state.draftManual = false;
  render();
}
function updateMemberContact(id, field, value){
  const m = state.members.find(function(x){return x.id===id;});
  if(m){ m[field] = (value||'').trim(); persistAll(); render(); }
}
function removeMember(id){
  state.members = state.members.filter(function(m){return m.id!==id;});
  if(state.selectedMemberId===id){ state.screen='main'; state.selectedMemberId=null; }
  persistAll(); render();
}
function moveMemberGroup(id, groupId){
  const m = state.members.find(function(x){return x.id===id;});
  if(m){ m.group = groupId; m.hourSlot = null; persistAll(); render(); }
}
function moveMemberHourSlot(id, slot){
  const m = state.members.find(function(x){return x.id===id;});
  if(m){ m.hourSlot = slot; persistAll(); render(); }
}
function getHourSlots(groupId){ return (state.settings.hourSlots && state.settings.hourSlots[groupId]) || []; }
function slotGradeOf(groupId, slot){ return (((state.settings.slotGrades||{})[groupId])||{})[slot] || null; }
function addHourSlot(groupId, text, grade){
  text = (text||'').trim();
  if(!text) return;
  const label = grade ? text+' '+grade : text;
  const list = getHourSlots(groupId);
  if(list.includes(label)) return;
  state.settings.hourSlots[groupId] = [...list, label];
  if(grade){
    state.settings.slotGrades = state.settings.slotGrades || {};
    state.settings.slotGrades[groupId] = state.settings.slotGrades[groupId] || {};
    state.settings.slotGrades[groupId][label] = grade;
  }
  persistSettings();
  state.newHourSlotDraft[groupId] = '';
  render();
}
function submitHourSlot(g){
  const i = document.getElementById('hourSlotInput_'+g), sel = document.getElementById('hourSlotGrade_'+g);
  addHourSlot(g, i ? i.value : '', sel ? sel.value : '');
}
function removeHourSlot(groupId, slot){
  state.settings.hourSlots[groupId] = getHourSlots(groupId).filter(function(s){return s!==slot;});
  if(state.settings.slotGrades && state.settings.slotGrades[groupId]) delete state.settings.slotGrades[groupId][slot];
  state.members.forEach(function(m){ if(m.group===groupId && m.hourSlot===slot) m.hourSlot = null; });
  persistSettings(); persistAll();
  render();
}
// registration: after the grade is chosen, offer the times that were set up for that grade
function timeOptionsForGrade(grade){
  const out = [];
  if(!grade) return out;
  GROUPS.forEach(function(g){ getHourSlots(g.id).forEach(function(slot){ if(slotGradeOf(g.id, slot) === grade) out.push({group: g.id, slot: slot}); }); });
  return out;
}
function timeText(groupId, slot){ return t('groupLabel')[groupId] + (slot ? ' — '+slot : ''); }
function setDraftGrade(grade){
  state.draftGrade = grade; state.draftManual = false;
  const opts = timeOptionsForGrade(grade);
  state.draftHourSlot = null;
  if(opts.length === 1){ state.draftGroup = opts[0].group; state.draftHourSlot = opts[0].slot; }
  render();
}
function pickTime(groupId, slot){ state.draftGroup = groupId; state.draftHourSlot = slot; state.draftManual = false; render(); }
function getGrades(){ return state.settings.grades || []; }
function addGrade(name){
  name = (name||'').trim();
  if(!name) return;
  const list = getGrades();
  if(list.includes(name)) return;
  state.settings.grades = [...list, name];
  persistSettings();
  render();
}
function removeGrade(name){
  state.settings.grades = getGrades().filter(function(g){return g!==name;});
  state.members.forEach(function(m){ if(m.grade===name) m.grade = null; });
  if(state.selectedGrade===name) state.selectedGrade = 'all';
  if(state.draftGrade===name) state.draftGrade = null;
  GROUPS.forEach(function(g){ const sg = (state.settings.slotGrades||{})[g.id]; if(sg) Object.keys(sg).forEach(function(k){ if(sg[k]===name) delete sg[k]; }); });
  persistSettings(); persistAll();
  render();
}
function renameGrade(oldName, newName){
  newName = (newName||'').trim();
  state.renamingGrade = null;
  if(!newName || newName===oldName){ render(); return; }
  if(getGrades().includes(newName)) return render();
  state.settings.grades = getGrades().map(function(g){return g===oldName?newName:g;});
  state.members.forEach(function(m){ if(m.grade===oldName) m.grade = newName; });
  if(state.selectedGrade===oldName) state.selectedGrade = newName;
  if(state.draftGrade===oldName) state.draftGrade = newName;
  GROUPS.forEach(function(g){
    const sg = (state.settings.slotGrades||{})[g.id]; if(!sg) return;
    Object.keys(sg).forEach(function(label){
      if(sg[label] !== oldName) return;
      const nl = label.endsWith(oldName) ? label.slice(0, label.length-oldName.length)+newName : label;
      state.settings.hourSlots[g.id] = getHourSlots(g.id).map(function(x){ return x===label ? nl : x; });
      state.members.forEach(function(m){ if(m.group===g.id && m.hourSlot===label) m.hourSlot = nl; });
      if(state.draftGroup===g.id && state.draftHourSlot===label) state.draftHourSlot = nl;
      delete sg[label]; sg[nl] = newName;
    });
  });
  persistSettings(); persistAll();
  render();
}
function setMemberGrade(id, grade){
  const m = state.members.find(function(x){return x.id===id;});
  if(m){ m.grade = grade; persistAll(); render(); }
}
function toggleExempt(id){
  const m = state.members.find(function(x){return x.id===id;});
  if(m){ m.exempt = !m.exempt; persistAll(); render(); }
}
function isExempt(id){
  const m = state.members.find(function(x){return x.id===id;});
  return !!(m && m.exempt);
}
function toggleAttendance(id){
  const day = state.attendance[state.selectedDate] || [];
  state.attendance[state.selectedDate] = day.includes(id) ? day.filter(function(x){return x!==id;}) : [...day, id];
  persistAll(); render();
}
function attendanceCount(id){
  let c=0;
  for(const date in state.attendance){ if(state.attendance[date].includes(id)) c++; }
  return c;
}
function groupSessionCount(groupId){
  const groupIds = state.members.filter(function(x){return x.group===groupId;}).map(function(x){return x.id;});
  let c=0;
  for(const date in state.attendance){
    if(state.attendance[date].some(function(id){return groupIds.includes(id);})) c++;
  }
  return c;
}
function cycleCount(id){
  const m = state.members.find(function(x){return x.id===id;});
  if(!m) return 0;
  const asOf = payAsOf(), tm = termEffective(m.group);
  const ok = function(date){ return date <= asOf && (!tm.start || date >= tm.start) && (!tm.end || date <= tm.end); };
  let ids = [id];
  if(state.settings.cycleMode==='group') ids = state.members.filter(function(x){return x.group===m.group;}).map(function(x){return x.id;});
  let c = 0;
  for(const date in state.attendance){
    if(ok(date) && state.attendance[date].some(function(x){return ids.includes(x);})) c++;
  }
  return c;
}
// ---- School year + payment pause (e.g. winter break) ----
// During a pause nothing new becomes due; whatever would have been due is collected after the pause ends.
function pauseRanges(){ return (state.settings.pauses||[]).filter(function(p){return p.from && p.to;}); }
function pauseAt(iso){ return pauseRanges().find(function(p){return iso >= p.from && iso <= p.to;}) || null; }
function isPaused(){ return !!pauseAt(todayISO()); }
function payAsOf(){
  let d = todayISO(), p, guard = 0;
  while((p = pauseAt(d)) && guard++ < 20) d = shiftDay(p.from, -1);
  return d;
}
function deferDue(iso){
  let p, guard = 0;
  while((p = pauseAt(iso)) && guard++ < 20) iso = shiftDay(p.to, 1);
  return iso;
}
function termEffective(g){
  const raw = ((state.settings.terms||{})[g]) || {}, sy = state.settings.schoolYear || {};
  return {start: raw.start || sy.start || '', end: raw.end || sy.end || ''};
}
function addPause(){
  const v = function(id){ const e = document.getElementById(id); return e ? e.value : ''; };
  const from = v('pauseFrom'), to = v('pauseTo'), label = (v('pauseLabel')||'').trim();
  if(!from || !to || to < from){ alert(t('pauseBad')); return; }
  state.settings.pauses = (state.settings.pauses||[]).concat([{from: from, to: to, label: label}]);
  persistSettings(); render();
}
function removePause(i){
  state.settings.pauses = (state.settings.pauses||[]).filter(function(_, k){return k !== i;});
  persistSettings(); render();
}
function setSchoolYear(which, v){
  const sy = Object.assign({start:'', end:''}, state.settings.schoolYear || {});
  sy[which] = v || '';
  if(sy.start && sy.end && sy.end < sy.start){ alert(t('termBad')); render(); return; }
  state.settings.schoolYear = sy; persistSettings(); render();
}
// ---- Payment plan: 'sessions' (every 8 attendance days) | 'month_start' | 'month_end' ----
// Monthly plans: one payment per calendar month, from each class's start date to its end date.
function payPlan(){ return state.settings.payPlan || 'sessions'; }
function isMonthly(){ return payPlan() !== 'sessions'; }
function isoOf(y, m, d){ return y+'-'+String(m+1).padStart(2,'0')+'-'+String(d).padStart(2,'0'); }
function getTerm(g){ const x = (state.settings.terms||{})[g] || {}; return {start: x.start||'', end: x.end||''}; }
function setTermDate(g, which, v){
  state.settings.terms = state.settings.terms || {};
  const cur = Object.assign({}, state.settings.terms[g] || {});
  cur[which] = v || '';
  if(cur.start && cur.end && cur.end < cur.start){ alert(t('termBad')); render(); return; }
  state.settings.terms[g] = cur;
  persistSettings(); render();
}
function setPayPlan(p){
  if(p === payPlan()) return;
  if(Object.keys(state.payments).length && !confirm(t('payPlanConfirm'))) return;
  state.settings.payPlan = p;
  persistSettings(); render();
}
function termStartISO(g){
  const s = termEffective(g).start; if(s) return s;
  // no start date set: use the first day this class had attendance
  const ids = state.members.filter(function(x){return x.group===g;}).map(function(x){return x.id;});
  let first = '';
  for(const date in state.attendance){
    if(state.attendance[date].some(function(id){return ids.includes(id);}) && (first==='' || date<first)) first = date;
  }
  return first;
}
function monthSchedule(g){
  // one entry per calendar month of the class: {key:'YYYY-MM', due:'YYYY-MM-DD'}
  const start = termStartISO(g); if(!start) return [];
  const end = termEffective(g).end, endKey = end ? end.slice(0,7) : null, today = todayISO();
  let y = +start.slice(0,4), m = +start.slice(5,7)-1;
  const list = [];
  for(let i=0; i<240; i++){
    const key = y+'-'+String(m+1).padStart(2,'0');
    if(endKey && key > endKey) break;
    let due;
    if(payPlan()==='month_start'){ due = isoOf(y, m, 1); if(due < start) due = start; }
    else { due = isoOf(y, m, new Date(y, m+1, 0).getDate()); if(end && end < due) due = end; }
    due = deferDue(due);
    list.push({key: key, due: due});
    if(!endKey && due > today) break;
    m++; if(m>11){ m=0; y++; }
  }
  return list;
}
function monthKeyOf(g, cycle){
  const s = termStartISO(g); if(!s) return '';
  let y = +s.slice(0,4), m = +s.slice(5,7)-1 + (cycle-1);
  y += Math.floor(m/12); m = ((m%12)+12)%12;
  return y+'-'+String(m+1).padStart(2,'0');
}
function monthLabel(key){ return key ? MONTH_NAMES[lang()][+key.slice(5,7)-1]+' '+key.slice(0,4) : ''; }
function cycleName(g, cycle){ return isMonthly() ? (monthLabel(monthKeyOf(g, cycle)) || String(cycle)) : String(cycle); }
function cycleBadge(g, cycle){ return isMonthly() ? cycleName(g, cycle) : t('cycleLabel')+' '+cycle; }
function memberStartISO(m){
  // a member only owes months from when they joined (or first attended, whichever is earlier)
  let join = m.joined || '';
  if(!join){
    const ms = parseInt(String(m.id).slice(2,10), 36);
    if(ms > 1.5e12 && ms < Date.now()+864e5){ const d = new Date(ms); join = isoOf(d.getFullYear(), d.getMonth(), d.getDate()); }
  }
  let first = '';
  for(const date in state.attendance){ if(state.attendance[date].includes(m.id) && (first==='' || date<first)) first = date; }
  return (join && first) ? (join < first ? join : first) : (join || first);
}
function firstCycle(m){
  const sch = monthSchedule(m.group), ms = memberStartISO(m);
  if(!ms || sch.length===0) return 1;
  for(let i=0; i<sch.length; i++){ if(sch[i].key >= ms.slice(0,7)) return i+1; }
  return sch.length+1;
}
function monthlyNotDueText(m){
  const sch = monthSchedule(m.group);
  if(sch.length===0) return t('setStartDate');
  const e = sch[Math.max(0, firstCycle(m)-1)];
  return e ? t('firstDueOn')(formatDateAr(e.due)) : t('termEnded');
}
function currentCycle(id){
  if(!isMonthly()) return Math.floor(cycleCount(id)/CYCLE_LENGTH);
  const m = state.members.find(function(x){return x.id===id;}); if(!m) return 0;
  const today = todayISO();
  const due = monthSchedule(m.group).filter(function(e){return e.due <= today;}).length;
  return due >= firstCycle(m) ? due : 0;
}
function unpaidCycleList(id){
  const dueCycle = currentCycle(id);
  if(dueCycle < 1) return [];
  let from = 1;
  if(isMonthly()){ const m = state.members.find(function(x){return x.id===id;}); if(m) from = firstCycle(m); }
  const list = [];
  for(let c=from; c<=dueCycle; c++){
    const rec = (state.payments[id]||{})[c];
    if(!rec || !rec.paid) list.push(c);
  }
  return list;
}
function severity(id){
  if(isExempt(id)) return null;
  const u = unpaidCycleList(id);
  if(u.length===0) return null;
  return u.length===1 ? 'orange' : 'red';
}
function markPaidCycle(id, cycle){
  if(isMonthly()){ const u = unpaidCycleList(id); if(u.length) cycle = u[0]; }
  if(!cycle || cycle<1) return;
  const draft = state.amountDrafts[id];
  const amount = (draft!==undefined && draft!=='') ? Number(draft) : state.settings.fee;
  const rec = state.payments[id] || {};
  rec[cycle] = {paid:true, amount, paidAt: todayISO()};
  state.payments[id] = rec;
  persistAll(); render();
}
function nextUnpaidCycleNumber(id){
  const rec = state.payments[id] || {};
  let c = 1;
  while(rec[c] && rec[c].paid) c++;
  return c;
}
function payAdvance(id, count, amountPerCycle){
  count = Math.max(1, Math.min(60, Math.round(Number(count)||1)));
  const perCycle = (amountPerCycle!=null && amountPerCycle!=='') ? Number(amountPerCycle) : state.settings.fee;
  const rec = state.payments[id] || {};
  let c = nextUnpaidCycleNumber(id);
  for(let i=0;i<count;i++){
    rec[c+i] = {paid:true, amount: perCycle, paidAt: todayISO()};
  }
  state.payments[id] = rec;
  state.advanceDrafts = state.advanceDrafts || {};
  delete state.advanceDrafts[id];
  persistAll(); render();
}
function markUnpaidCycle(id, cycle){
  const rec = state.payments[id] || {};
  const prevAmount = rec[cycle] ? rec[cycle].amount : 0;
  rec[cycle] = {paid:false, amount: prevAmount};
  state.payments[id] = rec;
  persistAll(); render();
}
function updatePaidAmount(id, cycle, value){
  const rec = state.payments[id] || {};
  const current = rec[cycle] || {paid:true, amount:0};
  current.amount = value==='' ? 0 : Number(value);
  rec[cycle] = current;
  state.payments[id] = rec;
  persistAll();
}
function saveFeeValue(value){ state.settings.fee = value==='' ? 0 : Number(value); persistSettings(); }
function saveTeacherPassword(value){
  if(!isTeacher()) return;
  value = (value||'').trim();
  if(!value) return;
  state.settings.teacherPassword = value;
  persistSettings();
  state.syncStatus = t('passwordSaved');
  render();
}
function setFontSize(v){ state.settings.fontSize = v; persistSettings(); document.documentElement.style.setProperty('--scale', FONT_SCALES[v]||1); render(); }
function setHighContrast(v){ state.settings.highContrast = v; persistSettings(); document.documentElement.classList.toggle('hc', v); render(); }
function setLang(v){
  state.settings.lang = v; persistSettings();
  document.documentElement.dir = v==='en' ? 'ltr' : 'rtl';
  document.documentElement.lang = v==='en' ? 'en' : 'ar';
  applyBootstrapDirection();
  render();
}
async function syncNow(){
  if(!state.teacherCode) return;
  state.syncStatus = t('syncing'); render();
  try { await pushByCode(state.teacherCode, {members: state.members, attendance: state.attendance, payments: state.payments}); state.syncStatus = t('syncSuccess'); }
  catch(e){ state.syncStatus = t('syncFail'); }
  render();
}
function deleteEverything(){
  if(!confirm(t('deleteConfirm'))) return;
  state.members = []; state.attendance = {}; state.payments = {};
  persistAll(); render();
}
function bulkMove(){
  const ids = Object.keys(state.bulkSelected).filter(function(id){return state.bulkSelected[id];});
  ids.forEach(function(id){ const m = state.members.find(function(x){return x.id===id;}); if(m) m.group = state.bulkTargetGroup; });
  state.bulkSelected = {};
  persistAll(); render();
}

function getGroupMembers(){
  let list = state.members.filter(function(m){return m.group === state.selectedGroup;});
  if(state.selectedHourSlot !== 'all') list = list.filter(function(m){return m.hourSlot === state.selectedHourSlot;});
  if(state.selectedGrade !== 'all') list = list.filter(function(m){return m.grade === state.selectedGrade;});
  return list;
}
function getFilteredSorted(){
  let list = getGroupMembers();
  if(state.search.trim()){
    const q = state.search.trim().toLowerCase();
    list = list.filter(function(m){return m.name.toLowerCase().includes(q);});
  }
  list.sort(function(a,b){ return state.sortDir==='asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name); });
  return list;
}
function getHistory(id){
  const days = Object.entries(state.attendance).filter(function(e){return e[1].includes(id);}).map(function(e){return e[0];}).sort().reverse();
  const paidCycles = Object.entries(state.payments[id] || {}).filter(function(e){return e[1] && e[1].paid;}).sort(function(a,b){return Number(b[0])-Number(a[0]);});
  return {days, paidCycles};
}
function missedDays(id){
  const m = state.members.find(function(x){return x.id===id;});
  if(!m) return [];
  const groupmateIds = state.members.filter(function(x){return x.group===m.group;}).map(function(x){return x.id;});
  const missed = [];
  Object.entries(state.attendance).forEach(function(e){
    const date = e[0], presentIds = e[1];
    const sessionHeld = presentIds.some(function(pid){return groupmateIds.includes(pid);});
    if(sessionHeld && !presentIds.includes(id)) missed.push(date);
  });
  return missed.sort().reverse();
}
function onDateChange(value){ if(value){ state.selectedDate = value; render(); } }
function openDetail(id){ state.selectedMemberId = id; state.screen = 'detail'; render(); }

function paymentsSummary(){
  let total = 0;
  const byGroup = {}; GROUPS.forEach(function(g){ byGroup[g.id] = 0; });
  const byCycle = {};
  state.members.forEach(function(m){
    const rec = state.payments[m.id] || {};
    Object.entries(rec).forEach(function(entry){
      const cycle = entry[0], r = entry[1];
      if(r && r.paid){
        total += r.amount;
        byGroup[m.group] = (byGroup[m.group]||0) + r.amount;
        const ck = isMonthly() ? (monthKeyOf(m.group, Number(cycle)) || cycle) : cycle;
        byCycle[ck] = (byCycle[ck]||0) + r.amount;
      }
    });
  });
  return {total, byGroup, byCycle};
}

function memberTotalPaid(id){
  let total = 0;
  Object.values(state.payments[id]||{}).forEach(function(r){ if(r && r.paid) total += r.amount; });
  return total;
}
function memberStatusLabel(id){
  if(isExempt(id)) return t('flagExempt');
  const sev = severity(id);
  if(sev==='red') return t('flagVeryOverdue');
  if(sev==='orange') return t('flagOverdue');
  return t('statusOk');
}
function ensureXLSXLoaded(){
  return new Promise(function(resolve, reject){
    if(window.XLSX){ resolve(); return; }
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = function(){ resolve(); };
    s.onerror = function(){ reject(new Error('load failed')); };
    document.head.appendChild(s);
  });
}
function groupIdFromLabel(label){
  if(!label) return null;
  label = String(label).trim();
  for(const g of GROUPS){
    if(label === T.ar.groupLabel[g.id] || label === T.en.groupLabel[g.id] || label === g.id) return g.id;
  }
  return null;
}
function downloadImportTemplate(){
  const header = [t('colName'), t('colGroup'), t('colHourSlot'), t('colGrade'), t('phoneLabel'), t('parentPhoneLabel')];
  const example = [lang()==='ar'?'مثال: محمد أحمد':'e.g. John Smith', t('groupLabel')[GROUPS[0].id], '', '', '', ''];
  const csv = [header, example].map(function(r){ return r.map(csvEscape).join(','); }).join('\r\n');
  const blob = new Blob(['\uFEFF'+csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'import_template.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
async function handleImportFile(fileInput){
  const file = fileInput.files && fileInput.files[0];
  if(!file) return;
  state.importStatus = t('importing'); render();
  try {
    await ensureXLSXLoaded();
    const data = await file.arrayBuffer();
    const wb = XLSX.read(data, {type:'array'});
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet, {defval:''});
    let count = 0;
    let settingsChanged = false;
    json.forEach(function(row){
      const name = String(row[t('colName')] != null ? row[t('colName')] : (row['الاسم'] || row['Name'] || '')).trim();
      if(!name) return;
      const groupLabelVal = row[t('colGroup')] != null ? row[t('colGroup')] : (row['المجموعة'] || row['Group'] || '');
      const group = groupIdFromLabel(groupLabelVal) || state.selectedGroup;
      const hourSlot = String(row[t('colHourSlot')] != null ? row[t('colHourSlot')] : (row['الموعد'] || row['Slot'] || '')).trim() || null;
      const grade = String(row[t('colGrade')] != null ? row[t('colGrade')] : (row['الصف'] || row['Grade'] || '')).trim() || null;
      const phone = String(row[t('phoneLabel')] != null ? row[t('phoneLabel')] : (row['رقم الهاتف'] || row['Phone number'] || '')).trim();
      const parentPhone = String(row[t('parentPhoneLabel')] != null ? row[t('parentPhoneLabel')] : (row['رقم هاتف ولي الأمر'] || row['Parent phone number'] || '')).trim();
      if(hourSlot && !getHourSlots(group).includes(hourSlot)){
        state.settings.hourSlots[group] = [...getHourSlots(group), hourSlot]; settingsChanged = true;
      }
      if(grade && !getGrades().includes(grade)){
        state.settings.grades = [...getGrades(), grade]; settingsChanged = true;
      }
      const id = 'm_'+Date.now().toString(36)+Math.random().toString(36).slice(2,6)+count;
      state.members.push({id, name, group, exempt:false, hourSlot, grade, phone, parentPhone});
      count++;
    });
    if(settingsChanged){ saveLocal('settings', state.settings); }
    persistAll();
    state.importStatus = t('importDone')(count);
  } catch(e){
    state.importStatus = t('importFail');
  }
  fileInput.value = '';
  render();
}
function westernDigits(v){
  // Arabic-Indic (٠١٢…) and Persian (۰۱۲…) digits -> 0123… so every spreadsheet shows them the same way
  return String(v==null?'':v).replace(/[٠-٩]/g, function(c){ return '٠١٢٣٤٥٦٧٨٩'.indexOf(c); })
                             .replace(/[۰-۹]/g, function(c){ return '۰۱۲۳۴۵۶۷۸۹'.indexOf(c); });
}
// phone numbers as text: keeps the leading 0 and stops Excel turning 01012345678 into 1.01E+09
function csvPhone(v){
  const d = westernDigits(v).replace(/[^\d+]/g, '');
  return d ? '="'+d+'"' : '-';
}
function csvEscape(v){
  const s = westernDigits(v);
  return /[",\n\r]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s;
}
function exportCSV(){
  const rows = [[t('colName'), t('colGroup'), t('colHourSlot'), t('colGrade'), t('phoneLabel'), t('parentPhoneLabel'), t('colExempt'), t('colAttendance'), t('colCycle'), t('colStatus'), t('colPaid')]];
  state.members.forEach(function(m){
    rows.push([
      m.name, t('groupLabel')[m.group], m.hourSlot || '-', m.grade || '-', csvPhone(m.phone), csvPhone(m.parentPhone),
      m.exempt ? t('yesLabel') : t('noLabel'),
      attendanceCount(m.id), currentCycle(m.id), memberStatusLabel(m.id), memberTotalPaid(m.id)
    ]);
  });
  const csv = rows.map(function(r){ return r.map(csvEscape).join(','); }).join('\r\n');
  const blob = new Blob(['\uFEFF'+csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'attendance_'+todayISO()+'.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
function exportPDF(){
  const summary = paymentsSummary();
  let html = '<h1>'+t('appTitle')+'</h1><h2>'+t('summaryTitle')+'</h2><table>';
  html += '<tr><td>'+t('summaryTotal')+'</td><td>'+summary.total+' ج.م</td></tr>';
  GROUPS.forEach(function(g){ html += '<tr><td>'+t('groupLabel')[g.id]+'</td><td>'+(summary.byGroup[g.id]||0)+' ج.م</td></tr>'; });
  html += '</table><h2>'+t('exportTitle')+'</h2><table><tr><th>'+t('colName')+'</th><th>'+t('colGroup')+'</th><th>'+t('colAttendance')+'</th><th>'+t('colStatus')+'</th><th>'+t('colPaid')+'</th></tr>';
  state.members.forEach(function(m){
    html += '<tr><td>'+esc(m.name)+'</td><td>'+t('groupLabel')[m.group]+'</td><td>'+attendanceCount(m.id)+'</td><td>'+memberStatusLabel(m.id)+'</td><td>'+memberTotalPaid(m.id)+'</td></tr>';
  });
  html += '</table>';
  const el = document.getElementById('printReport');
  el.innerHTML = html;
  el.dir = lang()==='en' ? 'ltr' : 'rtl';
  window.print();
}

// ---- Rendering ----
// ---- Owner / admin console ----
async function adminCall(name, args){ args.p_secret = state.adminSecret; return rpc(name, args); }
async function adminRefresh(){
  const r = await adminCall('admin_overview', {p_query: state.adm.query || ''});
  state.adm.stats = r.stats; state.adm.accounts = r.accounts; state.adm.codes = r.codes;
}
async function adminLogin(secret){
  secret = (secret||'').trim(); if(!secret) return;
  state.adminSecret = secret;
  try { await adminRefresh(); state.authError = ''; try{ sessionStorage.setItem('adm', secret); }catch(e){} }
  catch(e){ state.adminSecret = null; state.authError = e.code === 'forbidden' ? t('adminBad') : t('adminFail'); }
  render();
}
function adminLogout(){
  state.adminSecret = null; state.adm.result = []; state.adm.msg = '';
  try{ sessionStorage.removeItem('adm'); }catch(e){}
  render();
}
async function adminRun(fn){
  state.adm.msg = '';
  try { await fn(); } catch(e){ state.adm.msg = e.code === 'forbidden' ? t('adminBad') : (e.code || t('adminFail')); }
  render();
}
function adminSearch(){ adminRun(adminRefresh); }
function adminGenerate(){
  adminRun(async function(){
    const n = parseInt(state.adm.count, 10) || 1;
    state.adm.result = await adminCall('admin_generate', {p_plan: state.adm.plan, p_count: n, p_note: state.adm.note || null});
    state.adm.resultNote = normPhone(state.adm.note);
    await adminRefresh();
  });
}
function adminGrant(id, action){
  if(action === 'revoke' && !confirm(t('adminRevokeConfirm'))) return;
  adminRun(async function(){ await adminCall('admin_grant', {p_id: id, p_action: action}); await adminRefresh(); state.adm.msg = t('adminDone'); });
}
function adminVoid(code){
  adminRun(async function(){ await adminCall('admin_void_code', {p_code: code}); await adminRefresh(); });
}
function adminWaLink(phone, code, plan){
  return 'https://wa.me/2'+phone+'?text='+encodeURIComponent(t('adminWaMsg')(code, t('plan_'+plan)));
}
function adminStatusText(st){
  if(!st) return '';
  if(st.state === 'lifetime') return t('statusLifetime');
  if(st.state === 'trial') return t('statusTrial')(st.days_left);
  if(st.state === 'active') return t('statusActive')(st.days_left);
  return t('adminExpired');
}
function renderAdmin(){
  const a = state.adm, s = a.stats || {};
  let h = '<div class="d-flex justify-content-between align-items-center mb-3 pb-3 att-header"><p class="h4 fw-bold mb-0">'+t('adminTitle')+'</p>';
  h += '<button class="btn btn-sm btn-outline-dark" onclick="adminLogout()">'+t('logout')+'</button></div>';
  if(a.msg) h += '<div class="alert alert-success py-2 small">'+esc(a.msg)+'</div>';

  h += '<div class="d-flex flex-wrap gap-1 mb-3">';
  [['stAccounts','accounts'],['stTrial','trial'],['stActive','active'],['stLifetime','lifetime'],['stExpired','expired'],['stUnused','unused']].forEach(function(p){
    h += '<span class="badge border fw-normal att-chip">'+t(p[0])+': <b>'+(s[p[1]]!=null?s[p[1]]:'–')+'</b></span>';
  });
  h += '</div>';

  // generate
  h += '<div class="card card-body p-3 mb-3"><h3 class="h6 fw-semibold">'+t('adminGenTitle')+'</h3><div class="d-flex flex-wrap gap-2 mb-2">';
  ['monthly','yearly','lifetime'].forEach(function(p){
    h += '<button class="btn btn-sm rounded-pill btn-outline-dark '+(a.plan===p?'active':'')+'" onclick="state.adm.plan=\''+p+'\'; render();">'+t('plan_'+p)+'</button>';
  });
  h += '</div><div class="d-flex gap-2 mb-2"><input class="form-control form-control-sm" style="width:4.5rem" type="number" min="1" max="50" value="'+esc(a.count)+'" oninput="state.adm.count=this.value" title="'+t('adminCount')+'">';
  h += '<input class="form-control form-control-sm" dir="ltr" placeholder="'+t('adminNotePh')+'" value="'+esc(a.note)+'" oninput="state.adm.note=this.value"></div>';
  h += '<button class="btn btn-sm btn-dark" onclick="adminGenerate()">'+t('adminGenBtn')+'</button>';
  if(a.result.length){
    h += '<div class="mt-3">';
    a.result.forEach(function(r){
      h += '<div class="d-flex align-items-center gap-2 mb-2 flex-wrap"><span class="badge border fw-normal att-chip" dir="ltr" style="font-size:.95rem;letter-spacing:1px;padding:6px 10px">'+esc(r.code)+'</span>';
      h += '<span class="small text-secondary">'+t('plan_'+r.plan)+'</span>';
      h += '<button class="btn btn-sm btn-outline-dark" onclick="copyText(\''+esc(r.code)+'\', this)">'+t('payCopy')+'</button>';
      if(/^01[0125]\d{8}$/.test(a.resultNote||'')) h += '<a class="btn btn-sm btn-outline-success" target="_blank" rel="noopener" href="'+adminWaLink(a.resultNote, r.code, r.plan)+'">'+t('adminSendWa')+'</a>';
      h += '</div>';
    });
    h += '</div>';
  }
  h += '</div>';

  // accounts
  h += '<div class="card card-body p-3 mb-3"><h3 class="h6 fw-semibold">'+t('adminFindTitle')+'</h3><div class="d-flex gap-2 mb-2">';
  h += '<input class="form-control form-control-sm" dir="ltr" placeholder="'+t('adminQueryPh')+'" value="'+esc(a.query)+'" oninput="state.adm.query=this.value" onkeydown="if(event.key===\'Enter\') adminSearch()">';
  h += '<button class="btn btn-sm btn-dark" onclick="adminSearch()">'+t('adminSearchBtn')+'</button></div>';
  if(!a.accounts.length) h += '<p class="small text-secondary mb-0">'+t('adminNoResults')+'</p>';
  a.accounts.forEach(function(x){
    h += '<div class="border-top pt-2 mt-2 small"><div class="d-flex justify-content-between gap-2"><b dir="ltr">'+esc(x.id)+'</b><span style="color:var(--paid)">'+esc(adminStatusText(x.status))+'</span></div>';
    h += '<div class="text-secondary" dir="ltr">'+esc(x.email||'—')+' · '+esc(x.phone||'—')+'</div><div class="d-flex flex-wrap gap-1 mt-1">';
    [['month','adminAddMonth'],['year','adminAddYear'],['lifetime','adminLifetimeBtn']].forEach(function(b){
      h += '<button class="btn btn-sm btn-outline-dark" onclick="adminGrant(\''+esc(x.id)+'\',\''+b[0]+'\')">'+t(b[1])+'</button>';
    });
    h += '<button class="btn btn-sm btn-outline-danger" onclick="adminGrant(\''+esc(x.id)+'\',\'revoke\')">'+t('adminRevokeBtn')+'</button></div></div>';
  });
  h += '</div>';

  // unused codes
  h += '<div class="card card-body p-3 mb-3"><h3 class="h6 fw-semibold">'+t('adminUnusedTitle')+'</h3>';
  if(!a.codes.length) h += '<p class="small text-secondary mb-0">–</p>';
  a.codes.forEach(function(c){
    h += '<div class="d-flex align-items-center gap-2 py-1 border-top small flex-wrap"><span dir="ltr" style="letter-spacing:1px">'+esc(c.code)+'</span><span class="text-secondary">'+t('plan_'+c.plan)+'</span><span class="text-secondary nm" dir="ltr">'+esc(c.note||'')+'</span>';
    h += '<button class="btn btn-sm btn-outline-dark" onclick="copyText(\''+esc(c.code)+'\', this)">'+t('payCopy')+'</button>';
    h += '<button class="btn btn-sm btn-outline-danger" onclick="adminVoid(\''+esc(c.code)+'\')">'+t('adminVoid')+'</button></div>';
  });
  return h + '</div>';
}

function renderPayInfo(){
  let h = '<div class="card card-body p-3 mb-3"><h3 class="h6 fw-semibold">'+t('payTitle')+'</h3>';
  h += '<ul class="small mb-2">';
  ['monthly','yearly','lifetime'].forEach(function(p){
    const pr = PAY.prices[p];
    h += '<li>'+t('plan_'+p)+(pr!=null ? ' — '+pr+' ج.م' : '')+'</li>';
  });
  h += '</ul>';
  [['payCard', PAY.card, true], ['payInstapay', PAY.instapay, false]].forEach(function(r){
    h += '<div class="small text-secondary">'+t(r[0])+'</div>';
    h += '<div class="d-flex align-items-center gap-2 mb-2"><span class="badge border fw-normal att-chip" dir="ltr" style="font-size:1rem;letter-spacing:1px;padding:6px 12px">'+r[1]+'</span>';
    h += '<button class="btn btn-sm btn-outline-dark" onclick="copyText(\''+r[1]+'\', this)">'+t('payCopy')+'</button></div>';
  });
  h += '<p class="small mb-2">'+t('payStep')(PAY.whatsappDisplay)+'</p>';
  h += '<a class="btn btn-sm btn-outline-success" target="_blank" rel="noopener" href="'+waLink()+'">'+t('payWhatsapp')+'</a></div>';
  return h;
}
function renderActivation(){
  let h = '<div class="card card-body p-3 mb-3"><h3 class="h6 fw-semibold">'+t('activateTitle')+'</h3>';
  if(state.licenseMsg){ h += '<div class="alert '+(state.licenseOk?'alert-success':'alert-danger')+' py-2 small">'+esc(state.licenseMsg)+'</div>'; }
  h += '<div class="d-flex gap-2"><input id="actCodeInput" class="form-control form-control-sm" dir="ltr" style="text-transform:uppercase;letter-spacing:2px" maxlength="20" placeholder="XXXX-XXXX-XXXX" onkeydown="if(event.key===\'Enter\') redeemCode(this.value)">';
  h += '<button class="btn btn-sm btn-dark" onclick="redeemCode(document.getElementById(\'actCodeInput\').value)">'+t('activateBtn')+'</button></div></div>';
  return h;
}
function renderPaywall(){
  let h = '<div class="mx-auto my-4 px-1"><div class="d-flex gap-2 mb-3">';
  h += '<button class="btn btn-sm rounded-pill btn-outline-dark '+(lang()==='ar'?'active':'')+'" onclick="setLang(\'ar\')">العربية</button>';
  h += '<button class="btn btn-sm rounded-pill btn-outline-dark '+(lang()==='en'?'active':'')+'" onclick="setLang(\'en\')">English</button></div>';
  h += '<h2 class="h4 fw-bold mb-2">'+t('paywallTitle')+'</h2><p class="small text-secondary">'+t('paywallBody')+'</p>';
  h += renderActivation() + renderPayInfo();
  h += '<div class="card card-body p-3 mb-3"><h3 class="h6 fw-semibold">'+t('yourDataTitle')+'</h3><p class="small text-secondary">'+t('yourDataHint')+'</p>';
  h += '<div class="d-flex flex-wrap gap-2"><button class="btn btn-sm btn-outline-dark" onclick="exportCSV()">'+t('exportCsvBtn')+'</button><button class="btn btn-sm btn-outline-dark" onclick="exportPDF()">'+t('exportPdfBtn')+'</button></div></div>';
  h += '<button class="btn btn-sm btn-outline-dark" onclick="doLogout()">'+t('logout')+'</button></div>';
  return h;
}
function renderLicenseSettings(){
  const l = state.license || {}, d = licenseDaysLeft();
  let line = '';
  if(l.state === 'lifetime') line = t('statusLifetime');
  else if(l.state === 'trial') line = t('statusTrial')(d);
  else if(l.state === 'active') line = t('statusActive')(d);
  let h = '<div class="mb-3 pb-3 border-bottom"><h3 class="h6 fw-semibold">'+t('subscriptionTitle')+'</h3>';
  if(line) h += '<p class="small fw-semibold" style="color:var(--paid)">'+esc(line)+'</p>';
  if(l.state !== 'lifetime'){ h += renderActivation() + '<details class="small"><summary class="mb-2">'+t('payTitle')+'</summary>'+renderPayInfo()+'</details>'; }
  return h + '</div>';
}

function renderAuth(){
  let html = '<div class="mx-auto my-5 px-3 att-authwrap"><div class="d-flex justify-content-center gap-2 mb-3">';
  html += '<button class="btn btn-sm rounded-pill btn-outline-dark '+(lang()==='ar'?'active':'')+'" onclick="setLang(\'ar\')">العربية</button>';
  html += '<button class="btn btn-sm rounded-pill btn-outline-dark '+(lang()==='en'?'active':'')+'" onclick="setLang(\'en\')">English</button>';
  html += '</div><div class="card card-body p-4">';
  html += '<h2 class="h4 text-center fw-bold mb-3">'+t('appTitle')+'</h2>';
  if(state.authError) html += '<div class="alert alert-danger py-2 small">'+esc(state.authError)+'</div>';
  html += '<div class="d-flex flex-wrap gap-2" style="justify-content:center;margin-bottom:14px">';
  html += '<button class="btn btn-sm rounded-pill btn-outline-dark '+((state.authMode!=='join' && state.authMode!=='admin')?'active':'')+'" onclick="state.authMode=\'create\'; state.authError=\'\'; render();">'+t('newCodeTab')+'</button>';
  html += '<button class="btn btn-sm rounded-pill btn-outline-dark '+(state.authMode==='join'?'active':'')+'" onclick="state.authMode=\'join\'; state.authError=\'\'; render();">'+t('joinCodeTab')+'</button>';
  html += '</div>';
  if(state.authMode==='admin'){
    html += '<div class="mb-3"><label class="form-label small text-secondary">'+t('adminSecretLabel')+'</label><input id="adminSecretInput" class="form-control form-control-sm" type="password" dir="ltr" onkeydown="if(event.key===\'Enter\') adminLogin(this.value)"></div>';
    html += '<button class="btn btn-dark w-100 mt-1" onclick="adminLogin(document.getElementById(\'adminSecretInput\').value)">'+t('adminLoginBtn')+'</button>';
  } else if(state.authMode==='join'){
    html += '<p class="small text-secondary" style="margin-bottom:8px">'+t('joinCodeHint')+'</p>';
    html += '<div class="mb-3"><input id="joinCodeInput" class="form-control form-control-sm" type="text" style="text-align:center;font-size:1.3rem;letter-spacing:3px;text-transform:uppercase" maxlength="6" placeholder="ABC123" value="'+esc(state.joinCodeDraft||'')+'" oninput="state.joinCodeDraft=this.value"></div>';
    html += '<div class="d-flex flex-wrap gap-2" style="margin-bottom:10px"><button class="btn btn-sm rounded-pill btn-outline-dark '+(state.joinRole!=='assistant'?'active':'')+'" onclick="state.joinRole=\'teacher\'; render();">'+t('joinAsTeacherTab')+'</button>';
    html += '<button class="btn btn-sm rounded-pill btn-outline-dark '+(state.joinRole==='assistant'?'active':'')+'" onclick="state.joinRole=\'assistant\'; render();">'+t('joinAsAssistantTab')+'</button></div>';
    if(state.joinRole!=='assistant'){
      html += '<div class="mb-3"><label class="form-label small text-secondary">'+t('password')+'</label><input id="joinPasswordInput" class="form-control form-control-sm" type="password" onkeydown="if(event.key==\'Enter\') joinWithCode(document.getElementById(\'joinCodeInput\').value, this.value)"></div>';
    }
    html += '<button class="btn btn-dark w-100 mt-1" onclick="joinWithCode(document.getElementById(\'joinCodeInput\').value, document.getElementById(\'joinPasswordInput\')?document.getElementById(\'joinPasswordInput\').value:\'\')">'+t('joinBtn')+'</button>';
  } else {
    html += '<p class="small text-secondary" style="margin-bottom:8px">'+t('newCodeHint')+'</p>';
    html += '<p class="small fw-semibold" style="margin-bottom:12px;color:var(--paid)">'+t('trialNote')+'</p>';
    html += '<div class="mb-3"><label class="form-label small text-secondary">'+t('emailLabel')+'</label><input id="newEmailInput" class="form-control form-control-sm" type="email" dir="ltr" autocomplete="email"></div>';
    html += '<div class="mb-3"><label class="form-label small text-secondary">'+t('phoneLabel')+'</label><input id="newPhoneInput" class="form-control form-control-sm" type="tel" dir="ltr" inputmode="tel" autocomplete="tel" placeholder="01xxxxxxxxx"></div>';
    html += '<div class="mb-3"><label class="form-label small text-secondary">'+t('password')+'</label><input id="newPasswordInput" class="form-control form-control-sm" type="password"></div>';
    html += '<div class="mb-3"><label class="form-label small text-secondary">'+t('confirmPassword')+'</label><input id="newPasswordConfirmInput" class="form-control form-control-sm" type="password" onkeydown="if(event.key===\'Enter\') submitSignup()"></div>';
    html += '<button class="btn btn-dark w-100 mt-1" onclick="submitSignup()">'+t('createCodeBtn')+'</button>';
  }
  html += '</div><div class="text-center mt-3"><a href="#" class="small text-secondary" onclick="state.authMode=\'admin\'; state.authError=\'\'; render(); return false;">'+t('adminLink')+'</a></div></div>';
  return html;
}

function renderHeader(){
  let h = '<div class="d-flex justify-content-between align-items-end gap-2 mb-3 pb-3 att-header"><div><p class="h4 fw-bold mb-0">'+t('appTitle')+'</p><p class="small text-secondary">'+t('memberCount')(state.members.length)+'</p></div>';
  h += '<div class="d-flex gap-1">';
  h += '<button class="btn btn-sm btn-dark '+(state.showGrades?'active':'')+'" onclick="state.showGrades=!state.showGrades; if(!state.showGrades){state.selectedGrade=\'all\'; state.gradesEditMode=false; state.renamingGrade=null;} render();" style="'+(state.showGrades?'background:var(--focus)':'')+'">&#127891;</button>';
  h += '<button class="btn btn-sm btn-dark" onclick="state.screen=\'settings\'; render();">&#9881;</button>';
  h += '<button class="btn btn-sm btn-dark" onclick="state.draftGroup=state.selectedGroup; state.adding=!state.adding; render();">'+t('add')+'</button>';
  h += '</div></div>';
  return h;
}

function renderNotices(){
  let html = '';
  const _p = pauseAt(todayISO());
  if(_p){ html += '<div class="alert alert-info py-2 small">'+esc(t('pauseBanner')(formatDateAr(shiftDay(_p.to, 1)), _p.label))+'</div>'; }
  if(state.pendingSync){
    html += '<div class="alert alert-danger alert-dismissible py-2 small">'+esc(t('pendingSyncBanner'))+'</div>';
  }
  const _d = licenseDaysLeft();
  if(state.license && (state.license.state==='trial' || state.license.state==='active') && _d!==null && _d<=7){
    html += '<div class="alert alert-danger py-2 small d-flex justify-content-between align-items-center gap-2"><span>'+esc(t('expiringBanner')(_d))+'</span><button class="btn btn-sm btn-outline-danger" onclick="state.screen=\'settings\'; render();">'+t('renewBtn')+'</button></div>';
  }
  if(state.welcomeMsg){
    html += '<div class="alert alert-success alert-dismissible py-2 small"><button class="btn-close" onclick="state.welcomeMsg=\'\'; render();"></button>'+esc(state.welcomeMsg)+'</div>';
  }
  if(state.monthlySummaryMsg){
    html += '<div class="alert alert-success alert-dismissible py-2 small"><button class="btn-close" onclick="state.monthlySummaryMsg=\'\'; render();"></button>'+esc(state.monthlySummaryMsg)+'</div>';
  }
  if(!state.dismissedSevere){
    const severe = state.members.filter(function(m){return severity(m.id)==='red';});
    if(severe.length > 0){
      html += '<div class="alert alert-danger alert-dismissible py-2 small"><button class="btn-close" onclick="state.dismissedSevere=true; render();"></button>';
      html += '<div class="fw-bold mb-1">'+t('severeOverdue')(severe.length)+'</div>';
      html += '<div class="d-flex flex-wrap gap-1 mt-1 att-chips">'+severe.map(function(m){return '<span class="badge border fw-normal att-chip clickable" onclick="openDetail(\''+m.id+'\')">'+esc(m.name)+'</span>';}).join('')+'</div></div>';
    }
  }
  return html;
}

function renderGradesBar(){
  if(!state.showGrades) return '';
  const grades = getGrades();
  let html = '<div class="d-flex flex-wrap gap-2" style="margin-bottom:8px">';
  html += '<button class="btn btn-sm rounded-pill btn-outline-dark '+(state.selectedGrade==='all'&&!state.gradesEditMode?'active':'')+'" onclick="'+(state.gradesEditMode?'':'state.selectedGrade=\'all\'; render();')+'">'+t('gradesAll')+'</button>';
  grades.forEach(function(g){
    if(state.gradesEditMode){
      if(state.renamingGrade===g){
        html += '<span class="att-gradechip"><input type="text" value="'+esc(g)+'" autofocus onkeydown="if(event.key==\'Enter\') renameGrade(\''+esc(g)+'\', this.value); if(event.key==\'Escape\'){state.renamingGrade=null; render();}" onblur="renameGrade(\''+esc(g)+'\', this.value)"></span>';
      } else {
        html += '<span class="att-gradechip"><span class="nm" onclick="state.renamingGrade=\''+esc(g)+'\'; render();">'+esc(g)+'</span><span class="del" onclick="removeGrade(\''+esc(g)+'\')">&times;</span></span>';
      }
    } else {
      html += '<button class="btn btn-sm rounded-pill btn-outline-dark '+(state.selectedGrade===g?'active':'')+'" onclick="state.selectedGrade=\''+esc(g)+'\'; render();">'+esc(g)+'</button>';
    }
  });
  if(isTeacher()){
    html += '<button class="btn btn-sm rounded-pill btn-outline-dark" onclick="state.gradesEditMode=!state.gradesEditMode; state.renamingGrade=null; render();">'+(state.gradesEditMode?t('doneEditing'):t('editGrades'))+'</button>';
  }
  html += '</div>';
  if(state.gradesEditMode && isTeacher()){
    html += '<div class="d-flex gap-2" style="display:flex;gap:6px;margin-bottom:10px"><input id="newGradeInput" class="form-control form-control-sm" style="margin-top:0" type="text" placeholder="'+t('gradePlaceholder')+'" onkeydown="if(event.key==\'Enter\'){addGrade(this.value); this.value=\'\';}">';
    html += '<button class="btn btn-sm btn-outline-dark" onclick="addGrade(document.getElementById(\'newGradeInput\').value); document.getElementById(\'newGradeInput\').value=\'\';">'+t('addGradeBtn')+'</button></div>';
  }
  return html;
}

function renderMain(){
  const filteredSorted = getFilteredSorted();
  const presentToday = state.attendance[state.selectedDate] || [];
  const presentInGroup = filteredSorted.filter(function(m){return presentToday.includes(m.id);}).length;
  const nonExempt = filteredSorted.filter(function(m){return !isExempt(m.id);});
  const exemptMembers = filteredSorted.filter(function(m){return isExempt(m.id);});
  const dueMembers = nonExempt.filter(function(m){return currentCycle(m.id) > 0;});
  const notDueMembers = nonExempt.filter(function(m){return currentCycle(m.id) === 0;});
  const paidList = dueMembers.filter(function(m){return severity(m.id) === null;});
  const unpaidList = dueMembers.filter(function(m){return severity(m.id) !== null;});

  let html = renderHeader();
  html += renderNotices();
  html += renderGradesBar();

  if(state.adding){
    html += '<div class="d-flex flex-column gap-2 mb-3"><div class="d-flex gap-2"><input class="form-control form-control-sm" type="text" id="newNameInput" autofocus placeholder="'+t('namePlaceholder')+'" onkeydown="if(event.key==\'Enter\') document.getElementById(\'newPhoneInput\').focus(); if(event.key==\'Escape\'){state.adding=false; render();}">';
    html += '<button class="btn btn-sm btn-dark" onclick="addMember(document.getElementById(\'newNameInput\').value, document.getElementById(\'newPhoneInput\').value, document.getElementById(\'newParentPhoneInput\').value)">+</button></div>';
    html += '<div class="d-flex gap-2"><input type="tel" id="newPhoneInput" placeholder="'+t('phoneLabel')+'" class="form-control form-control-sm">';
    html += '<input type="tel" id="newParentPhoneInput" placeholder="'+t('parentPhoneLabel')+'" onkeydown="if(event.key==\'Enter\') addMember(document.getElementById(\'newNameInput\').value, document.getElementById(\'newPhoneInput\').value, this.value)" class="form-control form-control-sm"></div>';
    const gList = getGrades();
    if(gList.length > 0){
      html += '<div class="small text-secondary">'+t('chooseGradeFirst')+'</div><div class="d-flex flex-wrap gap-2">';
      html += '<button class="btn btn-sm rounded-pill btn-outline-dark '+(!state.draftGrade?'active':'')+'" onclick="setDraftGrade(null)">'+t('noGrade')+'</button>';
      gList.forEach(function(g){ html += '<button class="btn btn-sm rounded-pill btn-outline-dark '+(state.draftGrade===g?'active':'')+'" onclick="setDraftGrade(\''+esc(g)+'\')">'+esc(g)+'</button>'; });
      html += '</div>';
    }
    const opts = timeOptionsForGrade(state.draftGrade);
    if(opts.length > 0 && !state.draftManual){
      html += '<div class="small text-secondary">'+t('availableTimes')+'</div><div class="d-flex flex-wrap gap-2">';
      opts.forEach(function(o){
        html += '<button class="btn btn-sm rounded-pill btn-outline-dark '+(state.draftGroup===o.group && state.draftHourSlot===o.slot?'active':'')+'" onclick="pickTime(\''+o.group+'\', \''+esc(o.slot)+'\')">'+esc(timeText(o.group, o.slot))+'</button>';
      });
      html += '<button class="btn btn-sm btn-link text-secondary" onclick="state.draftManual=true; render();">'+t('otherTime')+'</button></div>';
      if(state.draftHourSlot && opts.some(function(o){return o.group===state.draftGroup && o.slot===state.draftHourSlot;})){
        html += '<div class="alert alert-success py-2 small mb-0">'+esc(t('assignedTime')(timeText(state.draftGroup, state.draftHourSlot)))+'</div>';
      }
    } else {
      html += '<div class="d-flex flex-wrap gap-2">';
      GROUPS.forEach(function(g){ html += '<button class="btn btn-sm rounded-pill btn-outline-dark '+(state.draftGroup===g.id?'active':'')+'" onclick="state.draftGroup=\''+g.id+'\'; state.draftHourSlot=null; render();">'+t('groupLabel')[g.id]+'</button>'; });
      html += '</div>';
      const draftSlots = getHourSlots(state.draftGroup);
      if(draftSlots.length > 0){
        html += '<div class="d-flex flex-wrap gap-2">';
        html += '<button class="btn btn-sm rounded-pill btn-outline-dark '+(!state.draftHourSlot?'active':'')+'" onclick="state.draftHourSlot=null; render();">'+t('noHourSlot')+'</button>';
        draftSlots.forEach(function(slot){
          html += '<button class="btn btn-sm rounded-pill btn-outline-dark '+(state.draftHourSlot===slot?'active':'')+'" onclick="state.draftHourSlot=\''+esc(slot)+'\'; render();">'+esc(slot)+'</button>';
        });
        html += '</div>';
      }
    }
    html += '</div>';
  }

  html += '<div class="d-flex gap-2 mb-2">';
  GROUPS.forEach(function(g){
    const cnt = state.members.filter(function(m){return m.group===g.id;}).length;
    html += '<button class="btn btn-outline-dark flex-fill d-flex flex-column align-items-center py-2 att-grouptab '+(state.selectedGroup===g.id?'active':'')+'" onclick="state.selectedGroup=\''+g.id+'\'; state.selectedHourSlot=\'all\'; render();">';
    html += '<span class="n">'+cnt+'</span><span>'+t('groupLabel')[g.id]+'</span></button>';
  });
  html += '</div>';
  const curGroup = GROUPS.find(function(g){return g.id===state.selectedGroup;});
  html += '<div class="small text-secondary mb-2">'+t('groupDaysPrefix')+' '+groupDaysLabel(curGroup)+'</div>';

  const curSlots = getHourSlots(state.selectedGroup);
  if(curSlots.length > 0){
    html += '<div class="d-flex flex-wrap gap-2" style="margin-bottom:12px">';
    html += '<button class="btn btn-sm rounded-pill btn-outline-dark '+(state.selectedHourSlot==='all'?'active':'')+'" onclick="state.selectedHourSlot=\'all\'; render();">'+t('allHours')+'</button>';
    curSlots.forEach(function(slot){
      html += '<button class="btn btn-sm rounded-pill btn-outline-dark '+(state.selectedHourSlot===slot?'active':'')+'" onclick="state.selectedHourSlot=\''+esc(slot)+'\'; render();">'+esc(slot)+'</button>';
    });
    html += '</div>';
  }

  html += '<div class="nav nav-tabs nav-fill mb-3">';
  const tabs = [
    {id:'attendance', label:t('tabAttendance'), count: presentInGroup+'/'+filteredSorted.length},
    {id:'paid', label:t('tabPaid'), count: paidList.length},
    {id:'unpaid', label:t('tabUnpaid'), count: unpaidList.length}
  ];
  tabs.forEach(function(tb){
    html += '<button class="nav-link d-flex flex-column align-items-center att-tab '+(state.tab===tb.id?'active':'')+'" onclick="state.tab=\''+tb.id+'\'; render();">';
    html += '<span class="n">'+tb.count+'</span><span>'+tb.label+'</span></button>';
  });
  html += '</div>';

  html += '<div class="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-2">';
  if(state.tab==='attendance'){
    html += '<div class="d-flex align-items-center gap-1 small"><button class="btn btn-sm btn-outline-dark" onclick="state.selectedDate=shiftDay(state.selectedDate,-1); render();">&#8594;</button>';
    html += '<span class="fw-bold att-datelabel">'+formatDateAr(state.selectedDate)+'</span>';
    html += '<button class="btn btn-sm btn-outline-dark" onclick="state.selectedDate=shiftDay(state.selectedDate,1); render();">&#8592;</button>';
    html += '<span class="att-caldwrap"><button class="btn btn-sm btn-dark att-calbtn" tabindex="-1">&#128197;</button><input class="att-realdate" type="date" value="'+state.selectedDate+'" onchange="onDateChange(this.value)"></span>';
    html += '</div>';
  } else { html += '<div></div>'; }
  html += '<div class="d-flex align-items-center gap-2"><div class="input-group input-group-sm att-search"><span class="input-group-text">&#128269;</span><input class="form-control" placeholder="'+t('searchPlaceholder')+'" value="'+esc(state.search)+'" oninput="onSearchInput(this)"></div>';
  html += '<button class="btn btn-sm btn-outline-dark" onclick="state.sortDir=state.sortDir===\'asc\'?\'desc\':\'asc\'; render();">'+(state.sortDir==='asc'?t('sortAsc'):t('sortDesc'))+'</button></div>';
  html += '</div>';

  html += '<div class="list-group list-group-flush border-top">';

  if(state.tab==='attendance'){
    if(filteredSorted.length===0){
      html += '<div class="text-center text-secondary small py-4">'+t('noMembersInGroup')+'</div>';
    } else {
      filteredSorted.forEach(function(m,i){
        const present = presentToday.includes(m.id);
        const exempt = isExempt(m.id);
        const cCount = cycleCount(m.id);
        const inCycle = (cCount % CYCLE_LENGTH === 0 && cCount > 0) ? CYCLE_LENGTH : cCount % CYCLE_LENGTH;
        const sev = severity(m.id);
        html += '<div class="list-group-item d-flex align-items-center gap-2 px-1 att-row"><span class="seq">'+(i+1)+'</span>';
        html += '<button class="btn btn-link text-decoration-none text-body text-start p-0 flex-grow-1 fw-medium" onclick="openDetail(\''+m.id+'\')">&#128100; '+esc(m.name)+'</button>';
        if(exempt){ html += '<span class="badge rounded-pill att-flag exempt">'+t('flagExempt')+'</span>'; }
        else {
          if(!isMonthly()) html += '<span class="badge rounded-pill border fw-normal text-secondary att-progress">'+inCycle+'/'+CYCLE_LENGTH+'</span>';
          if(sev==='orange') html += '<span class="badge rounded-pill att-flag orange">'+t('flagOverdue')+'</span>';
          if(sev==='red') html += '<span class="badge rounded-pill att-flag red">'+t('flagVeryOverdue')+'</span>';
        }
        html += '<button class="btn btn-sm btn-outline-dark rounded-circle att-check '+(present?'active':'')+'" onclick="toggleAttendance(\''+m.id+'\')">'+(present?'&#10003;':'')+'</button>';
        if(isTeacher()){ html += '<button class="btn btn-sm btn-link text-secondary p-1" onclick="removeMember(\''+m.id+'\')">&#128465;</button>'; }
        html += '</div>';
      });
    }
  } else if(state.tab==='paid'){
    if(paidList.length===0){ html += '<div class="text-center text-secondary small py-4">'+t('noPaidYet')+'</div>'; }
    else {
      paidList.forEach(function(m,i){
        const cycle = currentCycle(m.id);
        const amt = state.payments[m.id][cycle].amount;
        html += '<div class="list-group-item d-flex align-items-center gap-2 px-1 att-row"><span class="seq">'+(i+1)+'</span><button class="btn btn-link text-decoration-none text-body text-start p-0 flex-grow-1 fw-medium" onclick="openDetail(\''+m.id+'\')">'+esc(m.name)+'</button>';
        html += '<span class="badge rounded-pill border fw-normal text-secondary att-progress">'+cycleBadge(m.group, cycle)+'</span>';
        html += '<input class="form-control form-control-sm att-amount" type="number" value="'+amt+'" onchange="updatePaidAmount(\''+m.id+'\', '+cycle+', this.value)">';
        html += '<button class="btn btn-sm btn-outline-danger" onclick="markUnpaidCycle(\''+m.id+'\', '+cycle+')">'+t('markUnpaid')+'</button></div>';
      });
    }
  } else {
    if(unpaidList.length===0){ html += '<div class="text-center text-secondary small py-4">'+t('noUnpaidDue')+'</div>'; }
    else {
      unpaidList.forEach(function(m,i){
        const cycle = currentCycle(m.id);
        const sev = severity(m.id);
        const draft = state.amountDrafts[m.id] != null ? state.amountDrafts[m.id] : '';
        html += '<div class="list-group-item d-flex align-items-center gap-2 px-1 att-row"><span class="seq">'+(i+1)+'</span><button class="btn btn-link text-decoration-none text-body text-start p-0 flex-grow-1 fw-medium" onclick="openDetail(\''+m.id+'\')">'+esc(m.name)+'</button>';
        if(isMonthly()) html += '<span class="badge rounded-pill border fw-normal text-secondary att-progress">'+esc(cycleName(m.group, unpaidCycleList(m.id)[0]))+'</span>';
        html += '<span class="badge rounded-pill att-flag '+(sev==='red'?'red':'orange')+'">'+(sev==='red'?t('flagVeryOverdue'):t('flagOverdue'))+'</span>';
        html += '<input class="form-control form-control-sm att-amount" type="number" placeholder="'+state.settings.fee+'" value="'+draft+'" oninput="state.amountDrafts[\''+m.id+'\']=this.value">';
        html += '<button class="btn btn-sm btn-outline-success" onclick="markPaidCycle(\''+m.id+'\', '+cycle+')">'+t('markPaid')+'</button></div>';
      });
    }
    if(notDueMembers.length > 0){
      html += '<div class="small text-secondary py-2">'+(isMonthly() ? t('notDuePrefixMonthly') : t('notDuePrefix'))+'<div class="d-flex flex-wrap gap-1 mt-1 att-chips">';
      html += notDueMembers.map(function(m){return '<span class="badge border fw-normal att-chip">'+esc(m.name)+(isMonthly() ? '' : ' · '+cycleCount(m.id)+'/'+CYCLE_LENGTH)+'</span>';}).join('');
      html += '</div></div>';
    }
    if(exemptMembers.length > 0){
      html += '<div class="small text-secondary py-2">'+t('exemptPrefix')+'<div class="d-flex flex-wrap gap-1 mt-1 att-chips">';
      html += exemptMembers.map(function(m){return '<span class="badge border fw-normal att-chip">'+esc(m.name)+'</span>';}).join('');
      html += '</div></div>';
    }
  }
  html += '</div>';
  return html;
}

function renderDetail(){
  const m = state.members.find(function(x){return x.id===state.selectedMemberId;});
  if(!m){ state.screen='main'; return renderMain(); }
  const hist = getHistory(m.id);
  const count = attendanceCount(m.id);
  const cycle = currentCycle(m.id);
  const sev = severity(m.id);
  const exempt = isExempt(m.id);
  let html = '<button class="btn btn-sm btn-outline-dark mb-3" onclick="state.screen=\'main\'; render();">'+t('back')+'</button>';
  html += '<h2 class="h4 fw-bold mb-3">'+esc(m.name)+'</h2>';

  html += '<div class="mb-3 pb-3 border-bottom"><h3 class="h6 fw-semibold">'+t('groupSection')+'</h3><div class="d-flex flex-wrap gap-2">';
  GROUPS.forEach(function(g){ html += '<button class="btn btn-sm rounded-pill btn-outline-dark '+(m.group===g.id?'active':'')+'" onclick="moveMemberGroup(\''+m.id+'\', \''+g.id+'\')">'+t('groupLabel')[g.id]+'</button>'; });
  html += '</div></div>';

  const detailSlots = getHourSlots(m.group);
  if(detailSlots.length > 0){
    html += '<div class="mb-3 pb-3 border-bottom"><h3 class="h6 fw-semibold">'+t('hourSlotSection')+'</h3><div class="d-flex flex-wrap gap-2">';
    html += '<button class="btn btn-sm rounded-pill btn-outline-dark '+(!m.hourSlot?'active':'')+'" onclick="moveMemberHourSlot(\''+m.id+'\', null)">'+t('noHourSlot')+'</button>';
    detailSlots.forEach(function(slot){
      html += '<button class="btn btn-sm rounded-pill btn-outline-dark '+(m.hourSlot===slot?'active':'')+'" onclick="moveMemberHourSlot(\''+m.id+'\', \''+esc(slot)+'\')">'+esc(slot)+'</button>';
    });
    html += '</div></div>';
  }

  const detailGrades = getGrades();
  if(detailGrades.length > 0){
    html += '<div class="mb-3 pb-3 border-bottom"><h3 class="h6 fw-semibold">'+t('gradeSection')+'</h3><div class="d-flex flex-wrap gap-2">';
    html += '<button class="btn btn-sm rounded-pill btn-outline-dark '+(!m.grade?'active':'')+'" onclick="setMemberGrade(\''+m.id+'\', null)">'+t('noGrade')+'</button>';
    detailGrades.forEach(function(g){ html += '<button class="btn btn-sm rounded-pill btn-outline-dark '+(m.grade===g?'active':'')+'" onclick="setMemberGrade(\''+m.id+'\', \''+esc(g)+'\')">'+esc(g)+'</button>'; });
    html += '</div></div>';
  }

  html += '<div class="mb-3 pb-3 border-bottom"><h3 class="h6 fw-semibold">'+t('contactSection')+'</h3>';
  html += '<p class="small text-secondary">'+t('phoneLabel')+'</p><div style="display:flex;gap:6px;align-items:center;margin-bottom:8px">';
  html += '<input type="tel" class="form-control form-control-sm" style="margin-top:0" value="'+esc(m.phone||'')+'" placeholder="'+t('noPhone')+'" onchange="updateMemberContact(\''+m.id+'\',\'phone\',this.value)">';
  if(m.phone){ html += '<a class="btn btn-sm btn-outline-dark" href="tel:'+esc(m.phone)+'" style="text-decoration:none;white-space:nowrap">'+t('call')+'</a>'; }
  html += '</div>';
  html += '<p class="small text-secondary">'+t('parentPhoneLabel')+'</p><div style="display:flex;gap:6px;align-items:center">';
  html += '<input type="tel" class="form-control form-control-sm" style="margin-top:0" value="'+esc(m.parentPhone||'')+'" placeholder="'+t('noPhone')+'" onchange="updateMemberContact(\''+m.id+'\',\'parentPhone\',this.value)">';
  if(m.parentPhone){ html += '<a class="btn btn-sm btn-outline-dark" href="tel:'+esc(m.parentPhone)+'" style="text-decoration:none;white-space:nowrap">'+t('call')+'</a>'; }
  html += '</div></div>';

  html += '<div class="mb-3 pb-3 border-bottom"><label class="d-flex align-items-center gap-2 small"><input class="form-check-input mt-0" type="checkbox" '+(exempt?'checked':'')+(isTeacher()?' onchange="toggleExempt(\''+m.id+'\')"':' disabled')+'> '+t('exemptCheckbox')+(isTeacher()?'':' <span class="small text-secondary">('+t('teacherOnlyNote')+')</span>')+'</label></div>';

  html += '<div class="mb-3 pb-3 border-bottom"><h3 class="h6 fw-semibold">'+t('attendanceSection')+'</h3><p class="small text-secondary">'+t('totalAttendance')(count)+'</p>';
  html += hist.days.length===0 ? '<span class="small text-secondary">'+t('noAttendanceYet')+'</span>' :
    '<div class="d-flex flex-wrap gap-1 mt-1 att-chips">'+hist.days.map(function(d){return '<span class="badge border fw-normal att-chip">'+formatDateAr(d)+'</span>';}).join('')+'</div>';
  html += '</div>';

  const missed = missedDays(m.id);
  html += '<div class="mb-3 pb-3 border-bottom"><h3 class="h6 fw-semibold">'+t('absenceSection')+'</h3><p class="small text-secondary">'+t('absenceHint')(groupDaysLabel(GROUPS.find(function(g){return g.id===m.group;})))+'</p>';
  html += missed.length===0 ? '<span class="small text-secondary">'+t('noAbsences')+'</span>' :
    '<div class="d-flex flex-wrap gap-1 mt-1 att-chips">'+missed.map(function(d){return '<span class="badge border fw-normal att-chip" style="border-color:var(--unpaid);color:var(--unpaid);background:var(--unpaid-bg)">'+formatDateAr(d)+'</span>';}).join('')+'</div>';
  html += '</div>';

  html += '<div class="mb-3 pb-3 border-bottom"><h3 class="h6 fw-semibold">'+t('collectionSection')+'</h3>';
  if(!exempt && cycle >= 1){
    if(sev){
      html += '<p class="small text-secondary">'+t('statusOf')(cycleName(m.group, cycle))+' <span class="badge rounded-pill att-flag '+(sev==='red'?'red':'orange')+'">'+(sev==='red'?t('flagVeryOverdue'):t('flagOverdue'))+'</span></p>';
      html += '<button class="btn btn-sm btn-outline-success" onclick="markPaidCycle(\''+m.id+'\', '+cycle+')">'+t('markPaid')+'</button>';
    } else {
      html += '<p class="small text-secondary">'+t('currentPaid')+'</p>';
      html += '<button class="btn btn-sm btn-outline-danger" onclick="markUnpaidCycle(\''+m.id+'\', '+cycle+')">'+t('markUnpaid')+'</button>';
    }
  } else if(!exempt){
    html += '<p class="small text-secondary">'+(isMonthly() ? monthlyNotDueText(m) : t('notYetDue')(cycleCount(m.id)))+'</p>';
  } else {
    html += '<p class="small text-secondary">'+t('exemptNotice')+'</p>';
  }
  html += hist.paidCycles.length===0 ? '<p class="small text-secondary">'+t('noPaymentHistory')+'</p>' :
    '<div class="d-flex flex-wrap gap-1 mt-1 att-chips">'+hist.paidCycles.map(function(e){return '<span class="badge border fw-normal att-chip pay">'+cycleBadge(m.group, e[0])+' · '+e[1].amount+' ج.م</span>';}).join('')+'</div>';
  html += '</div>';

  if(!exempt){
    const advDraft = state.advanceDrafts[m.id] || {};
    html += '<div class="mb-3 pb-3 border-bottom"><h3 class="h6 fw-semibold">'+t('advancePaymentTitle')+'</h3><p class="small text-secondary">'+t('advancePaymentHint')+'</p>';
    html += '<div style="display:flex;gap:6px;margin-top:6px">';
    html += '<input type="number" min="1" class="form-control form-control-sm att-amount" style="width:5.5rem" placeholder="'+t('advanceCountPlaceholder')+'" value="'+(advDraft.count||'')+'" oninput="state.advanceDrafts[\''+m.id+'\']=Object.assign({},state.advanceDrafts[\''+m.id+'\'],{count:this.value})">';
    html += '<input type="number" min="0" class="form-control form-control-sm att-amount" style="width:8rem" placeholder="'+t('advanceAmountPlaceholder')+'" value="'+(advDraft.amount||'')+'" oninput="state.advanceDrafts[\''+m.id+'\']=Object.assign({},state.advanceDrafts[\''+m.id+'\'],{amount:this.value})">';
    html += '<button class="btn btn-sm btn-outline-dark" onclick="payAdvance(\''+m.id+'\', (state.advanceDrafts[\''+m.id+'\']||{}).count, (state.advanceDrafts[\''+m.id+'\']||{}).amount)">'+t('advancePaymentBtn')+'</button>';
    html += '</div></div>';
  }

  if(isTeacher()){ html += '<button class="btn btn-sm btn-outline-danger" onclick="removeMember(\''+m.id+'\')">'+t('deleteMember')+'</button>'; }
  return html;
}

function renderSettings(){
  const summary = paymentsSummary();
  let html = '<button class="btn btn-sm btn-outline-dark mb-3" onclick="state.screen=\'main\'; render();">'+t('back')+'</button>';
  html += '<h2 class="h4 fw-bold mb-3">'+t('settingsTitle')+'</h2>';

  html += '<div class="mb-3 pb-3 border-bottom"><h3 class="h6 fw-semibold">'+t('accountTitle')+'</h3><p class="small text-secondary">'+t('teacherCodeLabel')+'</p>';
  html += '<div class="d-flex flex-wrap gap-2"><span class="badge border fw-normal att-chip" style="font-size:1rem;letter-spacing:2px;padding:6px 14px">'+esc(state.teacherCode||'')+'</span>';
  if(!isTeacher()){ html += '<span class="badge rounded-pill att-flag orange">'+t('assistantBadge')+'</span>'; }
  html += '<button class="btn btn-sm btn-outline-dark" onclick="copyTeacherCode()">'+t('copyCode')+'</button></div>';
  if(state.syncStatus){ html += '<p class="small text-secondary mt-1">'+esc(state.syncStatus)+'</p>'; }
  html += '<div class="d-flex flex-wrap gap-2" style="margin-top:8px"><button class="btn btn-sm btn-outline-dark" onclick="syncNow()">'+t('syncNow')+'</button><button class="btn btn-sm btn-outline-dark" onclick="doLogout()">'+t('logout')+'</button></div></div>';

  html += renderLicenseSettings();

  if(isTeacher()){
    html += '<div class="mb-3 pb-3 border-bottom"><h3 class="h6 fw-semibold">'+t('teacherPasswordTitle')+'</h3><p class="small text-secondary">'+t('teacherPasswordHint')+'</p>';
    html += '<input id="teacherPasswordInput" class="form-control form-control-sm" type="password" placeholder="'+t('password')+'" value="">';
    html += '<button class="btn btn-sm btn-outline-dark" style="margin-top:6px" onclick="saveTeacherPassword(document.getElementById(\'teacherPasswordInput\').value)">'+t('changePasswordBtn')+'</button>';
    html += '</div>';
  }

  html += '<div class="mb-3 pb-3 border-bottom"><h3 class="h6 fw-semibold">'+t('languageTitle')+'</h3><div class="d-flex flex-wrap gap-2">';
  html += '<button class="btn btn-sm rounded-pill btn-outline-dark '+(lang()==='ar'?'active':'')+'" onclick="setLang(\'ar\')">العربية</button>';
  html += '<button class="btn btn-sm rounded-pill btn-outline-dark '+(lang()==='en'?'active':'')+'" onclick="setLang(\'en\')">English</button>';
  html += '</div></div>';

  if(isTeacher()){
  html += '<div class="mb-3 pb-3 border-bottom"><h3 class="h6 fw-semibold">'+t('feeTitle')+'</h3><input class="form-control form-control-sm" type="number" value="'+state.settings.fee+'" onchange="saveFeeValue(this.value)">';
  html += '<p class="small text-secondary">'+t('feeHint')+'</p></div>';

  html += '<div class="mb-3 pb-3 border-bottom"><h3 class="h6 fw-semibold">'+t('payPlanTitle')+'</h3><div class="d-flex flex-wrap gap-2">';
  [['sessions','planSessions'],['month_start','planMonthStart'],['month_end','planMonthEnd']].forEach(function(p){
    html += '<button class="btn btn-sm rounded-pill btn-outline-dark '+(payPlan()===p[0]?'active':'')+'" onclick="setPayPlan(\''+p[0]+'\')">'+t(p[1])+'</button>';
  });
  html += '</div><p class="small text-secondary mt-2 mb-0">'+t('payPlanHint')+'</p></div>';

  const _sy = state.settings.schoolYear || {};
  html += '<div class="mb-3 pb-3 border-bottom"><h3 class="h6 fw-semibold">'+t('schoolYearTitle')+'</h3><p class="small text-secondary mb-2">'+t('schoolYearHint')+'</p><div class="d-flex flex-wrap align-items-center gap-2">';
  html += '<label class="small text-secondary">'+t('termStart')+'</label><input type="date" class="form-control form-control-sm" style="width:auto" value="'+esc(_sy.start||'')+'" onchange="setSchoolYear(\'start\', this.value)">';
  html += '<label class="small text-secondary">'+t('termEnd')+'</label><input type="date" class="form-control form-control-sm" style="width:auto" value="'+esc(_sy.end||'')+'" onchange="setSchoolYear(\'end\', this.value)"></div></div>';

  html += '<div class="mb-3 pb-3 border-bottom"><h3 class="h6 fw-semibold">'+t('pauseTitle')+'</h3><p class="small text-secondary mb-2">'+t('pauseHint')+'</p>';
  const _ps = state.settings.pauses || [];
  if(_ps.length === 0) html += '<p class="small text-secondary">'+t('pauseNone')+'</p>';
  _ps.forEach(function(p, i){
    html += '<div class="d-flex align-items-center gap-2 mb-2 small"><span class="badge border fw-normal att-chip">'+esc(p.label||t('pauseDefault'))+'</span><span dir="ltr">'+esc(p.from)+' → '+esc(p.to)+'</span><button class="btn btn-sm btn-outline-danger" onclick="removePause('+i+')">'+t('pauseRemove')+'</button></div>';
  });
  html += '<div class="d-flex flex-wrap align-items-center gap-2"><input id="pauseLabel" class="form-control form-control-sm" style="width:9rem" placeholder="'+t('pauseLabelPh')+'">';
  html += '<input id="pauseFrom" type="date" class="form-control form-control-sm" style="width:auto"><span class="small text-secondary">→</span><input id="pauseTo" type="date" class="form-control form-control-sm" style="width:auto">';
  html += '<button class="btn btn-sm btn-dark" onclick="addPause()">'+t('pauseAddBtn')+'</button></div></div>';

  html += '<div class="mb-3 pb-3 border-bottom"><h3 class="h6 fw-semibold">'+t('termTitle')+'</h3><p class="small text-secondary mb-1">'+t('termHint')+'</p>';
  GROUPS.forEach(function(g){
    const tm = getTerm(g.id);
    html += '<p class="small fw-semibold mb-1 mt-2">'+t('groupLabel')[g.id]+'</p><div class="d-flex flex-wrap align-items-center gap-2">';
    html += '<label class="small text-secondary">'+t('termStart')+'</label><input type="date" class="form-control form-control-sm" style="width:auto" value="'+esc(tm.start)+'" onchange="setTermDate(\''+g.id+'\',\'start\',this.value)">';
    html += '<label class="small text-secondary">'+t('termEnd')+'</label><input type="date" class="form-control form-control-sm" style="width:auto" value="'+esc(tm.end)+'" onchange="setTermDate(\''+g.id+'\',\'end\',this.value)"></div>';
    if(isMonthly()){
      const sch = monthSchedule(g.id);
      html += '<p class="small text-secondary mb-0">'+(sch.length ? t('termInfo')(sch.length, formatDateAr(sch[0].due)) : t('setStartDate'))+'</p>';
    }
  });
  html += '</div>';

  html += '<div class="mb-3 pb-3 border-bottom"'+(isMonthly()?' hidden':'')+'><h3 class="h6 fw-semibold">'+t('cycleModeTitle')+'</h3><div class="d-flex flex-wrap gap-2">';
  html += '<button class="btn btn-sm rounded-pill btn-outline-dark '+(state.settings.cycleMode!=='group'?'active':'')+'" onclick="state.settings.cycleMode=\'personal\'; persistSettings(); render();">'+t('cycleModePersonal')+'</button>';
  html += '<button class="btn btn-sm rounded-pill btn-outline-dark '+(state.settings.cycleMode==='group'?'active':'')+'" onclick="state.settings.cycleMode=\'group\'; persistSettings(); render();">'+t('cycleModeGroup')+'</button>';
  html += '</div><p class="small text-secondary">'+t('cycleModeHint')+'</p></div>';

  html += '<div class="mb-3 pb-3 border-bottom"><h3 class="h6 fw-semibold">'+t('hourSlotsTitle')+'</h3>';
  GROUPS.forEach(function(g){
    const slots = getHourSlots(g.id);
    html += '<p class="small text-secondary" style="margin-top:10px;font-weight:700;color:var(--ink)">'+t('groupLabel')[g.id]+'</p>';
    html += '<div class="d-flex flex-wrap gap-1 mt-1 att-chips">';
    if(slots.length === 0){ html += '<span class="small text-secondary">'+t('noHourSlot')+'</span>'; }
    else slots.forEach(function(slot){
      html += '<span class="badge border fw-normal att-chip">'+esc(slot)+' <span style="cursor:pointer;color:var(--unpaid);font-weight:700" onclick="removeHourSlot(\''+g.id+'\', \''+esc(slot)+'\')">&times;</span></span>';
    });
    html += '</div>';
    html += '<div class="d-flex flex-wrap gap-2" style="margin-top:6px"><input id="hourSlotInput_'+g.id+'" class="form-control form-control-sm" style="margin-top:0;flex:1;min-width:8rem;width:auto" type="text" placeholder="'+t('hourSlotPlaceholder')+'" onkeydown="if(event.key===\'Enter\'){submitHourSlot(\''+g.id+'\');}">';
    if(getGrades().length > 0){
      html += '<select id="hourSlotGrade_'+g.id+'" class="form-select form-select-sm" style="width:auto"><option value="">'+t('slotAllGrades')+'</option>';
      getGrades().forEach(function(gr){ html += '<option value="'+esc(gr)+'">'+esc(gr)+'</option>'; });
      html += '</select>';
    }
    html += '<button class="btn btn-sm btn-outline-dark" onclick="submitHourSlot(\''+g.id+'\')">'+t('addHourSlotBtn')+'</button></div>';
  });
  html += '</div>';
  }

  html += '<div class="mb-3 pb-3 border-bottom"><h3 class="h6 fw-semibold">'+t('fontSizeTitle')+'</h3><div class="d-flex flex-wrap gap-2">';
  [['small',t('small')],['medium',t('medium')],['large',t('large')]].forEach(function(pair){
    html += '<button class="btn btn-sm rounded-pill btn-outline-dark '+(state.settings.fontSize===pair[0]?'active':'')+'" onclick="setFontSize(\''+pair[0]+'\')">'+pair[1]+'</button>';
  });
  html += '</div></div>';

  html += '<div class="mb-3 pb-3 border-bottom"><label class="d-flex align-items-center gap-2 small"><input class="form-check-input mt-0" type="checkbox" '+(state.settings.highContrast?'checked':'')+' onchange="setHighContrast(this.checked)"> '+t('highContrastLabel')+'</label></div>';

  if(isTeacher()){
  html += '<div class="mb-3 pb-3 border-bottom"><h3 class="h6 fw-semibold">'+t('exemptListTitle')+'</h3><div class="border rounded p-1 att-settingslist">';
  if(state.members.length===0){ html += '<p class="small text-secondary">'+t('noMembersYet')+'</p>'; }
  else state.members.forEach(function(m){
    html += '<div class="d-flex align-items-center gap-2 py-1 border-bottom small"><input class="form-check-input mt-0" type="checkbox" '+(m.exempt?'checked':'')+' onchange="toggleExempt(\''+m.id+'\')"><span class="nm">'+esc(m.name)+'</span><span class="small text-secondary">'+t('groupLabel')[m.group]+'</span></div>';
  });
  html += '</div></div>';

  html += '<div class="mb-3 pb-3 border-bottom"><h3 class="h6 fw-semibold">'+t('bulkMoveTitle')+'</h3><div class="border rounded p-1 att-settingslist">';
  if(state.members.length===0){ html += '<p class="small text-secondary">'+t('noMembersYet')+'</p>'; }
  else state.members.forEach(function(m){
    html += '<div class="d-flex align-items-center gap-2 py-1 border-bottom small"><input class="form-check-input mt-0" type="checkbox" '+(state.bulkSelected[m.id]?'checked':'')+' onchange="state.bulkSelected[\''+m.id+'\']=this.checked"><span class="nm">'+esc(m.name)+'</span><span class="small text-secondary">'+t('groupLabel')[m.group]+'</span></div>';
  });
  html += '</div><div class="d-flex flex-wrap gap-2" style="margin-top:8px">';
  GROUPS.forEach(function(g){ html += '<button class="btn btn-sm rounded-pill btn-outline-dark '+(state.bulkTargetGroup===g.id?'active':'')+'" onclick="state.bulkTargetGroup=\''+g.id+'\'; render();">'+t('groupLabel')[g.id]+'</button>'; });
  html += '</div><button class="btn btn-sm btn-dark" style="margin-top:8px" onclick="bulkMove()">'+t('bulkMoveBtn')+'</button></div>';
  }

  html += '<div class="mb-3 pb-3 border-bottom"><h3 class="h6 fw-semibold">'+t('summaryTitle')+'</h3><table class="table table-sm mb-0">';
  html += '<tr><td>'+t('summaryTotal')+'</td><td>'+summary.total+' ج.م</td></tr>';
  GROUPS.forEach(function(g){ html += '<tr><td>'+t('groupLabel')[g.id]+'</td><td>'+(summary.byGroup[g.id]||0)+' ج.م</td></tr>'; });
  const cycles = Object.keys(summary.byCycle).sort(function(a,b){ return (isNaN(a)||isNaN(b)) ? (a<b?-1:a>b?1:0) : Number(a)-Number(b); });
  if(cycles.length===0){ html += '<tr><td colspan="2" class="small text-secondary">'+t('summaryNoData')+'</td></tr>'; }
  else cycles.forEach(function(c){ html += '<tr><td>'+(isMonthly() ? t('summaryMonthRow')(monthLabel(c) || c) : t('summaryCycleRow')(c))+'</td><td>'+summary.byCycle[c]+' ج.م</td></tr>'; });
  html += '</table></div>';

  html += '<div class="mb-3 pb-3 border-bottom"><h3 class="h6 fw-semibold">'+t('importTitle')+'</h3><p class="small text-secondary">'+t('importHint')+'</p>';
  html += '<input id="importFileInput" type="file" accept=".xlsx,.xls,.csv" style="display:none" onchange="handleImportFile(this)">';
  html += '<div class="d-flex flex-wrap gap-2"><button class="btn btn-sm btn-outline-dark" onclick="document.getElementById(\'importFileInput\').click()">'+t('importBtn')+'</button>';
  html += '<button class="btn btn-sm btn-outline-dark" onclick="downloadImportTemplate()">'+t('downloadTemplateBtn')+'</button></div>';
  if(state.importStatus){ html += '<p class="small text-secondary mt-1">'+esc(state.importStatus)+'</p>'; }
  html += '</div>';

  html += '<div class="mb-3 pb-3 border-bottom"><h3 class="h6 fw-semibold">'+t('exportTitle')+'</h3><p class="small text-secondary">'+t('exportHint')+'</p>';
  html += '<div class="d-flex flex-wrap gap-2"><button class="btn btn-sm btn-outline-dark" onclick="exportCSV()">'+t('exportCsvBtn')+'</button>';
  html += '<button class="btn btn-sm btn-outline-dark" onclick="exportPDF()">'+t('exportPdfBtn')+'</button></div></div>';

  if(isTeacher()){
  html += '<div class="mb-3 pb-3"><h3 class="h6 fw-semibold">'+t('deleteAllTitle')+'</h3><p class="small text-secondary">'+t('deleteAllHint')+'</p>';
  html += '<button class="btn btn-sm btn-outline-danger" onclick="deleteEverything()">'+t('deleteAllBtn')+'</button></div>';
  } else {
  html += '<div class="mb-3 pb-3"><p class="small text-secondary">'+t('teacherOnlyNote')+'</p></div>';
  }

  return html;
}

function render(){
  const app = document.getElementById('app');
  if(!state.ready){ app.innerHTML = '<div class="text-center text-secondary small py-4">'+t('loading')+'</div>'; return; }
  if(state.adminSecret){ app.innerHTML = renderAdmin(); return; }
  if(state.authScreen){ app.innerHTML = renderAuth(); return; }
  if(isExpired()){ app.innerHTML = renderPaywall(); return; }
  if(state.screen==='settings'){ app.innerHTML = renderSettings(); return; }
  if(state.screen==='detail'){ app.innerHTML = renderDetail(); return; }
  app.innerHTML = renderMain();
}


if('serviceWorker' in navigator){
  window.addEventListener('load', function(){
    navigator.serviceWorker.register('sw.js').catch(function(){});
  });
}

try{ const _adm = sessionStorage.getItem('adm'); if(_adm) adminLogin(_adm); }catch(e){}
initLoad();
