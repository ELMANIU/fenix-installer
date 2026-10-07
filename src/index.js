const APP_ID = "com.fenixtv.app";
const INSTALL_TTL_SECONDS = 60 * 60;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Preflight CORS para consultas públicas desde FÉNIX TV / webOS.
    if (request.method === "OPTIONS" && (path === "/api/latest" || path === "/api/install/session" || path === "/api/experience")) {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    if (path === "/health") {
      return json({ ok: true, service: "Fenix Installer API", appId: APP_ID, workerVersion: "8.0-experience-manager" });
    }

    // Imágenes de la guía oficial usadas por el bot de Telegram.
    if (path.startsWith("/guide/") && request.method === "GET") {
      return guideAssetResponse(path);
    }

    // Endpoint público para que la app FÉNIX TV consulte la última versión publicada.
    // No entrega ADMIN_TOKEN ni una URL de descarga utilizable sin sesión autorizada.
    if (path === "/api/latest" && request.method === "GET") {
      const latest = await readLatest(env);

      if (!latest) {
        return publicJson({
          ok: false,
          error: "No hay una versión publicada."
        }, 404);
      }

      return publicJson({
        ok: true,
        appId: latest.appId || APP_ID,
        version: latest.version,
        fileName: latest.fileName,
        size: latest.size,
        sha256: latest.sha256,
        publishedAt: latest.publishedAt,
        updateUrl: `${url.origin}/update`
      });
    }

    // Configuración pública del Experience Engine de FÉNIX TV.
    if (path === "/api/experience" && request.method === "GET") {
      const obj = await env.RELEASES.get("experience.json");
      if (!obj) {
        return publicJson({ ok: false, error: "No hay configuración remota publicada." }, 404);
      }
      try {
        const value = JSON.parse(await obj.text());
        return publicJson(value);
      } catch {
        return publicJson({ ok: false, error: "La configuración remota no es JSON válido." }, 500);
      }
    }

    // Sesión automática para FÉNIX Bridge vinculado.
    // /update ya generaba tokens públicos para el QR; este endpoint devuelve
    // el mismo tipo de sesión en JSON para que el Bridge pueda actualizar con un toque.
    if (path === "/api/install/session" && request.method === "GET") {
      if (!env.INSTALL_SIGNING_SECRET) {
        return publicJson({ ok: false, error: "Servicio de actualización no configurado." }, 503);
      }
      const token = await makeInstallToken("bridge-auto", env.INSTALL_SIGNING_SECRET);
      return publicJson({
        ok: true,
        token,
        expiresIn: INSTALL_TTL_SECONDS,
        appId: APP_ID
      });
    }

    if (path === "/telegram" && request.method === "POST") {
      return handleTelegram(request, env, url.origin);
    }

    // Entrada pública para actualizaciones iniciadas desde el QR del Centro FÉNIX.
    // Genera una sesión temporal firmada y reutiliza el mismo flujo seguro del Bridge.
    if (path === "/update" && request.method === "GET") {
      if (!env.INSTALL_SIGNING_SECRET) {
        return new Response("Servicio de actualización no configurado.", { status: 503 });
      }
      const token = await makeInstallToken("tv-update", env.INSTALL_SIGNING_SECRET);
      const target = `${url.origin}/install?t=${encodeURIComponent(token)}&source=tv`;
      return new Response(null, {
        status: 302,
        headers: {
          "location": target,
          "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
          "pragma": "no-cache",
          "referrer-policy": "no-referrer"
        }
      });
    }

    if (path === "/install" && request.method === "GET") {
      // Compatibilidad con el Bridge ya instalado: si el APK abre /install?bridge=1,
      // lo mandamos a una ruta exclusiva que SIEMPRE muestra el formulario.
      if (url.searchParams.get("bridge") === "1") {
        const token = url.searchParams.get("t") || "";
        return Response.redirect(`${url.origin}/bridge?t=${encodeURIComponent(token)}&v=6`, 302);
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
        publishedAt: latest.publishedAt,
        downloadUrl: `${url.origin}/download/${encodeURIComponent(latest.fileName)}?token=${encodeURIComponent(token)}`
      });
    }

    if (path.startsWith("/download/") && request.method === "GET") {
      const token = url.searchParams.get("token") || "";
      const verified = await verifyInstallToken(token, env.INSTALL_SIGNING_SECRET);
      if (!verified.ok) return new Response("Token vencido o inválido", { status: 401 });

      const fileName = decodeURIComponent(path.slice("/download/".length));
      const latest = await readLatest(env);
      if (!latest || fileName !== latest.fileName) {
        return new Response("Archivo no disponible", { status: 404 });
      }

      const obj = await env.RELEASES.get(`releases/${fileName}`);
      if (!obj) return new Response("Archivo no encontrado", { status: 404 });

      const headers = new Headers();
      headers.set("content-type", "application/vnd.webos.ipk");
      headers.set("content-disposition", `attachment; filename="${fileName}"`);
      headers.set("cache-control", "private, no-store");
      headers.set("x-content-type-options", "nosniff");
      if (obj.size != null) headers.set("content-length", String(obj.size));

      return new Response(obj.body, { headers });
    }

    if (path === "/installer.apk" && request.method === "GET") {
      const obj = await env.RELEASES.get("installer/FenixTVInstaller.apk");
      if (!obj) {
        return new Response("FÉNIX Installer todavía no está publicado.", { status: 404 });
      }

      return new Response(obj.body, {
        headers: {
          "content-type": "application/vnd.android.package-archive",
          "content-disposition": 'attachment; filename="FenixTVInstaller.apk"',
          "cache-control": "public, max-age=300",
          "x-content-type-options": "nosniff"
        }
      });
    }

    if (path === "/admin" && request.method === "GET") {
      return new Response(adminHtml(url.origin), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store"
        }
      });
    }

    if (path === "/admin/latest" && request.method === "GET") {
      if (!isAdmin(request, env)) {
        return json({ ok: false, error: "No autorizado" }, 401);
      }

      const latest = await readLatest(env);
      return json({ ok: true, latest });
    }

    if (path === "/admin/setup-bot" && request.method === "POST") {
      if (!isAdmin(request, env)) {
        return json({ ok: false, error: "No autorizado" }, 401);
      }
      const result = await setupTelegramBot(env);
      return json(result, result.ok ? 200 : 500);
    }

    if (path === "/admin/upload" && request.method === "POST") {
      if (!isAdmin(request, env)) {
        return json({ ok: false, error: "No autorizado" }, 401);
      }

      const form = await request.formData();
      const file = form.get("ipk");
      const version = String(form.get("version") || "").trim();

      if (!(file instanceof File) || !version) {
        return json({ ok: false, error: "Falta IPK o versión" }, 400);
      }

      if (!file.name.toLowerCase().endsWith(".ipk")) {
        return json({ ok: false, error: "El archivo debe ser .ipk" }, 400);
      }

      if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
        return json({
          ok: false,
          error: "Versión inválida. Usa formato como 1.2.16"
        }, 400);
      }

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

    if (path === "/admin/upload-experience" && request.method === "POST") {
      if (!isAdmin(request, env)) {
        return json({ ok: false, error: "No autorizado" }, 401);
      }
      const form = await request.formData();
      const file = form.get("experience");
      if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".json")) {
        return json({ ok: false, error: "Selecciona fenix-experience.json" }, 400);
      }
      const textValue = await file.text();
      let parsed;
      try { parsed = JSON.parse(textValue); }
      catch { return json({ ok: false, error: "El archivo no contiene JSON válido" }, 400); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return json({ ok: false, error: "La configuración debe ser un objeto JSON" }, 400);
      }
      parsed.updatedAt = new Date().toISOString();
      await env.RELEASES.put("experience.json", JSON.stringify(parsed, null, 2), {
        httpMetadata: { contentType: "application/json; charset=utf-8" }
      });
      return json({ ok: true, updatedAt: parsed.updatedAt, schemaVersion: parsed.schemaVersion || 1 });
    }

    if (path === "/admin/upload-installer" && request.method === "POST") {
      if (!isAdmin(request, env)) {
        return json({ ok: false, error: "No autorizado" }, 401);
      }

      const form = await request.formData();
      const file = form.get("apk");

      if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".apk")) {
        return json({ ok: false, error: "Falta APK" }, 400);
      }

      await env.RELEASES.put(
        "installer/FenixTVInstaller.apk",
        await file.arrayBuffer(),
        {
          httpMetadata: {
            contentType: "application/vnd.android.package-archive"
          }
        }
      );

      return json({ ok: true });
    }

    return new Response("FÉNIX Installer", {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  }
};

async function handleTelegram(request, env, origin) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.INSTALL_SIGNING_SECRET) {
    return json({ ok: false }, 500);
  }

  const update = await request.json();

  // Botones del menú visual.
  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message?.chat?.id;
    const action = String(cq.data || "");
    if (!chatId) return json({ ok: true });

    await tg(env, "answerCallbackQuery", {
      callback_query_id: cq.id,
      text: action === "guide" ? "Abriendo guía…" : "Consultando…"
    });

    if (action === "guide") {
      await sendGuide(env, chatId, origin);
      return json({ ok: true });
    }

    if (action === "status") {
      await sendStatus(env, chatId);
      return json({ ok: true });
    }

    if (action === "help") {
      await sendHelp(env, chatId, origin);
      return json({ ok: true });
    }

    return json({ ok: true });
  }

  const message = update.message;
  if (!message || !message.chat) return json({ ok: true });

  const chatId = message.chat.id;
  const text = String(message.text || "").trim().toLowerCase();

  if (text === "/start" || text === "start" || text === "comenzar") {
    await sendWelcome(env, chatId, origin);
    return json({ ok: true });
  }

  if (text === "/instalar" || text === "instalar") {
    await sendInstall(env, chatId, origin);
    return json({ ok: true });
  }

  if (text === "/guia" || text === "/guía" || text === "guia" || text === "guía") {
    await sendGuide(env, chatId, origin);
    return json({ ok: true });
  }

  if (text === "/actualizar" || text === "actualizar") {
    await sendUpdate(env, chatId, origin);
    return json({ ok: true });
  }

  if (text === "/estado" || text === "estado" || text === "/version" || text === "/versión") {
    await sendStatus(env, chatId);
    return json({ ok: true });
  }

  if (text === "/ayuda" || text === "ayuda" || text === "/help") {
    await sendHelp(env, chatId, origin);
    return json({ ok: true });
  }

  await sendHelp(env, chatId, origin);
  return json({ ok: true });
}

async function sendWelcome(env, chatId, origin) {
  const token = await makeInstallToken(chatId, env.INSTALL_SIGNING_SECRET);
  const base = env.PUBLIC_BASE_URL || origin;
  const installLink = `${base}/install?t=${encodeURIComponent(token)}&source=telegram`;
  const photo = `${base}/guide/guide-00-welcome.jpg`;

  await tg(env, "sendPhoto", {
    chat_id: chatId,
    photo,
    parse_mode: "HTML",
    caption:
      "<b>🔥 Bienvenido a FÉNIX TV para LG webOS</b>\n\n" +
      "Este asistente te guía desde cero. La primera vez vinculas tu LG con IP + passphrase; después FÉNIX Bridge recuerda esa TV y comprueba/actualiza con un toque.\n\n" +
      "<b>Antes de comenzar necesitas:</b>\n" +
      "• Una LG con webOS y Developer Mode.\n" +
      "• Un teléfono Android conectado a la misma Wi‑Fi.\n" +
      "• Dev Mode Status y Key Server activados <b>solo para la primera vinculación</b>.\n\n" +
      "La llave y passphrase quedan protegidas en tu Android con Android Keystore; no se envían a Telegram ni a Cloudflare.",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🚀 INSTALAR FÉNIX TV", url: installLink }],
        [
          { text: "📖 GUÍA PASO A PASO", callback_data: "guide" },
          { text: "✅ VER VERSIÓN", callback_data: "status" }
        ],
        [{ text: "❓ AYUDA", callback_data: "help" }]
      ]
    }
  });
}

async function sendInstall(env, chatId, origin) {
  const token = await makeInstallToken(chatId, env.INSTALL_SIGNING_SECRET);
  const base = env.PUBLIC_BASE_URL || origin;
  const link = `${base}/install?t=${encodeURIComponent(token)}&source=telegram`;

  await tg(env, "sendPhoto", {
    chat_id: chatId,
    photo: `${base}/guide/guide-03-bridge.jpg`,
    parse_mode: "HTML",
    caption:
      "<b>🚀 INSTALAR FÉNIX TV EN TU LG</b>\n\n" +
      "1. <b>Primera vez:</b> abre Developer Mode y activa Dev Mode Status + Key Server.\n" +
      "2. Abre FÉNIX Bridge y escribe IP + passphrase una sola vez.\n" +
      "3. Pulsa <b>VINCULAR E INSTALAR FÉNIX TV</b>.\n" +
      "4. En adelante, abre FÉNIX Bridge: comprobará tu LG automáticamente.\n" +
      "5. Si hay una versión nueva, pulsa <b>ACTUALIZAR MI LG</b>.\n\n" +
      "No tendrás que volver a escribir la passphrase mientras la vinculación de Developer Mode siga vigente.",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔥 ABRIR FÉNIX BRIDGE", url: link }],
        [{ text: "📖 VER GUÍA COMPLETA", callback_data: "guide" }]
      ]
    }
  });
}

async function sendUpdate(env, chatId, origin) {
  const latest = await readLatest(env);
  const token = await makeInstallToken(chatId, env.INSTALL_SIGNING_SECRET);
  const base = env.PUBLIC_BASE_URL || origin;
  const link = `${base}/install?t=${encodeURIComponent(token)}&source=telegram-update`;

  if (!latest) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "Todavía no hay una versión de FÉNIX TV publicada en el servidor."
    });
    return;
  }

  await tg(env, "sendPhoto", {
    chat_id: chatId,
    photo: `${base}/guide/guide-04-update.jpg`,
    parse_mode: "HTML",
    caption:
      `<b>⬆️ ACTUALIZACIÓN DE FÉNIX TV</b>\n\n` +
      `Versión publicada: <b>${escapeHtml(latest.version)}</b>\n` +
      `Archivo: <code>${escapeHtml(latest.fileName || "")}</code>\n\n` +
      "Si tu LG ya está vinculada, abre FÉNIX Bridge: detectará la versión instalada y te dirá <b>ESTÁS AL DÍA</b> o mostrará <b>ACTUALIZAR MI LG</b>. No necesitas volver a escribir IP ni passphrase.",
    reply_markup: {
      inline_keyboard: [
        [{ text: `⬆️ INSTALAR v${latest.version}`, url: link }],
        [{ text: "✅ COMPROBAR SERVICIO", callback_data: "status" }]
      ]
    }
  });
}

async function sendStatus(env, chatId) {
  const latest = await readLatest(env);
  await tg(env, "sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text: latest
      ? "<b>✅ FÉNIX Installer está activo</b>\n\n" +
        `Última versión publicada: <b>${escapeHtml(latest.version)}</b>\n` +
        `Tamaño: <b>${formatBytes(latest.size)}</b>\n` +
        `SHA‑256: <code>${escapeHtml(latest.sha256 || "")}</code>\n\n` +
        "Si tu TV ya tiene esa misma versión, no necesitas actualizar."
      : "<b>✅ Servicio activo</b>\n\nTodavía no hay una versión publicada."
  });
}

async function sendGuide(env, chatId, origin) {
  const base = env.PUBLIC_BASE_URL || origin;
  const cards = [
    {
      photo: `${base}/guide/guide-01-developer-mode.jpg`,
      caption:
        "<b>PASO 1 · Instala Developer Mode</b>\n" +
        "En la LG abre <b>LG Content Store</b>, busca exactamente <b>Developer Mode</b>, instálala y ábrela."
    },
    {
      photo: `${base}/guide/guide-02-devmode-access.jpg`,
      caption:
        "<b>PASO 2 · Activa el acceso</b>\n" +
        "Activa <b>Dev Mode Status</b> y <b>Key Server</b>. Guarda la IP y la passphrase que aparecen en la pantalla."
    },
    {
      photo: `${base}/guide/guide-03-bridge.jpg`,
      caption:
        "<b>PASO 3 · Vincula FÉNIX Bridge una sola vez</b>\n" +
        "Abre el Bridge, escribe IP y passphrase y pulsa <b>VINCULAR E INSTALAR FÉNIX TV</b>. La llave queda protegida en tu Android."
    },
    {
      photo: `${base}/guide/guide-04-update.jpg`,
      caption:
        "<b>PASO 4 · Actualizaciones futuras</b>\n" +
        "Abre FÉNIX Bridge cuando quieras: comprobará automáticamente tu LG. Si hay una versión nueva, solo pulsa <b>ACTUALIZAR MI LG</b>. El QR del Centro FÉNIX sigue funcionando como acceso rápido."
    }
  ];

  for (const card of cards) {
    await tg(env, "sendPhoto", {
      chat_id: chatId,
      photo: card.photo,
      parse_mode: "HTML",
      caption: card.caption
    });
  }

  const token = await makeInstallToken(chatId, env.INSTALL_SIGNING_SECRET);
  const installLink = `${base}/install?t=${encodeURIComponent(token)}&source=guide`;
  await tg(env, "sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text:
      "<b>✅ Ya estás listo.</b>\n\n" +
      "La primera vinculación requiere Developer Mode + Key Server. Después FÉNIX Bridge recordará tu LG y podrás comprobar o actualizar sin volver a escribir los datos.",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🚀 CONTINUAR CON LA INSTALACIÓN", url: installLink }],
        [{ text: "✅ VER VERSIÓN PUBLICADA", callback_data: "status" }]
      ]
    }
  });
}

async function sendHelp(env, chatId, origin) {
  const token = await makeInstallToken(chatId, env.INSTALL_SIGNING_SECRET);
  const base = env.PUBLIC_BASE_URL || origin;
  const installLink = `${base}/install?t=${encodeURIComponent(token)}&source=help`;

  await tg(env, "sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text:
      "<b>🔥 FÉNIX TV · Centro de ayuda</b>\n\n" +
      "<b>/instalar</b> — iniciar una instalación en LG\n" +
      "<b>/guia</b> — ver la guía visual paso a paso\n" +
      "<b>/actualizar</b> — instalar la versión más reciente\n" +
      "<b>/estado</b> — consultar versión, tamaño y SHA‑256\n" +
      "<b>/ayuda</b> — mostrar este menú\n\n" +
      "<b>Errores frecuentes:</b>\n" +
      "• <b>HTTP 401:</b> la sesión venció. Abre un botón nuevo del bot o escanea otra vez el QR.\n" +
      "• <b>No conecta:</b> revisa que la TV esté encendida, en la misma Wi‑Fi y Developer Mode siga activo. Si cambió la IP, usa CAMBIAR IP; si cambió la llave, vuelve a vincular.\n" +
      "• <b>IPK Extraction Failure:</b> el paquete publicado debe reemplazarse por un IPK válido.",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🚀 INSTALAR AHORA", url: installLink }],
        [{ text: "📖 GUÍA VISUAL", callback_data: "guide" }]
      ]
    }
  });
}

async function tg(env, method, body) {
  return fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

const GUIDE_ASSETS = {
  "guide-00-welcome.jpg": [
    "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",
    "oSvXL6HKDIAyGEGgX/fiZu4+IRMIqzeICQrXW4SgkzNASarj1dUWbOzMMeBDT3MOgw5fTjhgUWIR6m3EiSFcz/tQBAAJCAeDEuBZjEqTIzDapypyoSSWbMxd",
    "Zj6wCQEmowsBHptGE0Rx+/aERiRWHCXJGJ1V6VlBMBDBImXcF6/kgwlgDV5hIiX61BGCG0dJoyoT7wBSKpypzN5yo0EVHn1y+hyh5UI0GT1J4hOuuYRuSQFT",
    "lT/tRAAi2lxLN0eZyp/3oQmTMOX044Ctu85vtCVstl2PaxdZj6wUZivGOJSagEoQmc+z+SDCGEpJORHdADLJiEv2cvoY1XwgGED9pyDxCGLJ9g5fTj93F1mP",
    "r7v5IMJr7mX0OT7hy+nH7uLrMfX3fyQYTX3Mvocn3Dl9Ioxg6qdx5nceZ3Hmdx5nceZ3Hmdx5nceZ3Hmdx5lbiE+noweJ3Hmdx5nceZ3Hmdx5nceZ3Hmdx5n",
    "ceZ3HmVuITxj0Q8Gdx5nceZ3Hmdx5nceZ3Hmdx5nceZ3Hmdx5lbiE6HoAPWdx5nceZ3Hmdx5nceZ3Hmdx5nceZ3Hmdx5lbjzC0H+OWmUycBMR0FAQEdjDpC/",
    "3xHqxyB2f8RJAgDlGYErRPS2R/EohcDfSK2ccrMGAsG1tC+TVsawgIDADY8/EdwguktomaCJZxagCd3xHLaP9/ELaoCThWGB3A/eRHTIAngw6BIne7AOhahs",
    "HDT/AFzBtasHWgVDCuRiXjtCR2hsg8fMKSgBTB4+YVMUAKIjEAvobC0cMKY2YOb+JQALMAIQCSE8Hj5heK2Qo/ol1NrQOzhRpff+s5HmNufMKTIoKM7mNufM",
    "5HmM2y4zuZY28xtzGdzCRV4oRnc+jbnzGUmVG3PmNufMbc+Y25rmM7xneM7zkeY258xkmV1jJMqch8xlJlTKhpTkeZyN8/5O/9oADAMBAAIAAwAAABD3n3X3",
    "3333333333333333333v3X3b30mr+vH3333333333333333324DHGX32z333X3333333333333333333333330q6Z1v+/ub928d+/wB99999999999999x95",
    "11x9x5595515x911951x9999999999999999999999999999999999999999999999999999999999999999999Desdsc8Daudsc4Aaudsc7sWufuc/99Ub+",
    "+++8ET++++oQT++++o/he+++899C4QIse8QoYgw+oWok0YUo6s0Ao8899EeyuqScEiqWS+oGCuSSeo+m+ium899E+++++8Eee+++oCue+++o+uO+++899Wyy",
    "yyy4fyyyyyoLyyyyyk7yyyyy099999999999999999999999999999999/4xww851ww8ww48439999999999999tvd9N99999tNd9t/N9999999999999999",
    "99999999999999999999999999//xAAlEQACAgECBgMBAQAAAAAAAAAAARFhIDGhECEwQXGxQFDRcJH/2gAIAQMBAT8QEzmO3x24IECAmnxdZf74Hr8ZqUN3",
    "wKBB/GU+gj7lxf6LdkWbL8JscvCE2gj7lxf6LdkWbL8JscvCE2gtLi/0W7Is2X4JZOXhCbQWlxf6LdkWbISSfLwsJyZOTJyZPQebzeb6LzebzfRebzeb6Lze",
    "bzf07Ralg1alg0cB8aLOBEsLOBYJHp1460fWf//EACERAAMAAQMFAQEAAAAAAAAAAAABESAQMUEhMFFgoUBQ/9oACAECAQE/EBopef0VEECd1RlLbgW35mqO",
    "tdL0GaTSE0hCaTSExhCehqIw/P8AEN3I2cjZj6kbiqMPz/EN3I3cjZj6kblqh+f4hu5G7kbMfUgtUN3PxDdyN3I2Y+pGqHiYsjFmXZLbJiyYs12VkxZMWa7K",
    "yYsmLNdlZMWTFkxZP+C2kQQQQQQQQQQQQQQQJp+k/wD/xAAsEAEAAgIABQQBBQEBAQEBAAABABEhMUFRYXGBkaHR8LEQIDDB8VBAcGDh/9oACAEBAAE/EP8A",
    "vsItBjfAL0c/rdJ7DbkHNeR/y9ha/Kd71nc9Yi0geSzues7nrO56xcxZ5i2v2r8So2LqiVWwHDwVH+VInaDiE5UCqNuGU33i1BECYs8v+yuQo4N+Y+TtCxIT",
    "tNZA8UDM2yrBkupd9bigoQw/VSjc4pGvFlS+lHr/AMZiK4bjBqBF5jlMiFAARhapypM51Bq0yALzT2V7wgt5QVjpyLzxuJ8DDiXm344RSugaBVAlWePP6Mq4",
    "h+3JIqpaDxh+sCr7vwr7iKrblYAghbLwy448SHpMPCYG2yKXPgVasagARBQLdEQtFzW4iRTatr/xkLU6CdBOgnQToJ0EVMARVbW1/coEmyi8F/8A4MKAKvAL",
    "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"
  ].join(""),
  "guide-01-developer-mode.jpg": [
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgwKCA0MCwwPDg0QFCIWFBISFCkdHxgiMSszMjArLy42PE1CNjlJOi4vQ1xESVBSV1dXNEFfZl5UZU1VV1P/",
    "2wBDAQ4PDxQSFCcWFidTNy83U1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1P/wgARCAEOAeADASIAAhEBAxEB/8QA",
    "GgABAQADAQEAAAAAAAAAAAAAAAIBAwQFBv/EABgBAQEBAQEAAAAAAAAAAAAAAAABAgQD/9oADAMBAAIQAxAAAAH5oWDfLoFhs1gAAAAAAAAAAAAAAAAAAAAu",
    "IbiaW4aW4aW7UuBQHV9L8z9Dx9Xy/p+Vnr5vb6PncJ7nFwD3OHhVgAAAAAAAAAAAAAAAAADfozHQ1Jnvz55OiNRduprtC0BnBQQAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAADd08/oy+f0ehzHB0d8Hj+lq6bOLV6+qPN398r5mfUyeRn1tJzS6bObR6ty8HL7fnJ54oAAAAAAAAAAAAAAAAAA2dRwuuTmdW48926zmdmw892wct9c",
    "nG3dBwu3WczuwcTug5Hdk4HTuOB2UcLv0HO7xwOscjqwcz0JOF2jidO04XTvPPddnC6rOJ3Dhdg4wAAAXu57NzSNuIk3NNGNdSAAAAAAAAAAAAAAAAAAAAAA",
    "AAAKxsIUqVCVCVCVCVCVCVCVCVCVCVCVCVCVCVCVCVCVCVCVCVCVCVCVCVCZ2xEgAqpqmFkOmY0N9HM37DkdUnOSUkUkUkUkUkUkUkUkUkUkVWvZWM46zker",
    "B5r0cnmvQyefj1pPLbtIAAAmpJEAVU1WLjEdUah0Z5hvjWOlzDE2IWIWIWIWIWIWIWIWIWIXJjZr2VgowtULo1LELENmCFiFjWqYTUkiAKqarGcZNtad5odO",
    "44Hfk8936Tmd9nmgAAAAAAAAYzgjZr2GKnJbDVz3+ePSry0epHnD08ear0vOwMsDE5xmJqSRAFVNViamKU0lQnORKhKhKhKhKhKhKhKhKhKhKhM7NcNmvYYL",
    "IVgwrBgAAAAACakkQBVTVYuLrO+O7d5J7o1fPPW8c+S9WjyHqYPMejtPJerqPPAAAAAAAxnGmrZr2ZY2a9p0Y57N3JuHOAAAAABNSSIAqpqsXF1t9DzOv0vZ",
    "zxr1ea42+GZxQTY1AAAAAAAAAYzjTVs17MsbdXQY256Dmu+Q04AAAAABNSSIAqpqsYrBSVUkUkUkUkUkUkUkUkUkUkUkUkUkVGUTsmjFTvNOevaefjts4J9T",
    "QcWfQg4XdZ5709Rw47+AATUkiAKrXsAoAAAAAAAAAAAAAAAAAAAAAAAABNRGAAGzqk4XXZwu2zz3aOJ3k4HXsXgddHE7bTz3ZS8LsycTvJwOvYvA7MHI78p5",
    "7q2rwPQg4nXZwu3Bxu/hMC0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//xAAqEAABBQABAwIHAQEBAQAAAAABAAIDERITBBAxICMUITAyQEFQImAk",
    "cP/aAAgBAQABBQL++YnCLs1uh/KAtZCyFkLIWQshZR+Xp6ePlfxjid93Suz0+nfBtDH9QF1JczqJJT8X1Ptj+K3x22xbYr/x2d6enk45ZZ2th7aIVqz/ACQa",
    "WlpaWlpaWv8Avom7ld0z+VsErnt6SR0XBLxydOdvY6N0kXTxKTpntmMMjU2GRyi6c8rYJXRs6eV4ZDJIWwSuXSQNnkh6cv6l/Tu+I4ZDJL0zmNkjfEf40BAn",
    "nkaYXStdOTEYWugYwmF7+se15nayZDqY3SCYCcTx8rZQJGyRmT5Og52StlmuDpnBqPVBzHvZIuWNyZNHGOpd/n+mXOLf5zPlISzUWMtrEhse0F7Safb9qvaT",
    "TGCw0Dxk+1RzxP43H207HH7NgR5HGV7dHiv2rifTgWJvEvbKqMF2L2wkcYcS1ojND/Ie8MoiKiWFVGrZTuPWY0/CIiBHGgWZfx2REncZX+L9sNjxn6DRb+Jc",
    "VnhKEYTosjitCIlzxTv6fhB7gtuW3VyPvRW3LkeiSf6tKlSpUqVKlSpUqVKlSpUqVKlSpUqVKlSpUqVKlSpUqVKlSpUqVKlSpUqVKlSpUq9Q8/1j59A8rwrK",
    "sqyrKsqyrKsqyrKsqyrKsqyrKsqyrKsqyrKsqyrKsqyrKsqyrKv8U+fQPKKjZsiEYbGOPgkXw764JEOnPO7p3BfDypzS13437XTuDXyGFxcIb9jmBiAdwcw4",
    "KBgD/wDzqXO/oHz6B5RUb+Nw6ghNlLWfEPXxL1zuRk1IepeV8S+3HTvxv3+GfPoHlHtSpUqVKlSpUqVKlSpUqVKlSpUqVKlSpUqVd/36cmvRR7ePQe58+geU",
    "U1Mbt7gMflnwv2h6ORoa6SG+WG9RcckkWWTtaNwqaSNze57nz6B5RTe3KSovsLIUGRBCKMrjiTeMxubEUWRV+G7t+/wz59A8o9tFaK0VorRWitFaK0VorRWi",
    "tFaK0VorRWitFaK0VorRWitFaK0VorR7/v8ADPn0Dyj2w5YcsOWHLDlhyw5YcsOWHLDlhyw5YcsOWHLDlhyw5YcsOWHLDlhyw5YcsOWHLDu/7QaXIggqvrnz",
    "6B5RTO3EVxFOYR+U/t+012V8QVzfI9QSj8z9U+fQPKKYmff2d9qcAjBFuOOMFsDCeGPLQxvVsZCWMiZuaNgZ9d/hftMYZHNaXLikvhfXC+vqnz6B5RTEz7wc",
    "nZTvtWVn5ZKAcDk/iP8AC/aY7D2yYPxDq+IIb8U6/qnz6B5RTEDR5AuRqdJ8lsoPIWytlbP4j/C/ahbuSNg5ndMh04zKzjk+qfPoHlHtsrZWytlbK2VsrZWy",
    "tlbK2VsrZWytlbK2VsrZWytlbK2VsrZWytlbPf8AaHb518+1fVPn0DyvKoqiqKoqiqKoqiqKoqiqKoqiqKoqiqKoqiqKoqiqKoqiqKoqiqKoqu8TsvbIwS8s",
    "VOfEYuSHPLCnPjIEkN8jNl8Ww+FCaIOEkYIewM9B8+gef6x8/wDeMrZZEQGMKxEuONGONMDDHxx644yeKNM488ceyxmhHHTeNVGVIGBp47YGVxxrjiXFGgI0",
    "WREyMjTo2AYjoxxJzGYMcWRHEmsjJY2Ms4405jLkYwMwy/8A4b//xAAcEQEBAQEBAAMBAAAAAAAAAAAAERIBQAMgUHD/2gAIAQMBAT8BT0VV+nxTPojKOc/u",
    "sRERERERETw8T2891/arTTTTStKrTStNNNK52/k//8QAIBEAAgMBAAICAwAAAAAAAAAAABEBAhJRMDFAUAMgcP/aAAgBAgEBPwEfyWP9Pz61HyUL+loQhCEL",
    "6XNjNuGbcM24Ztwzbhm3DNuGbcM24Ztwzbhm3DNuExMe/PX2VqzEeWPU+evspMDjyx6n4GpNSak1JqTUmpNSak1JqTUmpNSOZ+tYxjGMYxjGMYxjH9V//8QA",
    "OhAAAQMCAwYDBAkDBQAAAAAAAQACESExAxJBIjJRYXGRE0ChECBQgQQjMFJicILR8DNCsWByosHx/9oACAEBAAY/Avj4xND7SaU4/GIJooiiMWWMczm1bVqa",
    "WnFJJdVo/wAplg9jB+oQmZv6Xg7altABsRwQw3u+rc0A/MJmDq2ruvwndVvRAa/YSbKfbc/lgxpsTCeMJpc1roRYGHMLhOflNDELxMhy8UxuEHOJYHLK8QVh",
    "h/iS5odIXht29RGoTpYRlumwwnNZOZigthpKzjDcW8UC3DJBRDGExdbOG4wYTmvMQ2V4bqZd5Pw8JpdlK8PIc/BYQDXeI+ZCh7S34Phk2DgsYNdU40/JYm3h",
    "ljg2Q7VY7GPA2pbm1Tsr27WHGsyhL20wgBJpKw8hBhkUWEfGw2gMAMp7aBuQNaXDgmte9hYW5TkFAnsluXJkaTZQ7Ew4GGRs2WDjeKGjDbBbqvo7jiDDAcTX",
    "qsQAsafEzfWC6xfrAXF4tSVjZjE4ZATREPJHiO4wvpGGMQNzPkE2Kdh+IJ8IMzrCb4jTsObPBMbmwzGjBb4oGk0Fh8Pb1W0ZrxlDORdVIo6YW/NVALUadKqA",
    "7Kdea0Q3YQoP4U4EgDkjup1B3QOpRq2V/bqqRm5Ll1Q3cyGbLZWH8CoB3VYsgJgL6w5ndUJWiEx/AhlGqf8AiugdmfRNLN7injNB6wsM05pkEc1NIRqJ5obs",
    "wjXRDhOnBCcoTciMxPVVA0WlQm5bKkInZX9sTqhYlDOR9iBxW8E0A1IVOSvQXKNR0QgrLNVHxWhK3iozFTmKurlbxVT+dZE2BKBc6C6oAErO9+WbUlbvqtJm",
    "IlbvqjhTUcEI1m9IW76qHUI8yZMbJ1RdIn/xbJZet6I2yxThKplnKbpkRk1qqxavbRAiBB/7QmKmsStm3XyMgA0iqo1tLcllytcNJFlpW/OkIWp+0LTX/ELO",
    "WtMragqaaon4pdXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dX+xmDHH3RS/kSgEHNkViD5wfYCs7GXKjDByot3ZpQDmp2Zsdm9EcjWzpRYcirLHhxVv+Nk",
    "YAzcY8jD5cE7czU3lQ68bIVmvFXmn3r/ALLemvFHNSt0TMfOyvb8Q8oP9N2VlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVvdooPmT7dPNg+4aTIhWUZfVb",
    "vl3dEPafZtADDyCDzWUEjmUxwmqaK996imsxu8EABIHHWiLQbkGeHJAxWmxNqrMJn08g33MoujGglRkKtxW6enlndEFITvxI+5ZSAZVvKN9wOiYUtAVgsoa2",
    "EDlZS1PLHop9tPZohy8u33Iyyq7grVCsc4urzLZCy+X07Kw7Kw7Kw7Kw7Kw7Kw7Kw7Kw7Kw7Kw7Kw7Kw7Kw7Kw7Kw7Kw7Kw7Kw7Kw7Kw7Kw7Kw7Kw7Kw7Kw7",
    "Kw7Kw7LTt7tPjkkkJ7qw791uwf8AaiI2oGiOxWOCoI/ShDLEIyJr91SBEtIsmkNpNaIS2f09UIaB+lYJEy07RhZZdSba/l82bSqO0Q2tOKvyut+vVb3qhmgc",
    "Tqt9QHLf1W195b1OqbDrqrvVMBjeqtqM1VsxMp1G7NeqMxfU6L+poozqr4ongnoVIdHKUMrtVv6q/qt6PmpDq8FvW9Udr1RGbW6qYPFb/qqOG9HyUg14J27f",
    "jp+R3//EACwQAAICAQQABQMFAQEBAAAAAAERACExQVFhcRCRofDxQIGxIDBQwdHhYHD/2gAIAQEAAT8h/n9Ql5eJQRACyy/i/tv1gAJAZfpDSADPMN+FEuIA",
    "AMBqcFkGdYS7gBFwAACx7ORB0sP2Mr7vEbhQ+O1QgiIaOiL84GNTRv8A+L+JXMHIJrE6u41ccQgdEJdeOY/SAT6IqWG3ha+DKTqAJAQ2BjNsuUJldwklM4hJ",
    "OS4SSWbP8MTCPtH2j7R9o+0faP8ArZSdD/242pMlDz2LwgvomImwcTnfyhA6u6QY9EDZwwJHoYAsWECD4iCkiGh9yY5AF9BNWRK6qFEEl6nCEAmDthEPA9IY",
    "h8ggxWDDERIw0MLK5F9gIQOaPtzAhdLcKIA+xMCSg2Hr/DkbRAk6XB+SlAOUzAYL0FINCNRAZVXTQRyFoEkjTB0EveBhAWoFRUsMroFneAguNCx9oBZKo927",
    "hBnawBijEoO6b9xgAGVATpFGRJdhoBzEvEdvJGiQgwB/sT+l0A2g9GwNTKvGk0YR+ELFGzhUQIDaJB/EJWzVJBE/iNV7mkP5QUSftn8eYINAATCCU4Bk0Fxo",
    "FARIP2mNkIjkQVr8RoB/UsJAEBtrP+QbagLEHV/eUwwE2qKMjqhd1r94yIJDVkTSttln2UGSVuL+24hHDsw8LTmcoGLDT/YFBpeWscLDRZ4z6xPWpGTez4g5",
    "Vu6GlILlvt/2ZMSatfeLOABCm8x12LLPtcIbAVkt4yBDAEC15yrDWzDAAAQzh05YSWME4MagaDQk0GccxIHAKz5vvDogyJb1hOj3rnTuaaRByaPTmV06mvmo",
    "K8CRF2YCMEFoiI5rD4/7GgbRzscekE2dDFaRIQlvNOs+s0RaGy8afeMSAKTbZf5h3KRKJRDL/qY4dl/mAsFOgST/ADDqNwLO1xsBfAWgUIBBUai35xy1RYu6",
    "/wBhcY0e1LlwE1FJURRFQuMU0GsR4EATR+37PNRQMAV43p4g1wgsGrUJA9tDyv8AYQCVJNTEIQXC+jUoIAYCepTiQFBdGjtAqbD8fygJIEFEQgwoB48ybIdz",
    "cDdwlyRcAAQBAhZnkCzEjCv5UEZ3E7idxO4ncTuJ3E7idxO4ncTuJ3E7idxO4ncTuJ3E7idxO4ncTuJ3E7idxO4ncTuJ3E7idxO4ncTuJ3E7idxO4ncTuJ3E",
    "7idxO4ncTuJ3E7idxO4hIc/qBh/Lgv0sfgTozOYzmM5jOYzmM5jOYzmM5jOYzmM5jOYzmM5jOYzmM5jOYzmM5jOYzmM5jOYzmM5jOYzmM5jOYwE7sfVWPwzH",
    "UwY9FDjnQCW0G+0ToDIHIpg3cKp3tUIxKZiHhvqEQJOHDZ/iEqSAnU+BzARIRyADfadBEiw0zCIWoH02sOXgY74gaX3GebUyGfY3DQAANxwVjfWAaklGtz+5",
    "qVBTG9LmB2WaxztGMlgQZr/pMtEggnQf6ceGZA5IBePSWVA4MP3rH4ZjqHtgRDAgwmCDfE57X+Y4wJdr7ITA1VZewoAEk+FeyhOPzDmByFGQtdwiUcwWMg6S",
    "nobFRVekKRyfptYcv3FFFF+1Y/DMdQBlCL8Ivwi/CL8Ivwi/CL8Ivwi/CL8Ivwi/CL8Ivwi/CL8Ivwi/CL8Ivwi/CL8Ivwi/CL8Ivwi/CL8IvwhCNzWHLwGf",
    "0EL3dleCJBKoZ8bgbZWfAgkiCDz+4sfhmOp+CXKnFyASYf1n5k1hy/UBWTR6ZLMIpIDXVsfP0hYAB8hYtcNsCshCWza1CBhEANUD/YOSEAo3f0jtHG4jne1G",
    "/C1W0x+4sfhmOpqG48AESl7mxyIDSCZKYt5+0IZKitB6MxwuAg0WRptmAGGBsBhHLBg1HvuKFprkQFiBQhXTYGmusrtA0GG8v+vpMAmsOXgIxGIxGIxGIxGI",
    "xGIxGIxGIf2LH4Zjrw5Jyek5PScnpOT0nL6Tk9Jyek5PScnpOT0nJ6Tk9Jyek5PScnpOT0nJ6Tk9Jyek5PScnpOT0nJ6Tk9Jyek5PScnpOT08NYcvqbH4Zjr",
    "xPuGe4Z7hnuGe4Z7hnuGe4Z7hnuGe4Z7hnuGe4Z7hnuGe4Z7hnuGe4Z7hnuGe4Z7hnuGe4Z7h8ZrDl4GELpwoAQRp4MgVR+ksfhmOpmWoFTJgRkCc0BXRHH1",
    "VhrETWHLwETIYDUCAFQNI6Q14Ej5secyAa4MKz+39HY/DMdT2O56zwIIyCJ6DwvaEgaRiXNMglEA/wCOOnZXY1oxsEJABTcK2uXiNQkCzWJ2Mt2CtACVvUSf",
    "VBiiVyQ8j96wnORFscjX0H5U1hy8BVLblStXADVpYFjeBglFq4mVY1S8P6Ox+GY6nsdz1kOHIIVAENU9B4Ew2go6GrDj3euIrLuAnsD6T8qaw5eC9AiYBh0l",
    "S9XAEBhII83AlOzrPtz/ABkIbL+isfhmOpmO8IA0gXbE7vKCJh78LmvJKIqISzSV6Xxy5eDTHH0mBxNYcvBc4dUUuY9IkN02HUC7yJuwWNj7RQQ9QsY/2Pmd",
    "A+f0dj8Mx1AUWJwF9YEIQhCEIQhCEIQhCEIQhCEIXBIkkslmaw5eDPJ8SzvNS1vClFjwYho3WP15gBIJAJWa/asfgRozOIziM4jOIziM4jOIziM4jOIziM4j",
    "OIziM4jOIziM4jOIziM4jOIziM4jOIziM4jOIziM4jOIwE7oeIhgnAcMBhGiN2jcFlohnSAETgFKIWvnNAEhG1+1cAiC1uKDGnnB0hhK1bD8oApAtiGNBwvW",
    "XRAKoc2q8pqUBDqF2oEztPDt6iuIcEmo7f0oDizRDxMMWgIv9/2rH/OzB4lbiVuJW4lbiVuJW4lbiVuJW4lbiVuJW4lbiVuJW4lbiVuJW4lbiVuJW4lbiVuJ",
    "W4lbiVuJW4lbiVuJW4lbiVuJW4lbiVuJW4lbiVuJW4lbiVuJW4lbiVuJW4lbiVuJW4lbiVuJW4lbiMDmGz/4F1WhuAJVlmxnMGMjbD3UAARdkMQq8wKAOBmi",
    "6h5YEM4AbRsnO2h0qXhUNaRZsRREIcqUBDFQTA0Ns5FVKVS2EvH/AHyg4mgCTYiAl6AQQsCSbjzhZJBdmjHQTGwejKjagAAXHHnM4wFJsCaQpHYYbtA5Y4ih",
    "YVkxsI2oAIEypDojy/7ACWRSARQgoQ5qdUIsniXhCMZ0kOsHM80VJiLhoQYpCNlApWIcYgCpG1AG4YLYsaQvQJ9PKXwQNQLW6EleswYQCBvRsAncIRX/AMN/",
    "/9oADAMBAAIAAwAAABD3n3X33333333333333333333v333b30mr+vH3333333333333333326MDKX32z33333333333333333333333333330q6YmN4ZJ1K",
    "P3333333333333333333H3Xnnn33Hnn3HXX3HHnXn3nXnn3330FnGlX3333333333333333333333332vzzzzzzzzzzzzzzzzzzzzzzzzzxP31Sw4YoY4444",
    "4444446yzTDxjT777z31Tq77777777777777rzoMccMssPbz31ShQgAwAIIIIIIIIJTy4IDIKAAJ7z31T7f+/wD/AP8A/wD/AP8A/wD/AP8A/wA66y++++++",
    "899UrksCAEMACCCCCCCV86Gq++++++899UrdWCeCCCCCCCCCCV8sEwe+++++899Uozzzzzzzzzzzzzzj4sgIYo4A0+899a88888888888888888+++++++++",
    "699z0w05849845w4x404079999999999999999999999999999999999999999//xAAhEQADAAICAgIDAAAAAAAAAAAAAREQUTBAQXEgMVBwkf/aAAgBAwEB",
    "PxATOzx124QQQJp5da/vof31mqisaIfo2lKUpSlL8H21l9OEIQhCYWX0lwMWXitFaK0VorRWitFaK0VorRWitFaI1xrLEImRyrzxrLEMirlXnjWXiisrKysr",
    "KysrKysrKysvGsvtrLRMggggaIk9D1JpBAlIIIIEoj8S/8QAJhEAAwACAgEDAwUAAAAAAAAAAAEREGEwkSExQEEgUMFgcaGx8P/aAAgBAgEBPxAaKX59xUQQ",
    "J3KMpenwL09s1SPGhL9BzEzCExMTMIQmIQn2NIhCEIQhCEIQhCEIQhCEIQhBrKxSlLyLieViEIQhCEIQhCEwuEAx5R85vKhFR4PB4PAoVD9R5WND6Njo2OjY",
    "6Njo2OjY6Njo2OjY6Njo2OjY6Njo9AC4nlYFJWOPjl/w/dC4nlH5P6EE0xrXh8v8D8oXE8rG02m02m02m02m02m02m02j9QxcTyvdvLcIIwjCPoEYQQQQQQJ",
    "37T/AP/EACwQAQACAQIFAwUAAwEBAQAAAAEAESExYUFRcZHxodHhECCBsfAwQFDBYHD/2gAIAQEAAT8Q/wC+wi0GNeAXZz9bpPYbcg5ryP8Al6ha/adbvOt3",
    "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",
    "90eryho6z1j90NL0E7fnT6BAnUBg6/UUDuna86xzzEpRxWscCHAU/Zq+uv0P19v9On09Imj+tSGmg20LcC0HFao3SLf+BKwGxAszTjD1/wBz+reGjrPWP01P",
    "2PIlGizIulF3zsjxYRuLkF/Cg8rGsCa0kBAUthQ5a85f8wgEpHDbLGjFtAK8jNrihxO/I/JHFV6OOhN40td47YJeWtVmq/Eu3EtYkAPAFCU/ZqPrr9D9fb/T",
    "p9PSJk8bBvkYNIjSaJAVrpevBHR9E1hINUHXkLHZmEWjBEZUZZHG+UZrNt04OWVZWcIztAQ0wt4wFrOsBeKw0gWinLZwFQqBf3U1uocl1rW8BtoaOngOOy2T",
    "RGaBDUWC2WA4DmzL/wBPBGoK/mGjrPWP0VM3pvTem9N6b03pvTem9N6b03pvRW/XX6H6+3+nT6ekfTq+oM2XZ7TYdntNl2e02XZ7QK6rZTQyTZdntNl2e02X",
    "Z7TZdntNl2e02XZ7TZdntNl2e02XZ7TZdntNl2e02XZ7TZdntNl2e02XZ7TZdntNl2e02XZ7TZdntNl2e02XZ7TZdntPCEVW1tho6z1j/qa/Q/X2/wBOn09I",
    "+g5djqhN32e83fZ7zd9nvN32e83fZ7zd9nvN32e83fZ7zd9nvN32e83fZ7zd9nvN32e83fZ7zd9nvN32e83fZ7zd9nvN32e83fZ7zd9nvN32e83fZ7zd9nvN",
    "32e83fZ7zd9nvN29Ef8A2IiiImow0dZ6x+jW4EshQcbYiEqUaMp5PaItViG9a/59fofr7f6dPp6RMD6tXJsL9YGALV7xYVXKfxMt+hq8Eo5TG0o5TG0o5Sjl",
    "KORKORKNpRyJRylHKUcpRylHKUcpRylHKUcpRylHKUcpRylHKVtMw1AvOmiGjrPWP0zDJwA1x/EDXxOBgUF08DWAnteKqz2N2rUdwSglA3+L9cy8yyGtmCtf",
    "82v0P19v9On09Imn+NH1Ye8pWSsz1f8AUdI8N2xJFmRlbuzldxVjBCVS0eN3HCzGsSq9S4Nmu4gH56ku9iPEWwrQA/OczEuRU1a3zyGtVdOYetkTuPJQXiLl",
    "qWhRCzpqt3JeslsLoSrIANflNMS8UUnbQHj/AEPQftDR1nrH6cs+1juxcgkRxSwxzbSGbDRUpVFxVM6QbU2hj8HRiA1HnVoWrlSf5tfofr7f6dPp6RNP8aPo",
    "zTg9ig+jFlAr1v4LWuuu89T/AFOETeepV1auj8QcJRCGqDUGUvDd8msEgVgoeT+5iKaVYmGlyvpRVUV0lF3Rf+h6D9oaOs9Y/R8kaGr/AAkbs28ylUtl1wHS",
    "CB7Ai0juF1dtXrWIyX1Aeq9c5wiBZoxFqZVVnaKxaqv+XX6H6+3+nT6ekTIGqUc6R/8AI2uFZFhtcqubkhySKVKr6c2Lvqqr7Q3CbCtC7i4UaCFi0PDWBoHJ",
    "l4tD1WXMuCDyPDp/qYo1EpsuIaOs9Y/S1KZQgBqkFoL01xOVjbY0DeBWjvHhcGmTWl1dBo4Zi0lcmKWrd0tIS9Y6OMDVNAacuc8/82v0P19v9On09IiAiJkT",
    "hOermi2eITxCeITxCeITxCeITxCeITxCeITxCeITxCeITxCeITxCeITxCeITxCeITxCeITxCeITlE8wR2pNVho6z1j9AyXvQvb2mpqxbqyuR2tVDWnWoKQxW",
    "DZhzf5iq2qu8BAwqIsvLr91XpAUAKugF3BgmoJDry+3X6H6+3+nT6OB0CqvX/gEREREREREREREREREREREIJofyxbV5/Q+iNWtkaQRprgyhHZKpRRznBrvN",
    "SZtRlwHOnFHrwj0aTUAs8Waw0zMRSqtABGqbttWdTlFcC3U0Q1bNgM5Lu4X40Aita1Nic8oo1sBiBRnUtYCxFMQ2zg0oxziq8FWAq8ELwv8AMeqFFQWsqDxi",
    "WdTYPCpXLaWw2lCMCJHABrkdecONCxBRwtCkcZsSGn2a/Q/X/cmv0P19ooiYSGZYuTL+XL+XL+XL+XL+XL+XL+XL+XL+XL+XL+XL+XL+XL+XL+XL+XL+XL+X",
    "L+XL+XL+XL+XL+XL+XL+XL+XL+XL+XL+XL+XL+XL+XL+XL+XL+XL+XL+XL+XL+XL+XL+XL+XL+XL+XL+XL+XL+XL+XL+XL+XL+XL+XHXJsIlF1f/AIElFOiq",
    "KvNsFKVVQZMLapQUa2MesZTTlS8OTY5axMm8jhFY2rnpmcAKoyqLDztc6Yik+gNAaFeGTfXErQqU1Iwtk/GlwtrE5uVljfLCXzqVYGLLCq5TiuDHWKIgWHRZ",
    "dujxyacZjtVRyMy1pd67MDXUGMC+LgF4OXRLZvEAGrAXS3GY0+ULsVUHpV8ddSGV9EOFKt0H4zzlQkFw4IGFBNTOcxHiRLmsGc2Vf45ssiEBocTVrY/FwQgi",
    "ILC2jlvlcG9tDY44oOdpjkMBQHk5SsuSGXm6Sgxnci2l7auHOJeKiDaVdtGo1X5IRpWw5GM+L+EPKlxh/VZ0bgckpCCzXGtGb0gZPAm5CnGNbxppe0PsEYqK",
    "uWvHHbjc1PoKkusNa8dOUM6RqWmTT+sal5gGrAlnPgNVFzoSlVoUwP4c12la6kDyPNouesKlBbkb11c8GdJXYihFj6K9YdMA0zKLtNXLkxiBQmRmJSAM3+TG",
    "IzpFOTZ3/wDw3//Z"
  ].join(""),
  "guide-02-devmode-access.jpg": [
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgwKCA0MCwwPDg0QFCIWFBISFCkdHxgiMSszMjArLy42PE1CNjlJOi4vQ1xESVBSV1dXNEFfZl5UZU1VV1P/",
    "2wBDAQ4PDxQSFCcWFidTNy83U1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1P/wgARCAEOAeADASIAAhEBAxEB/8QA",
    "GgABAAMBAQEAAAAAAAAAAAAAAAECBAMFBv/EABgBAQEBAQEAAAAAAAAAAAAAAAABAgQD/9oADAMBAAIQAxAAAAH5oWDvLwFh05gAAAAAAAAAAAAAAAAAAAAv",
    "FHYnF2HF2HF25LAoDV9L8z9Dx9Xy/p+VPXze3o+dhPcxYB7mHCqAAAAAAAAAAAAAAAAAAO/CY0OSZ3z55NPPkXryc7QtATBQQAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAB6mP1Y8rZYuOfT4p5npcda+by9iE8vRy9Ez4vWLjzelYxX5+ieV09LEY59fgeX09DBZsx+pePG7bvPIj2aHkW0azyuPseLQAAAAAAAAAAAAB01mBtgxt",
    "dTM9DmY28YGnsYG2TC09jA2VMrfUxNVzLTYMbfQzU28Tg1djz22557T3PPbbnntHUxNljC38jK2VMrbBkjTJlaOpidOYAAABbvwuX6cB0chzTAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAtHQosqqwqsKrCqwqsKrCqwqsKrCqwqsKrCqwqsKrCqwqsKrCqwqsKrCqwqsKrCqwrXrSKgAtatqQ6RzaKHJpocXccGqpnTQsqLKiyosq",
    "LKiyosqLKiyotNL0AlBKBKBKBKBKBKBKBMJIrapUQBa1bVHTnWNrEN1vPG3nmG5hHXkAAAAAAsVdCc3Qc0wq9LgUvSpotlGjlQBAAAADpz6VWtqlRAFrVtUV",
    "tWNPLTcyzfsZo2ZyldcGKvbiAAAOnMasojdh0TPdyZxv9z5fdnDxNWX09l6XuwpaIPVYUdOuaTfk5CnqebyLcrVAAHSlqitqlRAFrVtUVtWAAAAAAAABJCYB",
    "qTK2JnG9D0pPnW7Dra9LqFTMCUCUCUCUCUCUCUBEiK2qVEAWtW1RW1Y9fl5snpx5g9PDyAAAAADpzGrKI3YZk3MSZ9b2PkUz63jmvRel7oKWrB1UkmqCogAA",
    "AB059KrW1SogC1q2qK2rAAAAAAAAAAAAAAC9LgUie5wnXojzHp8jz7d+5hp63kgAADpz6VWtqlRAFrVtUVvSAAAAAAAAAAAAAAF6XAqVqoCkCUWIRIRIRdKu",
    "kFFoK1tVaiALW59CUKlAlAlAlAlAlAlAlAlAlAlAlAlAlAlAA1WxpnV0wjVOQa7YhsnENrENfPgXbTKTX188aclqLAUAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/xAAqEAABBAEDBAIDAAIDAAAAAAABAAIDERIEEzEQFCAhI0AiMFAkMkFggP/aAAgBAQABBQL++YnCLo1uQ/lAWsQs",
    "QsQsQsQsQsUfXjp491+2Np3+2ldjp8ndm0MfqAtSXM1Ekp7vU/GP4reOmbFmxEjDo7x08m3LLO1sPTIhWrP8kGlkslkslksll/3+XTBmmbBK9nZSVNEWOGmm",
    "Lmt+R0On3xp5S90b2tEZE2q02zPqdLtF8MkZOmczTuglYzTwiRjNNvHt5cTpXjT7T7MMjY8HBgiO+dM1jtiUx7Mmemh3Xva1zzp5Q98MkYGnlc4QSuc4Frvt",
    "QBpmbqopJn4SxFzDG2WJ07HxvU72nXSCLuxO2WNkzHy7mer7trZI52ARSRwNyZFFqJQRprBM0ckumMERLmnSPdHlM5joNE5u2x96mSZs7zM1MlA0On/37lm7",
    "HKGS6V7ShqGygzfj/RDiG9ciW/wWepLagYwfjUeAc7BFzS74r+NVFT8KEjcviT9tyjwxBYC3bTRGgYsvjX4h7TGjtYnbRwaXbadtWxODFUWQMaBjan4AfFYM",
    "aBjydhj8SO2jtl/xB7ME0sa8uD3uMZb+BjEhEbi3Km5/FcmOf6WjJ20StpbKEJKEV/1wcTuOW45F7ic3LNy5/r0qVKlSpUqVKlSpUqVKlSpUqVKlSpUqVKlS",
    "pUqVKlSpUqVKlSpUqVKlSpUqVKlSryHP9Y8+A5XCsqyrKsqyrKsqyrKsqyrKsqyrKsqyrKsqyrKsqyrKsqyrKsqyrK5+sefAcoqJm47YctmRbD8dmRCCQoQk",
    "wv00jXCB5jc0tP1B14VlWVZVlWVZVlWVZVlWVZVlWVZV9Tz4DlFRv23DUuahqXhdy6u5/F2pc4MmdGBqXBDVOapH5u+oOpTKv8CsWViynUHfrPKPPgOUfrgE",
    "rArArArAoiuo6n6J5R58Byj02XY4OW04xSQvjcYXgNjJYYZA4xvaSC0/oY3JxhoeOnYHyUK1sbW9R1KZjntR9y1kXcaYRu1EMLSGwM2tK2N8kX+7YGP1EjcZ",
    "PI8o8+A5R6dxSOqcXMndGzuiu7KjmLG9yu5Ur9x/7A9ZhZhNlxPfeppjKeg6lNOLjO8yMmexjZntcNRICJ5A1s72vEzwWuLSTZ8jyjz4DlH748LVq1atWrVq",
    "1atWrVq/A8+A5R+uGBYhYhMizd2TK1EG0eg8LVq1atWrVq1atWrVq/A8+A5R6DaLDHFizbdDhAsIMZMdz9bHYkzEjoDY6QSbb92OtZMH9R1Ka3I7bltlbbkW",
    "lv7Dyjz4DlH7FlWVZVnwHU9MnIvcVk5Ek/sPKPPgOUfvjqVyiC0lpAxOIaXFOaWnE4/oPKPPgOUfvjqVp5dmbVT9xLqtZ3EUWs29Lo9T2zt7/J1mp7kyazPS",
    "foPKPPgOUfvjw9L0vS9L0vS9L0vS9L0vS9L0vXgefAco/fHHTE4+VGl/x1DS5GNwWLliQKPQ8+A5/htloby3V3C3fy3fyM1rfTprQnob3rfTJcVuLf8Ay3fx",
    "3qY2cXJJmjz/AOLv/8QAHxEAAwACAgIDAAAAAAAAAAAAAAERAhIDQCAhUGBw/9oACAEDAQE/ASdilL4cU17ENSCX6JS9zJEZlhkzBNL3224bD5EhO9qDVNR8",
    "dMcYvrsRqiI1RqjVENUaoS+e/8QAHxEAAwABAwUAAAAAAAAAAAAAAAERQAIDEhAgUGBw/9oACAECAQE/AS5NL2b/AC5LJhPsT6NM05lOSzGQegSnrsIQhCIh",
    "Cef/AP/EADUQAAEDAwIEAwcCBgMAAAAAAAEAAhESITEDQSIyUWETIFAQIzBAQnGBBMEzcJGh4fCAgrH/2gAIAQEABj8C9fGpsfaTa3X1iCbKIsjGFrGpzbtu",
    "1NLTqkkuu0f+pmA9jB/2EJlX8LweNS2wA4I6Iab3e7c0A/kJmju27vv6TyrH9kBv8CThT7cn+WIcCaxFY6SqmsJb1WmaSasxsjANFUAlEDTMhBrrXhHRnUa6",
    "Yk4TmtYSW5hVFpAmE1jxEkKlnEHcq02sl7nC/wB0A9hBOE9+o1zXAiFU5hDVqPdUQzZuU/waqWjfr0Rd4boCbqxlOFN2Z7KssIb1QdHCcFN03iLwVqueSNNh",
    "gdXKsMdT1QZSajgJ0zDRMDJQboh89CqSw1KXsICgMMxKIDDIyEQcj5ttZhs3lPqZSNSxdK0vetZ4bYIX6Y1t4LEb5Ws3UcPDL6wU/Ue5tZfMOnCLgeGrKOs7",
    "WZRVMDKeJ02uL6uPC1G6zwWkh1X2XiO3fK1bVQ4u0ytGXfQ4E9CtJjnh8alUjZP963UJeHQFquZqaUP2jiKJbrjSd33WoK2gu0qatiVpurZ3JmVpcYnTceFf",
    "qXjVafEbYKXuY7UtSW5/KeNTlZ7xNe8/VJWrpaj+GZ039E17H6TaWxcXXiH+I33bSpGr4ThgptbmudQWueBZMnU0oAdybJ+nrOhj9z1WqCWNLnSKxaF+o940",
    "uLQBTafUi0GxyPIGzYbehN+6jUcHdLoWH+lfSie9p6JlKNbqr2X5UcP9bK/LP5RpAQO8Qtu3+UYionMo1r6MhDHdPk/ZbC/7q9PdMNu6w3H7KwGOqOBCI4Zu",
    "jEdkYjHVPEjCZEE7wrwrU/6EIITIgndEmnOy2Fv2X+VbK2R5ZhfTcoREJwm07p0HhkQhOB1RxUrkTSoDvqwmgXblOFrbqLff8o04+EB1VjtK5guYdlm8SuYR",
    "19XB6LmK5iplZK5j/O6Ji0oFnEDuuQqYvMQjwGy5CvEHWIURVbZVR0gdVBHyp8mVlZWVlZWVlZWVlZWVlZ+JMTaFAADYiE3FjKiLdyuUVTbtaEZ3EZQDbQZQ",
    "sDThWAm1/sp/f5U+TiRWVzK2PTcLCwseQ/PzI5ao7LlP9FWMTSnAjlzCHCb7KvbCpoMiyILTZQRB+DCJnzXWFItPtPkFc09lrMhsgwxrjZPZRU0G7ieUJrXg",
    "kEwE5zi3NLAeqhzRXDt7/hQ8E2sgKA8m0FEhnu2kN4dynCIg/JCG8QbTKJjI64UNXKJGFZsflOj6u6eQwS5Hh679VVEfFv7ZBuuUK/tPkkR+V4kirrCpFMd2",
    "ygREtxZGCLmcKmpVCJxhAggRMWQIKk59PPql1hYUALPkPkwsLCwsLCwsLCwsLCwsLHxWCQDDavsnm/D3ymB5pvsRdR1Mc2FY7xlOo5fv8SVEeaThTWFA9p+B",
    "f03KysrPkPlysrKv6ofLBEFAkESpgx1UNBJ7eyHAj7qqDHX1E+Rr4mFXTFoTWURCOjRPdONNUrxoHNMJvDTCGjR2n1E+Tdbrdbrdbrdbrdbrdbrdbrf02Yt5",
    "5281gsLBUxZfb0ttsLCdbm7rl/ummMJhp5VhHhR4coClYurNR4cmU62QpDfuiIygI2VwsY/4Yf/EACwQAAICAQQBAgUFAQEBAAAAAAERACExQVFhcRAgkUCB",
    "ofDxMFCxwdHhYHD/2gAIAQEAAT8h/f8AUJe3koIgBZZftfy3rAASAy9IaQAZ5hvwolxAABgNTgsgzrCXcAIuAAAWPs5EHSw/Iyvm8RuFD47VCCIho6Iv3gY1",
    "NG//AIv2lcwcgmsS7TuNXHEQmq685j0gE+iKlht4WvhlJ1AEgIbAxm2XKEyu4SSmcQknJcJJLNn9mJhH2j7R9o+0faPtH9bKTof+4LFCLZYQwFmgQV1WFGD/",
    "AMhFTFmXCJKGNo0USUhqLgwtQmBaFeKtiaoQTvtCzjYGqMMB2U30XvGPJEF02m0UhmDaAAcEGCB+1IiQCG+cAdlNQ4A4Fkyto6AjTsNDCM8kMdkHD7qEJjNq",
    "3IIbGRBqHCWq75tAQ1rTSaGl7ggRb2dvAIW3LI7BgMLIMBZEvsSuOnoTgww+cBFiBDRERt8WPx3i2QDjFJ5nqpUDGR53Cy4hMVLhxPARIP8AYgkMuFBwAyYB",
    "+SEpjSFHLJSS4h0E1RZD/YJ9YAIE/wChKxkgnoHC20pYBP8AWsBizrRxzCodhpApQAZsGLDhKDTH0GEF1wHQS6wAwtzGmiAQYg3gYAgOATBLJZ0l+lrb0hui",
    "QZBdIUGJWHY0+c1dBN84HlaRjh1Cgdmw8SkhuIAANvCP+ByhAgWNHidumIOO4F3sCIERvDaAAnQC4I4XPApQN5goYNv3IkEfPPQSgRxaB+xGCDQAEwHsLJ0B",
    "85pUkGyT9lBZEOsspv8AyG8Ctb9jFhOzL/mAkYkzfGdfaaxCFEC63/qEoQS2ASLKAbIxWzqhjaKSL7/qA6aDqkv50iQK6yJ2hXnAi/5Avg9N4d6HMPEaTKMM",
    "C64/kzESZ58QASAhnf2qAcyqErXHOJUiA2E1ABqUZd/lEAwd5WYBlFNvdV9YuhUGvH1zEggM7His85gICIwJI/ZgC0bQEmsiKAbC9iEZghTBAe/8wA0wIt3+",
    "UyJU12JaIGj5f9hcrZxbE0gN2V/6guQpoMBp/wBmOIAK2Wd4XJCAM2CWmP6cBPZCV8vpDI+dtJQFlAGXcsMGcbhcrI9kc0ahs29nxDDZAKOKGINJCAau4LkM",
    "MG0iJ2MO9PlDeUBAtTv/ADLKUZZ/J7T6B/pJHJKAQkJFBRv7UyKJhJ3BQ7gBWm1KABoEYe6UbY6/dzBckxGvUzctbI/jcAGruYB4oCzCSVl/u4IzuJ3E7idx",
    "O4ncTuJ3E7idxO4ncTuJ3E7idxO4ncTuJ3E7idxO4ncTuJ3E7idxO4ncTuJ3E7idxO4ncTuJ3E7idxO4ncTuJ3E7idxO4ncTuJ3E7idxCQ59QMP3cF6WPwTo",
    "zOYzmM5jOYzmM5jOYzmM5jOYzmM5jOYzmM5jOYzmM5jOYzmM5jOYzmM5jOYzmM5jOYzmM5jAU5+LsfjMdRrUBEU8BwkxOwFaq3LFZX1xNafSE29pXwB9n/EJ",
    "ACwOEqiA/V39YpWACe2kOnZ3DfiUdH4XHyJopyPecj3nI95yPecj3nI95yPecj3nI95yPecj3nI95yPecj3nI94D1LEIRI9dj8ZjqHKpiIHYhQRjkEkatvMH",
    "plsdc19T7ywQk8ghpJOPsLFoCQDAGVb3Xyi6SI3YA/qCNOF3RGsVHDja0X8QjrwrI/z8Lj5aepty57gY1MId7ylXXX6ywifygEA3u/Uz+ux+Mx18PhA/SkkQ",
    "rC84+Wnr4HP67H4zHXgiACk0TfKEZALzUBJPTZcIHOpYD5wmmiTS6hfQCctTtCMmjVrBEJZ1tHhbBC/RyRUThw1pQJSv7vyAgh5V8QGt4AIAWygwDFlecfLT",
    "1MYLUCRMQAZ0AKBg5LK1frFsGDWusEiMzJR+SDC0mIa4wmFUMD0lQoYJhUKSZn5QiInAbm6Eu8wEfXn9dj8ZjrwCExhYZddThEAWbce5ggoIks3lfwpSMAif",
    "AB7xEE0CzV23mAUCSwOi9xrKkCOSS+v8jJVJKF6YE/xGqW215/VGl7p3+07/AGgRnAOIDyZvGQvOPlpPEKBwjYxC1AwkAfZ5h1elkAY/OFGUVNW4ZBMBUDuN",
    "jElSwyAw83mExq7ETSUIgHIFPMLyBBYhjkZFn1AMqWL12PxmOvj8fIFRvsRvsRvsRvsRvsRvsRvsRvsRvsRvsRvsRvsRvsRvsRvsRn9Cx+Mx18GASULMR2Pk",
    "QUZnGnGgxjswZhvqF4NCNfOPlQFxPyiflE/KJ+UT8on5RPyiflE/KJ+UT8on5RPyiflE/KMHRfoWPxmOvDdPCOuy53ipAKKvbArmANooCxmb3BhArA3iOkXW",
    "jhcYTmWsX87ihAgKGX6mDOltDMhRBGcfa8gcPIFlgjAbA9xNjGu/nHy09RwGkHNgAjQuC3A+csSvGYoRP9TP67H4zHXl0tPhASMGcz3nM95zPecz39GPlp6j",
    "T5lWcQM5zcuZA/1M/rsfjMdfH4+WnqAEgACSdBDgoGhCgMZgSMwFITDlKE4oUDmq1jMXYFCECEeEo/o5/XY/GY6+Px8tPUo3tRbRCBmUpcyW/aVtIggNV7xi",
    "KFZRhI5rpRqChOrJlKwQATVXH6Of12PxmOvj8fLRGKCgoKCgoKCgoKCgoKCgoUMN8/oWPxpPx+TnyQgZNgw1mAE4vWaPT0aH28I20w/ConQeHDisxGzv6RX+",
    "UIUyBYMIGxy49dj8YjMZjMZjMZjMZjMZjMZjMZjMZjMZjMZjMZjMZjMZjMZjMZ9ABCZLjIv6TG3KGsADnQWOQHEfMOgYtDwgAIqwmDMGZknP0iYoAH9TNlBZ",
    "hF/5qgABJve4HGMBI4GIF3iULIIQ6qF8GCN7YgQbhG+/9gV0Buvn/sGIFdB9cweJW4lbiVuJW4lbiVuJW4lbiVuJW4lbiVuJW4lbiVuJW4lbiVuJW4lbiVuJ",
    "W4lbiVuJW4lbiVuJW4lbiVuJW4lbiVuJW4lbiVuJW4lbiVuJW4lbiVuJW4lbiVuJW4lbiVuJW4lbiVuJW4jA5hs//c//2gAMAwEAAgADAAAAEPefdfffffff",
    "fffffffffffffe/ffdvfSav68ffffffffffffffffffbowMpffbPffffffffffffffffffffffffffffb7g0u20mjlgvR+1w/fffffffffffffdffedfdccd",
    "cWfXcfceecdfeVffffffYYVfffffffffffffffffffffffffffa/PPPPPPPPPPPPPPPPPPPPPPPPPE/fVLhggjhjjjjjjjjjmPqAAAAAAAHvPfVLvnvnnvvv",
    "vvuscfqvrHDPvvvvqPPfVPpc+RVvvvrPef8AP2r7QsM9Nb76Tz31T7bb777777rbj3nyr6oIIIIIILrz31T7n177777652vNF+r6hij77776jz31T7777777",
    "77777776r7wYo57776jz31TLLLLLLLLLLLLLLKL6Eg4gwwkmHz31p77777777777777675/0+03x50zv3333333333333333333333333333333333333333",
    "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"
  ].join(""),
  "guide-03-bridge.jpg": [
    "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",
    "EVOFFZyfLVvy+PjgCbQgi/yGt/BhSgkJCUTS+IpUGrPcMAAd+QPjhFYAjuK0CGIsDMLJvSJghUSYDWsuAVKt1L/AUaQHJEQGXRCUQagSGebeZrflcfA+OBCE",
    "jOZVZzKIvg4CVPsdTluR6hKoNAiwuOoP2B7PtK1QCKoyG4RQS0ca8zW/hwpkRz+UcUVaT0hA2p9T+cfHHJCpPEZPXyGt/BnACnaRz/WLihoqW4j+U3KOOOOO",
    "OOOOOOOOHwPjhEDiNJ7ilYz7GGGkRWRan3gsWsVLH9ReUtRWrBVESPrf9ShiJqsKCI6uPdIBgagmg+24uhryqcIsJMTqL1RgEuLofLVvy+Pii2TVNUASwUdy",
    "kuJolrqaJomiaJomiapqmqapqmqapqmqapqmqEKv8Nb8KfQDO4vXycRERERERERERAS8aEJZfjb+KsRqASuz8xBgLQs0G/PERkktcSsK3ANQ0NPqOYOjAdUn",
    "iHoW31cRFAt9LPvK0phWSss0l+cOsGeHVOkukB+x3uPBIIaAJcmMBIBBYC6j0hhiAOGeXf6fz8Ci5e0RxF1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F",
    "1EcRHERxDgiDN03TdN03TdFyiZTdN0XKLlEyiZTdFym6bpum6bpum6bobhSI4iOJukJZfxs5jOYzmM5jOYzmM5jOYzmM5jOYzmM5jOYzmM5jOYzmM5jOYzmM",
    "5jOYzmM5jOYzmM5jOYzmM5jOYzmM5jOYzmM5jOYzmM5jOYzmM5jOYzmM5jOYzmM5jOYzmM5/+c//2gAMAwEAAgADAAAAEPefdffffffffffffffffffffe/f",
    "fdvfSav68ffffffffffffffffffbowEpffbPfeffffffffffffffffffffffffffb3p3jyy2s7jpj4+/fffffffffffffffceefcdYVdddffdfdefecfdcde",
    "efffYTcVffffffffffffffffffffffffffa+MMMMMMMMMNPPPPPPPPPPPPPPPE/fVIgTTTQQQQQQPtPMPMMNvvvvvvvvPfVAoQYcQQQQQQPufnvvnnvvvvvv",
    "vvPfVAjzzzzzzzywPvbIAGMMNPvvvvvvPfVArqq6gggglwPjuMMMMNPvvvvvvvPfVArwwQQQQQQQPvetlkNvvvvvvvvvPfVArhiggggglgPrbPLDHvvvvvvv",
    "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",
    "GiUWFbf0eI4XFourd+7f+3EvAbst98t98t98t98t98t98t98t98t98t98t98t98t98t98t98t98t98t98t98t98t98t98t98t98t98t98t98t98t98t98t98",
    "t98t98t98t98t98t98t98t98t98t98t98t98t98t98t98t98t98t98t98t98t98EvANn8iA6LmLbb6DkOVOVOVOVOVOVOVOVOVOVOVOVOVOVOVOVOVOVNbju",
    "f6AabNYSBpr+PydvR3YZR2f+sW23Lu/w28rWq0YAR0B2H/Qa/Y9vx+Tt6e0930EKUsZKGShkesGT7MQC0WAMVdudiWRQm8VXeNipd4MF6BwXkhXWkS8j4dgo",
    "FHZluqViEWaB6lSnpAMWGSqcsXINf3DBWY5ZVIUjsn+P4XL635HQU4vPoJfmMTRPQL6B0v8AuS+orKoa1wvL0i7aN41VUvq1rozoBFMEFGTQg2JJIX9DeG7k",
    "j/OiGrIV4q+l6kNRZZWqHbJp3reUHVBpqhuqg6ZKhUXG4C90m17EozpCoIKTmr1ISQqbKoTJSBtNUf3N0RqGHqdHj+Dr9j2/H5O3p7T3fTDLetArH9eJj1IQ",
    "kAgQ9FNehFVs0li7N9FhfUN4RSJcVtZm0oAdS4ONQm0Eptz/AFBRnarNSud4l74iN2o1yJ013nS9eyGtcKjK6bRFqRSQgAzo6f4/hcvqE2A6XeZgq1VWvSBJ",
    "aNtpuB4bTLHbaamWdc6y9Tdgts95/aArLKtY0zFgFAbLdJkHIaN6QEKNBEJnvMdbRbbcv8HX7Ht+PydvT2nu/wAX4XL6m2YN2azk3P5mv2Pb8fk7entPd9BA",
    "gANdarTbTXmFxoKoaDdfNZmAW4tdD+oCNDgXBVUH9/wPhcvq6QDVSzUuHeK3TS+IKWMOSlaIlSG2i1cVzdO8B5aEU4G+1JnmaNMKZzqg70Zk3y6oYAVXoYEt",
    "a6LscM5c4MvEScrRsw5o/pmMSMbBg2Y5EgkXKGtNqu9NcTD3AESqVbvpbxFJw16GnP2EdCMyzaBROhY9pU0hgZyNdjTXaZ8gW4lJobzo/wA2v2Pb8fk7entP",
    "d9AK0lG0o2lG0o2lG0o2lG0o2lG0o2lG0o2lG0o2lG0o2hpPT4XL66qqKZXFBpxNkyQEVB6QLp/tjWrip5L7rBwqAABoqi66UeJRoAtUXLAcVWaPEVRQBQNM",
    "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"
  ].join(""),
  "guide-04-update.jpg": [
    "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",
    "CqAntDMozjahxcM2APEPAUL5QFDJ9cyzBGsi6ZTWcJFYHj6GBRcziI6iOojqI6iOojqI6iOojqI6iOojqI6iOojqI6iOojqI6iOojqI6iOojqI6iOojqI6iO",
    "ojqI6iOojqI6iOojqI6iOojqI6iOojqI6iOojqI6iOojqI6iOojqI6nmoSy/xs7jO4zuM7jO4zuM7jO4zuM7jO4zuM7jO4zuM7jO4zuM7jO4zuM7jO4zuM7j",
    "O4zuM7jO4zuM7jO4zuM7jO4zuM7jO4zuM7jO4zuM7jO4zuM7jO4zuM7jO4zuM79gg4CPMzWrNQAnA/CD4J8ekgRwCYQRkH2bkzziEgASCAcewiPr+rC6gEBj",
    "AhR49XPSiCWFn/CVgyckXCJyKhawLGIrnAm8RmKUQa8KHEE0QuGICBZZODBnBJti4BrgAEAgBWHJLhJIkVgUKhErgWJ8LU5wAt1E14UCGImVlidgKuYRZC9v",
    "pRgcUrjNeoQJVRBqAGkDw6gSIZOYQKrymKACMUJilSg/1ghqnlv/AOW//9oADAMBAAIAAwAAABD3n3X33333333333333333333v333b30mr+vH333333333",
    "3333333326ECAb32z3333n33333333333X333333333332/p7bFd7/v+OPm76s+4/wB99999999999x9xx5111d551559xF915919519999JF1RZ99999999",
    "99999999999999999r88888888888888888888888888T99UONMAIMMMMMY++++gNFNFNc++++899UR5U0c4wwwws++++HgcMgs8++++899U1+mKm88888o+",
    "+++TYAoog8++++899Umescs88888s++++XEIkEQ8++++899UduuW40++++o++++XYAUow8++++899Ua+48888888Q++++Dw84U48++++899UdhMMwkYwwwg+",
    "+++6UsIAQe++++899SyyyyyyyyyyyyyyyxAySACyyyyyw998EJNMIJJNNEBJNBNNNNNNNNNNNN999Os8MN/8d88NcsNcNf8Affffffffffff/8QAIREAAwAC",
    "AgICAwAAAAAAAAAAAAEREDAgYUBBITFgcZH/2gAIAQMBAT8QEzs9eO3CCCBNPLrX9/Q/vxkq4Of55SlKUpSlKUpSlKUpSlKUpS8GJUam+EIQnJZYnBu7lrWW",
    "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",
    "WKiqSLr5XHbZAFvYwf7QS8B3Zb55b55b55b55b55b55b55b55b55b55b55b55b55b55b55b55b55b55b55b55b55b55b55b55b55b55b55b55b55b55b55b5",
    "5b55b55b55b55b55b55b55b55b55b55b55b55b55b55b55b55b55b55b55b54JeAdn6iA6LmLbb/ALUabNYSBpr9PueP41mO/KY/smP7Jj+yY/smP7Jj+yY/",
    "smP7Jj+yY/smP7Jj+yY/smP7Jj+yY/smP7Jj+yV2R8P26ezxLdniW7PEt2eJbs8S3Z4luzxLdniW7PEt2eJbs8fc1/B+vp9zx/H52Aeh0I6FHQR4Z7zGYQ0S",
    "sU16O/Su8cQCmtNrNWVbzFZwLsGlOpWiZLqL4ZIH0sAs1XLxTHQ3VJ7u+5AcBgNCmsnf7d1kmp9qxHGJbdHXzAgjCWJrgCADLvVhDCpCpaW60IMYbQLV7ay+",
    "DaUANWnREhDtSRrqrPSVGwkB7La6enmPYcM0Fj3Z/gS4dE1S4xrPYNvt6/g/X0+54/jT8w9akjkdgRvUAu3xFtXvHTIKoBaJrgxpDgYWUKvOeV9ZV+zbWYo7",
    "XtBWz2jyCHhfzFQbnLBCumlf8mcgRSOaW23xNVIpr7ep9vIp12sq28zrLjE1SEEnTDIbbFxCbsmbo/A9Y9QAdZWutmdOkbeLh1F51oDiaCgqaKi84rtEdvex",
    "AawdQQJQCK0nv/aPZNvt6/g/X0+54/jpTpNyFNVTcjPed6xgrFApQBVVeIsUzXFY+0KXbXrnWKNqM3I3I3I3I3I3I3I3I3IAby+ftv6dMDCtfSNAvs2Bpqx6",
    "fViDrhmc4RCGVHWh0jaVhlKUhpe5qUrl9QrpqiJ41kVdBqYdDEVPhRUryqwm0bi9StoUGtYYhqVleTvNEoKhVdPBPZNvt6/g/X0+54/hatLtfpD7sTYm5+I4",
    "Vq4MNXXGZsOY8sX2MINsAbjRaOYm04eyTe/E3vxN78Te/E3vxN78Te/E3vxN78Te/EH1yeIlNfatxUInYJXcuolBsGNdYgKwSeAX0rEASfToPTXTWXvSUm6W",
    "PUXNRYjoWYHvcX7INJhQbwDXowp+s8VYejmBDq1GtYD111hfbW3DlUVo3iMVKWy7Ly6z2Tb7ev4P19PueP40/MI6WXOa/M0o5vNvWlzXmNW1pHWfhYUUS+tC",
    "Y8pFyoWhLMBxhM+qwJXVtGHIc2qTwR90enkJWmjd9aiA5QQKMd++mL0cwK7gIqoq2CIALFKv7ep9oOxvZknQ76esyxytkwENtTzBI6WsUl01sx7gHCLRyvtB",
    "SWduDAQ1qz1Y3bRqhq8zqc+JZthgoaO9d4ABGqgrONswGMLRXVRzWpr2gSUvhS6J0tCvKtBrnGTaeybfb1/B+vp9zx/CYOsSYMdoXWBtN5GKssZEdpqR625d",
    "+i7fWOuQ0Xx75i+BWVh46RbVpot3TdsFVzAWGm9ZWgBNVi9NeJvJvJvJvJvJvJvJvJvIPqURbb+1VbwpFKy+k1UjE4ABMIExEAqFXJTvtMGwRoNc46Uut6m+",
    "Uk79iC8dgDth3GKqHguFwY4NFOk0wloq+ufHfEtKD1s741jozgSDQOmmhAzcy0ZrDc9k2+3r+D9fT7nj+OluCeTiewT2CewT2CewT2CewT2CewT2CewT2Cew",
    "T2CewT2CewT2CCmhTz9tMUXqXSs+aiWRnnoUFX4zLSLx0cVVSBWNpVp5eNFs3YJ1CDqPQtnViUppVUxqs6K/Ma00XsMb5DEttTrAlANL8SmPW12/CQyAYkSu",
    "4U/aAzILEOW3ObX1nsm329fwfr6fc8fxp+YVFVrhekQ62sqI6OQlN1i9MzEDQ7MzVY0y6diFU8VLalkaAdHTWUa3gesns02DS9YaF6197U+1TGhV+lY65qB1",
    "xrD82DNIXW0EbsclQsFYpi3sSEE7la20xFKQKVV1QTXOsshh6g5r9eC4tWlolbnUMK5jci0a0aLzR2zGVyQoELo6QaRm0AQF6Wr6yihdiKK1vpPZNvt6/g/X",
    "0+54/j8bMIVKbE6SyqqhoAPTH8OQhYhh5thSOhdlJ0xBzLiwZwzXqfmMBiFp7/z4gM9xYFNYNTr4mnXD2LK/8fVg4uWVWnfH2tZqfaqcEFxaMnrAIkG0aTGG",
    "AlV1hRrmPuo5VSmRCrqFsU97yA01hBeqUqoVVO2DrKi3Xm5Yg0SkzcarEMwyoOt6Qyglls9nWV4J4Nji8hf9Q0SSOK9hnsm329fwfr6fc8fwTw8Tw8Tw8Tw8",
    "Tw8Tw8Tw8Tw8Tw8Tw8Tw8Tw8Tw8Tw8Tw8Tw8Tw8Tw8Tw8SkzQ3r7mQ5vzsXnEpGSOku0X/amBWgKWLWWa3Sdqo3Kp00zERkg9AadcekrBMZLjrLWjqwh5Cik",
    "W1uDTO8vJatgxNR1suGJongQVVbGqxpiAcAZgApXf/2eybfb1/B+vp9zx/CrHq1NQ4g8nnsxwRNkiwKsOX8Sr/RQOGs1rQgXv98VWRwv2rmEdNlU9fEGBgUB",
    "plRGB4v1jDRg6w9zQ2gQ02SHQsNCfG/8RQpWiC98Qt+Eo929ds9m/wDkZVlDNdjiA1IMUGgvWeybfb1/B+vp9zx/Gn5gigFdlWXpK203IFFY2jld4i+iqhy6",
    "rrXfWKH+jLAeNf8Agg1UlLNzGfyczpUWlulkauFC4zBVZYqGjJBQcD4nUpi8odLlwVtW9+34+zqfaTwoAWVwEZBoVULoFuuoJr2goGBGRWgmPFpcQ9XaxdXa",
    "oYrqWQsEILqWaGsj+4ODFrI6GTiMQaiiN0x4RHcmG39G01ClUrKRDl9/NJOCgseIFb1IAsLPd65xZcHVVpXa8O+Iqtrb9vX8H6+n3PH8YSmFGyr4luo9JXs4",
    "mZcjq1OCrB0lWGZoHCuz8ssgTtUXFSopdMzrVWyl2xlRtlZL96S2pZ1xd+6jFcwHpK9nEr2cSvZxK9nEr2cSvZxK9nECOW9qjl+0kEQNidJUchB2UtaxeGfM",
    "1ieA2xS+DtELnkkjV+uNYDbJVRHq7Xmt3vDwvKgooQPQULIsL/qC1DOyqeYSI4TiJaO6vMte+CD1prq5d17wSDK1FJAWrQ4/qNqGFrRRffz9zX8H6+n3PH+h",
    "NWBoDK9b106bQ1F+NF9eusUqEtidelZnRKvPVz5lChtNtuGsVnv3jDWa66V+dbmjrC/Bnr3ilwmcFvjr7qB6w8hdZidNgwWdLdc5xGACW1Xi8dfua/g/X01I",
    "6MCl5n6m44m44m44m44m44m44m44m44m44m44m44m44m44m44m44m44m44m44m44m44m44m44m44m44m44m44m44m44m44m44m44m44m44m44m44m44m44m4",
    "4m44m44m44m44m44m44m44m44m44m44m44m44m44m44iUXg7su9F/UNaYm45m45m45m45m45m45m45m45m45m45m45m45m45m45m45m45m45m45m45m45m45",
    "m45m45m45m45m45m45m45m45m45m45m45m45m45m45m45m45m45m45m45m45m45m45m45m45m45m45m45m45m45m45m45irq39QKgFr0I9SPYVBcHoNFgdFl",
    "JY3dUa1r/Fnf+XacOg2JINjoWz+IlWUDBee0EsBdZOvaXvLO5/F7y95e8MtGX+BUFBYE0d5kwgkQfEveXvPWWd/5veILRDH50/z2FuyFqeYM6LBnV101mCrU",
    "AUCl2b9KhOyBsQQfDSv1B2BkICgxjx36sVbttBCsrrXg9IaEIUwKRvtcIMUgrarvTLMpVqClrWaz3makTaxtu6l99yqi3b2vOGsQS21i4YCqrbXvBhaKQoGn",
    "XS4LioqRNovTb8xzQulGq30z3hQK4MgqgrpsvrHbgYMCg1DHWjxW8Qrr1b1WVe25xFUqGKg3jrWtWesCwFMRnfT93qxwE6FoTXbTaJ0eNDAK0/XaUADVHZHU",
    "016+ZcXbSFfduA3EqupTVV02iCuBkBbWWjMyrKxdaErTTP4jmIy30psxXbEwAatbLcVrUSXcaZumqvTXeE69DVbY0lAKNkUsVVLX5lR16y9WuK/+W//Z"
  ].join("")
};

async function setupTelegramBot(env) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    return { ok: false, error: "TELEGRAM_BOT_TOKEN no configurado" };
  }

  const calls = [
    ["setMyCommands", {
      commands: [
        { command: "instalar", description: "Instalar FÉNIX TV en una LG" },
        { command: "guia", description: "Guía visual paso a paso" },
        { command: "actualizar", description: "Instalar la última versión" },
        { command: "estado", description: "Ver versión publicada y estado" },
        { command: "ayuda", description: "Ayuda y errores frecuentes" }
      ]
    }],
    ["setMyDescription", {
      description: "Instala y actualiza FÉNIX TV en televisores LG webOS con una guía visual paso a paso y FÉNIX Bridge."
    }],
    ["setMyShortDescription", {
      short_description: "Instalador y actualizador oficial de FÉNIX TV para LG webOS."
    }],
    ["setChatMenuButton", {
      menu_button: { type: "commands" }
    }]
  ];

  const details = [];
  let ok = true;
  for (const [method, body] of calls) {
    const r = await tg(env, method, body);
    let data = null;
    try { data = await r.json(); } catch {}
    details.push({ method, status: r.status, ok: !!data?.ok, response: data });
    if (!r.ok || !data?.ok) ok = false;
  }

  return { ok, message: ok ? "Bot configurado correctamente" : "Uno o más ajustes fallaron", details };
}

function guideAssetResponse(path) {
  const name = decodeURIComponent(path.slice("/guide/".length));
  const b64 = GUIDE_ASSETS[name];
  if (!b64) return new Response("Imagen no encontrada", { status: 404 });
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new Response(bytes, {
    headers: {
      "content-type": "image/jpeg",
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff"
    }
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatBytes(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

async function readLatest(env) {
  const obj = await env.RELEASES.get("latest.json");
  if (!obj) return null;

  try {
    return JSON.parse(await obj.text());
  } catch {
    return null;
  }
}

function isAdmin(request, env) {
  const token =
    request.headers.get("x-admin-token") ||
    (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");

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
    if (!p || !sig || !secret) {
      return { ok: false, error: "token_invalid" };
    }

    const expected = await hmac(p, secret);
    if (!timingSafe(sig, expected)) {
      return { ok: false, error: "token_invalid" };
    }

    const payload = new TextDecoder().decode(b64urlDecode(p));
    const [chatId, exp] = payload.split("|");

    if (!chatId || Number(exp) < Math.floor(Date.now() / 1000)) {
      return { ok: false, error: "token_expired" };
    }

    return { ok: true, chatId };
  } catch {
    return { ok: false, error: "token_invalid" };
  }
}

async function hmac(data, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  return b64url(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(data)
      )
    )
  );
}

function timingSafe(a, b) {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) {
    x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return x === 0;
}

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const raw = atob(s);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

function hex(buf) {
  return [...new Uint8Array(buf)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "Content-Type",
    "access-control-max-age": "86400"
  };
}

function json(v, status = 200) {
  return new Response(JSON.stringify(v, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function publicJson(v, status = 200) {
  return new Response(JSON.stringify(v, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders()
    }
  });
}

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
    <a class="btn alt" href="/installer.apk?v=6">INSTALAR / ACTUALIZAR BRIDGE</a>
  </div>
</div>
</body>
</html>`, {
    headers: installerHeaders("browser-v6")
  });
}

function bridgeLanding(url, env) {
  const token = url.searchParams.get("t") || "";
  const base = env.PUBLIC_BASE_URL || `${url.protocol}//${url.host}`;
  const safeToken = JSON.stringify(token);
  const safeBase = JSON.stringify(base);

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

    <button id="go" onclick="startInstall()">INSTALAR / ACTUALIZAR FÉNIX TV</button>

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
  setStatus(
    TOKEN
      ? 'Bridge conectado. Listo para comenzar.'
      : 'Bridge conectado. Vuelve al bot de Telegram y pulsa INSTALAR FÉNIX TV para autorizar la sesión.',
    TOKEN ? 'ok' : ''
  );
};

window.fenixNativeProgress=function(stage,msg,percent){
  pct(percent||0);
  setStatus((stage?stage+'\\n':'')+(msg||''));
};

window.fenixNativeDone=function(ok,msg){
  pct(ok?100:0);
  setStatus(
    msg || (ok?'Instalación completada.':'No se pudo completar.'),
    ok?'ok':'err'
  );
  document.getElementById('go').disabled=false;
};

function startInstall(){
  const ip=document.getElementById('ip').value.trim();
  const pass=document.getElementById('pass').value.trim();

  if(!TOKEN){
    setStatus(
      'Sesión no autorizada. Vuelve al bot de Telegram, escribe /start y abre el instalador desde ese botón.',
      'err'
    );
    return;
  }

  if(!window.FenixBridge || typeof window.FenixBridge.install !== 'function'){
    setStatus(
      'El puente nativo no está disponible. Cierra esta pantalla y ábrela desde la aplicación FÉNIX Bridge.',
      'err'
    );
    return;
  }

  if(!/^((10\\.)|(192\\.168\\.)|(172\\.(1[6-9]|2\\d|3[01])\\.))/.test(ip)){
    setStatus(
      'Escribe una IP privada válida, por ejemplo 192.168.1.86.',
      'err'
    );
    return;
  }

  if(pass.length < 4){
    setStatus(
      'Escribe la passphrase que muestra Developer Mode.',
      'err'
    );
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
    headers: installerHeaders("bridge-v6")
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
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FÉNIX Installer Admin</title>
<style>
body{font:15px system-ui;background:#080a10;color:#fff;margin:0;padding:20px}
.c{max-width:720px;margin:auto}
.card{background:#121725;border:1px solid #26324b;border-radius:18px;padding:20px;margin:15px 0}
input,button{box-sizing:border-box;width:100%;padding:13px;margin:7px 0;border-radius:10px;border:1px solid #34425f;background:#0d111b;color:#fff}
button{background:#7b2cff;border:0;font-weight:800}
pre{white-space:pre-wrap;color:#b9c4d8}
.okline{color:#8ce99a;font-size:13px;word-break:break-all}
</style>
</head>
<body>
<div class="c">
  <h1>FÉNIX Installer Control <small style="font-size:14px;color:#8ce99a">V8 EXPERIENCE</small></h1>

  <div class="card">
    <input id="tok" type="password" placeholder="ADMIN_TOKEN">
    <input id="ver" placeholder="Versión, ej. 1.2.16">
    <input id="ipk" type="file" accept=".ipk">
    <button onclick="up()">PUBLICAR IPK</button>
    <pre id="o"></pre>
  </div>

  <div class="card">
    <input id="apk" type="file" accept=".apk">
    <button onclick="upApk()">PUBLICAR FÉNIX INSTALLER APK</button>
  </div>

  <div class="card">
    <b>FÉNIX Experience Manager</b>
    <p style="color:#9ba8c2;line-height:1.5">Publica temporadas, mantenimiento, campañas, FÉNIX Now, Home dinámica y trailers sin generar otro IPK.</p>
    <input id="experience" type="file" accept=".json,application/json">
    <button onclick="upExperience()">PUBLICAR FENIX-EXPERIENCE.JSON</button>
    <div class="okline">${origin}/api/experience</div>
    <pre id="experienceOut"></pre>
  </div>

  <div class="card">
    <b>Endpoint público de actualización</b>
    <div class="okline">${origin}/api/latest</div>
    <button onclick="latest()">CONSULTAR ÚLTIMA VERSIÓN</button>
    <pre id="latestOut"></pre>
  </div>

  <div class="card">
    <b>Bot de Telegram</b>
    <p style="color:#9ba8c2;line-height:1.5">Configura automáticamente los comandos visibles del bot, descripción y menú. La guía visual ya viene integrada en este Worker.</p>
    <button onclick="setupBot()">CONFIGURAR BOT TELEGRAM</button>
    <pre id="botOut"></pre>
  </div>
</div>

<script>
const o=document.getElementById('o');
const latestOut=document.getElementById('latestOut');
const botOut=document.getElementById('botOut');
const experienceOut=document.getElementById('experienceOut');

async function up(){
  const file=ipk.files[0];
  const version=ver.value.trim();

  if(!file || !version){
    o.textContent='Selecciona el IPK y escribe la versión.';
    return;
  }

  let f=new FormData();
  f.append('version',version);
  f.append('ipk',file);

  o.textContent='Publicando…';
  let r=await fetch('/admin/upload',{
    method:'POST',
    headers:{'x-admin-token':tok.value},
    body:f
  });
  o.textContent=await r.text();
}

async function upApk(){
  const file=apk.files[0];
  if(!file){
    o.textContent='Selecciona el APK del Bridge.';
    return;
  }

  let f=new FormData();
  f.append('apk',file);

  o.textContent='Publicando Bridge…';
  let r=await fetch('/admin/upload-installer',{
    method:'POST',
    headers:{'x-admin-token':tok.value},
    body:f
  });
  o.textContent=await r.text();
}

async function upExperience(){
  const file=experience.files[0];
  if(!file){ experienceOut.textContent='Selecciona fenix-experience.json.'; return; }
  const f=new FormData(); f.append('experience',file);
  experienceOut.textContent='Publicando experiencia…';
  try{
    const r=await fetch('/admin/upload-experience',{method:'POST',headers:{'x-admin-token':tok.value},body:f});
    experienceOut.textContent=await r.text();
  }catch(e){ experienceOut.textContent='Error: '+e.message; }
}

async function latest(){
  latestOut.textContent='Consultando…';
  try{
    const r=await fetch('/api/latest',{cache:'no-store'});
    latestOut.textContent=await r.text();
  }catch(e){
    latestOut.textContent='Error: '+e.message;
  }
}

async function setupBot(){
  botOut.textContent='Configurando bot…';
  try{
    const r=await fetch('/admin/setup-bot',{
      method:'POST',
      headers:{'x-admin-token':tok.value}
    });
    botOut.textContent=await r.text();
  }catch(e){
    botOut.textContent='Error: '+e.message;
  }
}
</script>
</body>
</html>`;
}
