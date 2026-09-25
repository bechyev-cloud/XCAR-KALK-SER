// Отдаёт статическую HTML-страницу админ-панели (/admin) — без единой
// npm-зависимости, чистый HTML+CSS+JS в одной строке, как и весь остальной
// проект. Здесь Идрис: 1) смотрит заявки на подписку и продлевает их вручную,
// 2) загружает свои HTML-страницы для чёрного списка, по которым потом ищут
// клиенты в приложении.
function renderAdminPage() {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>XCAR — админ-панель</title>
<style>
body{margin:0;background:#0b1220;color:#e7ebf3;font-family:system-ui,-apple-system,sans-serif;padding:18px;}
.wrap{max-width:720px;margin:0 auto;}
h1{font-size:20px;margin-bottom:4px;}
.sub{color:#8b93a7;font-size:13px;margin-bottom:20px;}
.card{background:#121a2b;border:1px solid #26314a;border-radius:16px;padding:16px;margin-bottom:18px;}
.card h2{font-size:15px;margin:0 0 12px;}
input,textarea{width:100%;box-sizing:border-box;padding:10px 12px;margin:5px 0 10px;border-radius:10px;border:1px solid #26314a;background:#1a2338;color:#e7ebf3;font-family:inherit;font-size:14px;}
textarea{min-height:140px;font-family:ui-monospace,monospace;font-size:12px;}
button{padding:10px 16px;border-radius:10px;border:none;background:#0047ff;color:#fff;font-weight:700;cursor:pointer;font-size:13px;}
button.danger{background:#c62828;}
button.secondary{background:#2a3550;}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}
.item{background:#1a2338;border-radius:12px;padding:10px 12px;margin-bottom:8px;font-size:13px;}
.item .top{display:flex;justify-content:space-between;gap:8px;}
.muted{color:#8b93a7;font-size:11.5px;}
.hint{font-size:12.5px;margin-top:8px;min-height:16px;}
.ok{color:#4ade80;} .err{color:#f87171;}
a{color:#7aa2ff;}
</style>
</head>
<body>
<div class="wrap">
<h1>🔧 XCAR — админ-панель</h1>
<div class="sub">Заявки на подписку и загрузка страниц чёрного списка. Ключ администратора задаётся переменной окружения <code>XCAR_ADMIN_KEY</code> на сервере.</div>

<div class="card">
<h2>🔑 Ключ администратора</h2>
<input id="adminKey" type="password" placeholder="Введите ключ (XCAR_ADMIN_KEY)">
<div class="row"><button onclick="saveKey()">Сохранить и загрузить данные</button></div>
<div class="hint" id="keyHint"></div>
</div>

<div class="card">
<h2>👑 Заявки на подписку</h2>
<div class="muted">Проверьте оплату по ФИО и номеру телефона, затем продлите подписку по логину аккаунта клиента.</div>
<div id="requestsList" style="margin-top:10px;"></div>
<div class="row" style="margin-top:12px;">
<input id="extendUsername" placeholder="Логин аккаунта клиента" style="flex:1;min-width:160px;">
<input id="extendDays" placeholder="Дней" style="width:90px;" inputmode="numeric">
<button onclick="extendSub()">Продлить</button>
</div>
<div class="hint" id="extendHint"></div>
</div>

<div class="card">
<h2>🚫 Чёрный список — загрузка страниц</h2>
<div class="muted">Загрузите HTML-страницу со списком клиентов (можно — просто список ФИО/телефонов). Клиенты в приложении смогут искать по ней в разделе «Чёрный список».</div>
<input id="uploadFilename" placeholder="Название файла, например blacklist1.html">
<textarea id="uploadHtml" placeholder="Вставьте HTML-код страницы или просто текст со списком (по одному клиенту на строку)"></textarea>
<div class="row"><button onclick="uploadPage()">Загрузить</button><input type="file" id="fileInput" accept=".html,.htm,.txt" onchange="handleFile(event)"></div>
<div class="hint" id="uploadHint"></div>
<div id="pagesList" style="margin-top:14px;"></div>
</div>

</div>
<script>
function getKey(){return localStorage.getItem("xcarAdminKey")||"";}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function fmtDate(ts){return ts?new Date(ts).toLocaleString("ru-RU"):"—";}

function saveKey(){
  const k=document.getElementById("adminKey").value.trim();
  if(!k){document.getElementById("keyHint").innerHTML='<span class="err">Введите ключ</span>';return;}
  localStorage.setItem("xcarAdminKey",k);
  document.getElementById("keyHint").innerHTML='<span class="ok">Ключ сохранён в этом браузере ✓</span>';
  loadRequests();
  loadPages();
}

async function loadRequests(){
  const k=getKey();
  if(!k) return;
  try{
    const resp=await fetch("/api/admin/subscription/requests?key="+encodeURIComponent(k));
    if(!resp.ok){document.getElementById("requestsList").innerHTML='<div class="muted err">Неверный ключ или ошибка сервера</div>';return;}
    const data=await resp.json();
    const wrap=document.getElementById("requestsList");
    if(!data.requests.length){wrap.innerHTML='<div class="muted">Пока нет заявок</div>';return;}
    wrap.innerHTML=data.requests.map(r=>
      '<div class="item"><div class="top"><b>'+esc(r.name)+'</b><span class="muted">'+fmtDate(r.createdAt)+'</span></div>'+
      '<div>📞 '+esc(r.phone)+(r.username?' · логин: <b>'+esc(r.username)+'</b>':' · логин не указан (клиент не подключён к аккаунту)')+'</div>'+
      (r.note?'<div class="muted">'+esc(r.note)+'</div>':'')+
      '<div class="row" style="margin-top:6px;"><button class="secondary" onclick="fillExtend(\\''+esc(r.username||"")+'\\')">Заполнить логин ниже</button>'+
      '<button class="danger" onclick="removeRequest(\\''+r.id+'\\')">Удалить заявку</button></div></div>'
    ).join("");
  }catch(e){document.getElementById("requestsList").innerHTML='<div class="muted err">Не удалось загрузить</div>';}
}
function fillExtend(username){document.getElementById("extendUsername").value=username;window.scrollTo({top:document.getElementById("extendUsername").getBoundingClientRect().top+window.scrollY-100,behavior:"smooth"});}
async function removeRequest(id){
  const k=getKey();
  await fetch("/api/admin/subscription/requests/"+encodeURIComponent(id)+"?key="+encodeURIComponent(k),{method:"DELETE"});
  loadRequests();
}
async function extendSub(){
  const k=getKey();
  const username=document.getElementById("extendUsername").value.trim();
  const days=Number(document.getElementById("extendDays").value);
  const hint=document.getElementById("extendHint");
  if(!username||!days){hint.innerHTML='<span class="err">Укажите логин и число дней</span>';return;}
  try{
    const resp=await fetch("/api/admin/subscription/extend",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:k,username,days})});
    const data=await resp.json();
    if(!resp.ok){hint.innerHTML='<span class="err">'+esc(data.error||"Ошибка")+'</span>';return;}
    hint.innerHTML='<span class="ok">Продлено до '+fmtDate(data.subscriptionUntil)+' ✓</span>';
  }catch(e){hint.innerHTML='<span class="err">Не удалось выполнить запрос</span>';}
}

function handleFile(ev){
  const file=ev.target.files[0];
  if(!file) return;
  document.getElementById("uploadFilename").value=file.name;
  const reader=new FileReader();
  reader.onload=()=>{document.getElementById("uploadHtml").value=reader.result;};
  reader.readAsText(file);
}
async function uploadPage(){
  const k=getKey();
  const filename=document.getElementById("uploadFilename").value.trim()||"страница.html";
  const html=document.getElementById("uploadHtml").value;
  const hint=document.getElementById("uploadHint");
  if(!html.trim()){hint.innerHTML='<span class="err">Вставьте содержимое страницы</span>';return;}
  try{
    const resp=await fetch("/api/admin/blacklist/upload",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:k,filename,html})});
    const data=await resp.json();
    if(!resp.ok){hint.innerHTML='<span class="err">'+esc(data.error||"Ошибка")+'</span>';return;}
    hint.innerHTML='<span class="ok">Загружено ✓</span>';
    document.getElementById("uploadHtml").value="";
    loadPages();
  }catch(e){hint.innerHTML='<span class="err">Не удалось загрузить</span>';}
}
async function loadPages(){
  const k=getKey();
  if(!k) return;
  try{
    const resp=await fetch("/api/admin/blacklist/pages?key="+encodeURIComponent(k));
    if(!resp.ok){document.getElementById("pagesList").innerHTML='<div class="muted err">Неверный ключ</div>';return;}
    const data=await resp.json();
    const wrap=document.getElementById("pagesList");
    if(!data.pages.length){wrap.innerHTML='<div class="muted">Пока нет загруженных страниц</div>';return;}
    wrap.innerHTML='<div class="muted" style="margin-bottom:8px;">Обновлено последний раз: '+fmtDate(data.meta.lastUpdatedAt)+'</div>'+data.pages.map(p=>
      '<div class="item"><div class="top"><b>'+esc(p.filename)+'</b><span class="muted">'+fmtDate(p.uploadedAt)+'</span></div>'+
      '<div class="muted">'+p.size+' символов</div>'+
      '<div class="row" style="margin-top:6px;"><button class="danger" onclick="removePage(\\''+p.id+'\\')">Удалить</button></div></div>'
    ).join("");
  }catch(e){document.getElementById("pagesList").innerHTML='<div class="muted err">Не удалось загрузить</div>';}
}
async function removePage(id){
  const k=getKey();
  await fetch("/api/admin/blacklist/pages/"+encodeURIComponent(id)+"?key="+encodeURIComponent(k),{method:"DELETE"});
  loadPages();
}

(function init(){
  const k=getKey();
  if(k){document.getElementById("adminKey").value=k;loadRequests();loadPages();}
})();
</script>
</body>
</html>`;
}

module.exports = { renderAdminPage };
