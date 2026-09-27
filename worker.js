const HF = "https://zerogpu-aoti-wan2-2-fp8da-aoti-faster.hf.space";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/") {
        return json({ ok: true, service: "DIZA Imagine Wan Relay v2", mode: "polling", hf_auth: Boolean(env.HF_TOKEN) });
      }
      if (!env.HF_TOKEN) return json({ error: "HF_TOKEN secret missing" }, 500);

      if (request.method === "POST" && url.pathname === "/upload") {
        const incoming = await request.formData();
        const image = incoming.get("image") || incoming.get("files");
        if (!image) return json({ error: "image missing" }, 400);
        const form = new FormData();
        form.append("files", image, image.name || "input.png");
        const r = await fetch(HF + "/gradio_api/upload", {
          method: "POST",
          headers: { Authorization: `Bearer ${env.HF_TOKEN}` },
          body: form
        });
        return proxyText(r);
      }

      if (request.method === "POST" && url.pathname === "/generate") {
        const body = await request.text();
        const r = await fetch(HF + "/gradio_api/call/generate_video", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.HF_TOKEN}` },
          body
        });
        return proxyText(r);
      }

      if (request.method === "GET" && url.pathname.startsWith("/poll/")) {
        const eventId = url.pathname.slice("/poll/".length);
        if (!eventId) return json({ error: "event id missing" }, 400);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
          const r = await fetch(HF + "/gradio_api/call/generate_video/" + encodeURIComponent(eventId), {
            headers: { Authorization: `Bearer ${env.HF_TOKEN}`, Accept: "text/event-stream" },
            signal: controller.signal
          });
          if (!r.ok) {
            const t = await r.text();
            clearTimeout(timer);
            return json({ status: "network_retry", event_id: eventId, http_status: r.status, error: t.slice(0,500) });
          }
          const reader = r.body.getReader();
          const decoder = new TextDecoder();
          let raw = "", status = "queue", result = null;
          const deadline = Date.now() + 6500;

          while (Date.now() < deadline) {
            const chunk = await Promise.race([
              reader.read(),
              new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 1000))
            ]);
            if (chunk.timeout) continue;
            if (chunk.done) break;
            raw += decoder.decode(chunk.value, { stream: true });
            if (/event:\s*(generating|progress)/.test(raw)) status = "generating";
            if (/event:\s*complete/.test(raw)) {
              const matches = [...raw.matchAll(/event:\s*complete\s*\ndata:\s*(.+)/g)];
              if (matches.length) {
                const v = matches[matches.length - 1][1];
                try { result = JSON.parse(v); } catch { result = v; }
              }
              status = "complete";
              break;
            }
            if (/event:\s*error/.test(raw)) { status = "error"; break; }
          }
          try { await reader.cancel(); } catch {}
          clearTimeout(timer);
          return json({ status, event_id: eventId, result, raw: raw.slice(-1500) });
        } catch (e) {
          clearTimeout(timer);
          if (e?.name === "AbortError" || String(e).includes("aborted")) return json({ status: "queue", event_id: eventId });
          return json({ status: "network_retry", event_id: eventId, error: String(e?.message || e) });
        }
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e?.message || e) }, 500);
    }
  }
};

async function proxyText(r) {
  const body = await r.text();
  return new Response(body, {
    status: r.status,
    headers: { ...cors, "Content-Type": r.headers.get("content-type") || "application/json", "Cache-Control": "no-store" }
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
