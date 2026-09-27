/* Luckyroom Telegram-replica UI — frontend only, mock data */
const $ = s => document.querySelector(s);
const grads = [
  ["#ff845e","#d45246"],["#ffa127","#e46e18"],["#b580f2","#7b61ff"],
  ["#5fc_bef".replace("_",""),"#2aabee"],["#5dd978","#3aa655"],["#6ad7fd","#2a9ad8"],
  ["#f27fa5","#d44d7d"],["#8bc34a","#558b2f"]
];
const G = i => grads[i % grads.length];

const chats = [
  {id:1,type:"personal",name:"Sara Mohammadi",init:"SM",g:3,status:"online",unread:2,time:"12:42",typing:true,preview:"is typing...",msgs:[
    {f:"Sara Mohammadi",c:3,t:"Hey! Did you see the new design? 👀"},
    {me:1,t:"Hi Sara! Not yet, send me the link"},
    {f:"Sara Mohammadi",c:3,t:"Check the Luckyroom repo, I pushed the new UI draft 🎨",time:"12:40"},
    {me:1,t:"Looks amazing, very Telegram-like!",time:"12:41",read:1},
  ]},
  {id:2,type:"groups",name:"Luckyroom Devs 💬",init:"LD",g:5,status:"128 members, 12 online",unread:5,time:"12:30",preview:"Ali: let's ship the replica today 🚀",msgs:[
    {sys:"Ali joined the group"},
    {f:"Ali",c:1,t:"Salam everyone! Ready for the Telegram replica?",time:"12:10"},
    {f:"Nima",c:4,t:"Ready ✅ I handle the chat list UI",time:"12:15"},
    {me:1,t:"I take the chat window + bubbles 💪",time:"12:20",read:1},
    {f:"Ali",c:1,t:"Perfect. Let's ship it today 🚀",time:"12:30"},
  ],pinned:"Sprint goal: Telegram-like UI v1"},
  {id:3,type:"channels",name:"Luckyroom News",init:"LN",g:1,status:"2.4K subscribers",time:"11:58",preview:"📢 v2 UI preview is out!",mute:1,msgs:[
    {f:"Luckyroom News",c:1,t:"📢 v2 UI preview is out! Telegram-style dark mode included 🌙",time:"11:58"},
  ]},
  {id:4,type:"personal",name:"Saved Messages",init:"🔖",g:0,status:"",time:"11:20",preview:"You: todo: fix bubbles",self:1,msgs:[
    {me:1,t:"todo: fix bubbles tail + time alignment",time:"11:20",read:1},
    {me:1,t:"https://github.com/Imluckyluke/luckyroom-telegram",time:"11:21",read:1},
  ]},
  {id:5,type:"personal",name:"Reza Bot 🤖",init:"RB",g:6,status:"bot",time:"10:05",preview:"What can this bot do?",bot:1,msgs:[
    {f:"Reza Bot",c:6,t:"Hello! I'm a demo bot 🤖. Send /help to see commands.",time:"10:05"},
    {me:1,t:"/help",time:"10:06",read:1},
  ]},
  {id:6,type:"personal",name:"Mina",init:"M",g:2,status:"last seen recently",time:"09:41",preview:"Sent a photo",photo:1,msgs:[
    {f:"Mina",c:2,photo:"🌅",t:"Sunset from yesterday!",time:"09:41"},
    {me:1,t:"Wooow 😍 where is this?",time:"09:42",read:1},
  ]},
  {id:7,type:"groups",name:"Family ❤️",init:"F",g:4,status:"8 members",time:"Yesterday",pin:1,preview:"Mom: dinner at 8 🍲",msgs:[
    {f:"Mom",c:1,t:"Dinner at 8, don't be late 🍲",time:"20:10"},
    {me:1,t:"On my way! 🛵",time:"20:12",read:1},
  ]},
  {id:8,type:"personal",name:"Arman",init:"A",g:7,status:"online",time:"Yesterday",voice:1,preview:"🎤 Voice · 0:42",msgs:[
    {f:"Arman",c:7,voice:42,t:"",time:"18:02"},
  ]},
  {id:9,type:"channels",name:"Design Daily",init:"DD",g:3,status:"18K subscribers",time:"Monday",preview:"10 dark UI tips",mute:1,msgs:[
    {f:"Design Daily",c:3,t:"10 tips for perfect dark-mode chat UI 🎨",time:"15:00"},
  ]},
  {id:10,type:"personal",name:"Niloofar",init:"N",g:2,status:"last seen 1 hour ago",time:"Monday",preview:"You: file sent 📄",file:{n:"ui-spec.pdf",s:"2.1 MB"},msgs:[
    {me:1,file:{n:"ui-spec.pdf",s:"2.1 MB"},t:"UI spec is ready 📄",time:"14:00",read:1},
    {f:"Niloofar",c:2,t:"Got it, reviewing now 👀",time:"14:05"},
  ]},
];

let activeId = null, folder = "all", replyTo = null;
const list = $("#chatList"), msgsEl = $("#msgs");

/* stories */
$("#stories").innerHTML = ["You","Ali","Sara","Nima","Mina","Arman"].map((n,i)=>
  `<div class="story"><div class="ring"><span>${n[0]}</span></div>${n}</div>`).join("");

function tickHTML(m){
  if(!m.me) return "";
  return m.read ? `<span class="read">✓✓</span>` : `<span>✓</span>`;
}
function renderList(){
  const q = ($("#search").value||"").toLowerCase();
  list.innerHTML = "";
  chats.filter(c=>(folder==="all"||c.type===folder)&&(c.name.toLowerCase().includes(q))).forEach(c=>{
    const b = document.createElement("button");
    b.className = "chat"+(c.id===activeId?" active":"");
    const [g1,g2]=c.g===0?["#2aabee","#7b61ff"]:G(c.g);
    b.innerHTML = `
      <div class="avatar" style="--g1:${g1};--g2:${g2}">${c.init}</div>
      <div class="c-main">
        <div class="c-top"><span class="c-name">${c.pin?"📌 ":""}${c.name}</span><span class="c-time">${c.time}</span></div>
        <div class="c-bot"><span class="c-sub${c.typing?" typing":""}">${c.typing?"typing...":c.preview}</span>
        <span class="c-right">${c.mute?'<span class="mute">🔇</span>':""}${c.unread?`<span class="badge">${c.unread}</span>`:""}${(!c.unread&&c.self)?"":""}</span></div>
      </div>`;
    b.onclick = ()=>openChat(c.id);
    list.appendChild(b);
  });
}

function bubHTML(m){
  let inner = "";
  if(m.f && !m.me && currentGroup()) inner += `<div class="from" style="color:${G(m.c||1)[1]}">${m.f}</div>`;
  if(m.quote) inner += `<div class="quote"><b>${m.quote.f}</b><br>${m.quote.t}</div>`;
  if(m.photo) inner += `<div class="photo">${m.photo}</div>`;
  if(m.voice) inner += `<div class="voice"><span class="play">▶</span><span class="wave">${bars()}</span><small>${"0:"+m.voice}</small></div>`;
  if(m.file) inner += `<div class="file"><span style="font-size:26px">📄</span><div><b>${m.file.n}</b><small>${m.file.s}</small></div></div>`;
  if(m.t) inner += `<span>${m.t}</span>`;
  inner += `<span class="meta">${m.time||now()} ${tickHTML(m)}</span>`;
  return `<div class="row ${m.me?"out":"in"}"><div class="bub" data-t="${(m.t||"").replace(/"/g,"")}">${inner}</div></div>`;
}
function bars(){
  let s=""; const h=[8,16,22,12,20,10,18,14,24,11,17,9,21,13,19,12];
  h.forEach(v=>s+=`<i style="height:${v}px"></i>`);
  return s;
}
const now = ()=>new Date().toTimeString().slice(0,5);
const currentGroup = ()=>{ const c=chats.find(x=>x.id===activeId); return c&&c.type==="groups"; };

function openChat(id){
  activeId=id; replyTo=null; $("#replyBar").classList.add("hidden");
  const c=chats.find(x=>x.id===id);
  c.unread=0; c.typing=false;
  $("#emptyState").classList.add("hidden");
  $("#chatView").classList.remove("hidden");
  const [g1,g2]=c.g===0?["#2aabee","#7b61ff"]:G(c.g);
  const av=$("#peerAvatar"); av.textContent=c.init; av.style.setProperty("--g1",g1); av.style.setProperty("--g2",g2);
  $("#peerName").textContent=c.name; $("#peerStatus").textContent=c.status||"";
  $("#infoName").textContent=c.name; $("#infoStatus").textContent=c.status||"";
  const ia=$("#infoAvatar"); ia.textContent=c.init; ia.style.setProperty("--g1",g1); ia.style.setProperty("--g2",g2);
  const pb=$("#pinnedBar");
  if(c.pinned){pb.classList.remove("hidden");$("#pinnedText").textContent=c.pinned;}else pb.classList.add("hidden");
  msgsEl.innerHTML = `<div class="day">Today</div>` + (c.msgs||[]).map(m=>m.sys?`<div class="service">${m.sys}</div>`:bubHTML(m)).join("");
  msgsEl.scrollTop = msgsEl.scrollHeight;
  // reply on double click
  msgsEl.querySelectorAll(".bub").forEach(el=>{
    el.ondblclick=()=>{ replyTo={f:"reply",t:el.dataset.t||"message"}; $("#replyName").textContent="Reply"; $("#replyText").textContent=replyTo.t; $("#replyBar").classList.remove("hidden"); };
  });
  if(innerWidth<=900){ $("#sidebar").classList.add("hide"); $("#main").classList.remove("hide"); }
  renderList();
}

/* send */
function send(){
  const inp=$("#msgInput"); const t=inp.value.trim(); if(!t||!activeId) return;
  const c=chats.find(x=>x.id===activeId);
  const m={me:1,t,time:now(),read:0};
  if(replyTo){m.quote={f:c.name,t:replyTo.t};replyTo=null;$("#replyBar").classList.add("hidden");}
  c.msgs.push(m); c.preview="You: "+t; c.time=now();
  inp.value=""; openChatRefresh(c);
  setTimeout(()=>{m.read=1;openChatRefresh(c);},900);
  // fake reply in personal chats
  if(c.type==="personal"&&!c.self){
    setTimeout(()=>{c.msgs.push({f:c.name,c:c.g,t:"Got it 👍",time:now()});c.preview=c.name.split(" ")[0]+": Got it 👍";c.time=now();if(c.id===activeId)openChatRefresh(c);else{c.unread=(c.unread||0)+1;renderList();}},2200);
  }
}
function openChatRefresh(c){
  msgsEl.innerHTML = `<div class="day">Today</div>` + c.msgs.map(m=>m.sys?`<div class="service">${m.sys}</div>`:bubHTML(m)).join("");
  msgsEl.scrollTop=msgsEl.scrollHeight; renderList();
}
$("#sendBtn").onclick=send;
$("#msgInput").addEventListener("keydown",e=>{if(e.key==="Enter")send();});
$("#msgInput").addEventListener("input",e=>{$("#sendIcon").style.transform=e.target.value?"rotate(-45deg)":"none";});

/* folders + search */
document.querySelectorAll(".folder").forEach(f=>f.onclick=()=>{document.querySelectorAll(".folder").forEach(x=>x.classList.remove("active"));f.classList.add("active");folder=f.dataset.f;renderList();});
$("#search").addEventListener("input",renderList);
$("#backBtn").onclick=()=>{$("#sidebar").classList.remove("hide");$("#main").classList.add("hide");};
$("#replyClose").onclick=()=>{replyTo=null;$("#replyBar").classList.add("hidden");};
$("#pinnedClose").onclick=()=>$("#pinnedBar").classList.add("hidden");

/* drawer + theme */
const drawer=$("#drawer"),scrim=$("#scrim");
$("#burger").onclick=()=>{drawer.classList.add("open");scrim.classList.remove("hidden");};
scrim.onclick=()=>{drawer.classList.remove("open");scrim.classList.add("hidden");};
function toggleTheme(){
  const h=document.documentElement;
  h.dataset.theme=h.dataset.theme==="dark"?"light":"dark";
}
$("#themeBtn").onclick=()=>{toggleTheme();scrim.click();};

/* emoji */
const em=["😀","😂","😍","👍","🙏","🎉","❤️","🔥","👀","🚀","😢","😮","👏","💪","🎨","📌","🍲","🌅","🤖","✅"];
$("#emojiPop").innerHTML=em.map(e=>`<span>${e}</span>`).join("");
$("#emojiPop").querySelectorAll("span").forEach(s=>s.onclick=()=>{$("#msgInput").value+=s.textContent;$("#msgInput").focus();});
$("#emojiBtn").onclick=e=>{e.stopPropagation();$("#emojiPop").classList.toggle("hidden");};
document.addEventListener("click",e=>{if(!e.target.closest("#emojiPop,#emojiBtn"))$("#emojiPop").classList.add("hidden");});

/* info panel */
$("#peerBtn").onclick=()=>$("#infoPanel").classList.toggle("hidden");
$("#infoBtn").onclick=()=>$("#infoPanel").classList.toggle("hidden");
$("#infoClose").onclick=()=>$("#infoPanel").classList.add("hidden");
$("#infoMedia").innerHTML=Array.from({length:9}).join("<div></div>");
$("#newChatBtn").onclick=()=>{drawer.classList.add("open");scrim.classList.remove("hidden");};
$("#searchMsgBtn").onclick=()=>{$("#search").focus();if(innerWidth<=900)$("#backBtn").click();};

if(innerWidth>900) openChat(2); else {$("#main").classList.add("hide");renderList();}
renderList();
