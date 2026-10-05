import './style.css';
import {supabase,configured} from './supabase.js';

const $=s=>document.querySelector(s);
let session=null, profile=null;
const app=$('#app');

function shell(body){
  app.innerHTML=`<nav><b>WANT<span>.</span></b><div><button type="button" data-go="home">Home</button><button type="button" data-go="dashboard">Dashboard</button><button type="button" data-go="auth">Account</button></div></nav><main>${body}</main><footer>WANT • The market comes to you</footer>`;
}

document.addEventListener('click',e=>{
  const target=e.target.closest('[data-go]');
  if(!target)return;
  e.preventDefault();
  route(target.dataset.go);
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

function route(r){
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
  shell(`<section><div class="head"><div><p class="eyebrow">BUYER DASHBOARD</p><h2>My WANTs</h2></div><button type="button" class="primary" data-go="home">+ New WANT</button></div>${(intents||[]).map(i=>`<article class="card"><span class="pill">${esc(i.status)}</span><h3>${esc(i.description)}</h3><p>${esc(i.location||'Location flexible')} • ${i.budget_max?'≤ $'+i.budget_max:'Budget open'}${i.deadline?' • Due '+formatDate(i.deadline):''}</p><h4>${i.offers.length} offer(s)</h4>${i.offers.map(o=>`<div class="offer"><div><b>$${o.amount}</b> ${esc(o.message||'')} <span class="pill">${esc(o.status)}</span></div>${i.status==='open'&&o.status==='pending'?`<button type="button" onclick="acceptOffer('${o.id}','${i.id}')">Accept</button>`:''}</div>`).join('')}</article>`).join('')||'<div class="empty">No WANTs yet.</div>'}</section>`);
}

async function providerDash(){
  const [{data:intents,error:intentError},{data:offers,error:offerError}]=await Promise.all([
    supabase.from('intents').select('*,profiles!intents_buyer_id_fkey(display_name)').eq('status','open').order('created_at',{ascending:false}),
    supabase.from('offers').select('intent_id,status,amount,message').eq('provider_id',session.user.id)
  ]);
  const error=intentError||offerError;
  if(error){console.error('Provider dashboard load:',error);return shell(`<section class="card"><h2>Could not load open WANTs</h2><p class="notice">${esc(error.message)}</p><button type="button" data-go="dashboard">Try again</button></section>`);}
  const mine=new Map((offers||[]).map(o=>[o.intent_id,o]));
  shell(`<section><p class="eyebrow">PROVIDER MARKET</p><h2>Open WANTs</h2>${(intents||[]).map(i=>{const existing=mine.get(i.id);return `<article class="card"><h3>${esc(i.description)}</h3><p>${esc(i.location||'Location flexible')} • ${i.budget_max?'Budget ≤ $'+i.budget_max:'Budget open'}${i.deadline?' • Due '+formatDate(i.deadline):''}</p>${existing?`<p class="notice">Offer sent ✓ $${existing.amount} • ${esc(existing.status)}</p>`:`<form onsubmit="makeOffer(event,'${i.id}')"><div class="row"><input name="amount" type="number" min="0" step="0.01" required placeholder="Your offer"><input name="message" maxlength="500" placeholder="Message / terms"><button>Send offer</button></div></form>`}</article>`}).join('')||'<div class="empty">No open WANTs right now.</div>'}</section>`);
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

boot();
