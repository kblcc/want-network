import './style.css';
import {supabase,configured} from './supabase.js';

const $=s=>document.querySelector(s);
let session=null, profile=null, activeChannel=null, notifChannel=null, unread=0;
let ratings=new Map(), myReviews=new Set(), people=new Map();
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
  if(r==='review')return reviewScreen(id);
  if(r==='profile')return profilePage(id);
  if(r==='editProfile')return editProfile();
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
    shell(`<section class="card narrow account-card"><p class="eyebrow">MY ACCOUNT</p><h2>${esc(name)}</h2><div class="account-row"><span>Account type</span><b>${role}</b></div><div class="account-row"><span>Email</span><b>${esc(session.user.email||'')}</b></div><div class="account-row"><span>Your rating</span><b id="myRating">…</b></div><div class="actions"><button type="button" class="primary" data-go="editProfile">Edit profile</button><button type="button" data-go="profile" data-id="${escAttr(session.user.id)}">View public profile</button></div><div class="row"><button type="button" data-go="dashboard">Go to Dashboard</button><button type="button" id="signout">Sign out</button></div></section><section class="card narrow account-card" id="myReviewsCard"><p class="eyebrow">REVIEWS ABOUT YOU</p><div id="myReviews"><p class="muted-note">Loading…</p></div></section>`);
    $('#signout').onclick=signout;
    loadAccountReviews();
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
  await loadReputation((intents||[]).flatMap(i=>(i.offers||[]).map(o=>o.provider_id)));
  shell(`<section><div class="head"><div><p class="eyebrow">BUYER DASHBOARD</p><h2>My WANTs</h2></div><button type="button" class="primary" data-go="home">+ New WANT</button></div>${(intents||[]).map(buyerCard).join('')||'<div class="empty">No WANTs yet.</div>'}</section>`);
}

const STATUS_LABEL={open:'Open',matched:'Matched',in_progress:'In progress',awaiting:'Awaiting confirmation',completed:'Completed',cancelled:'Cancelled',closed:'Closed',pending:'Pending',accepted:'Accepted',declined:'Declined',withdrawn:'Withdrawn'};
function pill(st){return `<span class="pill st-${escAttr(st)}">${esc(STATUS_LABEL[st]||st)}</span>`;}
function stage(i){if(i.status!=='matched')return i.status;if(i.provider_done_at)return 'awaiting';if(i.started_at)return 'in_progress';return 'matched';}
const fmtDay=ts=>ts?esc(new Date(ts).toLocaleDateString()):'';
function wantMeta(i){return `${esc(i.location||'Location flexible')} • ${i.budget_max!=null?'≤ $'+esc(i.budget_max):'Budget open'}${i.deadline?' • Due '+formatDate(i.deadline):''}`;}

function buyerCard(i){
  const id=escAttr(i.id);
  let actions='';
  if(i.status==='open'){
    actions=`<div class="actions"><button type="button" data-go="edit" data-id="${id}">Edit</button><button type="button" class="ghost danger" onclick="cancelWant('${id}',false)">Cancel WANT</button></div>`;
  }else if(i.status==='matched'){
    const st=stage(i);
    const note=st==='awaiting'?`<p class="notice">Your provider marked the job as done on ${fmtDay(i.provider_done_at)}. Please confirm once you're satisfied.</p>`
      :st==='in_progress'?`<p class="stage-note">Job in progress since ${fmtDay(i.started_at)}.</p>`
      :`<p class="stage-note">Waiting for your provider to start the job. Use messages to agree on the details.</p>`;
    actions=`${note}<div class="actions"><button type="button" class="${st==='matched'?'':'primary'}" onclick="confirmCompleted('${id}')">${st==='awaiting'?'Confirm completed':'Mark as completed'}</button><button type="button" class="ghost danger" onclick="cancelWant('${id}',true)">Cancel job</button></div>`;
  }else if(i.status==='completed'){
    actions=`<p class="done-note">Completed ✓${i.completed_at?' on '+esc(new Date(i.completed_at).toLocaleDateString()):''}</p>${myReviews.has(i.id)?'<p class="reviewed-note">You reviewed this job ✓</p>':`<div class="actions"><button type="button" class="primary" data-go="review" data-id="${id}">★ Leave a review</button></div>`}`;
  }else if(i.status==='cancelled'){
    actions=`<p class="muted-note">You cancelled this WANT${i.cancelled_at?' on '+esc(new Date(i.cancelled_at).toLocaleDateString()):''}.</p>`;
  }
  const offers=i.offers||[];
  const offerRows=offers.map(o=>`<div class="offer"><div><b>$${esc(o.amount)}</b> ${personLink(o.provider_id,'Provider')} ${ratingBadge(o.provider_id)} ${esc(o.message||'')} ${pill(o.status)}</div>${i.status==='open'&&o.status==='pending'?`<button type="button" onclick="acceptOffer('${escAttr(o.id)}','${id}')">Accept</button>`:''}${o.status==='accepted'&&i.status!=='cancelled'?`<button type="button" class="${i.status==='matched'?'primary ':''}msg-btn" data-go="chat" data-id="${id}">${i.status==='matched'?'Message provider':'View conversation'}</button>`:''}</div>`).join('');
  return `<article class="card${i.status==='cancelled'?' is-cancelled':''}">${pill(stage(i))}<h3>${esc(i.description)}</h3><p>${wantMeta(i)}${i.updated_at&&i.status==='open'?' • Edited':''}</p>${actions}<h4>${offers.length} offer(s)</h4>${offerRows}</article>`;
}

function providerOfferCard(o){
  const i=o.intents||{}, id=escAttr(o.intent_id);
  let box='';
  if(o.status==='accepted'){
    if(stage(i)==='matched')box=`<div class="match-box"><b>Matched ✓ Your offer was accepted.</b><p>Agree on the details with the buyer, then start the job when you begin.</p><div class="actions"><button type="button" data-go="chat" data-id="${id}">Message buyer</button><button type="button" class="primary" onclick="startJob('${id}')">Start job</button></div></div>`;
    else if(stage(i)==='in_progress')box=`<div class="match-box"><b>Job in progress</b><p>Started on ${fmtDay(i.started_at)}. Mark it as done when you've finished.</p><div class="actions"><button type="button" data-go="chat" data-id="${id}">Message buyer</button><button type="button" class="primary" onclick="markJobDone('${id}')">Mark job as done</button></div></div>`;
    else if(i.status==='matched')box=`<div class="match-box"><b>Job marked as done ✓</b><p>Waiting for the buyer to confirm it's completed.</p><button type="button" class="msg-btn" data-go="chat" data-id="${id}">Message buyer</button></div>`;
    else if(i.status==='completed')box=`<div class="match-box done"><b>Job completed ✓</b><p>The buyer confirmed this job${i.completed_at?' on '+esc(new Date(i.completed_at).toLocaleDateString()):''}.</p><div class="actions"><button type="button" data-go="chat" data-id="${id}">View conversation</button>${myReviews.has(o.intent_id)?'<span class="reviewed-note">You rated the buyer ✓</span>':`<button type="button" class="primary" data-go="review" data-id="${id}">★ Rate the buyer</button>`}</div></div>`;
    else if(i.status==='cancelled')box=`<p class="muted-note">The buyer cancelled this job.</p>`;
  }else if(i.status==='cancelled'){
    box=`<p class="muted-note">The buyer cancelled this WANT.</p>`;
  }
  const shown=o.status==='accepted'&&i.status?stage(i):o.status;
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
window.startJob=async id=>{
  if(!confirm('Start this job now? The buyer will be notified.'))return;
  const {error}=await supabase.rpc('start_job',{p_intent_id:id});
  if(error)return alert(error.message);
  dashboard();
};
window.markJobDone=async id=>{
  if(!confirm('Mark this job as done? The buyer will be asked to confirm.'))return;
  const {error}=await supabase.rpc('mark_job_done',{p_intent_id:id});
  if(error)return alert(error.message);
  dashboard();
};

async function loadReputation(userIds){
  const ids=[...new Set(userIds.filter(Boolean))];
  const [r1,r2,r3]=await Promise.all([
    ids.length?supabase.from('user_ratings').select('user_id,avg_rating,review_count').in('user_id',ids):Promise.resolve({data:[]}),
    supabase.from('reviews').select('intent_id').eq('reviewer_id',session.user.id),
    ids.length?supabase.from('profiles').select('id,display_name').in('id',ids):Promise.resolve({data:[]})
  ]);
  people=new Map((r3.data||[]).map(p=>[p.id,p.display_name]));
  if(r1.error)console.warn('Ratings:',r1.error.message);
  if(r2.error)console.warn('My reviews:',r2.error.message);
  ratings=new Map((r1.data||[]).map(r=>[r.user_id,r]));
  myReviews=new Set((r2.data||[]).map(r=>r.intent_id));
}

function ratingBadge(userId){
  const r=ratings.get(userId);
  if(!r||!r.review_count)return '<span class="rating new">New</span>';
  return `<span class="rating" title="${escAttr(r.avg_rating)} out of 5 from ${r.review_count} review${r.review_count===1?'':'s'}">★ ${esc(Number(r.avg_rating).toFixed(1))} <small>(${r.review_count})</small></span>`;
}

function starsText(n){return '★'.repeat(n)+'☆'.repeat(5-n);}

async function loadAccountReviews(){
  const box=$('#myReviews'), rate=$('#myRating');
  const [{data:sum},{data:list,error}]=await Promise.all([
    supabase.from('user_ratings').select('avg_rating,review_count').eq('user_id',session.user.id).maybeSingle(),
    supabase.from('reviews').select('rating,comment,created_at,reviewer_id,profiles!reviews_reviewer_id_fkey(display_name)').eq('reviewee_id',session.user.id).order('created_at',{ascending:false}).limit(20)
  ]);
  if(!$('#myReviews'))return;
  rate.innerHTML=sum&&sum.review_count?`<span class="rating">★ ${esc(Number(sum.avg_rating).toFixed(1))} <small>(${sum.review_count})</small></span>`:'<span class="rating new">No reviews yet</span>';
  if(error){box.innerHTML=`<p class="notice">${esc(error.message)}</p>`;return;}
  box.innerHTML=reviewsHtml(list)||'<p class="muted-note">Reviews appear here after you complete jobs.</p>';
}

async function reviewScreen(intentId){
  if(!session)return auth('Sign in to leave a review.');
  const fail=m=>shell(`<section class="card narrow"><h2>Can't review this job</h2><p class="notice">${esc(m)}</p><button type="button" data-go="dashboard">Back to dashboard</button></section>`);
  const {data:i,error}=await supabase.from('intents').select('id,description,status,buyer_id,accepted_offer_id').eq('id',intentId).maybeSingle();
  if(error)return fail(error.message);
  if(!i||i.status!=='completed'||!i.accepted_offer_id)return fail('Reviews open once a job is completed.');
  const {data:o}=await supabase.from('offers').select('provider_id,amount').eq('id',i.accepted_offer_id).maybeSingle();
  const me=session.user.id, isBuyer=me===i.buyer_id;
  if(!o||(!isBuyer&&me!==o.provider_id))return fail('Only the buyer and the hired provider can review this job.');
  const otherId=isBuyer?o.provider_id:i.buyer_id;
  const {data:other}=await supabase.from('profiles').select('display_name').eq('id',otherId).maybeSingle();
  const {data:already}=await supabase.from('reviews').select('id').eq('intent_id',intentId).eq('reviewer_id',me).maybeSingle();
  if(already)return fail('You already reviewed this job. Thank you!');
  const who=esc(other?.display_name||(isBuyer?'your provider':'the buyer'));
  shell(`<section class="narrow-wide"><button type="button" class="back" data-go="dashboard">← Dashboard</button><form id="reviewForm" class="card"><p class="eyebrow">${isBuyer?'RATE YOUR PROVIDER':'RATE THE BUYER'}</p><h2>How was it working with ${who}?</h2><p class="chat-want">${esc(i.description)} • $${esc(o.amount)}</p><fieldset class="star-input"><legend class="sr-only">Rating</legend>${[1,2,3,4,5].map(n=>`<label title="${n} star${n>1?'s':''}"><input type="radio" name="rating" value="${n}" required><span aria-hidden="true">★</span><span class="sr-only">${n} star${n>1?'s':''}</span></label>`).join('')}</fieldset><p class="hint" id="starHint">Tap a star to rate.</p><textarea name="comment" maxlength="1000" rows="4" placeholder="Optional: what went well, what could be better? (visible to other WANT members)"></textarea><div class="actions"><button class="primary">Submit review</button><button type="button" data-go="dashboard">Not now</button></div><p class="hint">Reviews can't be edited after you submit them.</p></form></section>`);
  const form=$('#reviewForm'), labels=[...form.querySelectorAll('.star-input label')];
  const words=['','Poor','Fair','Good','Very good','Excellent'];
  form.querySelectorAll('input[name=rating]').forEach(inp=>inp.addEventListener('change',()=>{
    const v=Number(inp.value); labels.forEach((l,k)=>l.classList.toggle('on',k<v)); $('#starHint').textContent=`${v} star${v>1?'s':''} — ${words[v]}`;
  }));
  form.onsubmit=async e=>{
    e.preventDefault();
    const f=new FormData(form), rating=Number(f.get('rating'));
    if(!rating)return alert('Please choose a star rating.');
    const btn=form.querySelector('.primary'); btn.disabled=true; btn.textContent='Submitting…';
    const {error}=await supabase.rpc('submit_review',{p_intent_id:intentId,p_rating:rating,p_comment:(f.get('comment')||'').trim()});
    if(error){btn.disabled=false;btn.textContent='Submit review';return alert(error.message);}
    dashboard();
  };
}

function personLink(id,fallback){
  if(!id)return '';
  const name=people.get(id)||fallback||'WANT member';
  return `<button type="button" class="link" data-go="profile" data-id="${escAttr(id)}">${esc(name)}</button>`;
}

function reviewsHtml(list){
  return (list||[]).map(r=>`<div class="review"><div class="review-head"><span class="stars" aria-label="${r.rating} out of 5">${starsText(r.rating)}</span><span class="muted-note">${esc(r.profiles?.display_name||'WANT member')} • ${fmtDay(r.created_at)}</span></div>${r.comment?`<p class="review-body">${esc(r.comment)}</p>`:''}</div>`).join('');
}

async function profilePage(userId){
  if(!session)return auth('Sign in to view profiles.');
  if(!userId)return dashboard();
  const [{data:p,error},{data:list}]=await Promise.all([
    supabase.rpc('get_profile',{p_user_id:userId}),
    supabase.from('reviews').select('rating,comment,created_at,profiles!reviews_reviewer_id_fkey(display_name)').eq('reviewee_id',userId).order('created_at',{ascending:false}).limit(20)
  ]);
  if(error||!p)return shell(`<section class="card narrow"><h2>Profile not found</h2><p class="notice">${esc(error?.message||'This profile does not exist.')}</p><button type="button" data-go="dashboard">Back to dashboard</button></section>`);
  const isMe=userId===session.user.id, isProvider=p.role==='provider';
  const name=p.display_name||(isProvider?'Provider':'WANT member');
  const initials=name.split(/\s+/).map(w=>w[0]||'').join('').slice(0,2).toUpperCase()||'?';
  const rating=p.review_count?`<span class="rating big">★ ${esc(Number(p.avg_rating).toFixed(1))} <small>(${p.review_count} review${p.review_count===1?'':'s'})</small></span>`:'<span class="rating new">No reviews yet</span>';
  const stat=(n,l)=>`<div class="stat"><b>${esc(n)}</b><span>${esc(l)}</span></div>`;
  shell(`<section class="narrow-wide profile"><button type="button" class="back" data-go="dashboard">← Dashboard</button><div class="card profile-card"><div class="profile-head"><div class="avatar" aria-hidden="true">${esc(initials)}</div><div><p class="eyebrow">${isProvider?'PROVIDER':'BUYER'}</p><h2>${esc(name)}</h2><div class="profile-meta">${rating}${p.service_area?`<span class="muted-note">📍 ${esc(p.service_area)}</span>`:''}</div></div></div><div class="stats">${isProvider?stat(p.completed_jobs,'jobs completed'):stat(p.completed_wants,'WANTs completed')}${stat(p.review_count,'reviews')}${stat(new Date(p.member_since).toLocaleDateString([], {month:'short',year:'numeric'}),'member since')}</div>${p.bio?`<p class="bio">${esc(p.bio)}</p>`:`<p class="muted-note">${isMe?'Add a short bio so people know who you are.':'No bio yet.'}</p>`}${isProvider&&(p.services||[]).length?`<div class="chips">${p.services.map(x=>`<span class="chip">${esc(x)}</span>`).join('')}</div>`:''}${isMe?`<div class="actions"><button type="button" class="primary" data-go="editProfile">Edit profile</button></div>`:''}</div><div class="card"><p class="eyebrow">REVIEWS</p>${reviewsHtml(list)||'<p class="muted-note">No reviews yet.</p>'}</div></section>`);
}

function editProfile(){
  if(!session)return auth('Sign in to edit your profile.');
  const p=profile||{}, isProvider=p.role==='provider';
  shell(`<section class="narrow-wide"><button type="button" class="back" data-go="auth">← Account</button><form id="profileForm" class="card"><p class="eyebrow">EDIT PROFILE</p><label class="field">Display name<input name="display_name" maxlength="80" required value="${escAttr(p.display_name||'')}" placeholder="How people will see you"></label><label class="field">Service area<input name="service_area" maxlength="120" value="${escAttr(p.service_area||'')}" placeholder="City or area, e.g. Denver metro — not a street address"></label>${isProvider?`<label class="field">Services you offer<input name="services" value="${escAttr((p.services||[]).join(', '))}" placeholder="e.g. Home cleaning, Deep cleaning, Move-out cleaning"><span class="hint">Separate with commas. Up to 10, each up to 40 characters.</span></label>`:''}<label class="field">Bio<textarea name="bio" maxlength="600" rows="4" placeholder="${isProvider?'Your experience, what makes you reliable, availability…':'A sentence about you (optional)'}">${esc(p.bio||'')}</textarea><span class="hint"><span id="bioCount">${(p.bio||'').length}</span>/600 • Visible to signed-in WANT members. Don't include phone numbers or addresses.</span></label><div class="actions"><button class="primary">Save profile</button><button type="button" data-go="auth">Cancel</button></div></form></section>`);
  const form=$('#profileForm');
  form.bio.addEventListener('input',()=>{$('#bioCount').textContent=form.bio.value.length;});
  form.onsubmit=async e=>{
    e.preventDefault();
    const f=new FormData(form);
    const display_name=(f.get('display_name')||'').trim();
    if(!display_name)return alert('Please enter a display name.');
    const services=isProvider?[...new Set((f.get('services')||'').split(',').map(x=>x.trim()).filter(Boolean))]:(p.services||[]);
    if(services.length>10)return alert('Please list up to 10 services.');
    if(services.some(x=>x.length>40))return alert('Each service can be up to 40 characters.');
    const btn=form.querySelector('.primary');btn.disabled=true;btn.textContent='Saving…';
    const {error}=await supabase.from('profiles').update({display_name,service_area:(f.get('service_area')||'').trim()||null,bio:(f.get('bio')||'').trim()||null,services,updated_at:new Date().toISOString()}).eq('id',session.user.id);
    if(error){btn.disabled=false;btn.textContent='Save profile';return alert(error.message);}
    await loadProfile();
    profilePage(session.user.id);
  };
}

async function providerDash(){
  const [{data:intents,error:intentError},{data:offers,error:offerError}]=await Promise.all([
    supabase.from('intents').select('*,profiles!intents_buyer_id_fkey(display_name)').eq('status','open').order('created_at',{ascending:false}),
    supabase.from('offers').select('intent_id,status,amount,message,created_at,intents!offers_intent_id_fkey(id,buyer_id,description,location,budget_max,deadline,status,started_at,provider_done_at,completed_at,cancelled_at)').eq('provider_id',session.user.id).order('created_at',{ascending:false})
  ]);
  const error=intentError||offerError;
  if(error){console.error('Provider dashboard load:',error);return shell(`<section class="card"><h2>Could not load provider dashboard</h2><p class="notice">${esc(error.message)}</p><button type="button" data-go="dashboard">Try again</button></section>`);}
  await loadReputation([...(intents||[]).map(i=>i.buyer_id),...(offers||[]).map(o=>o.intents?.buyer_id)]);
  const mine=new Map((offers||[]).map(o=>[o.intent_id,o]));
  const market=(intents||[]).map(i=>{const existing=mine.get(i.id);return `<article class="card"><h3>${esc(i.description)}</h3><p>${esc(i.location||'Location flexible')} • ${i.budget_max?'Budget ≤ $'+i.budget_max:'Budget open'}${i.deadline?' • Due '+formatDate(i.deadline):''}</p><p class="who">Buyer: ${personLink(i.buyer_id,i.profiles?.display_name||'WANT member')} ${ratingBadge(i.buyer_id)}</p>${existing?`<p class="notice">Offer sent ✓ $${existing.amount} • ${esc(existing.status)}</p>`:`<form onsubmit="makeOffer(event,'${i.id}')"><div class="row"><input name="amount" type="number" min="0" step="0.01" required placeholder="Your offer"><input name="message" maxlength="500" placeholder="Message / terms"><button>Send offer</button></div></form>`}</article>`}).join('');
  const myOffers=(offers||[]).map(providerOfferCard).join('');
  const incomplete=!profile?.display_name||(!profile?.bio&&!(profile?.services||[]).length);
  shell(`<section>${incomplete?`<div class="card nudge"><div><b>Complete your profile</b><p>Buyers choose providers they trust. Add your name, the services you offer and a short bio.</p></div><button type="button" class="primary" data-go="editProfile">Complete profile</button></div>`:''}<p class="eyebrow">PROVIDER DASHBOARD</p><h2>Open WANTs</h2>${market||'<div class="empty">No open WANTs right now.</div>'}<div class="head provider-offers-head"><div><p class="eyebrow">YOUR ACTIVITY</p><h2>My Offers</h2></div></div>${myOffers||'<div class="empty">You have not sent any offers yet.</div>'}</section>`);
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
  shell(`<section class="chat"><button type="button" class="back" data-go="dashboard">← Dashboard</button><div class="card chat-card"><div class="chat-head"><p class="eyebrow">PRIVATE CONVERSATION</p><h2>${esc(otherLabel)} <button type="button" class="link small" data-go="profile" data-id="${escAttr(otherId)}">View profile</button></h2><p class="chat-want">${esc(intent.description)} • Accepted offer $${esc(offer.amount)}</p><p class="chat-privacy">Only you and ${esc(otherLabel)} can see these messages.</p></div><div id="msgs" class="msgs" aria-live="polite"></div>${canSend?`<form id="composer" class="composer"><textarea name="body" maxlength="2000" rows="2" placeholder="Write a message…" required></textarea><button class="primary">Send</button></form>`:`<p class="notice">This WANT is ${esc(intent.status)}. The conversation is read-only.</p>`}</div></section>`);
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

const NOTIF_ICON={new_offer:'💬',offer_accepted:'✅',offer_declined:'•',new_message:'✉️',want_edited:'✏️',want_cancelled:'✕',job_started:'▶️',job_done:'🧹',job_completed:'🎉',review_received:'⭐'};

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
  if(kind==='review_received')return route('auth');
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
