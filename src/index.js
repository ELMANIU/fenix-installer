const APP_ID = "com.fenixtv.app";
const INSTALL_TTL_SECONDS = 15 * 60;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health") {
      return json({ ok: true, service: "Fenix Installer API", appId: APP_ID });
    }

    if (path === "/telegram" && request.method === "POST") {
      return handleTelegram(request, env, url.origin);
    }

    if (path === "/install" && request.method === "GET") {
      // Compatibilidad con el Bridge ya instalado: si el APK abre /install?bridge=1,
      // lo mandamos a una ruta exclusiva que SIEMPRE muestra el formulario.
      if (url.searchParams.get("bridge") === "1") {
        const token = url.searchParams.get("t") || "";
        return Response.redirect(`${url.origin}/bridge?t=${encodeURIComponent(token)}&v=3`, 302);
      }
      return installLanding(url, env);
    }

    if (path === "/bridge" && request.method === "GET") {
      return bridgeLanding(url, env);
    }

    if (path === "/api/install/resolve" && request.method === "GET") {
      const token = url.searchParams.get("token") || "";
      const verified = await verifyInstallToken(token, env.INSTALL_SIGNING_SECRET);
      if (!verified.ok) return json({ ok: false, error: verified.error }, 401);
      const latest = await readLatest(env);
      if (!latest) return json({ ok: false, error: "No hay una versión publicada." }, 404);
      return json({
        ok: true,
        appId: latest.appId || APP_ID,
        version: latest.version,
        fileName: latest.fileName,
        size: latest.size,
        sha256: latest.sha256,
        downloadUrl: `${url.origin}/download/${encodeURIComponent(latest.fileName)}?token=${encodeURIComponent(token)}`
      });
    }

    if (path.startsWith("/download/") && request.method === "GET") {
      const token = url.searchParams.get("token") || "";
      const verified = await verifyInstallToken(token, env.INSTALL_SIGNING_SECRET);
      if (!verified.ok) return new Response("Token vencido o inválido", { status: 401 });
      const fileName = decodeURIComponent(path.slice("/download/".length));
      const latest = await readLatest(env);
      if (!latest || fileName !== latest.fileName) return new Response("Archivo no disponible", { status: 404 });
      const obj = await env.RELEASES.get(`releases/${fileName}`);
      if (!obj) return new Response("Archivo no encontrado", { status: 404 });
      const headers = new Headers();
      headers.set("content-type", "application/vnd.webos.ipk");
      headers.set("content-disposition", `attachment; filename="${fileName}"`);
      headers.set("cache-control", "private, no-store");
      if (obj.size != null) headers.set("content-length", String(obj.size));
      return new Response(obj.body, { headers });
    }

    if (path === "/installer.apk" && request.method === "GET") {
      const obj = await env.RELEASES.get("installer/FenixTVInstaller.apk");
      if (!obj) return new Response("FÉNIX Installer todavía no está publicado.", { status: 404 });
      return new Response(obj.body, {
        headers: {
          "content-type": "application/vnd.android.package-archive",
          "content-disposition": 'attachment; filename="FenixTVInstaller.apk"',
          "cache-control": "public, max-age=300"
        }
      });
    }

    if (path === "/admin" && request.method === "GET") {
      return new Response(adminHtml(url.origin), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }

    if (path === "/admin/latest" && request.method === "GET") {
      if (!isAdmin(request, env)) return json({ ok: false, error: "No autorizado" }, 401);
      const latest = await readLatest(env);
      return json({ ok: true, latest });
    }

    if (path === "/admin/upload" && request.method === "POST") {
      if (!isAdmin(request, env)) return json({ ok: false, error: "No autorizado" }, 401);
      const form = await request.formData();
      const file = form.get("ipk");
      const version = String(form.get("version") || "").trim();
      if (!(file instanceof File) || !version) return json({ ok: false, error: "Falta IPK o versión" }, 400);
      if (!file.name.toLowerCase().endsWith(".ipk")) return json({ ok: false, error: "El archivo debe ser .ipk" }, 400);
      const bytes = await file.arrayBuffer();
      const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
      const fileName = `com.fenixtv.app_${version}_all.ipk`;
      await env.RELEASES.put(`releases/${fileName}`, bytes, {
        httpMetadata: { contentType: "application/vnd.webos.ipk" },
        customMetadata: { version, sha256, appId: APP_ID }
      });
      const latest = {
        appId: APP_ID,
        version,
        fileName,
        size: bytes.byteLength,
        sha256,
        publishedAt: new Date().toISOString()
      };
      await env.RELEASES.put("latest.json", JSON.stringify(latest), {
        httpMetadata: { contentType: "application/json; charset=utf-8" }
      });
      return json({ ok: true, latest });
    }

    if (path === "/admin/upload-installer" && request.method === "POST") {
      if (!isAdmin(request, env)) return json({ ok: false, error: "No autorizado" }, 401);
      const form = await request.formData();
      const file = form.get("apk");
      if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".apk")) return json({ ok: false, error: "Falta APK" }, 400);
      await env.RELEASES.put("installer/FenixTVInstaller.apk", await file.arrayBuffer(), {
        httpMetadata: { contentType: "application/vnd.android.package-archive" }
      });
      return json({ ok: true });
    }

    return new Response("FÉNIX Installer", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
};

async function handleTelegram(request, env, origin) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.INSTALL_SIGNING_SECRET) return json({ ok: false }, 500);
  const update = await request.json();
  const message = update.message;
  if (!message || !message.chat) return json({ ok: true });
  const chatId = message.chat.id;
  const text = String(message.text || "").trim().toLowerCase();

  if (text === "/start" || text === "start" || text === "comenzar" || text === "/instalar") {
    const token = await makeInstallToken(chatId, env.INSTALL_SIGNING_SECRET);
    const link = `${env.PUBLIC_BASE_URL || origin}/install?t=${encodeURIComponent(token)}`;
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "🔥 FÉNIX TV — Instalación en LG\n\n1) Instala Developer Mode desde LG Content Store.\n2) Inicia sesión y activa Dev Mode Status.\n3) Activa Key Server.\n4) Ten a la mano la IP y la passphrase de 6 caracteres.\n5) Pulsa el botón de abajo desde tu Android.\n\nLa IP y la passphrase se usan localmente en tu teléfono; no tienes que publicarlas en el grupo.",
      reply_markup: { inline_keyboard: [[{ text: "📺 INSTALAR FÉNIX TV", url: link }]] }
    });
    return json({ ok: true });
  }

  if (text === "/actualizar") {
    const latest = await readLatest(env);
    const token = await makeInstallToken(chatId, env.INSTALL_SIGNING_SECRET);
    const link = `${env.PUBLIC_BASE_URL || origin}/install?t=${encodeURIComponent(token)}`;
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: latest ? `⬆️ Última versión FÉNIX TV: ${latest.version}\nPulsa para instalar o actualizar en tu LG.` : "Todavía no hay una versión publicada.",
      reply_markup: latest ? { inline_keyboard: [[{ text: "ACTUALIZAR MI LG", url: link }]] } : undefined
    });
    return json({ ok: true });
  }

  if (text === "/estado") {
    const latest = await readLatest(env);
    await tg(env, "sendMessage", { chat_id: chatId, text: latest ? `✅ Servicio activo\nVersión disponible: ${latest.version}` : "✅ Servicio activo\nSin versión publicada todavía." });
    return json({ ok: true });
  }

  await tg(env, "sendMessage", { chat_id: chatId, text: "Comandos: /start · /instalar · /actualizar · /estado" });
  return json({ ok: true });
}

async function tg(env, method, body) {
  return fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function readLatest(env) {
  const obj = await env.RELEASES.get("latest.json");
  if (!obj) return null;
  try { return JSON.parse(await obj.text()); } catch { return null; }
}

function isAdmin(request, env) {
  const token = request.headers.get("x-admin-token") || (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  return !!env.ADMIN_TOKEN && token === env.ADMIN_TOKEN;
}

async function makeInstallToken(chatId, secret) {
  const exp = Math.floor(Date.now() / 1000) + INSTALL_TTL_SECONDS;
  const payload = `${chatId}|${exp}|${crypto.randomUUID()}`;
  const p = b64url(new TextEncoder().encode(payload));
  const sig = await hmac(p, secret);
  return `${p}.${sig}`;
}

async function verifyInstallToken(token, secret) {
  try {
    const [p, sig] = token.split(".");
    if (!p || !sig || !secret) return { ok: false, error: "token_invalid" };
    const expected = await hmac(p, secret);
    if (!timingSafe(sig, expected)) return { ok: false, error: "token_invalid" };
    const payload = new TextDecoder().decode(b64urlDecode(p));
    const [chatId, exp] = payload.split("|");
    if (!chatId || Number(exp) < Math.floor(Date.now() / 1000)) return { ok: false, error: "token_expired" };
    return { ok: true, chatId };
  } catch { return { ok: false, error: "token_invalid" }; }
}

async function hmac(data, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data))));
}
function timingSafe(a,b){ if(a.length!==b.length)return false; let x=0; for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i); return x===0; }
function b64url(bytes){ let s=""; for(const b of bytes)s+=String.fromCharCode(b); return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,""); }
function b64urlDecode(s){ s=s.replace(/-/g,"+").replace(/_/g,"/"); while(s.length%4)s+="="; const raw=atob(s); return Uint8Array.from(raw,c=>c.charCodeAt(0)); }
function hex(buf){ return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,"0")).join(""); }
function json(v,status=200){ return new Response(JSON.stringify(v,null,2),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}}); }

function installLanding(url, env) {
  const token = url.searchParams.get("t") || "";
  const base = env.PUBLIC_BASE_URL || `${url.protocol}//${url.host}`;
  const deep = `fenixtvbridge://install?token=${encodeURIComponent(token)}&base=${encodeURIComponent(base)}`;

  return new Response(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>FÉNIX LG Installer</title>
<style>${sharedInstallerCss()}</style>
</head>
<body>
<div class="wrap">
  <div class="hero">
    <h1>🔥 FÉNIX LG Installer</h1>
    <p class="sub">Instala o actualiza FÉNIX TV en tu LG webOS desde el mismo teléfono.</p>
  </div>

  <div class="card">
    <div class="step"><div class="badge">1</div><div>En la TV abre <b>Developer Mode</b>, activa <b>Dev Mode Status</b> y <b>Key Server</b>.</div></div>
    <div class="step"><div class="badge">2</div><div>El teléfono y la LG deben estar conectados a la misma red Wi‑Fi.</div></div>
    <div class="step"><div class="badge">3</div><div>La IP y la passphrase se introducirán dentro de FÉNIX Bridge.</div></div>
  </div>

  <div class="card">
    <b>FÉNIX Bridge</b>
    <p class="mini">La web administra versiones y descargas. El Bridge realiza únicamente la conexión local con tu LG.</p>
    <a class="btn" href="${deep}">ABRIR FÉNIX BRIDGE</a>
    <a class="btn alt" href="/installer.apk?v=3">INSTALAR / ACTUALIZAR BRIDGE</a>
  </div>
</div>
</body>
</html>`, {
    headers: installerHeaders("browser-v3")
  });
}

function bridgeLanding(url, env) {
  const token = url.searchParams.get("t") || "";
  const base = env.PUBLIC_BASE_URL || `${url.protocol}//${url.host}`;
  const safeToken = JSON.stringify(token);
  const safeBase = JSON.stringify(base);

  // IMPORTANTE: esta página NO intenta "detectar" si estamos dentro del APK.
  // La ruta /bridge existe únicamente para el Bridge y el formulario se muestra
  // desde el servidor, por lo que no puede quedarse en la pantalla de instalación.
  return new Response(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>FÉNIX Bridge</title>
<style>${sharedInstallerCss()}</style>
</head>
<body>
<div class="wrap">
  <div class="hero">
    <div class="connected">● BRIDGE CONECTADO</div>
    <h1>🔥 Instalar en LG</h1>
    <p class="sub">Introduce los datos que aparecen en Developer Mode de tu televisión.</p>
  </div>

  <div class="card">
    <label>IP de la LG</label>
    <input id="ip" inputmode="decimal" autocomplete="off" placeholder="192.168.1.86">

    <label>Passphrase</label>
    <input id="pass" type="password" maxlength="32" autocomplete="off" placeholder="6 caracteres">

    <button id="go" onclick="startInstall()">INSTALAR FÉNIX TV</button>

    <div class="bar"><i id="bar"></i></div>
    <div id="status" class="status">${token ? "Listo para comenzar." : "Abre esta aplicación desde el botón del bot de Telegram para obtener una sesión de instalación."}</div>

    <p class="mini">La IP y la passphrase permanecen en este teléfono. El IPK se descarga temporalmente, se verifica con SHA‑256 y se elimina al terminar.</p>
  </div>
</div>

<script>
const TOKEN=${safeToken};
const BASE=${safeBase};

function pct(n){
  document.getElementById('bar').style.width=Math.max(0,Math.min(100,n||0))+'%';
}
function setStatus(msg, cls){
  const s=document.getElementById('status');
  s.className='status'+(cls?' '+cls:'');
  s.textContent=msg;
}
window.fenixBridgeReady=function(){
  setStatus(TOKEN ? 'Bridge conectado. Listo para comenzar.' :
    'Bridge conectado. Vuelve al bot de Telegram y pulsa INSTALAR FÉNIX TV para autorizar la sesión.', TOKEN ? 'ok' : '');
};
window.fenixNativeProgress=function(stage,msg,percent){
  pct(percent||0);
  setStatus((stage?stage+'\\n':'')+(msg||''));
};
window.fenixNativeDone=function(ok,msg){
  pct(ok?100:0);
  setStatus(msg || (ok?'Instalación completada.':'No se pudo completar.'), ok?'ok':'err');
  document.getElementById('go').disabled=false;
};

function startInstall(){
  const ip=document.getElementById('ip').value.trim();
  const pass=document.getElementById('pass').value.trim();

  if(!TOKEN){
    setStatus('Sesión no autorizada. Vuelve al bot de Telegram, escribe /start y abre el instalador desde ese botón.','err');
    return;
  }
  if(!window.FenixBridge || typeof window.FenixBridge.install !== 'function'){
    setStatus('El puente nativo no está disponible. Cierra esta pantalla y ábrela desde la aplicación FÉNIX Bridge.','err');
    return;
  }
  if(!/^((10\\.)|(192\\.168\\.)|(172\\.(1[6-9]|2\\d|3[01])\\.))/.test(ip)){
    setStatus('Escribe una IP privada válida, por ejemplo 192.168.1.86.','err');
    return;
  }
  if(pass.length < 4){
    setStatus('Escribe la passphrase que muestra Developer Mode.','err');
    return;
  }

  document.getElementById('go').disabled=true;
  pct(3);
  setStatus('Iniciando instalación…');
  window.FenixBridge.install(ip, pass, TOKEN, BASE);
}
</script>
</body>
</html>`, {
    headers: installerHeaders("bridge-v3")
  });
}

function installerHeaders(version) {
  return {
    "content-type":"text/html; charset=utf-8",
    "cache-control":"no-store, no-cache, must-revalidate, max-age=0",
    "pragma":"no-cache",
    "expires":"0",
    "x-fenix-installer-version":version,
    "x-content-type-options":"nosniff",
    "referrer-policy":"no-referrer"
  };
}

function sharedInstallerCss() {
  return `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#07090f;color:#fff;font:16px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;min-height:100vh}
.wrap{max-width:620px;margin:auto;padding:22px 16px 48px}
.hero{padding:22px 0 10px}
h1{font-size:32px;margin:8px 0}
.sub{color:#aeb8ce;line-height:1.55;margin:0}
.card{background:#111624;border:1px solid #26334f;border-radius:22px;padding:20px;margin-top:16px;box-shadow:0 18px 55px #0007}
label{display:block;font-size:13px;color:#aeb8ce;margin:14px 0 7px}
input{width:100%;padding:15px 14px;border-radius:12px;border:1px solid #34425f;background:#0b101a;color:#fff;font-size:17px;outline:none}
input:focus{border-color:#8c58ff}
button,.btn{width:100%;display:block;border:0;border-radius:14px;padding:16px 18px;margin-top:14px;color:#fff;font-weight:800;font-size:16px;text-align:center;text-decoration:none;background:linear-gradient(135deg,#f43b47,#7b2cff)}
button:disabled{opacity:.55}
.btn.alt{background:#202a40}
.mini{font-size:13px;color:#8f9ab0;line-height:1.5}
.status{margin-top:15px;padding:14px;border-radius:12px;background:#0b101a;border:1px solid #26334f;min-height:54px;white-space:pre-wrap}
.bar{height:8px;background:#20283a;border-radius:999px;overflow:hidden;margin-top:12px}
.bar>i{display:block;width:0;height:100%;background:linear-gradient(90deg,#f43b47,#7b2cff);transition:width .25s ease}
.ok{color:#8ce99a}.err{color:#ff8787}
.step{display:flex;gap:10px;align-items:flex-start;margin:10px 0;color:#cbd3e3}
.badge{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;background:#202a40;font-size:13px;font-weight:800;flex:0 0 26px}
.connected{display:inline-block;padding:7px 10px;border-radius:999px;background:#14341e;color:#8ce99a;font-size:12px;font-weight:800;letter-spacing:.04em}
`;
}

function adminHtml(origin) {
return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FÉNIX Installer Admin</title><style>body{font:15px system-ui;background:#080a10;color:#fff;margin:0;padding:20px}.c{max-width:720px;margin:auto}.card{background:#121725;border:1px solid #26324b;border-radius:18px;padding:20px;margin:15px 0}input,button{box-sizing:border-box;width:100%;padding:13px;margin:7px 0;border-radius:10px;border:1px solid #34425f;background:#0d111b;color:#fff}button{background:#7b2cff;border:0;font-weight:800}pre{white-space:pre-wrap;color:#b9c4d8}</style></head><body><div class="c"><h1>FÉNIX Installer Control</h1><div class="card"><input id="tok" type="password" placeholder="ADMIN_TOKEN"><input id="ver" placeholder="Versión, ej. 1.2.16"><input id="ipk" type="file" accept=".ipk"><button onclick="up()">PUBLICAR IPK</button><pre id="o"></pre></div><div class="card"><input id="apk" type="file" accept=".apk"><button onclick="upApk()">PUBLICAR FÉNIX INSTALLER APK</button></div></div><script>const o=document.getElementById('o');async function up(){let f=new FormData();f.append('version',ver.value.trim());f.append('ipk',ipk.files[0]);let r=await fetch('/admin/upload',{method:'POST',headers:{'x-admin-token':tok.value},body:f});o.textContent=await r.text()}async function upApk(){let f=new FormData();f.append('apk',apk.files[0]);let r=await fetch('/admin/upload-installer',{method:'POST',headers:{'x-admin-token':tok.value},body:f});o.textContent=await r.text()}</script></body></html>`;
}
