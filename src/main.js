import './style.css';
import {supabase,configured} from './supabase.js';

const $=s=>document.querySelector(s);
let session=null, profile=null, activeChannel=null;
const app=$('#app');

function shell(body){
  app.innerHTML=`<nav><b>WANT<span>.</span></b><div><button type="button" data-go="home">Home</button><button type="button" data-go="dashboard">Dashboard</button><button type="button" data-go="auth">Account</button></div></nav><main>${body}</main><footer>WANT • The market comes to you</footer>`;
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
}

async function boot(){
  if(configured){
    const {data,error}=await supabase.auth.getSession();
    if(error)console.warn('Session load:',error.message);
    session=data?.session||null;
    if(session)await loadProfile();
    supabase.auth.onAuthStateChange((event,newSession)=>{
      session=newSession;
      if(event==='SIGNED_OUT'){profile=null;route('home');}
    });
  }
  route('home');
}

function route(r,id){
  if(activeChannel){supabase.removeChannel(activeChannel);activeChannel=null;}
  if(r==='chat')return chat(id);
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
  session=null;profile=null;auth('You have been signed out.');
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
  shell(`<section><div class="head"><div><p class="eyebrow">BUYER DASHBOARD</p><h2>My WANTs</h2></div><button type="button" class="primary" data-go="home">+ New WANT</button></div>${(intents||[]).map(i=>`<article class="card"><span class="pill">${esc(i.status)}</span><h3>${esc(i.description)}</h3><p>${esc(i.location||'Location flexible')} • ${i.budget_max?'≤ $'+i.budget_max:'Budget open'}${i.deadline?' • Due '+formatDate(i.deadline):''}</p><h4>${i.offers.length} offer(s)</h4>${i.offers.map(o=>`<div class="offer"><div><b>$${o.amount}</b> ${esc(o.message||'')} <span class="pill">${esc(o.status)}</span></div>${i.status==='open'&&o.status==='pending'?`<button type="button" onclick="acceptOffer('${o.id}','${i.id}')">Accept</button>`:''}${o.status==='accepted'?`<button type="button" class="primary msg-btn" data-go="chat" data-id="${escAttr(i.id)}">Message provider</button>`:''}</div>`).join('')}</article>`).join('')||'<div class="empty">No WANTs yet.</div>'}</section>`);
}

async function providerDash(){
  const [{data:intents,error:intentError},{data:offers,error:offerError}]=await Promise.all([
    supabase.from('intents').select('*,profiles!intents_buyer_id_fkey(display_name)').eq('status','open').order('created_at',{ascending:false}),
    supabase.from('offers').select('intent_id,status,amount,message,created_at,intents!offers_intent_id_fkey(id,buyer_id,description,location,budget_max,deadline,status)').eq('provider_id',session.user.id).order('created_at',{ascending:false})
  ]);
  const error=intentError||offerError;
  if(error){console.error('Provider dashboard load:',error);return shell(`<section class="card"><h2>Could not load provider dashboard</h2><p class="notice">${esc(error.message)}</p><button type="button" data-go="dashboard">Try again</button></section>`);}
  const mine=new Map((offers||[]).map(o=>[o.intent_id,o]));
  const market=(intents||[]).map(i=>{const existing=mine.get(i.id);return `<article class="card"><h3>${esc(i.description)}</h3><p>${esc(i.location||'Location flexible')} • ${i.budget_max?'Budget ≤ $'+i.budget_max:'Budget open'}${i.deadline?' • Due '+formatDate(i.deadline):''}</p>${existing?`<p class="notice">Offer sent ✓ $${existing.amount} • ${esc(existing.status)}</p>`:`<form onsubmit="makeOffer(event,'${i.id}')"><div class="row"><input name="amount" type="number" min="0" step="0.01" required placeholder="Your offer"><input name="message" maxlength="500" placeholder="Message / terms"><button>Send offer</button></div></form>`}</article>`}).join('');
  const myOffers=(offers||[]).map(o=>{const i=o.intents;return `<article class="card"><span class="pill">${esc(o.status)}</span><h3>${esc(i?.description||'WANT')}</h3><p>${esc(i?.location||'Location flexible')}${i?.deadline?' • Due '+formatDate(i.deadline):''}</p><p><b>Your offer: $${o.amount}</b>${o.message?' • '+esc(o.message):''}</p>${o.status==='accepted'?`<div class="match-box"><b>Matched ✓ Your offer was accepted.</b><p>You and the buyer are now connected for this WANT.</p>${i?.status==='matched'?`<button type="button" class="primary msg-btn" data-go="chat" data-id="${escAttr(o.intent_id)}">Message buyer</button>`:`<button type="button" class="msg-btn" data-go="chat" data-id="${escAttr(o.intent_id)}">View conversation</button>`}</div>`:''}</article>`}).join('');
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
