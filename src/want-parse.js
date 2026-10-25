// Turns a plain-language request into WANT fields, entirely in the browser.
// "Need my sink fixed tomorrow in Aurora, around $100"
//   -> { category:'plumbing', budget:100, location:'Aurora', deadline:'2026-10-26' }
// No AI service and no cost. It can later be swapped for an AI parser that
// returns the same shape.

// Keep in sync with want_categories() in supabase/migrations/011_categories.sql
export const CATEGORIES=[
  ['cleaning','Cleaning','🧽',/clean|maid|tidy|vacuum|mop|laundry|dust/],
  ['plumbing','Plumbing','🚰',/plumb|leak|sink|toilet|faucet|drain|pipe|water heater|clog/],
  ['electrical','Electrical','💡',/electric|outlet|wiring|light fixture|breaker|switch|ceiling fan/],
  ['moving','Moving & hauling','📦',/\bmove\b|moving|haul|couch|sofa|truck|junk|boxes|\bpack/],
  ['yard','Lawn & garden','🌿',/lawn|mow|yard|garden|leaves|rake|snow|tree|hedge|weed|gutter/],
  ['painting','Painting','🎨',/paint|stain/],
  ['pets','Pet care','🐾',/\bdogs?\b|\bcats?\b|\bpets?\b|walk my|groom|sitter|puppy|kitten/],
  ['tutoring','Tutoring & lessons','📚',/tutor|lesson|teach|homework|\bmath|english|piano|guitar|\bclass/],
  ['tech','Tech help','💻',/computer|laptop|phone|wifi|wi-fi|printer|website|\btech|install|set ?up|\btv\b/],
  ['beauty','Beauty & wellness','💇',/\bhair|nails?\b|makeup|massage|beauty|barber|braid/],
  ['events','Events & photography','🎉',/party|event|wedding|photo|\bdj\b|cater|birthday|decor/],
  ['errands','Errands & delivery','🛒',/errand|deliver|pick ?up|grocer|shopping|drop ?off/],
  ['handyman','Handyman & repairs','🔧',/fix|repair|handyman|assemble|assembly|ikea|mount|shelf|shelves|furniture|door|drywall|fence/],
  ['other','Other','✨',null]
];
// Display order (the list above is ordered for matching: specific trades first).
export const CATEGORY_ORDER=['cleaning','handyman','plumbing','electrical','moving','yard','painting','pets','tutoring','tech','beauty','events','errands','other'];

export function guessCategory(text){
  const t=(text||'').toLowerCase();
  for(const [k,,,re] of CATEGORIES){ if(re&&re.test(t))return k; }
  return '';
}

// ---------- budget
const num=s=>Number(String(s).replace(/,/g,''));
export function parseBudget(text){
  const t=(text||'').toLowerCase();
  let m=t.match(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)\s*(k)?\b/);
  if(m)return m[2]?num(m[1])*1000:num(m[1]);
  m=t.match(/(\d[\d,]*(?:\.\d{1,2})?)\s*(?:dollars|usd|bucks)\b/);
  if(m)return num(m[1]);
  m=t.match(/\b(?:under|below|less than|max(?:imum)?|up to|budget(?: of| is)?|around|about|for about|no more than)\s+\$?(\d[\d,]*(?:\.\d{1,2})?)\b(?!\s*(?:hours?|hrs?|days?|weeks?|minutes?|mins?|people|rooms?|bedrooms?|am|pm|kids?|times?|dogs?|cats?|x\b))/);
  if(m)return num(m[1]);
  return null;
}

// ---------- dates (local time, YYYY-MM-DD)
const DAYS=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
const MONTHS=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const pad=n=>String(n).padStart(2,'0');
export const ymd=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const addDays=(d,n)=>{const x=new Date(d.getFullYear(),d.getMonth(),d.getDate());x.setDate(x.getDate()+n);return x;};

export function parseDeadline(text,now=new Date()){
  const t=(text||'').toLowerCase();
  const today=new Date(now.getFullYear(),now.getMonth(),now.getDate());
  if(/\b(asap|urgent|right away|today|tonight|this (?:morning|afternoon|evening))\b/.test(t))return ymd(today);
  if(/\bday after tomorrow\b/.test(t))return ymd(addDays(today,2));
  if(/\b(tomorrow|tmrw|tmr)\b/.test(t))return ymd(addDays(today,1));
  let m=t.match(/\bin (\d{1,2}) days?\b/); if(m)return ymd(addDays(today,Number(m[1])));
  if(/\bnext week\b/.test(t))return ymd(addDays(today,7));
  if(/\b(this )?weekend\b/.test(t)){const toSat=(6-today.getDay()+7)%7;return ymd(addDays(today,toSat));}
  m=t.match(/\b(next )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if(m){let diff=(DAYS.indexOf(m[2])-today.getDay()+7)%7; if(m[1]&&diff===0)diff=7; return ymd(addDays(today,diff));}
  m=t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if(m){let y=m[3]?Number(m[3].length===2?'20'+m[3]:m[3]):today.getFullYear();const d=new Date(y,Number(m[1])-1,Number(m[2]));if(!m[3]&&d<today)d.setFullYear(y+1);if(d.getMonth()===Number(m[1])-1)return ymd(d);}
  m=t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/)||t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/);
  if(m){const mon=isNaN(m[1])?m[1]:m[2], day=Number(isNaN(m[1])?m[2]:m[1]);const mi=MONTHS.indexOf(mon.slice(0,3));const d=new Date(today.getFullYear(),mi,day);if(d<today)d.setFullYear(d.getFullYear()+1);if(d.getMonth()===mi)return ymd(d);}
  return null;
}

// ---------- location
const STOP=new Set(['the','a','an','my','me','morning','afternoon','evening','night','tonight','today','tomorrow','next','this','on','by','for','under','around','about','before','after','at','with','and','or','to','asap','please','week','weekend','days','day','house','home','apartment','condo','kitchen','backyard','yard','person','general','area','time','budget','max','up','less','below','monday','tuesday','wednesday','thursday','friday','saturday','sunday']);
export function parseLocation(text){
  const src=(text||'').replace(/\s+/g,' ');
  const re=/\b(?:in|near|around|at|from)\s+([A-Za-z][A-Za-z.'-]*(?:[ ,]+[A-Za-z][A-Za-z.'-]*){0,3})/gi;
  let m;
  while((m=re.exec(src))){
    const words=m[1].split(/[ ,]+/);
    const keep=[];
    for(const w of words){ if(STOP.has(w.toLowerCase())||/^\d/.test(w))break; keep.push(w); }
    if(!keep.length)continue;
    const last=keep[keep.length-1].replace(/[.,]+$/,'');
    const hasState=keep.length>1&&/^[A-Za-z]{2}$/.test(last)&&new RegExp(',\\s*'+last+'\\b').test(m[1]);
    const city=(hasState?keep.slice(0,-1):keep).join(' ').replace(/[.,]+$/,'');
    if(/^(me|here|town|the|my)$/i.test(city)||city.length<2)continue;
    const titled=city.replace(/\b\w/g,c=>c.toUpperCase());
    return hasState?`${titled}, ${last.toUpperCase()}`:titled;
  }
  return null;
}

// ---------- whole request
export function parseWant(text,now=new Date()){
  const description=(text||'').trim().replace(/\s+/g,' ');
  return {
    description,
    category:guessCategory(description)||null,
    budget:parseBudget(description),
    location:parseLocation(description),
    deadline:parseDeadline(description,now)
  };
}

// A short follow-up answer for one field ("tomorrow", "$80", "Aurora").
export function parseAnswer(field,text,now=new Date()){
  const t=(text||'').trim();
  if(!t)return null;
  if(field==='budget')return parseBudget(t)??(/^\$?\d[\d,]*(\.\d{1,2})?$/.test(t)?num(t.replace('$','')):null);
  if(field==='deadline')return parseDeadline(t,now);
  if(field==='location')return parseLocation('in '+t.replace(/^(in|near|around|at)\s+/i,''))||t.slice(0,120);
  return t;
}

export function friendlyDate(s,now=new Date()){
  if(!s)return '';
  const [y,m,d]=s.split('-').map(Number), date=new Date(y,m-1,d);
  const today=new Date(now.getFullYear(),now.getMonth(),now.getDate());
  const diff=Math.round((date-today)/86400000);
  if(diff===0)return 'Today';
  if(diff===1)return 'Tomorrow';
  if(diff>1&&diff<7)return date.toLocaleDateString([], {weekday:'long'});
  return date.toLocaleDateString([], {month:'short',day:'numeric',year:date.getFullYear()===today.getFullYear()?undefined:'numeric'});
}
