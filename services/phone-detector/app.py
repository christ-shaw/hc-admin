"""Phone bounding-box detector. Run behind HTTPS; never expose the token to clients."""
import base64
import binascii
import hmac
import io
import os
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException, Request
from PIL import Image, ImageOps, UnidentifiedImageError
from starlette.concurrency import run_in_threadpool
from ultralytics import YOLO

MAX_BODY = 14 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 25_000_000
model_lock = threading.Lock()


@asynccontextmanager
async def lifespan(app):
    token = os.environ.get("PHONE_DETECTOR_TOKEN", "")
    if len(token) < 32:
        raise RuntimeError("PHONE_DETECTOR_TOKEN must contain at least 32 characters")
    # Weights are mounted by the operator; no implicit model download on startup.
    weights = os.environ.get("PHONE_DETECTOR_WEIGHTS", "/models/phone.pt")
    if not os.path.isfile(weights):
        raise RuntimeError("PHONE_DETECTOR_WEIGHTS file is missing")
    app.state.model = YOLO(weights, task="detect")
    app.state.model_name = os.environ.get("PHONE_DETECTOR_MODEL_VERSION", "phone-v1")
    if not 1 <= len(app.state.model_name) <= 120:
        raise RuntimeError("Invalid PHONE_DETECTOR_MODEL_VERSION")
    labels = {s.strip().lower() for s in os.environ.get("PHONE_DETECTOR_LABELS", "cell phone,phone,smartphone,手机").split(",")}
    app.state.classes = [index for index, name in app.state.model.names.items() if name.lower() in labels]
    if not app.state.classes:
        raise RuntimeError("The model has no configured phone class")
    yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


def infer(image_base64, threshold):
    try:
        raw = base64.b64decode(image_base64, validate=True)
        if not raw or len(raw) > 10 * 1024 * 1024:
            raise ValueError("image size")
        with Image.open(io.BytesIO(raw)) as source:
            if source.format not in {"JPEG", "PNG", "WEBP"} or source.width * source.height > 25_000_000:
                raise ValueError("image format or dimensions")
            image = ImageOps.exif_transpose(source).convert("RGB")
    except (ValueError, binascii.Error, UnidentifiedImageError, OSError, Image.DecompressionBombError):
        raise HTTPException(400, "Invalid image") from None
    # The model instance is shared; serialize inference to avoid thread races.
    with model_lock:
        result = app.state.model.predict(image, classes=app.state.classes, conf=threshold,
                                         imgsz=1280, max_det=1000, verbose=False)[0]
        detections = [{"label": "phone", "confidence": float(confidence),
                       "box": [max(0.0, min(1.0, float(n))) for n in box]}
                      for box, confidence in zip(result.boxes.xyxyn.cpu().tolist(),
                                                 result.boxes.conf.cpu().tolist())]
    return {"model": app.state.model_name, "detections": detections}


@app.post("/detect")
async def detect(request: Request, authorization: str = Header(default="")):
    expected = "Bearer " + os.environ["PHONE_DETECTOR_TOKEN"]
    if not hmac.compare_digest(authorization.encode(), expected.encode()):
        raise HTTPException(401, "Unauthorized")
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_BODY:
            raise HTTPException(413, "Request too large")
    import json
    try:
        payload = json.loads(body)
        image_base64 = payload["imageBase64"]
        threshold = payload.get("threshold", 0.45)
        if not isinstance(image_base64, str) or type(threshold) not in (int, float) or not 0 < threshold <= 1:
            raise ValueError("invalid input")
    except (ValueError, KeyError, TypeError):
        raise HTTPException(400, "Invalid request") from None
    return await run_in_threadpool(infer, image_base64, threshold)
