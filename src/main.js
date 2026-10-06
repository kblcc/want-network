import './style.css';
import {supabase,configured} from './supabase.js';

const $=s=>document.querySelector(s);
let session=null, profile=null, activeChannel=null, notifChannel=null, unread=0;
const app=$('#app');

function bell(){
  if(!session)return '';
  const label=unread?`Notifications, ${unread} unread`:'Notifications';
  return `<button type="button" class="bell" data-go="notifications" aria-label="${label}" title="${label}"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2Z"/></svg>${unread?`<span class="badge">${unread>9?'9+':unread}</span>`:''}</button>`;
}

function renderBell(){
  const old=document.querySelector('nav .bell');
  if(old)old.outerHTML=bell();
}

function shell(body){
  app.innerHTML=`<nav><b>WANT<span>.</span></b><div><button type="button" data-go="home">Home</button><button type="button" data-go="dashboard">Dashboard</button><button type="button" data-go="auth">Account</button>${bell()}</div></nav><main>${body}</main><footer>WANT • The market comes to you</footer>`;
}

async function refreshUnread(){
  if(!session){unread=0;return renderBell();}
  const {count,error}=await supabase.from('notifications').select('id',{count:'exact',head:true}).eq('user_id',session.user.id).is('read_at',null);
  if(error)return console.warn('Notifications count:',error.message);
  unread=count||0;
  renderBell();
}

function startNotifications(){
  stopNotifications();
  if(!session)return;
  refreshUnread();
  notifChannel=supabase.channel('notifications-'+session.user.id)
    .on('postgres_changes',{event:'*',schema:'public',table:'notifications',filter:'user_id=eq.'+session.user.id},()=>{
      refreshUnread();
      if(document.querySelector('.notif-list'))notifications();
    })
    .subscribe();
}

function stopNotifications(){
  if(notifChannel){supabase.removeChannel(notifChannel);notifChannel=null;}
  unread=0;
}

document.addEventListener('click',e=>{
  const target=e.target.closest('[data-go]');
  if(!target)return;
  e.preventDefault();
  route(target.dataset.go,target.dataset.id);
});

async function loadProfile(){
  if(!session){profile=null;return;}
  const {data,error}=await supabase.from('profiles').select('*').eq('id',session.user.id).maybeSingle();
  if(error)console.warn('Profile load:',error.message);
  profile=data||{id:session.user.id,display_name:session.user.user_metadata?.display_name||'',role:session.user.user_metadata?.role||'buyer'};
  startNotifications();
}

async function boot(){
  if(configured){
    const {data,error}=await supabase.auth.getSession();
    if(error)console.warn('Session load:',error.message);
    session=data?.session||null;
    if(session)await loadProfile();
    supabase.auth.onAuthStateChange((event,newSession)=>{
      session=newSession;
      if(event==='SIGNED_OUT'){profile=null;stopNotifications();route('home');}
    });
  }
  route('home');
}

function route(r,id){
  if(activeChannel){supabase.removeChannel(activeChannel);activeChannel=null;}
  if(r==='chat')return chat(id);
  if(r==='edit')return editWant(id);
  if(r==='notifications')return notifications();
  if(r==='auth')return auth();
  if(r==='dashboard')return dashboard();
  return home();
}

function home(){
  const minDate=new Date().toISOString().slice(0,10);
  shell(`<section class="hero"><p class="eyebrow">THE MARKET COMES TO YOU</p><h1>What do you want?</h1><p>Say what you need. Providers compete to fulfill it.</p><form id="intent"><textarea maxlength="1000" placeholder="I want my apartment cleaned tomorrow under $120" required></textarea><div class="row"><input name="budget" type="number" min="0" step="0.01" placeholder="Max budget"><input name="location" maxlength="120" placeholder="City or area — don't enter a street address"><input name="deadline" type="date" min="${minDate}"></div><button class="primary">Create my WANT →</button></form></section>`);
  $('#intent').onsubmit=postIntent;
}

async function postIntent(e){
  e.preventDefault();
  if(!session)return auth('Sign in to publish your WANT.');
  if(profile?.role!=='buyer')return alert('Only buyer accounts can publish WANTs.');
  const f=new FormData(e.target),description=e.target.querySelector('textarea').value.trim();
  if(!description)return alert('Tell providers what you want.');
  const btn=e.target.querySelector('button');
  btn.disabled=true;btn.textContent='Publishing…';
  const {error}=await supabase.from('intents').insert({buyer_id:session.user.id,description,budget_max:f.get('budget')||null,location:(f.get('location')||'').trim(),deadline:f.get('deadline')||null});
  if(error){btn.disabled=false;btn.textContent='Create my WANT →';return alert(error.message);}
  await dashboard();
}

function auth(msg=''){
  if(session){
    const name=profile?.display_name||session.user.user_metadata?.display_name||'WANT member';
    const role=(profile?.role||session.user.user_metadata?.role||'buyer')==='provider'?'Provider':'Buyer';
    shell(`<section class="card narrow account-card"><p class="eyebrow">MY ACCOUNT</p><h2>${esc(name)}</h2><div class="account-row"><span>Account type</span><b>${role}</b></div><div class="account-row"><span>Email</span><b>${esc(session.user.email||'')}</b></div><div class="row"><button type="button" class="primary" data-go="dashboard">Go to Dashboard</button><button type="button" id="signout">Sign out</button></div></section>`);
    $('#signout').onclick=signout;
    return;
  }
  shell(`<section class="card narrow"><p class="eyebrow">WELCOME TO WANT</p><h2>Join WANT</h2>${msg?`<p class="notice">${esc(msg)}</p>`:''}<input id="email" type="email" autocomplete="email" placeholder="Email"><input id="password" type="password" autocomplete="current-password" placeholder="Password"><input id="name" autocomplete="name" maxlength="80" placeholder="Display name"><select id="role"><option value="buyer">I want things</option><option value="provider">I provide things</option></select><div class="row"><button type="button" id="signup" class="primary">Create account</button><button type="button" id="signin">Sign in</button></div>${configured?'':'<p class="notice">Backend not connected yet.</p>'}</section>`);
  $('#signup').onclick=signup;
  $('#signin').onclick=signin;
}

async function signup(){
  if(!configured)return alert('Connect Supabase first.');
  const email=$('#email').value.trim(),password=$('#password').value,display_name=$('#name').value.trim(),role=$('#role').value;
  if(!email||!password)return alert('Enter your email and password.');
  const {data,error}=await supabase.auth.signUp({email,password,options:{data:{display_name,role},emailRedirectTo:window.location.origin}});
  if(error)return alert(error.message);
  if(data.session){session=data.session;await loadProfile();return dashboard();}
  alert('Account created. Please confirm your email, then come back here and sign in.');
}

async function signout(){
  if(!configured)return;
  const {error}=await supabase.auth.signOut();
  if(error)return alert(error.message);
  session=null;profile=null;stopNotifications();auth('You have been signed out.');
}

async function signin(){
  if(!configured)return alert('Connect Supabase first.');
  const email=$('#email').value.trim(),password=$('#password').value;
  if(!email||!password)return alert('Enter your email and password.');
  const btn=$('#signin');btn.disabled=true;btn.textContent='Signing in…';
  const {data,error}=await supabase.auth.signInWithPassword({email,password});
  if(error){btn.disabled=false;btn.textContent='Sign in';return alert(error.message);}
  session=data.session;
  if(!session){btn.disabled=false;btn.textContent='Sign in';return alert('Please confirm your email first.');}
  await loadProfile();
  dashboard();
}

async function dashboard(){
  if(!session)return auth('Sign in to open your dashboard.');
  if(profile?.role==='provider')return providerDash();
  const {data:intents,error}=await supabase.from('intents').select('*,offers!offers_intent_id_fkey(*)').eq('buyer_id',session.user.id).order('created_at',{ascending:false});
  if(error){console.error('Dashboard load:',error);return shell(`<section class="card"><h2>Could not load your WANTs</h2><p class="notice">${esc(error.message)}</p><button type="button" data-go="dashboard">Try again</button></section>`);}
  shell(`<section><div class="head"><div><p class="eyebrow">BUYER DASHBOARD</p><h2>My WANTs</h2></div><button type="button" class="primary" data-go="home">+ New WANT</button></div>${(intents||[]).map(buyerCard).join('')||'<div class="empty">No WANTs yet.</div>'}</section>`);
}

const STATUS_LABEL={open:'Open',matched:'In progress',completed:'Completed',cancelled:'Cancelled',closed:'Closed',pending:'Pending',accepted:'Accepted',declined:'Declined',withdrawn:'Withdrawn'};
function pill(st){return `<span class="pill st-${escAttr(st)}">${esc(STATUS_LABEL[st]||st)}</span>`;}
function wantMeta(i){return `${esc(i.location||'Location flexible')} • ${i.budget_max!=null?'≤ $'+esc(i.budget_max):'Budget open'}${i.deadline?' • Due '+formatDate(i.deadline):''}`;}

function buyerCard(i){
  const id=escAttr(i.id);
  let actions='';
  if(i.status==='open'){
    actions=`<div class="actions"><button type="button" data-go="edit" data-id="${id}">Edit</button><button type="button" class="ghost danger" onclick="cancelWant('${id}',false)">Cancel WANT</button></div>`;
  }else if(i.status==='matched'){
    actions=`${i.provider_done_at?`<p class="notice">Your provider marked the job as done${' on '+esc(new Date(i.provider_done_at).toLocaleDateString())}. Please confirm once you're satisfied.</p>`:''}<div class="actions"><button type="button" class="primary" onclick="confirmCompleted('${id}')">${i.provider_done_at?'Confirm completed':'Mark as completed'}</button><button type="button" class="ghost danger" onclick="cancelWant('${id}',true)">Cancel job</button></div>`;
  }else if(i.status==='completed'){
    actions=`<p class="done-note">Completed ✓${i.completed_at?' on '+esc(new Date(i.completed_at).toLocaleDateString()):''}</p>`;
  }else if(i.status==='cancelled'){
    actions=`<p class="muted-note">You cancelled this WANT${i.cancelled_at?' on '+esc(new Date(i.cancelled_at).toLocaleDateString()):''}.</p>`;
  }
  const offers=i.offers||[];
  const offerRows=offers.map(o=>`<div class="offer"><div><b>$${esc(o.amount)}</b> ${esc(o.message||'')} ${pill(o.status)}</div>${i.status==='open'&&o.status==='pending'?`<button type="button" onclick="acceptOffer('${escAttr(o.id)}','${id}')">Accept</button>`:''}${o.status==='accepted'&&i.status!=='cancelled'?`<button type="button" class="${i.status==='matched'?'primary ':''}msg-btn" data-go="chat" data-id="${id}">${i.status==='matched'?'Message provider':'View conversation'}</button>`:''}</div>`).join('');
  return `<article class="card${i.status==='cancelled'?' is-cancelled':''}">${pill(i.status)}<h3>${esc(i.description)}</h3><p>${wantMeta(i)}${i.updated_at&&i.status==='open'?' • Edited':''}</p>${actions}<h4>${offers.length} offer(s)</h4>${offerRows}</article>`;
}

function providerOfferCard(o){
  const i=o.intents||{}, id=escAttr(o.intent_id);
  let box='';
  if(o.status==='accepted'){
    if(i.status==='matched'&&!i.provider_done_at)box=`<div class="match-box"><b>Matched ✓ Your offer was accepted.</b><p>Agree on the details with the buyer, do the job, then mark it as done.</p><div class="actions"><button type="button" class="primary" data-go="chat" data-id="${id}">Message buyer</button><button type="button" onclick="markJobDone('${id}')">Mark job as done</button></div></div>`;
    else if(i.status==='matched')box=`<div class="match-box"><b>Job marked as done ✓</b><p>Waiting for the buyer to confirm it's completed.</p><button type="button" class="msg-btn" data-go="chat" data-id="${id}">Message buyer</button></div>`;
    else if(i.status==='completed')box=`<div class="match-box done"><b>Job completed ✓</b><p>The buyer confirmed this job${i.completed_at?' on '+esc(new Date(i.completed_at).toLocaleDateString()):''}.</p><button type="button" class="msg-btn" data-go="chat" data-id="${id}">View conversation</button></div>`;
    else if(i.status==='cancelled')box=`<p class="muted-note">The buyer cancelled this job.</p>`;
  }else if(i.status==='cancelled'){
    box=`<p class="muted-note">The buyer cancelled this WANT.</p>`;
  }
  const shown=o.status==='accepted'&&i.status&&i.status!=='matched'?i.status:o.status;
  return `<article class="card">${pill(shown)}<h3>${esc(i.description||'WANT')}</h3><p>${esc(i.location||'Location flexible')}${i.deadline?' • Due '+formatDate(i.deadline):''}</p><p><b>Your offer: $${esc(o.amount)}</b>${o.message?' • '+esc(o.message):''}</p>${box}</article>`;
}

async function editWant(id){
  if(!session)return auth('Sign in to edit your WANT.');
  const {data:i,error}=await supabase.from('intents').select('*').eq('id',id).eq('buyer_id',session.user.id).maybeSingle();
  if(error||!i||i.status!=='open')return shell(`<section class="card narrow"><h2>Can't edit this WANT</h2><p class="notice">${esc(error?.message||'Only open WANTs can be edited.')}</p><button type="button" data-go="dashboard">Back to dashboard</button></section>`);
  const minDate=new Date().toISOString().slice(0,10);
  shell(`<section class="narrow-wide"><button type="button" class="back" data-go="dashboard">← Dashboard</button><form id="editForm" class="card"><p class="eyebrow">EDIT WANT</p><textarea name="description" maxlength="1000" required>${esc(i.description)}</textarea><div class="row"><input name="budget" type="number" min="0" step="0.01" placeholder="Max budget" value="${i.budget_max??''}"><input name="location" maxlength="120" placeholder="City or area — don't enter a street address" value="${escAttr(i.location||'')}"><input name="deadline" type="date" min="${minDate}" value="${escAttr(i.deadline||'')}"></div><p class="hint">Providers who already made an offer will be notified that you edited this WANT.</p><div class="actions"><button class="primary">Save changes</button><button type="button" data-go="dashboard">Cancel</button></div></form></section>`);
  $('#editForm').onsubmit=async e=>{
    e.preventDefault();
    const f=new FormData(e.target),btn=e.target.querySelector('.primary');
    const description=(f.get('description')||'').trim();
    if(!description)return alert('Tell providers what you want.');
    btn.disabled=true;btn.textContent='Saving…';
    const {error}=await supabase.rpc('edit_intent',{p_intent_id:id,p_description:description,p_budget_max:f.get('budget')===''?null:Number(f.get('budget')),p_location:(f.get('location')||'').trim(),p_deadline:f.get('deadline')||null});
    if(error){btn.disabled=false;btn.textContent='Save changes';return alert(error.message);}
    dashboard();
  };
}

window.cancelWant=async(id,matched)=>{
  const msg=matched?'Cancel this job? The provider will be notified and the conversation will become read-only.':'Cancel this WANT? Providers who made offers will be notified.';
  if(!confirm(msg))return;
  const {error}=await supabase.rpc('cancel_intent',{p_intent_id:id});
  if(error)return alert(error.message);
  dashboard();
};
window.confirmCompleted=async id=>{
  if(!confirm('Confirm the job is completed? This closes the WANT and the conversation becomes read-only.'))return;
  const {error}=await supabase.rpc('confirm_completed',{p_intent_id:id});
  if(error)return alert(error.message);
  dashboard();
};
window.markJobDone=async id=>{
  if(!confirm('Mark this job as done? The buyer will be asked to confirm.'))return;
  const {error}=await supabase.rpc('mark_job_done',{p_intent_id:id});
  if(error)return alert(error.message);
  dashboard();
};

async function providerDash(){
  const [{data:intents,error:intentError},{data:offers,error:offerError}]=await Promise.all([
    supabase.from('intents').select('*,profiles!intents_buyer_id_fkey(display_name)').eq('status','open').order('created_at',{ascending:false}),
    supabase.from('offers').select('intent_id,status,amount,message,created_at,intents!offers_intent_id_fkey(id,buyer_id,description,location,budget_max,deadline,status,provider_done_at,completed_at,cancelled_at)').eq('provider_id',session.user.id).order('created_at',{ascending:false})
  ]);
  const error=intentError||offerError;
  if(error){console.error('Provider dashboard load:',error);return shell(`<section class="card"><h2>Could not load provider dashboard</h2><p class="notice">${esc(error.message)}</p><button type="button" data-go="dashboard">Try again</button></section>`);}
  const mine=new Map((offers||[]).map(o=>[o.intent_id,o]));
  const market=(intents||[]).map(i=>{const existing=mine.get(i.id);return `<article class="card"><h3>${esc(i.description)}</h3><p>${esc(i.location||'Location flexible')} • ${i.budget_max?'Budget ≤ $'+i.budget_max:'Budget open'}${i.deadline?' • Due '+formatDate(i.deadline):''}</p>${existing?`<p class="notice">Offer sent ✓ $${existing.amount} • ${esc(existing.status)}</p>`:`<form onsubmit="makeOffer(event,'${i.id}')"><div class="row"><input name="amount" type="number" min="0" step="0.01" required placeholder="Your offer"><input name="message" maxlength="500" placeholder="Message / terms"><button>Send offer</button></div></form>`}</article>`}).join('');
  const myOffers=(offers||[]).map(providerOfferCard).join('');
  shell(`<section><p class="eyebrow">PROVIDER DASHBOARD</p><h2>Open WANTs</h2>${market||'<div class="empty">No open WANTs right now.</div>'}<div class="head provider-offers-head"><div><p class="eyebrow">YOUR ACTIVITY</p><h2>My Offers</h2></div></div>${myOffers||'<div class="empty">You have not sent any offers yet.</div>'}</section>`);
}

async function chat(intentId){
  if(!session)return auth('Sign in to open your messages.');
  if(!intentId)return dashboard();
  const unavailable=msg=>shell(`<section class="card narrow"><h2>Conversation unavailable</h2><p class="notice">${esc(msg)}</p><button type="button" data-go="dashboard">Back to dashboard</button></section>`);
  const {data:intent,error:intentError}=await supabase.from('intents').select('id,description,status,buyer_id,accepted_offer_id').eq('id',intentId).maybeSingle();
  if(intentError)return unavailable(intentError.message);
  if(!intent||!intent.accepted_offer_id)return unavailable('Messaging opens once an offer on this WANT has been accepted.');
  const {data:offer,error:offerError}=await supabase.from('offers').select('id,provider_id,amount,status').eq('id',intent.accepted_offer_id).maybeSingle();
  if(offerError)return unavailable(offerError.message);
  const me=session.user.id;
  if(!offer||offer.status!=='accepted'||(me!==intent.buyer_id&&me!==offer.provider_id))return unavailable('Only the buyer and the accepted provider can view this conversation.');
  const otherId=me===intent.buyer_id?offer.provider_id:intent.buyer_id;
  const [{data:people},{data:messages,error:msgError}]=await Promise.all([
    supabase.from('profiles').select('id,display_name').in('id',[intent.buyer_id,offer.provider_id]),
    supabase.from('messages').select('id,sender_id,body,created_at').eq('intent_id',intentId).order('created_at',{ascending:true}).limit(500)
  ]);
  if(msgError)return unavailable(msgError.message);
  const names=new Map((people||[]).map(p=>[p.id,p.display_name]));
  const nameOf=id=>id===me?'You':(names.get(id)||(id===intent.buyer_id?'Buyer':'Provider'));
  const otherLabel=nameOf(otherId);
  const canSend=intent.status==='matched';
  const seen=new Set();
  shell(`<section class="chat"><button type="button" class="back" data-go="dashboard">← Dashboard</button><div class="card chat-card"><div class="chat-head"><p class="eyebrow">PRIVATE CONVERSATION</p><h2>${esc(otherLabel)}</h2><p class="chat-want">${esc(intent.description)} • Accepted offer $${esc(offer.amount)}</p><p class="chat-privacy">Only you and ${esc(otherLabel)} can see these messages.</p></div><div id="msgs" class="msgs" aria-live="polite"></div>${canSend?`<form id="composer" class="composer"><textarea name="body" maxlength="2000" rows="2" placeholder="Write a message…" required></textarea><button class="primary">Send</button></form>`:`<p class="notice">This WANT is ${esc(intent.status)}. The conversation is read-only.</p>`}</div></section>`);
  const list=$('#msgs');
  const add=m=>{
    if(seen.has(m.id))return;
    seen.add(m.id);
    const el=document.createElement('div');
    el.className='msg'+(m.sender_id===me?' mine':'');
    el.innerHTML=`<div class="msg-meta"><b>${esc(nameOf(m.sender_id))}</b><time datetime="${escAttr(m.created_at)}">${esc(new Date(m.created_at).toLocaleString([], {dateStyle:'medium',timeStyle:'short'}))}</time></div><div class="msg-body">${esc(m.body)}</div>`;
    list.querySelector('.empty')?.remove();
    list.appendChild(el);
    list.scrollTop=list.scrollHeight;
  };
  if(!(messages||[]).length)list.innerHTML=`<div class="empty">No messages yet. Say hello and agree on the details.</div>`;
  (messages||[]).forEach(add);
  activeChannel=supabase.channel('messages-'+intentId)
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'messages',filter:'intent_id=eq.'+intentId},payload=>add(payload.new))
    .subscribe();
  const form=$('#composer');
  if(!form)return;
  const box=form.querySelector('textarea'),btn=form.querySelector('button');
  box.addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();form.requestSubmit();}});
  form.onsubmit=async e=>{
    e.preventDefault();
    const body=box.value.trim();
    if(!body)return;
    btn.disabled=true;btn.textContent='Sending…';
    const {data,error}=await supabase.from('messages').insert({intent_id:intentId,sender_id:me,body}).select('id,sender_id,body,created_at').single();
    btn.disabled=false;btn.textContent='Send';
    if(error)return alert(error.code==='42501'?'You can no longer send messages in this conversation.':error.message);
    box.value='';
    add(data);
    box.focus();
  };
}

const NOTIF_ICON={new_offer:'💬',offer_accepted:'✅',offer_declined:'•',new_message:'✉️',want_edited:'✏️',want_cancelled:'✕',job_done:'🧹',job_completed:'🎉'};

async function notifications(){
  if(!session)return auth('Sign in to see your notifications.');
  const {data,error}=await supabase.from('notifications').select('id,kind,body,intent_id,read_at,created_at').eq('user_id',session.user.id).order('created_at',{ascending:false}).limit(50);
  if(error)return shell(`<section class="card narrow"><h2>Could not load notifications</h2><p class="notice">${esc(error.message)}</p><button type="button" data-go="notifications">Try again</button></section>`);
  const items=(data||[]).map(n=>`<li><button type="button" class="notif${n.read_at?'':' unread'}" data-notif="${escAttr(n.id)}" data-kind="${escAttr(n.kind)}" data-intent="${escAttr(n.intent_id||'')}"><span class="notif-icon" aria-hidden="true">${NOTIF_ICON[n.kind]||'•'}</span><span class="notif-text"><span class="notif-body">${esc(n.body)}</span><time datetime="${escAttr(n.created_at)}">${esc(timeAgo(n.created_at))}</time></span>${n.read_at?'':'<span class="dot" aria-label="Unread"></span>'}</button></li>`).join('');
  shell(`<section class="notif-page"><div class="head"><div><p class="eyebrow">ACTIVITY</p><h2>Notifications</h2></div>${(data||[]).some(n=>!n.read_at)?'<button type="button" id="markAll">Mark all as read</button>':''}</div><div class="card notif-card">${items?`<ul class="notif-list">${items}</ul>`:'<div class="empty">No notifications yet. You\'ll see new offers, accepted offers and messages here.</div>'}</div></section>`);
  $('#markAll')?.addEventListener('click',async e=>{
    e.target.disabled=true;
    const {error}=await supabase.from('notifications').update({read_at:new Date().toISOString()}).eq('user_id',session.user.id).is('read_at',null);
    if(error){e.target.disabled=false;return alert(error.message);}
    await refreshUnread();
    notifications();
  });
}

document.addEventListener('click',async e=>{
  const n=e.target.closest('[data-notif]');
  if(!n)return;
  if(n.classList.contains('unread')){
    n.classList.remove('unread');
    await supabase.from('notifications').update({read_at:new Date().toISOString()}).eq('id',n.dataset.notif).is('read_at',null);
    refreshUnread();
  }
  const intent=n.dataset.intent,kind=n.dataset.kind;
  if(intent&&(kind==='new_message'||kind==='offer_accepted'))return route('chat',intent);
  route('dashboard');
});

function timeAgo(ts){
  const s=Math.max(0,(Date.now()-new Date(ts).getTime())/1000);
  if(s<60)return 'Just now';
  if(s<3600)return Math.floor(s/60)+' min ago';
  if(s<86400)return Math.floor(s/3600)+' h ago';
  if(s<604800)return Math.floor(s/86400)+' d ago';
  return new Date(ts).toLocaleDateString();
}

window.makeOffer=async(e,id)=>{
  e.preventDefault();
  if(!session||profile?.role!=='provider')return alert('Sign in with a provider account to send an offer.');
  const f=new FormData(e.target),amount=f.get('amount'),message=(f.get('message')||'').trim();
  const btn=e.target.querySelector('button');btn.disabled=true;btn.textContent='Sending…';
  const {error}=await supabase.from('offers').insert({intent_id:id,provider_id:session.user.id,amount,message});
  if(error){btn.disabled=false;btn.textContent='Send offer';if(error.code==='23505')return alert('You already sent an offer for this WANT.');return alert(error.message);}
  alert('Offer sent successfully.');
  providerDash();
};

window.acceptOffer=async(oid,iid)=>{
  if(!confirm('Accept this offer? Other offers for this WANT will be declined.'))return;
  const {error}=await supabase.rpc('accept_offer',{p_offer_id:oid,p_intent_id:iid});
  if(error)return alert(error.message);
  dashboard();
};

function formatDate(d){return new Date(d+'T00:00:00').toLocaleDateString();}
function esc(s=''){return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));}
function escAttr(s=''){return esc(s).replace(/`/g,'&#096;');}

boot();
