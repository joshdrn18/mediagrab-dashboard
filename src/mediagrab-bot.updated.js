
const MAX_BYTES = 15 * 1024 * 1024;
const WINDOW_SECONDS = 600;
const MAX_REQUESTS = 5;

const TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "image/avif", "video/mp4", "video/webm",
  "video/quicktime", "audio/mpeg", "audio/mp4",
  "audio/aac", "audio/ogg", "audio/wav", "audio/webm"
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("MediaGrab Bot is running.");
    }

    if (url.pathname !== `/webhook/${env.WEBHOOK_SECRET}`) {
      return new Response("Not found", { status: 404 });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad JSON", { status: 400 });
    }

    try {
      await handleUpdate(update, env);
    } catch (error) {
      console.error("Update failed:", String(error));
    }

    return new Response("OK");
  }
};

async function handleUpdate(update, env) {
  const msg = update.message;
  if (!msg?.chat?.id) return;

  const chatId = msg.chat.id;
  const userId = String(msg.from?.id || chatId);
  const username = String(msg.from?.username || "").slice(0, 64);
  const text = (msg.text || msg.caption || "").trim();

  if (text === "/start" || text === "/help") {
    return sendMessage(env, chatId,
      "👋 Welcome to MediaGrab!\n\n" +
      "Send a public image, video, or audio link. " +
      "I'll try to download and return it as a file.\n\n" +
      "Limit: 5 requests per 10 minutes, 15 MB per file.\n" +
      "Some social websites may not be supported.");
  }

  if (text === "/about") {
    return sendMessage(env, chatId,
      "MediaGrab — public media link downloader.\n" +
      "Only download content you have permission to save.");
  }

  const match = text.match(/https?:\/\/[^\s<>()]+/i);
  if (!match) {
    return sendMessage(env, chatId,
      "Send a valid HTTP/HTTPS media URL. Use /help for details.");
  }

  if (!await allowed(env, userId)) {
    return sendMessage(env, chatId,
      "⏳ Limit reached. Please try again in a few minutes.");
  }


  const source = match[0].replace(/[.,!?]+$/, "");
  let mediaType = "unknown";
  let sourceHost = "unknown";
  let sourceUrl = sanitizeSourceUrl(source);
  let filename = "";
  let sizeBytes = null;

  try {
    sourceHost = new URL(source).hostname;

    await sendAction(env, chatId, "upload_document");
    const media = await resolveMedia(source);

    if (!media) {
      throw new Error("No supported media found on this link.");
    }

    mediaType = media.type;

    filename = `mediagrab-${Date.now()}.${extension(media.type)}`;
    sizeBytes = media.bytes.byteLength;
    const form = new FormData();

    form.set("chat_id", String(chatId));
    form.set(
      "caption",
      `✅ Download ready\nSource: ${sourceHost}`
    );
    form.set(
      "document",
      new File([media.bytes], filename, { type: media.type })
    );

    const result = await telegram(env, "sendDocument", form);
    if (!result.ok) {
      throw new Error(result.description || "Telegram send failed.");
    }

    await recordDownload(
      env, userId, username, sourceHost, sourceUrl, filename, sizeBytes,
      mediaType, "success", "Download completed"
    );
  } catch (error) {
    await recordDownload(
      env, userId, username, sourceHost, sourceUrl, filename, sizeBytes,
      mediaType, "failed", cleanError(error)
    );

    await sendMessage(
      env,
      chatId,
      `❌ Download failed: ${cleanError(error)}\n\n` +
        "Try a direct public media link. Login-protected pages, " +
        "anti-bot pages, and segmented streams may not work."
    );
  }
}



async function recordDownload(
  env, userId, username, sourceHost, sourceUrl, filename, sizeBytes,
  mediaType, status, details
) {
  try {
    await env.DB.prepare(`
      INSERT INTO download_events
        (telegram_user_id, telegram_username, source_host, source_url,
         filename, size_bytes, media_type, status, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      String(userId),
      String(username || "").slice(0, 64) || null,
      String(sourceHost).slice(0, 253),
      String(sourceUrl || "").slice(0, 2000) || null,
      String(filename || "").slice(0, 255) || null,
      Number.isFinite(Number(sizeBytes)) ? Number(sizeBytes) : null,
      String(mediaType).slice(0, 100),
      status === "success" ? "success" : "failed",
      String(details).slice(0, 250)
    ).run();
  } catch (error) {
    // Statistik gagal dicatat tidak boleh mematikan bot.
    console.error("Failed to record download event:", String(error));
  }
}

function sanitizeSourceUrl(raw) {
  try {
    const url = new URL(raw);
    // Preserve the URL path but remove common credentials/signatures from query strings.
    const sensitive = /token|secret|password|passwd|api.?key|authorization|signature|(^|_)sig($|_)|credential|auth/i;
    for (const key of [...url.searchParams.keys()]) {
      if (sensitive.test(key) || /^x-amz-/i.test(key) || /^x-goog-/i.test(key)) {
        url.searchParams.set(key, "[REDACTED]");
      }
    }
    if (url.username) url.username = "[REDACTED]";
    if (url.password) url.password = "[REDACTED]";
    return url.href.slice(0, 2000);
  } catch {
    return "";
  }
}


async function allowed(env, userId) {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - WINDOW_SECONDS;
  try {
    await env.DB.prepare("DELETE FROM rate_limits WHERE created_at <= ?").bind(cutoff).run();
    const result = await env.DB.prepare(`
      SELECT COUNT(*) AS total FROM rate_limits
      WHERE user_id = ? AND created_at > ?
    `).bind(String(userId), cutoff).first();
    if ((result?.total ?? 0) >= MAX_REQUESTS) return false;
    await env.DB.prepare(`INSERT INTO rate_limits (user_id, created_at) VALUES (?, ?)`)
      .bind(String(userId), now).run();
    return true;
  } catch (error) {
    console.error("Rate limit check failed:", String(error));
    throw error;
  }
}


async function resolveMedia(input) {
  let current = await safeUrl(input);

  for (let i = 0; i < 4; i++) {
    const response = await fetch(current, {
      redirect: "manual",
      headers: {
        "User-Agent": "MediaGrabBot/1.0",
        "Accept": "image/*,video/*,audio/*,text/html,*/*;q=0.2"
      }
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Invalid redirect.");
      current = await safeUrl(new URL(location, current).href);
      continue;
    }

    if (!response.ok) {
      throw new Error(`Source returned HTTP ${response.status}.`);
    }

    const type = (response.headers.get("content-type") || "")
      .split(";")[0].trim().toLowerCase();

    if (TYPES.has(type)) {
      return { type, bytes: await readLimited(response, MAX_BYTES) };
    }

    if (type === "text/html" || type === "application/xhtml+xml") {
      const htmlBytes = await readLimited(response, 1024 * 1024);
      const html = new TextDecoder().decode(htmlBytes);
      const candidate = extractMetadataUrl(html, current);

      if (!candidate) return null;

      // Revalidate the extracted URL and its redirects.
      return resolveDirect(candidate);
    }

    // Conservative fallback for servers with a missing/wrong MIME type.
    const guessed = typeFromExtension(
      new URL(current).pathname.split(".").pop().toLowerCase()
    );

    if (guessed && TYPES.has(guessed)) {
      return { type: guessed, bytes: await readLimited(response, MAX_BYTES) };
    }

    return null;
  }

  throw new Error("Too many redirects.");
}

async function resolveDirect(input) {
  let current = await safeUrl(input);

  for (let i = 0; i < 4; i++) {
    const response = await fetch(current, {
      redirect: "manual",
      headers: {
        "User-Agent": "MediaGrabBot/1.0",
        "Accept": "image/*,video/*,audio/*,*/*;q=0.2"
      }
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Invalid media redirect.");
      current = await safeUrl(new URL(location, current).href);
      continue;
    }

    if (!response.ok) {
      throw new Error(`Media returned HTTP ${response.status}.`);
    }

    let type = (response.headers.get("content-type") || "")
      .split(";")[0].trim().toLowerCase();

    if (!TYPES.has(type)) {
      type = typeFromExtension(
        new URL(current).pathname.split(".").pop().toLowerCase()
      );
    }

    if (!type || !TYPES.has(type)) {
      throw new Error("Unsupported media format.");
    }

    return { type, bytes: await readLimited(response, MAX_BYTES) };
  }

  throw new Error("Too many media redirects.");
}

async function safeUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid URL.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP/HTTPS URLs are allowed.");
  }

  if (url.username || url.password) {
    throw new Error("URLs containing credentials are blocked.");
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  // Basic hostname/IP filtering. Not a complete DNS-rebinding defense.
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "metadata.google.internal" ||
    host === "169.254.169.254" ||
    /^(127\.|10\.|192\.168\.|0\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
    host === "::1" ||
    /^(fc|fd|fe80:)/i.test(host)
  ) {
    throw new Error("Private or local network addresses are blocked.");
  }

  return url.href;
}

function extractMetadataUrl(html, base) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  const wanted = [
    "og:video:secure_url", "og:video", "og:video:url",
    "og:audio", "og:image:secure_url", "og:image",
    "twitter:player:stream", "twitter:image"
  ];

  for (const tag of tags) {
    const key = getAttr(tag, "property") || getAttr(tag, "name");
    const content = getAttr(tag, "content");

    if (key && content && wanted.includes(key.toLowerCase())) {
      try {
        return new URL(decodeEntities(content), base).href;
      } catch {}
    }
  }

  // Simple fallback: first usable media src in the HTML.
  const match = html.match(
    /<(?:video|audio|source|img)\b[^>]*\bsrc\s*=\s*(['"])(.*?)\1/i
  );

  if (match?.[2]) {
    try {
      return new URL(decodeEntities(match[2]), base).href;
    } catch {}
  }

  return null;
}

function getAttr(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(
    new RegExp("\\b" + escaped + "\\s*=\\s*(['\"])(.*?)\\1", "i")
  );
  return match?.[2] || null;
}

function decodeEntities(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/gi, "/")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function readLimited(response, limit) {
  const length = Number(response.headers.get("content-length") || 0);

  if (length > limit) {
    throw new Error(`File exceeds ${limit / 1024 / 1024} MB.`);
  }

  if (!response.body) throw new Error("Empty response body.");

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    total += value.byteLength;

    if (total > limit) {
      await reader.cancel();
      throw new Error(`File exceeds ${limit / 1024 / 1024} MB.`);
    }

    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

async function telegram(env, method, body) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    { method: "POST", body }
  );

  return response.json();
}

async function sendMessage(env, chatId, text) {
  const body = new FormData();
  body.set("chat_id", String(chatId));
  body.set("text", text);
  return telegram(env, "sendMessage", body);
}

async function sendAction(env, chatId, action) {
  const body = new FormData();
  body.set("chat_id", String(chatId));
  body.set("action", action);
  return telegram(env, "sendChatAction", body);
}

function typeFromExtension(ext) {
  return ({
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    webp: "image/webp", gif: "image/gif", avif: "image/avif",
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
    mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac",
    ogg: "audio/ogg", wav: "audio/wav"
  })[ext] || null;
}

function extension(type) {
  return ({
    "image/jpeg": "jpg", "image/png": "png",
    "image/webp": "webp", "image/gif": "gif",
    "image/avif": "avif", "video/mp4": "mp4",
    "video/webm": "webm", "video/quicktime": "mov",
    "audio/mpeg": "mp3", "audio/mp4": "m4a",
    "audio/aac": "aac", "audio/ogg": "ogg",
    "audio/wav": "wav", "audio/webm": "webm"
  })[type] || "bin";
}

function cleanError(error) {
  return String(error?.message || error)
    .replace(/[<>]/g, "")
    .slice(0, 250);
}
