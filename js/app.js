/* Luckyroom Telegram replica v2 — WebK-accurate, frontend only */
const $ = s => document.querySelector(s);
/* Telegram sender palette (from official clients) */
const NAMES = ["#e17076","#faa357","#a695e7","#7bc862","#6ec9cb","#65aadd","#ee7aae"];
const AV = [
  ["#ff845e","#d45246"],["#ffa127","#e46e18"],["#b580f2","#7b61ff"],
  ["#5fc9f3","#3390ec"],["#5dd978","#3aa655"],["#6ad7fd","#2a9ad8"],
  ["#f27fa5","#d44d7d"]
];
const G = i => AV[i % AV.length];
const NC = i => NAMES[i % NAMES.length];

const chats = [
  {id:0,type:"personal",name:"Saved Messages",init:"🔖",g:-1,self:1,status:"",time:"11:20",preview:"You: new wallpaper pattern ✅",msgs:[
    {me:1,t:"todo: ship Telegram replica v2 ✅",time:"11:18",read:1},
    {me:1,t:"new wallpaper pattern + tails + folders",time:"11:20",read:1},
  ]},
  {id:1,type:"personal",name:"Sara Mohammadi",init:"SM",g:3,status:"online",unread:2,time:"12:42",typing:true,msgs:[
    {f:"Sara Mohammadi",c:2,t:"Hey! Did you see the new design? 👀",time:"12:38"},
    {me:1,t:"Hi Sara! Not yet, send me the link",time:"12:39",read:1},
    {f:"Sara Mohammadi",c:2,t:"Check the repo — I pushed the new UI draft 🎨",time:"12:40"},
    {me:1,t:"This looks exactly like Telegram WebK 😍",time:"12:41",read:1},
  ]},
  {id:2,type:"groups",name:"Luckyroom Devs",init:"LD",g:5,status:"128 members, 12 online",unread:3,time:"12:30",pin:1,pinned:"Sprint: Telegram replica v2 — details matter",msgs:[
    {sys:"Ali joined the group via invite link"},
    {f:"Ali",c:0,t:"Salam! v2 must be pixel-close to Telegram 📐",time:"12:10"},
    {f:"Nima",c:3,t:"Chat list rows = 72px, avatar 54px, got it ✅",time:"12:15"},
    {f:"Nima",c:3,t:"Folders need counters like real client",time:"12:16"},
    {me:1,t:"Bubbles + tails + wallpaper done 💪",time:"12:20",read:1},
    {f:"Ali",c:0,t:"Perfect. Ship it today 🚀",time:"12:30"},
  ]},
  {id:3,type:"channels",name:"Luckyroom News",init:"LN",g:1,status:"2.4K subscribers",verified:1,time:"11:58",mute:1,msgs:[
    {f:"Luckyroom News",c:0,photo:"📢",t:"v2 preview is out — WebK-accurate dark theme 🌙",time:"11:58",views:"1.2K"},
  ]},
  {id:5,type:"personal",name:"Reza Bot",init:"RB",g:6,status:"bot",verified:1,bot:1,time:"10:05",msgs:[
    {f:"Reza Bot",c:5,t:"Hello! Send /help to see what I can do 🤖",time:"10:05"},
    {me:1,t:"/help",time:"10:06",read:1},
    {f:"Reza Bot",c:5,t:"Available: /ui /colors /ship 🚀",time:"10:06"},
  ]},
  {id:6,type:"personal",name:"Mina",init:"M",g:2,status:"last seen recently",time:"09:41",unread:1,msgs:[
    {f:"Mina",c:1,photo:"🌅",t:"Sunset from yesterday!",time:"09:41"},
    {me:1,t:"Wooow 😍 where is this?",time:"09:42",read:1},
  ]},
  {id:7,type:"groups",name:"Family ❤️",init:"F",g:4,status:"8 members",time:"Yesterday",msgs:[
    {f:"Mom",c:0,t:"Dinner at 8, don't be late 🍲",time:"20:10"},
    {me:1,t:"On my way! 🛵",time:"20:12",read:1},
  ]},
  {id:8,type:"personal",name:"Arman",init:"A",g:7,status:"online",time:"Yesterday",msgs:[
    {f:"Arman",c:4,voice:42,t:"",time:"18:02"},
    {me:1,t:"Listened 👍 sounds good!",time:"18:10",read:1},
  ]},
  {id:9,type:"channels",name:"Design Daily",init:"DD",g:3,status:"18.2K subscribers",verified:1,time:"Monday",mute:1,msgs:[
    {f:"Design Daily",c:2,t:"Bubble radius: 12px big, 5px small corner — from WebK source 📐",time:"15:00",views:"8.4K"},
  ]},
  {id:10,type:"personal",name:"Niloofar",init:"N",g:2,status:"last seen 1 hour ago",time:"Monday",msgs:[
    {me:1,file:{n:"ui-spec-v2.pdf",s:"2.4 MB"},t:"Spec v2 is ready 📄",time:"14:00",read:1},
    {f:"Niloofar",c:1,t:"Got it, reviewing now 👀",time:"14:05"},
  ]},
];

let activeId = 2, folder = "all", replyTo = null;
const list = $("#chatList"), msgsEl = $("#msgs"), ctx = $("#ctx");
const previewOf = c => {
  const l = c.msgs[c.msgs.length-1]; if(!l) return "";
  if(l.sys) return l.sys;
  let p = (l.me ? "You: " : (c.type==="groups" ? l.f.split(" ")[0]+": " : "")) ;
  if(l.photo) p += "🖼 Photo";
  else if(l.voice) p += "🎤 Voice · 0:"+l.voice;
  else if(l.file) p += "📄 "+l.file.n;
  else p += l.t;
  return p;
};

/* stories — Telegram style */
$("#stories").innerHTML =
  `<div class="story"><div class="ring mine"><span>LU</span><span class="plus">+</span></div>My Story</div>` +
  ["Ali","Sara","Nima","Mina","Arman","Nilo"].map((n,i)=>`<div class="story"><div class="ring"><span>${n[0]}</span></div>${n}</div>`).join("");

/* folders with counters */
function renderFolders(){
  const counts = {all:chats.length,personal:chats.filter(c=>c.type==="personal").length,groups:chats.filter(c=>c.type==="groups").length,channels:chats.filter(c=>c.type==="channels").length};
  $("#folders").innerHTML = [["all","All Chats"],["personal","Personal"],["groups","Groups"],["channels","Channels"]]
    .map(([k,l])=>`<button class="folder${folder===k?" active":""}" data-f="${k}">${l}<span class="cnt">${counts[k]}</span></button>`).join("");
  document.querySelectorAll(".folder").forEach(f=>f.onclick=()=>{folder=f.dataset.f;renderFolders();renderList();});
}

const tick = m => !m.me ? "" : (m.read?`<span class="read">✓✓</span>`:`<span>✓</span>`);
const now = () => new Date().toTimeString().slice(0,5);

function renderList(){
  const q = ($("#search").value||"").toLowerCase();
  list.innerHTML = "";
  chats.filter(c=>(folder==="all"||c.type===folder)&&(c.name.toLowerCase().includes(q)||previewOf(c).toLowerCase().includes(q))).forEach(c=>{
    const b = document.createElement("button");
    b.className = "chat"+(c.id===activeId?" active":"");
    const [g1,g2] = c.g===-1 ? ["#37aee2","#1e96c8"] : G(c.g);
    const un = c.unread ? `<span class="badge">${c.unread}</span>` : "";
    const sub = c.typing ? `<span class="c-sub typing"><span class="typing-dots"><i></i><i></i><i></i></span> typing...</span>`
      : `<span class="c-sub">${c.me_last?"✓✓ ":""}${previewOf(c)}</span>`;
    b.innerHTML = `<div class="avatar" style="--g1:${g1};--g2:${g2}">${c.init}</div>
      <div class="c-main">
        <div class="c-top"><span class="c-name">${c.pin?"📌 ":""}${c.name}${c.verified?'<span class="verified">✦</span>':""}${c.mute?' <span class="mute">🔇</span>':""}</span><span class="c-time">${c.time}</span></div>
        <div class="c-bot">${sub}<span class="c-right">${un}</span></div>
      </div>`;
    b.onclick = () => openChat(c.id);
    b.oncontextmenu = e => { e.preventDefault(); showCtx(e.clientX,e.clientY,[
      [c.pin?"Unpin":"📌 Pin",()=>{c.pin=!c.pin;renderList();}],
      [c.mute?"Unmute":"🔇 Mute",()=>{c.mute=!c.mute;renderList();}],
      ["✓ Mark as read",()=>{c.unread=0;renderList();}],
      ["🗑 Delete",()=>{},1],
    ]);};
    list.appendChild(b);
  });
}

function bubHTML(m, prev){
  const grp = prev && prev.f===m.f && prev.me===m.me && !m.sys ? "" : "grp";
  const isG = chats.find(x=>x.id===activeId)?.type==="groups" && !m.me;
  let inner = "";
  if(isG && grp) inner += `<div class="from" style="color:${NC(m.c||0)}">${m.f}</div>`;
  if(m.quote) inner += `<div class="quote"><b>${m.quote.f}</b><br>${m.quote.t}</div>`;
  if(m.photo) inner += `<div class="photo">${m.photo}<small>${m.views?m.views+" views · ":""}${m.time||""}</small></div>`;
  if(m.voice) inner += `<div class="voice"><span class="play">▶</span><span class="wave">${bars()}</span><small>0:${m.voice}</small></div>`;
  if(m.file) inner += `<div class="file"><span style="font-size:26px">📄</span><div><b>${m.file.n}</b><small>${m.file.s}</small></div></div>`;
  if(m.t) inner += `<span>${m.t}</span>`;
  if(!m.photo) inner += `<span class="meta">${m.views?m.views+" 👁 · ":""}${m.time||now()} ${tick(m)}</span>`;
  return `<div class="row ${m.me?"out":"in"} ${grp}"><div class="bub" data-t="${(m.t||"message").replace(/"/g,"")}">${inner}</div>
    <div class="msg-actions"><span>😍</span><span>↩️</span></div></div>`;
}
function bars(){const h=[8,16,22,12,20,10,18,14,24,11,17,9,21,13];return h.map(v=>`<i style="height:${v}px"></i>`).join("");}

function openChat(id){
  activeId=id; replyTo=null; $("#replyBar").classList.add("hidden");
  const c=chats.find(x=>x.id===id);
  c.unread=0; c.typing=false;
  $("#emptyState").classList.add("hidden");
  $("#chatView").classList.remove("hidden");
  const [g1,g2]=c.g===-1?["#37aee2","#1e96c8"]:G(c.g);
  const av=$("#peerAvatar");av.textContent=c.init;av.style.setProperty("--g1",g1);av.style.setProperty("--g2",g2);
  $("#peerName").textContent=c.name;
  $("#verified").classList.toggle("hidden",!c.verified);
  const st=$("#peerStatus");st.textContent=c.typing?"typing...":(c.status||"");st.classList.toggle("gray",!c.status||c.status.includes("seen")||c.status.includes("member")||c.status.includes("subscriber"));
  $("#infoName").textContent=c.name;$("#infoStatus").textContent=c.status||"";
  const ia=$("#infoAvatar");ia.textContent=c.init;ia.style.setProperty("--g1",g1);ia.style.setProperty("--g2",g2);
  const pb=$("#pinnedBar");
  if(c.pinned){pb.classList.remove("hidden");$("#pinnedText").textContent=c.pinned;}else pb.classList.add("hidden");
  drawMsgs(c);
  if(innerWidth<=925){$("#sidebar").classList.add("hide");$("#main").classList.remove("hide");}
  renderFolders();renderList();
}
function drawMsgs(c){
  let html = `<div class="day">Today</div>`;
  c.msgs.forEach((m,i)=>{ html += m.sys?`<div class="service">${m.sys}</div>`:bubHTML(m,c.msgs[i-1]); });
  msgsEl.innerHTML = html;
  msgsEl.scrollTop = msgsEl.scrollHeight;
  msgsEl.querySelectorAll(".bub").forEach(el=>{
    el.ondblclick=()=>{replyTo={t:el.dataset.t};$("#replyName").textContent="Reply";$("#replyText").textContent=replyTo.t;$("#replyBar").classList.remove("hidden");};
    el.oncontextmenu=e=>{e.preventDefault();showCtx(e.clientX,e.clientY,[["↩️ Reply",()=>el.ondblclick()],["📋 Copy",()=>navigator.clipboard?.writeText(el.dataset.t)],["➡️ Forward",()=>{}],["🗑 Delete",()=>{},1]]);};
  });
  updateBottom();
}

function send(){
  const inp=$("#msgInput");const t=inp.value.trim();if(!t||activeId==null)return;
  const c=chats.find(x=>x.id===activeId);
  const m={me:1,t,time:now(),read:0};
  if(replyTo){m.quote={f:c.name,t:replyTo.t};replyTo=null;$("#replyBar").classList.add("hidden");}
  c.msgs.push(m);c.time=now();inp.value="";
  drawMsgs(c);renderList();
  setTimeout(()=>{m.read=1;if(c.id===activeId)drawMsgs(c);renderList();},800);
  if(c.type!=="channels"&&!c.self&&!c.bot){
    setTimeout(()=>{const r={f:c.name.split(" ")[0],c:c.g||0,t:"Nice! 👌",time:now()};c.msgs.push(r);c.time=now();
      if(c.id===activeId)drawMsgs(c);else{c.unread=(c.unread||0)+1;renderList();}},2000);
  }
}
$("#sendBtn").onclick=send;
$("#msgInput").addEventListener("keydown",e=>{if(e.key==="Enter")send();});
document.addEventListener("keydown",e=>{
  if(e.key==="/"&&document.activeElement!==$("#msgInput")&&document.activeElement!==$("#search")){e.preventDefault();$("#search").focus();}
  if(e.key==="Escape"){ctx.classList.add("hidden");$("#emojiPop").classList.add("hidden");}
});
msgsEl.addEventListener("scroll",updateBottom);
function updateBottom(){
  const near = msgsEl.scrollHeight-msgsEl.scrollTop-msgsEl.clientHeight<120;
  $("#toBottom").classList.toggle("hidden",near);
}
$("#toBottom").onclick=()=>{msgsEl.scrollTop=msgsEl.scrollHeight;};

/* ctx menu */
function showCtx(x,y,items){
  ctx.innerHTML=items.map((it,i)=>`<button data-i="${i}" class="${it[2]?"danger":""}">${it[0]}</button>`).join("");
  ctx.classList.remove("hidden");
  ctx.style.left=Math.min(x,innerWidth-230)+"px";ctx.style.top=Math.min(y,innerHeight-items.length*42-20)+"px";
  ctx.querySelectorAll("button").forEach(b=>b.onclick=()=>{items[+b.dataset.i][1]();ctx.classList.add("hidden");});
}
document.addEventListener("click",e=>{if(!e.target.closest("#ctx"))ctx.classList.add("hidden");});

/* misc */
$("#search").addEventListener("input",renderList);
$("#backBtn").onclick=()=>{$("#sidebar").classList.remove("hide");$("#main").classList.add("hide");};
$("#replyClose").onclick=()=>{replyTo=null;$("#replyBar").classList.add("hidden");};
$("#pinnedClose").onclick=()=>$("#pinnedBar").classList.add("hidden");
const drawer=$("#drawer"),scrim=$("#scrim");
$("#burger").onclick=()=>{drawer.classList.add("open");scrim.classList.remove("hidden");};
$("#fab").onclick=()=>{drawer.classList.add("open");scrim.classList.remove("hidden");};
scrim.onclick=()=>{drawer.classList.remove("open");scrim.classList.add("hidden");};
function toggleTheme(){
  const h=document.documentElement;
  h.dataset.theme=h.dataset.theme==="dark"?"light":"dark";
  $("#nightSw").checked=h.dataset.theme==="dark";
}
$("#themeBtn").onclick=()=>{toggleTheme();scrim.click();};
$("#nightSw").onchange=toggleTheme;
const em=["😀","😂","😍","👍","🙏","🎉","❤️","🔥","👀","🚀","😢","😮","👏","💪","🎨","📌","🍲","🌅","🤖","✅","😁","🥲","💯","🙌","😴","🤝","👋","⭐"];
$("#emojiPop").innerHTML=em.map(e=>`<span>${e}</span>`).join("");
$("#emojiPop").querySelectorAll("span").forEach(s=>s.onclick=()=>{$("#msgInput").value+=s.textContent;$("#msgInput").focus();});
$("#emojiBtn").onclick=e=>{e.stopPropagation();$("#emojiPop").classList.toggle("hidden");};
document.addEventListener("click",e=>{if(!e.target.closest("#emojiPop,#emojiBtn"))$("#emojiPop").classList.add("hidden");});
$("#peerBtn").onclick=()=>$("#infoPanel").classList.toggle("hidden");
$("#infoBtn").onclick=()=>$("#infoPanel").classList.toggle("hidden");
$("#infoClose").onclick=()=>$("#infoPanel").classList.add("hidden");
$("#infoMedia").innerHTML=Array.from({length:9}).join("<div></div>");
$("#searchMsgBtn").onclick=()=>{if(innerWidth<=925)$("#backBtn").click();setTimeout(()=>$("#search").focus(),50);};

renderFolders();
if(innerWidth>925) openChat(2); else {$("#main").classList.add("hide");renderList();}
