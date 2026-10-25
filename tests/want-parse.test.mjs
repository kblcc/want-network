// Run: node tests/want-parse.test.mjs
import {parseWant,parseAnswer,parseBudget,parseDeadline,parseLocation,guessCategory,friendlyDate} from '../src/want-parse.js';
// Fixed "now": Sunday 2026-10-25, 11:00 local
const NOW=new Date(2026,9,25,11,0);
let pass=0,fail=0;
const eq=(got,exp,msg)=>{const ok=JSON.stringify(got)===JSON.stringify(exp);ok?pass++:fail++;if(!ok)console.log('FAIL',msg,'\n   got ',JSON.stringify(got),'\n   want',JSON.stringify(exp));};
const w=t=>parseWant(t,NOW);

// Full sentences
eq(w('Need my kitchen sink fixed tomorrow in Aurora, around $100'),{description:'Need my kitchen sink fixed tomorrow in Aurora, around $100',category:'plumbing',budget:100,location:'Aurora',deadline:'2026-10-26'},'sink');
eq(w('I want my apartment cleaned tomorrow under $120'),{description:'I want my apartment cleaned tomorrow under $120',category:'cleaning',budget:120,location:null,deadline:'2026-10-26'},'placeholder example');
let r=w('someone to walk my dog this weekend in denver for 40 dollars');
eq([r.category,r.budget,r.location,r.deadline],['pets',40,'Denver','2026-10-31'],'dog walk weekend');
r=w('Move a couch from Lakewood to Golden on Friday, budget 150');
eq([r.category,r.budget,r.location,r.deadline],['moving',150,'Lakewood','2026-10-30'],'couch friday');
r=w('Math tutor for my son, 2 hours a week, near Boulder');
eq([r.category,r.budget,r.location],['tutoring',null,'Boulder'],'tutor: "2 hours" is not a budget');
r=w('Assemble an IKEA desk asap in Denver, CO $60');
eq([r.category,r.budget,r.location,r.deadline],['handyman',60,'Denver, CO','2026-10-25'],'ikea asap with state');
r=w('mow my lawn by 10/30 under 50');
eq([r.category,r.budget,r.deadline],['yard',50,'2026-10-30'],'m/d date');
r=w('Photographer for a birthday party on Nov 7th, about $300, in Littleton');
eq([r.category,r.budget,r.location,r.deadline],['events',300,'Littleton','2026-11-07'],'month name date');
r=w('fix my wifi');
eq([r.category,r.budget,r.location,r.deadline],['tech',null,null,null],'nothing but category');
r=w('paint 3 bedrooms next week in the morning');
eq([r.category,r.budget,r.location,r.deadline],['painting',null,null,'2026-11-01'],'"3 bedrooms" not budget; "in the morning" not a place');
r=w('deep clean before move-out $1.5k');
eq([r.category,r.budget],['cleaning',1500],'$1.5k');
r=w('Need groceries picked up in 3 days near me');
eq([r.category,r.location,r.deadline],['errands',null,'2026-10-28'],'"near me" ignored, in 3 days');
eq(w('blah').category,null,'unknown category stays empty');

// Budget edge cases
eq(parseBudget('under 120 for 2 hours'),120,'under 120');
eq(parseBudget('for 2 hours'),null,'for 2 hours');
eq(parseBudget('$1,250'),1250,'comma');
eq(parseBudget('max 80.50'),80.5,'decimal');
eq(parseBudget('around 3 pm'),null,'time is not budget');

// Dates
eq(parseDeadline('today',NOW),'2026-10-25','today');
eq(parseDeadline('tonight',NOW),'2026-10-25','tonight');
eq(parseDeadline('day after tomorrow',NOW),'2026-10-27','day after tomorrow');
eq(parseDeadline('sunday',NOW),'2026-10-25','same weekday = today');
eq(parseDeadline('next sunday',NOW),'2026-11-01','next same weekday = +7');
eq(parseDeadline('monday',NOW),'2026-10-26','monday');
eq(parseDeadline('1/5',NOW),'2027-01-05','past m/d rolls to next year');
eq(parseDeadline('2/30',NOW),null,'invalid date');
eq(parseDeadline('15 december',NOW),'2026-12-15','day month');
eq(parseDeadline('no date here',NOW),null,'none');

// Follow-up answers
eq(parseAnswer('budget','80',NOW),80,'bare number');
eq(parseAnswer('budget','$95',NOW),95,'$95');
eq(parseAnswer('budget','whatever',NOW),null,'no number');
eq(parseAnswer('deadline','tomorrow',NOW),'2026-10-26','answer tomorrow');
eq(parseAnswer('location','aurora',NOW),'Aurora','answer lowercase city');
eq(parseAnswer('location','in west denver',NOW),'West Denver','answer with "in"');
eq(parseAnswer('location','  ',NOW),null,'blank');

// Display helper
eq(friendlyDate('2026-10-25',NOW),'Today','friendly today');
eq(friendlyDate('2026-10-26',NOW),'Tomorrow','friendly tomorrow');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
