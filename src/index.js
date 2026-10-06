const APP_ID = "com.fenixtv.app";
const INSTALL_TTL_SECONDS = 15 * 60;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health") {
      return json({
        ok: true,
        service: "Fenix Installer API",
        appId: APP_ID
      });
    }

    if (path === "/telegram" && request.method === "POST") {
      return handleTelegram(request, env, url.origin);
    }

    if (path === "/install" && request.method === "GET") {
      return installLanding(url, env);
    }

    if (path === "/api/install/resolve" && request.method === "GET") {
      const token = url.searchParams.get("token") || "";

      const verified = await verifyInstallToken(
        token,
        env.INSTALL_SIGNING_SECRET
      );

      if (!verified.ok) {
        return json(
          {
            ok: false,
            error: verified.error
          },
          401
        );
      }

      const latest = await readLatest(env);

      if (!latest) {
        return json(
          {
            ok: false,
            error: "No hay una versión publicada."
          },
          404
        );
      }

      return json({
        ok: true,
        appId: latest.appId || APP_ID,
        version: latest.version,
        fileName: latest.fileName,
        size: latest.size,
        sha256: latest.sha256,
        downloadUrl:
          `${url.origin}/download/` +
          encodeURIComponent(latest.fileName) +
          "?token=" +
          encodeURIComponent(token)
      });
    }

    if (path.startsWith("/download/") && request.method === "GET") {
      const token = url.searchParams.get("token") || "";

      const verified = await verifyInstallToken(
        token,
        env.INSTALL_SIGNING_SECRET
      );

      if (!verified.ok) {
        return new Response("Token vencido o inválido", {
          status: 401
        });
      }

      const fileName = decodeURIComponent(
        path.slice("/download/".length)
      );

      const latest = await readLatest(env);

      if (!latest || fileName !== latest.fileName) {
        return new Response("Archivo no disponible", {
          status: 404
        });
      }

      const obj = await env.RELEASES.get(
        `releases/${fileName}`
      );

      if (!obj) {
        return new Response("Archivo no encontrado", {
          status: 404
        });
      }

      const headers = new Headers();

      headers.set(
        "content-type",
        "application/vnd.webos.ipk"
      );

      headers.set(
        "content-disposition",
        `attachment; filename="${fileName}"`
      );

      headers.set(
        "cache-control",
        "private, no-store"
      );

      if (obj.size != null) {
        headers.set(
          "content-length",
          String(obj.size)
        );
      }

      return new Response(obj.body, {
        headers
      });
    }

    if (path === "/installer.apk" && request.method === "GET") {
      const obj = await env.RELEASES.get(
        "installer/FenixTVInstaller.apk"
      );

      if (!obj) {
        return new Response(
          "FÉNIX Installer todavía no está publicado.",
          {
            status: 404
          }
        );
      }

      return new Response(obj.body, {
        headers: {
          "content-type":
            "application/vnd.android.package-archive",

          "content-disposition":
            'attachment; filename="FenixTVInstaller.apk"',

          "cache-control":
            "public, max-age=300"
        }
      });
    }

    if (path === "/admin" && request.method === "GET") {
      return new Response(
        adminHtml(url.origin),
        {
          headers: {
            "content-type":
              "text/html; charset=utf-8",

            "cache-control":
              "no-store"
          }
        }
      );
    }

    if (
      path === "/admin/latest" &&
      request.method === "GET"
    ) {
      if (!isAdmin(request, env)) {
        return json(
          {
            ok: false,
            error: "No autorizado"
          },
          401
        );
      }

      const latest = await readLatest(env);

      return json({
        ok: true,
        latest
      });
    }

    if (
      path === "/admin/upload" &&
      request.method === "POST"
    ) {
      if (!isAdmin(request, env)) {
        return json(
          {
            ok: false,
            error: "No autorizado"
          },
          401
        );
      }

      const form = await request.formData();

      const file = form.get("ipk");

      const version = String(
        form.get("version") || ""
      ).trim();

      if (!(file instanceof File) || !version) {
        return json(
          {
            ok: false,
            error: "Falta IPK o versión"
          },
          400
        );
      }

      if (
        !file.name
          .toLowerCase()
          .endsWith(".ipk")
      ) {
        return json(
          {
            ok: false,
            error: "El archivo debe ser .ipk"
          },
          400
        );
      }

      const bytes =
        await file.arrayBuffer();

      const sha256 = hex(
        await crypto.subtle.digest(
          "SHA-256",
          bytes
        )
      );

      const fileName =
        `com.fenixtv.app_${version}_all.ipk`;

      await env.RELEASES.put(
        `releases/${fileName}`,
        bytes,
        {
          httpMetadata: {
            contentType:
              "application/vnd.webos.ipk"
          },

          customMetadata: {
            version,
            sha256,
            appId: APP_ID
          }
        }
      );

      const latest = {
        appId: APP_ID,
        version,
        fileName,
        size: bytes.byteLength,
        sha256,
        publishedAt:
          new Date().toISOString()
      };

      await env.RELEASES.put(
        "latest.json",
        JSON.stringify(latest),
        {
          httpMetadata: {
            contentType:
              "application/json; charset=utf-8"
          }
        }
      );

      return json({
        ok: true,
        latest
      });
    }

    if (
      path === "/admin/upload-installer" &&
      request.method === "POST"
    ) {
      if (!isAdmin(request, env)) {
        return json(
          {
            ok: false,
            error: "No autorizado"
          },
          401
        );
      }

      const form =
        await request.formData();

      const file =
        form.get("apk");

      if (
        !(file instanceof File) ||
        !file.name
          .toLowerCase()
          .endsWith(".apk")
      ) {
        return json(
          {
            ok: false,
            error: "Falta APK"
          },
          400
        );
      }

      await env.RELEASES.put(
        "installer/FenixTVInstaller.apk",
        await file.arrayBuffer(),
        {
          httpMetadata: {
            contentType:
              "application/vnd.android.package-archive"
          }
        }
      );

      return json({
        ok: true
      });
    }

    return new Response(
      "FÉNIX Installer",
      {
        status: 200,
        headers: {
          "content-type":
            "text/plain; charset=utf-8"
        }
      }
    );
  }
};

async function handleTelegram(
  request,
  env,
  origin
) {
  if (
    !env.TELEGRAM_BOT_TOKEN ||
    !env.INSTALL_SIGNING_SECRET
  ) {
    return json(
      {
        ok: false
      },
      500
    );
  }

  const update =
    await request.json();

  const message =
    update.message;

  if (
    !message ||
    !message.chat
  ) {
    return json({
      ok: true
    });
  }

  const chatId =
    message.chat.id;

  const text = String(
    message.text || ""
  )
    .trim()
    .toLowerCase();

  if (
    text === "/start" ||
    text === "start" ||
    text === "comenzar" ||
    text === "/instalar"
  ) {
    const token =
      await makeInstallToken(
        chatId,
        env.INSTALL_SIGNING_SECRET
      );

    const link =
      `${
        env.PUBLIC_BASE_URL ||
        origin
      }/install?t=${encodeURIComponent(
        token
      )}`;

    await tg(
      env,
      "sendMessage",
      {
        chat_id: chatId,

        text:
          "🔥 FÉNIX TV — Instalación en LG\n\n" +
          "1) Instala Developer Mode desde LG Content Store.\n" +
          "2) Inicia sesión y activa Dev Mode Status.\n" +
          "3) Activa Key Server.\n" +
          "4) Ten a la mano la IP y la passphrase de 6 caracteres.\n" +
          "5) Pulsa el botón de abajo desde tu Android.\n\n" +
          "La IP y la passphrase se usan localmente en tu teléfono.",

        reply_markup: {
          inline_keyboard: [
            [
              {
                text:
                  "📺 INSTALAR FÉNIX TV",

                url: link
              }
            ]
          ]
        }
      }
    );

    return json({
      ok: true
    });
  }

  if (text === "/actualizar") {
    const latest =
      await readLatest(env);

    const token =
      await makeInstallToken(
        chatId,
        env.INSTALL_SIGNING_SECRET
      );

    const link =
      `${
        env.PUBLIC_BASE_URL ||
        origin
      }/install?t=${encodeURIComponent(
        token
      )}`;

    await tg(
      env,
      "sendMessage",
      {
        chat_id: chatId,

        text: latest
          ? `⬆️ Última versión FÉNIX TV: ${latest.version}\nPulsa para instalar o actualizar en tu LG.`
          : "Todavía no hay una versión publicada.",

        reply_markup: latest
          ? {
              inline_keyboard: [
                [
                  {
                    text:
                      "ACTUALIZAR MI LG",

                    url: link
                  }
                ]
              ]
            }
          : undefined
      }
    );

    return json({
      ok: true
    });
  }

  if (text === "/estado") {
    const latest =
      await readLatest(env);

    await tg(
      env,
      "sendMessage",
      {
        chat_id: chatId,

        text: latest
          ? `✅ Servicio activo\nVersión disponible: ${latest.version}`
          : "✅ Servicio activo\nSin versión publicada todavía."
      }
    );

    return json({
      ok: true
    });
  }

  await tg(
    env,
    "sendMessage",
    {
      chat_id: chatId,

      text:
        "Comandos: /start · /instalar · /actualizar · /estado"
    }
  );

  return json({
    ok: true
  });
}

async function tg(
  env,
  method,
  body
) {
  return fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",

      headers: {
        "content-type":
          "application/json"
      },

      body:
        JSON.stringify(body)
    }
  );
}

async function readLatest(env) {
  const obj =
    await env.RELEASES.get(
      "latest.json"
    );

  if (!obj) {
    return null;
  }

  try {
    return JSON.parse(
      await obj.text()
    );
  } catch {
    return null;
  }
}

function isAdmin(
  request,
  env
) {
  const token =
    request.headers.get(
      "x-admin-token"
    ) ||
    (
      request.headers.get(
        "authorization"
      ) || ""
    ).replace(
      /^Bearer\s+/i,
      ""
    );

  return (
    !!env.ADMIN_TOKEN &&
    token === env.ADMIN_TOKEN
  );
}

async function makeInstallToken(
  chatId,
  secret
) {
  const exp =
    Math.floor(
      Date.now() / 1000
    ) +
    INSTALL_TTL_SECONDS;

  const payload =
    `${chatId}|${exp}|${crypto.randomUUID()}`;

  const p =
    b64url(
      new TextEncoder().encode(
        payload
      )
    );

  const sig =
    await hmac(
      p,
      secret
    );

  return `${p}.${sig}`;
}

async function verifyInstallToken(
  token,
  secret
) {
  try {
    const [p, sig] =
      token.split(".");

    if (
      !p ||
      !sig ||
      !secret
    ) {
      return {
        ok: false,
        error:
          "token_invalid"
      };
    }

    const expected =
      await hmac(
        p,
        secret
      );

    if (
      !timingSafe(
        sig,
        expected
      )
    ) {
      return {
        ok: false,
        error:
          "token_invalid"
      };
    }

    const payload =
      new TextDecoder().decode(
        b64urlDecode(p)
      );

    const [chatId, exp] =
      payload.split("|");

    if (
      !chatId ||
      Number(exp) <
        Math.floor(
          Date.now() / 1000
        )
    ) {
      return {
        ok: false,
        error:
          "token_expired"
      };
    }

    return {
      ok: true,
      chatId
    };
  } catch {
    return {
      ok: false,
      error:
        "token_invalid"
    };
  }
}

async function hmac(
  data,
  secret
) {
  const key =
    await crypto.subtle.importKey(
      "raw",

      new TextEncoder().encode(
        secret
      ),

      {
        name: "HMAC",
        hash: "SHA-256"
      },

      false,

      ["sign"]
    );

  return b64url(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(
          data
        )
      )
    )
  );
}

function timingSafe(a, b) {
  if (
    a.length !== b.length
  ) {
    return false;
  }

  let x = 0;

  for (
    let i = 0;
    i < a.length;
    i++
  ) {
    x |=
      a.charCodeAt(i) ^
      b.charCodeAt(i);
  }

  return x === 0;
}

function b64url(bytes) {
  let s = "";

  for (const b of bytes) {
    s +=
      String.fromCharCode(b);
  }

  return btoa(s)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64urlDecode(s) {
  s = s
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  while (s.length % 4) {
    s += "=";
  }

  const raw =
    atob(s);

  return Uint8Array.from(
    raw,
    c => c.charCodeAt(0)
  );
}

function hex(buf) {
  return [
    ...new Uint8Array(buf)
  ]
    .map(
      b =>
        b
          .toString(16)
          .padStart(2, "0")
    )
    .join("");
}

function json(
  value,
  status = 200
) {
  return new Response(
    JSON.stringify(
      value,
      null,
      2
    ),
    {
      status,

      headers: {
        "content-type":
          "application/json; charset=utf-8",

        "cache-control":
          "no-store"
      }
    }
  );
}

function installLanding(
  url,
  env
) {
  const token =
    url.searchParams.get("t") || "";

  const base =
    env.PUBLIC_BASE_URL ||
    `${url.protocol}//${url.host}`;

  const deep =
    "fenixtvinstaller://install" +
    `?token=${encodeURIComponent(
      token
    )}` +
    `&base=${encodeURIComponent(
      base
    )}`;

  return new Response(
    `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FÉNIX Installer</title>

<style>
body{
margin:0;
background:#07090f;
color:#fff;
font:16px system-ui;
display:grid;
min-height:100vh;
place-items:center
}

.c{
width:min(92vw,520px);
background:#111624;
border:1px solid #26334f;
border-radius:24px;
padding:28px;
box-shadow:0 20px 70px #0008
}

h1{
margin:0 0 8px;
font-size:30px
}

.muted{
color:#aeb8ce;
line-height:1.55
}

.b{
display:block;
text-align:center;
text-decoration:none;
color:#fff;
background:linear-gradient(135deg,#f43b47,#7b2cff);
padding:16px 18px;
border-radius:14px;
font-weight:800;
margin-top:18px
}

.b.alt{
background:#202a40
}
</style>
</head>

<body>

<div class="c">

<h1>🔥 FÉNIX Installer</h1>

<p class="muted">
Abre el instalador en este Android.
El IPK se descargará temporalmente,
se verificará y se enviará a tu LG
por la red local.
</p>

<a
class="b"
href="${deep}"
>
ABRIR FÉNIX INSTALLER
</a>

<a
class="b alt"
href="/installer.apk"
>
INSTALAR FÉNIX INSTALLER
</a>

<p class="muted">
Developer Mode y Key Server deben estar
activados en la TV.
</p>

</div>

<script>
setTimeout(
  () =>
    location.href =
      ${JSON.stringify(deep)},
  350
);
</script>

</body>
</html>`,
    {
      headers: {
        "content-type":
          "text/html; charset=utf-8",

        "cache-control":
          "no-store"
      }
    }
  );
}

function adminHtml() {
  return `<!doctype html>

<html>

<head>

<meta charset="utf-8">

<meta
name="viewport"
content="width=device-width,initial-scale=1"
>

<title>
FÉNIX Installer Admin
</title>

<style>

body{
font:15px system-ui;
background:#080a10;
color:#fff;
margin:0;
padding:20px
}

.c{
max-width:720px;
margin:auto
}

.card{
background:#121725;
border:1px solid #26324b;
border-radius:18px;
padding:20px;
margin:15px 0
}

input,
button{
box-sizing:border-box;
width:100%;
padding:13px;
margin:7px 0;
border-radius:10px;
border:1px solid #34425f;
background:#0d111b;
color:#fff
}

button{
background:#7b2cff;
border:0;
font-weight:800
}

pre{
white-space:pre-wrap;
color:#b9c4d8
}

</style>

</head>

<body>

<div class="c">

<h1>
FÉNIX Installer Control
</h1>

<div class="card">

<input
id="tok"
type="password"
placeholder="ADMIN_TOKEN"
>

<input
id="ver"
placeholder="Versión, ej. 1.2.16"
>

<input
id="ipk"
type="file"
accept=".ipk"
>

<button onclick="up()">
PUBLICAR IPK
</button>

<pre id="o"></pre>

</div>

<div class="card">

<input
id="apk"
type="file"
accept=".apk"
>

<button onclick="upApk()">
PUBLICAR FÉNIX INSTALLER APK
</button>

</div>

</div>

<script>

const o =
document.getElementById("o");

async function up(){

let f =
new FormData();

f.append(
"version",
ver.value.trim()
);

f.append(
"ipk",
ipk.files[0]
);

let r =
await fetch(
"/admin/upload",
{
method:"POST",
headers:{
"x-admin-token":
tok.value
},
body:f
}
);

o.textContent =
await r.text();

}

async function upApk(){

let f =
new FormData();

f.append(
"apk",
apk.files[0]
);

let r =
await fetch(
"/admin/upload-installer",
{
method:"POST",
headers:{
"x-admin-token":
tok.value
},
body:f
}
);

o.textContent =
await r.text();

}

</script>

</body>

</html>`;
}
