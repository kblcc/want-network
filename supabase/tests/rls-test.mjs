// WANT database security tests: applies schema.sql + all migrations to an
// in-memory Postgres and checks who can read/write what.
// Run from the repo root:  npm i --no-save @electric-sql/pglite && node supabase/tests/rls-test.mjs

import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import fs from 'fs';
const R=new URL('../', import.meta.url).pathname;
const db = new PGlite({ extensions: { pgcrypto } });
await db.exec(`
create role anon nologin; create role authenticated nologin;
create schema auth; grant usage on schema auth to anon, authenticated;
create table auth.users(id uuid primary key, raw_user_meta_data jsonb);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true),'')::uuid $$;
grant execute on function auth.uid() to anon, authenticated;
grant usage on schema public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;
create publication supabase_realtime;
`);
for (const f of ['schema.sql','migrations/002_marketplace_security.sql','migrations/003_fix_rls_recursion.sql','migrations/004_messaging.sql','migrations/005_security_cleanup.sql','migrations/006_notifications.sql']) {
  await db.exec(fs.readFileSync(R+f,'utf8')); console.log('applied', f);
}
for (const f of ['migrations/004_messaging.sql','migrations/005_security_cleanup.sql','migrations/006_notifications.sql']) await db.exec(fs.readFileSync(R+f,'utf8'));
console.log('004-006 re-run in order OK (idempotent)');
const U={buyer:'00000000-0000-0000-0000-00000000000b',winner:'00000000-0000-0000-0000-00000000000a',loser:'00000000-0000-0000-0000-00000000000c',stranger:'00000000-0000-0000-0000-00000000000d'};
await db.exec(`create role auth_admin nologin; grant usage on schema auth to auth_admin; grant insert on auth.users to auth_admin; set role auth_admin;`);
await db.exec(`insert into auth.users values
 ('${U.buyer}','{"role":"buyer","display_name":"Bea"}'),('${U.winner}','{"role":"provider","display_name":"Win"}'),
 ('${U.loser}','{"role":"provider","display_name":"Lou"}'),('${U.stranger}','{"role":"buyer","display_name":"Sam"}'); reset role;`);
let pass=0,fail=0;
const as=async(u,sql)=>{await db.exec(`reset role; select set_config('test.uid','${U[u]}',false); set role authenticated;`);return db.query(sql);};
const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m);};
const expectErr=async(u,sql,m)=>{try{await as(u,sql);ok(false,m+' (was allowed!)');}catch(e){ok(true,m+' -> '+e.message.slice(0,60));}};
// flow
const I=(await as('buyer',`insert into intents(buyer_id,description,budget_max) values('${U.buyer}','Clean my apartment',120) returning id`)).rows[0].id;
const W=(await as('winner',`insert into offers(intent_id,provider_id,amount) values('${I}','${U.winner}',100) returning id`)).rows[0].id;
await as('loser',`insert into offers(intent_id,provider_id,amount) values('${I}','${U.loser}',90)`);
await expectErr('buyer',`insert into messages(intent_id,sender_id,body) values('${I}','${U.buyer}','hi')`,'buyer cannot message before acceptance');
await as('buyer',`select accept_offer('${W}','${I}')`);
await as('buyer',`insert into messages(intent_id,sender_id,body) values('${I}','${U.buyer}','Hi! Tomorrow 10am?')`); ok(true,'buyer can send after match');
await as('winner',`insert into messages(intent_id,body) values('${I}','Works for me')`); ok(true,'accepted provider can send (sender defaults to self)');
ok((await as('buyer',`select * from messages where intent_id='${I}'`)).rows.length===2,'buyer reads 2 messages');
ok((await as('winner',`select * from messages where intent_id='${I}'`)).rows.length===2,'accepted provider reads 2 messages');
ok((await as('loser',`select * from messages`)).rows.length===0,'losing provider reads 0 messages');
ok((await as('stranger',`select * from messages`)).rows.length===0,'unrelated user reads 0 messages');
await expectErr('loser',`insert into messages(intent_id,sender_id,body) values('${I}','${U.loser}','let me in')`,'losing provider cannot send');
await expectErr('stranger',`insert into messages(intent_id,sender_id,body) values('${I}','${U.stranger}','x')`,'stranger cannot send');
await expectErr('buyer',`insert into messages(intent_id,sender_id,body) values('${I}','${U.winner}','spoof')`,'buyer cannot impersonate provider');
await expectErr('buyer',`insert into messages(intent_id,sender_id,body) values('${I}','${U.buyer}','   ')`,'blank message rejected');
const upd=await as('buyer',`update messages set body='edited' returning id`).catch(e=>({err:e}));
ok(upd.err||upd.rows.length===0,'messages cannot be edited');
const del=await as('winner',`delete from messages returning id`).catch(e=>({err:e}));
ok(del.err||del.rows.length===0,'messages cannot be deleted');
await db.exec(`reset role; set role anon;`); 
const an=await db.query(`select * from messages`).catch(e=>({err:e})); ok(an.err||an.rows.length===0,'anonymous visitor reads nothing');
ok((await as('winner',`select * from notifications where kind='new_message'`)).rows.length===1,'provider got 1 new-message notification');
ok((await as('buyer',`select * from notifications where kind='new_message'`)).rows.length===1,'buyer got 1 new-message notification');
// read-only after close
await db.exec(`reset role; update intents set status='closed' where id='${I}';`);
ok((await as('buyer',`select * from messages`)).rows.length===2,'history still readable after WANT closed');
await expectErr('buyer',`insert into messages(intent_id,sender_id,body) values('${I}','${U.buyer}','late')`,'no new messages after WANT closed');
// existing flow intact
ok((await as('winner',`select * from intents where id='${I}'`)).rows.length===1,'provider still sees accepted WANT (003 policy intact)');
ok((await db.query(`select 1 from pg_publication_tables where tablename='messages'`)).rows.length===1,'messages added to realtime publication');

// 005 checks
ok((await db.query(`select count(*)::int n from profiles`)).rows[0].n===4,'signup trigger still creates profiles (non-superuser auth role)');
await db.exec(`reset role; set role anon;`);
for (const f of [`accept_offer('${W}','${I}')`,`provider_has_offer('${I}')`,`is_conversation_participant('${I}')`]) {
  const r=await db.query(`select ${f}`).catch(e=>({err:e})); ok(!!r.err,'anon cannot call '+f.split('(')[0]);
}
for (const t of ['profiles','intents','offers','notifications','messages']) {
  const r=await db.query(`select * from ${t}`).catch(e=>({err:e})); ok(!!r.err,'anon has no access to '+t);
}
const tf=await as('buyer',`select notify_new_message()`).catch(e=>({err:e})); ok(!!tf.err,'signed-in user cannot call trigger function via API');
const tr=await as('buyer',`truncate messages`).catch(e=>({err:e})); ok(!!tr.err,'signed-in user cannot TRUNCATE messages');
const tr2=await as('winner',`truncate intents cascade`).catch(e=>({err:e})); ok(!!tr2.err,'signed-in user cannot TRUNCATE intents');
// full fresh flow still works after 005
const I2=(await as('buyer',`insert into intents(buyer_id,description) values('${U.buyer}','Fix sink') returning id`)).rows[0].id;
const W2=(await as('winner',`insert into offers(intent_id,provider_id,amount) values('${I2}','${U.winner}',80) returning id`)).rows[0].id;
await as('buyer',`select accept_offer('${W2}','${I2}')`);
await as('winner',`insert into messages(intent_id,body) values('${I2}','On my way')`);
ok((await as('buyer',`select * from messages where intent_id='${I2}'`)).rows.length===1,'post-005: post → offer → accept → message flow works');
ok((await as('buyer',`select * from notifications where kind='new_message'`)).rows.length===2,'post-005: message notification trigger still fires');

// 006 notifications
const cnt=async(u,w)=>(await as(u,`select count(*)::int n from notifications where ${w}`)).rows[0].n;
const I3=(await as('buyer',`insert into intents(buyer_id,description) values('${U.buyer}','Paint fence') returning id`)).rows[0].id;
const W3=(await as('winner',`insert into offers(intent_id,provider_id,amount) values('${I3}','${U.winner}',150) returning id`)).rows[0].id;
await as('loser',`insert into offers(intent_id,provider_id,amount) values('${I3}','${U.loser}',140.5)`);
ok(await cnt('buyer',`kind='new_offer' and intent_id='${I3}'`)===2,'buyer notified of each new offer (linked to WANT)');
ok((await as('buyer',`select body from notifications where kind='new_offer' and body like '%140.50%'`)).rows.length===1,'offer notification shows amount');
await as('buyer',`select accept_offer('${W3}','${I3}')`);
ok(await cnt('winner',`kind='offer_accepted' and intent_id='${I3}'`)===1,'accepted provider notified (linked)');
ok(await cnt('loser',`kind='offer_declined' and intent_id='${I3}'`)===1,'losing provider notified of decline');
ok(await cnt('winner',`kind='offer_declined'`)===0,'winner not told they were declined');
for(let k=0;k<3;k++) await as('winner',`insert into messages(intent_id,body) values('${I3}','msg ${k}')`);
ok(await cnt('buyer',`kind='new_message' and intent_id='${I3}' and read_at is null`)===1,'3 messages -> 1 unread message notification');
const mr=await as('buyer',`update notifications set read_at=now() where intent_id='${I3}' and read_at is null returning id`);
ok(mr.rows.length===3,'user can mark own notifications read');
await as('winner',`insert into messages(intent_id,body) values('${I3}','after read')`);
ok(await cnt('buyer',`kind='new_message' and intent_id='${I3}' and read_at is null`)===1,'new message after reading creates fresh unread');
const other=await as('loser',`update notifications set read_at=now() where user_id='${U.buyer}' returning id`);
ok(other.rows.length===0,'cannot mark someone else\'s notifications');
ok(await cnt('loser',`user_id<>'${U.loser}'`)===0,'cannot read someone else\'s notifications');
await expectErr('buyer',`update notifications set body='hacked' where user_id='${U.buyer}'`,'cannot change notification text');
await expectErr('buyer',`update notifications set user_id='${U.loser}' where user_id='${U.buyer}'`,'cannot reassign a notification');
await expectErr('buyer',`insert into notifications(user_id,kind,body) values('${U.buyer}','x','fake')`,'cannot create fake notifications');
const dn=await as('buyer',`delete from notifications returning id`).catch(e=>({err:e})); ok(dn.err||dn.rows.length===0,'cannot delete notifications');
const nf=await as('buyer',`select notify_new_offer()`).catch(e=>({err:e})); ok(!!nf.err,'new-offer trigger function not callable via API');
ok((await db.query(`select 1 from pg_publication_tables where tablename='notifications'`)).rows.length===1,'notifications in realtime publication');
console.log(`\n${pass} passed, ${fail} failed`);
