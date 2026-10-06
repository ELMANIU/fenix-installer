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
