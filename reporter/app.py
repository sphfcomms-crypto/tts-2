"""The approved reporter says any text: text -> her voice (ElevenLabs, voices.py) -> LatentSync redraws
only her mouth on the real Seedance clip of her -> a film. One GPU, one text at a time, in order.

    REPORTER_TOKEN=... python app.py        (port 8200; the page is /?t=<token>)
"""
import json, os, subprocess, sys, threading, time, uuid, queue, shutil

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "avatar-flash"))
import voices  # noqa: E402

TOKEN = os.environ["REPORTER_TOKEN"]
LS = os.environ.get("LATENTSYNC_DIR", "/workspace/reporter/LatentSync")
PY = os.environ.get("LATENTSYNC_PY", "/workspace/reporter/venv/bin/python")
BASE = os.environ.get("REPORTER_BASE", "/workspace/reporter/base_long.mp4")
OUT = "/workspace/reporter/out"
STEPS = os.environ.get("REPORTER_STEPS", "20")
os.makedirs(OUT, exist_ok=True)

app = FastAPI()
jobs, work = {}, queue.Queue()


def log(**kw):
    kw["t"] = time.strftime("%H:%M:%S")
    print(json.dumps(kw, ensure_ascii=False), flush=True)


def ok(request):
    return request.query_params.get("t") == TOKEN


def run(job):
    d = os.path.join(OUT, job["id"])
    os.makedirs(d, exist_ok=True)
    job["state"] = "voice"
    wav = voices.speech(job["text"], job.get("voice", "saira"))
    with open(f"{d}/voice.wav", "wb") as f:
        f.write(wav)
    seconds = (len(wav) - 44) / (2 * voices.RATE24)
    job["seconds"] = round(seconds, 1)
    # the real clip of her, as long as her voice (and a little more)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", BASE, "-t", f"{seconds + 0.5:.2f}", "-an",
                    "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", f"{d}/base.mp4"], check=True)
    job["state"] = "lips"
    began = time.time()
    lips.make(f"{d}/base.mp4", f"{d}/voice.wav", f"{d}/film.mp4", steps=int(STEPS))
    if not os.path.exists(f"{d}/film.mp4"):
        raise RuntimeError("no film came out")
    job["took"] = round(time.time() - began, 1)
    job["state"] = "done"


def worker():
    lips.load()
    log(event="lips_loaded")
    while True:
        job = work.get()
        try:
            run(job)
            log(event="done", id=job["id"], seconds=job.get("seconds"), took=job.get("took"))
        except Exception as ex:  # noqa: BLE001
            job["state"], job["error"] = "failed", str(ex)[-600:]
            log(event="failed", id=job["id"], error=job["error"])


threading.Thread(target=worker, daemon=True).start()


@app.post("/make")
async def make(request: Request):
    if not ok(request):
        return JSONResponse({"error": "no"}, 403)
    body = await request.json()
    text = str(body.get("text", "")).strip()[:6000]
    if not text:
        return JSONResponse({"error": "no text"}, 400)
    job = {"id": uuid.uuid4().hex[:12], "text": text, "voice": body.get("voice", "saira"), "state": "waiting", "at": time.time()}
    jobs[job["id"]] = job
    work.put(job)
    return {"id": job["id"], "ahead": work.qsize() - 1}


@app.get("/job/{jid}")
def job(jid: str, request: Request):
    if not ok(request) or jid not in jobs:
        return JSONResponse({"error": "no"}, 404)
    j = jobs[jid]
    return {k: j.get(k) for k in ("id", "state", "error", "seconds", "took")}


@app.get("/film/{jid}.mp4")
def film(jid: str, request: Request):
    p = os.path.join(OUT, jid, "film.mp4")
    if not ok(request) or not jid.isalnum() or not os.path.exists(p):
        return JSONResponse({"error": "no"}, 404)
    return FileResponse(p, media_type="video/mp4")


IDLE = os.environ.get("REPORTER_IDLE", "/workspace/reporter/pingpong2.mp4")


@app.get("/idle.mp4")
def idle(request: Request):
    if not ok(request):
        return JSONResponse({"error": "no"}, 404)
    return FileResponse(IDLE, media_type="video/mp4")


@app.get("/")
def page(request: Request):
    if not ok(request):
        return HTMLResponse("<h3>Link is not complete</h3>", 403)
    with open(os.path.join(HERE, "page.html"), encoding="utf-8") as f:
        return HTMLResponse(f.read().replace("__TOKEN__", TOKEN))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8200, log_level="warning")
