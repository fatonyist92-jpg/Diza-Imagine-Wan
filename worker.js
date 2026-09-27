const APP_HTML = "<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Diza Imagine</title><style>\n*{box-sizing:border-box}body{margin:0;background:#070707;color:#f5f5f5;font-family:Inter,system-ui,sans-serif}main{max-width:760px;margin:auto;padding:28px 18px 60px}.brand{font-weight:750;font-size:20px;letter-spacing:-.4px;margin-bottom:28px}.panel{border:1px solid #242424;background:#0d0d0d;border-radius:18px;padding:16px}.drop{height:290px;border:1px dashed #383838;border-radius:14px;display:grid;place-items:center;overflow:hidden;background:#111;cursor:pointer}.drop img{width:100%;height:100%;object-fit:contain}.muted{color:#888;font-size:13px}textarea{width:100%;min-height:120px;margin-top:14px;background:#111;border:1px solid #2b2b2b;border-radius:14px;color:#fff;padding:14px;font:inherit;resize:vertical;outline:none}button{width:100%;height:52px;border:0;border-radius:14px;margin-top:12px;background:#fff;color:#050505;font-weight:750;font-size:15px;cursor:pointer}button:disabled{opacity:.45}.status{min-height:22px;margin:14px 2px 0;color:#aaa;font-size:13px}.progress{height:6px;background:#1d1d1d;border-radius:99px;overflow:hidden;margin-top:10px;display:none}.progress>i{display:block;height:100%;width:0;background:#fff;border-radius:99px;transition:width .35s ease}.progress.on{display:block}.result{margin-top:16px}.result video{width:100%;border-radius:14px;background:#000;max-height:70vh}.row{display:flex;justify-content:space-between;align-items:center;margin-top:10px}.pill{font-size:11px;color:#aaa;border:1px solid #292929;border-radius:99px;padding:5px 8px}\n</style></head><body><main><div class=\"brand\">DIZA IMAGINE <span class=\"pill\">WAN 2.2 · I2V</span></div><div class=\"panel\">\n<label class=\"drop\" id=\"drop\"><span id=\"hint\"><b>Upload image</b><br><span class=\"muted\">JPG / PNG / WEBP</span></span><img id=\"preview\" hidden></label><input id=\"file\" type=\"file\" accept=\"image/*\" hidden>\n<textarea id=\"prompt\" placeholder=\"Describe the motion...\"></textarea><button id=\"go\">Generate video</button><div class=\"progress\" id=\"progress\"><i id=\"bar\"></i></div><div class=\"status\" id=\"status\"></div><div class=\"result\" id=\"result\"></div>\n</div><div class=\"muted\" style=\"text-align:center;margin-top:12px\">VIDEO-URL-V11</div></main><script type=\"module\">\nconst file=document.querySelector('#file'),drop=document.querySelector('#drop'),preview=document.querySelector('#preview'),hint=document.querySelector('#hint'),go=document.querySelector('#go'),status=document.querySelector('#status'),result=document.querySelector('#result'),progress=document.querySelector('#progress'),bar=document.querySelector('#bar');\nconst prog=(n,t)=>{progress.classList.add('on');bar.style.width=Math.max(0,Math.min(100,n))+'%';status.textContent=n+'% · '+t};\ndrop.onclick=()=>file.click();\nfile.onchange=()=>{if(!file.files[0])return;preview.src=URL.createObjectURL(file.files[0]);preview.hidden=false;hint.hidden=true};\n\ngo.onclick=async()=>{\n const p=document.querySelector('#prompt').value.trim();\n if(!file.files[0]||!p){status.textContent='Upload image dan isi prompt dulu.';return}\n go.disabled=true;result.innerHTML='';prog(5,'Preparing image…');\n const relay=location.origin;\n const negative='色调艳丽, 过曝, 静态, 细节模糊不清, 字幕, 最差质量, 低质量, JPEG压缩残留, 畸形的, 静止不动的画面';\n try{\n   const fd=new FormData();fd.append('image',file.files[0]);\n   prog(12,'Authenticated upload…');\n   const uploadCtl=new AbortController();\n   const uploadTimer=setTimeout(()=>uploadCtl.abort(),30000);\n   let ur;\n   try{ur=await fetch(relay+'/upload',{method:'POST',body:fd,signal:uploadCtl.signal,cache:'no-store'});}\n   finally{clearTimeout(uploadTimer);}\n   if(!ur.ok)throw Error('upload HTTP '+ur.status+' '+(await ur.text()).slice(0,250));\n   const uj=await ur.json();\n   const raw=Array.isArray(uj)?uj[0]:(uj.files?.[0]||uj.path||uj);\n   const up=typeof raw==='string'?raw:(raw&&raw.path);\n   if(!up)throw Error('upload returned no file path: '+JSON.stringify(uj).slice(0,250));\n   const fileData={path:up,orig_name:file.files[0].name,meta:{_type:'gradio.FileData'}};\n\n   prog(35,'Joining Wan queue…');\n   const sessionHash=(crypto.randomUUID?crypto.randomUUID():Date.now()+'-'+Math.random().toString(36).slice(2));\n   const qbody={data:[\n     fileData,\n     p,\n     6,\n     negative,\n     5,\n     1,\n     1,\n     42,\n     true\n   ],fn_index:0,session_hash:sessionHash};\n   const qr=await fetch(relay+'/queue-join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(qbody)});\n   const qtxt=await qr.text();\n   if(!qr.ok)throw Error('queue join HTTP '+qr.status+' '+qtxt.slice(0,450));\n   let qj;try{qj=JSON.parse(qtxt)}catch{throw Error('invalid queue response: '+qtxt.slice(0,450))}\n   const eventId=qj.event_id;\n   if(!eventId)throw Error('queue returned no event_id: '+qtxt.slice(0,450));\n   prog(45,'Queued · waiting for Wan GPU…');\n   const payload=await new Promise((resolve,reject)=>{\n     const es=new EventSource(relay+'/queue-data?session_hash='+encodeURIComponent(sessionHash));\n     const timer=setTimeout(()=>{es.close();reject(Error('Wan queue timeout'));},12*60*1000);\n     es.onmessage=(ev)=>{\n       let m;try{m=JSON.parse(ev.data)}catch{return}\n       if(m.event_id&&m.event_id!==eventId)return;\n       if(m.msg==='estimation')prog(50,'Queue position '+((m.rank??0)+1)+'…');\n       else if(m.msg==='process_starts')prog(60,'Wan GPU processing…');\n       else if(m.msg==='progress')prog(70,'Wan GPU processing…');\n       else if(m.msg==='process_generating')prog(80,'Generating video…');\n       else if(m.msg==='process_completed'){\n         clearTimeout(timer);es.close();\n         if(m.success===false)return reject(Error('Wan provider failed: '+JSON.stringify(m.output||m).slice(0,450)));\n         resolve(m.output||m);\n       }else if(m.msg==='queue_full'||m.msg==='unexpected_error'){\n         clearTimeout(timer);es.close();reject(Error('Wan queue error: '+JSON.stringify(m).slice(0,450)));\n       }\n     };\n     es.onerror=()=>{clearTimeout(timer);es.close();reject(Error('Wan queue stream disconnected'));};\n   });\n   prog(90,'Finalizing MP4…');\n\n   let v=null;\n   const walk=o=>{if(v)return;if(o&&typeof o==='object'&&typeof o.url==='string'&&/\\.(mp4|webm)(\\?|$)/i.test(o.url))v=o.url;else if(typeof o==='string'&&/\\.(mp4|webm)(\\?|$)/i.test(o))v=o;else if(o&&typeof o==='object')Object.values(o).forEach(walk)};\n   walk(payload);\n   if(!v)throw Error('No MP4 URL returned: '+JSON.stringify(payload).slice(0,450));\n   if(v.startsWith('/tmp/gradio/'))v='https://zerogpu-aoti-wan2-2-fp8da-aoti-faster.hf.space/gradio_api/file='+v;\n   result.innerHTML='<video controls autoplay loop playsinline src=\"'+v+'\"></video><div class=\"row\"><span class=\"muted\">MP4 ready</span><a class=\"pill\" style=\"color:#fff;text-decoration:none\" target=\"_blank\" href=\"'+v+'\">Open MP4</a></div>';\n   prog(100,'MP4 ready ✓');\n }catch(e){\n   const msg=(e&&e.message)?e.message:String(e||'unknown error');\n   status.textContent='Wan failed: '+msg.slice(0,650);progress.classList.remove('on');\n }finally{go.disabled=false}\n};\n</script></body></html>\n";

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
        return new Response(APP_HTML, { headers: { ...cors, "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "no-store" } });
      }
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, build: "VIDEO-URL-V11", hf_auth: Boolean(env.HF_TOKEN) });
      }
      if (!env.HF_TOKEN) return json({ error: "HF_TOKEN secret missing" }, 500);

      if (request.method === "GET" && url.pathname === "/selftest-upload") {
        const fd = new FormData();
        fd.append("files", new Blob(["diza"], { type: "text/plain" }), "diza.txt");
        const r = await fetch(HF + "/gradio_api/upload", {
          method: "POST",
          headers: { "X-HF-Authorization": `Bearer ${env.HF_TOKEN}` },
          body: fd
        });
        const t = await r.text();
        return json({ status: r.status, ok: r.ok, body: t.slice(0,800) }, r.ok ? 200 : 502);
      }

      if (request.method === "POST" && url.pathname === "/upload") {
        const incoming = await request.formData();
        const image = incoming.get("image") || incoming.get("files");
        if (!image) return json({ error: "image missing" }, 400);
        const form = new FormData();
        form.append("files", image, image.name || "input.png");
        const r = await fetch(HF + "/gradio_api/upload", {
          method: "POST",
          headers: { "X-HF-Authorization": `Bearer ${env.HF_TOKEN}` },
          body: form
        });
        return proxyText(r);
      }

      if (request.method === "POST" && url.pathname === "/queue-join") {
        const body = await request.text();
        const r = await fetch(HF + "/gradio_api/queue/join", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-HF-Authorization": `Bearer ${env.HF_TOKEN}`, "x-gradio-user": "api" },
          body
        });
        return proxyText(r);
      }

      if (request.method === "GET" && url.pathname === "/queue-data") {
        const sessionHash = url.searchParams.get("session_hash");
        if (!sessionHash) return json({ error: "session_hash missing" }, 400);
        const r = await fetch(HF + "/gradio_api/queue/data?session_hash=" + encodeURIComponent(sessionHash), {
          headers: { "X-HF-Authorization": `Bearer ${env.HF_TOKEN}`, Accept: "text/event-stream", "x-gradio-user": "api" }
        });
        if (!r.ok) return json({ error: (await r.text()).slice(0,1200), provider_status: r.status }, r.status);
        return new Response(r.body, { status: 200, headers: { ...cors, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-cache", "X-Accel-Buffering": "no" } });
      }

      if (request.method === "POST" && url.pathname === "/run") {
        const body = await request.text();
        const r = await fetch(HF + "/gradio_api/run/generate_video", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-HF-Authorization": `Bearer ${env.HF_TOKEN}` },
          body
        });
        return proxyText(r);
      }

      if (request.method === "POST" && url.pathname === "/generate") {
        const body = await request.text();
        const r = await fetch(HF + "/gradio_api/call/generate_video", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-HF-Authorization": `Bearer ${env.HF_TOKEN}` },
          body
        });
        return proxyText(r);
      }

      if (request.method === "GET" && url.pathname.startsWith("/stream/")) {
        const eventId = url.pathname.slice("/stream/".length);
        if (!eventId) return json({ error: "event id missing" }, 400);
        const r = await fetch(HF + "/gradio_api/call/generate_video/" + encodeURIComponent(eventId), {
          headers: { "X-HF-Authorization": `Bearer ${env.HF_TOKEN}`, Accept: "text/event-stream" }
        });
        if (!r.ok) {
          const t = await r.text();
          return json({ error: t.slice(0,1200), provider_status: r.status }, r.status);
        }
        return new Response(r.body, {
          status: 200,
          headers: {
            ...cors,
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-store, no-cache",
            "X-Accel-Buffering": "no"
          }
        });
      }

      if (request.method === "GET" && url.pathname.startsWith("/poll/")) {
        const eventId = url.pathname.slice("/poll/".length);
        if (!eventId) return json({ error: "event id missing" }, 400);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
          const r = await fetch(HF + "/gradio_api/call/generate_video/" + encodeURIComponent(eventId), {
            headers: { "X-HF-Authorization": `Bearer ${env.HF_TOKEN}`, Accept: "text/event-stream" },
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
