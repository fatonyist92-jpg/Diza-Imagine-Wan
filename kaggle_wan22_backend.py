import os
import queue
import threading
import traceback
import uuid
from pathlib import Path

import torch
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from PIL import Image, ImageOps

from diffsynth.utils.data import save_video
from diffsynth.pipelines.wan_video import ModelConfig, WanVideoPipeline

APP_DIR = Path(os.getenv("DIZA_WORKDIR", "/kaggle/working/diza_wan"))
JOBS_DIR = APP_DIR / "jobs"
JOBS_DIR.mkdir(parents=True, exist_ok=True)

MODEL_ID = os.getenv("WAN_MODEL_ID", "Wan-AI/Wan2.2-TI2V-5B")
TOKENIZER_ID = os.getenv("WAN_TOKENIZER_ID", "Wan-AI/Wan2.1-T2V-1.3B")
DEFAULT_NEGATIVE = os.getenv(
    "WAN_NEGATIVE_PROMPT",
    "色调艳丽, 过曝, 静态, 细节模糊不清, 字幕, 最差质量, 低质量, JPEG压缩残留, 畸形的, 静止不动的画面",
)

app = FastAPI(title="DIZA Wan 2.2 Kaggle Backend", version="1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.getenv("DIZA_WEB_ORIGIN", "*")],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

_jobs = {}
_jobs_lock = threading.Lock()
_queue = queue.Queue()
_pipe = None
_pipe_lock = threading.Lock()


def _set_job(job_id, **changes):
    with _jobs_lock:
        if job_id in _jobs:
            _jobs[job_id].update(changes)


def _load_pipe():
    global _pipe
    if _pipe is not None:
        return _pipe
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA GPU tidak terdeteksi. Aktifkan GPU Accelerator di Kaggle.")

    with _pipe_lock:
        if _pipe is not None:
            return _pipe

        total_vram_gb = torch.cuda.mem_get_info("cuda")[1] / (1024 ** 3)
        vram_config = {
            "offload_dtype": "disk",
            "offload_device": "disk",
            "onload_dtype": torch.bfloat16,
            "onload_device": "cpu",
            "preparing_dtype": torch.bfloat16,
            "preparing_device": "cuda",
            "computation_dtype": torch.bfloat16,
            "computation_device": "cuda",
        }

        _pipe = WanVideoPipeline.from_pretrained(
            torch_dtype=torch.bfloat16,
            device="cuda",
            model_configs=[
                ModelConfig(
                    model_id=MODEL_ID,
                    origin_file_pattern="models_t5_umt5-xxl-enc-bf16.pth",
                    **vram_config,
                ),
                ModelConfig(
                    model_id=MODEL_ID,
                    origin_file_pattern="diffusion_pytorch_model*.safetensors",
                    **vram_config,
                ),
                ModelConfig(
                    model_id=MODEL_ID,
                    origin_file_pattern="Wan2.2_VAE.pth",
                    **vram_config,
                ),
            ],
            tokenizer_config=ModelConfig(
                model_id=TOKENIZER_ID,
                origin_file_pattern="google/umt5-xxl/",
            ),
            vram_limit=max(4.0, total_vram_gb - 2.0),
        )
        return _pipe


def _target_size(image):
    if image.height >= image.width:
        return 480, 832
    return 832, 480


def _worker():
    while True:
        job_id = _queue.get()
        try:
            job = _jobs[job_id]
            _set_job(job_id, status="loading_model", error=None)
            pipe = _load_pipe()

            image = Image.open(job["input_path"]).convert("RGB")
            width, height = _target_size(image)
            image = ImageOps.fit(
                image,
                (width, height),
                method=Image.Resampling.LANCZOS,
                centering=(0.5, 0.5),
            )

            _set_job(
                job_id,
                status="generating",
                width=width,
                height=height,
                frames=job["frames"],
                fps=job["fps"],
            )

            # Positive prompt is passed through exactly as received from the web.
            video = pipe(
                prompt=job["prompt"],
                negative_prompt=job["negative_prompt"],
                seed=job["seed"],
                tiled=True,
                height=height,
                width=width,
                input_image=image,
                num_frames=job["frames"],
            )

            output_path = str(Path(job["job_dir"]) / "result.mp4")
            _set_job(job_id, status="saving")
            save_video(video, output_path, fps=job["fps"], quality=5)

            _set_job(job_id, status="done", result_path=output_path)
        except Exception as exc:
            _set_job(
                job_id,
                status="failed",
                error=str(exc),
                traceback=traceback.format_exc()[-6000:],
            )
        finally:
            try:
                torch.cuda.empty_cache()
            except Exception:
                pass
            _queue.task_done()


threading.Thread(target=_worker, daemon=True, name="wan-worker").start()


@app.get("/")
def root():
    return {
        "ok": True,
        "service": "DIZA Wan 2.2 Kaggle Backend",
        "model": MODEL_ID,
    }


@app.get("/health")
def health():
    gpu = None
    vram_gb = None
    if torch.cuda.is_available():
        gpu = torch.cuda.get_device_name(0)
        vram_gb = round(torch.cuda.mem_get_info("cuda")[1] / (1024 ** 3), 2)
    return {
        "ok": True,
        "cuda": torch.cuda.is_available(),
        "gpu": gpu,
        "vram_gb": vram_gb,
        "model": MODEL_ID,
        "model_loaded": _pipe is not None,
        "queued": _queue.qsize(),
    }


@app.post("/generate")
async def generate(
    image: UploadFile = File(...),
    prompt: str = Form(...),
    negative_prompt: str = Form(DEFAULT_NEGATIVE),
    seed: int = Form(42),
    frames: int = Form(77),
    fps: int = Form(15),
):
    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="File harus berupa image.")
    if frames < 5 or frames > 121 or (frames - 1) % 4 != 0:
        raise HTTPException(status_code=400, detail="frames harus 4n+1, antara 5 dan 121.")
    if fps < 1 or fps > 30:
        raise HTTPException(status_code=400, detail="fps harus 1-30.")

    data = await image.read()
    if not data or len(data) > 20 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Image kosong atau lebih dari 20 MB.")

    job_id = uuid.uuid4().hex
    job_dir = JOBS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    suffix = Path(image.filename or "input.jpg").suffix.lower()
    if suffix not in {".jpg", ".jpeg", ".png", ".webp"}:
        suffix = ".jpg"
    input_path = job_dir / ("input" + suffix)
    input_path.write_bytes(data)

    with _jobs_lock:
        _jobs[job_id] = {
            "job_id": job_id,
            "status": "queued",
            "prompt": prompt,
            "negative_prompt": negative_prompt,
            "seed": seed,
            "frames": frames,
            "fps": fps,
            "input_path": str(input_path),
            "job_dir": str(job_dir),
            "result_path": None,
            "error": None,
        }

    _queue.put(job_id)
    return {
        "ok": True,
        "job_id": job_id,
        "status": "queued",
        "prompt_echo": prompt,
    }


@app.get("/jobs/{job_id}")
def job_status(job_id: str):
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job tidak ditemukan.")
        return {
            k: v
            for k, v in job.items()
            if k not in {"input_path", "job_dir", "result_path", "negative_prompt"}
        }


@app.get("/result/{job_id}")
def job_result(job_id: str):
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job tidak ditemukan.")
        if job["status"] != "done" or not job.get("result_path"):
            raise HTTPException(status_code=409, detail="Video belum siap.")
        result_path = job["result_path"]

    if not Path(result_path).exists():
        raise HTTPException(status_code=404, detail="File MP4 tidak ditemukan.")
    return FileResponse(result_path, media_type="video/mp4", filename=job_id + ".mp4")
