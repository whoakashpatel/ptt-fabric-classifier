// ============================================================
//  PTT Fabric Fiber Classifier — Camera, Inference & Device
// ============================================================

const API_URL = "https://hsakaletap-ptt-fabric-classifier.hf.space";

// --- DOM refs ---
const permissionScreen = document.getElementById("permission-screen");
const cameraScreen = document.getElementById("camera-screen");
const resultScreen = document.getElementById("result-screen");

const btnGrantCamera = document.getElementById("btn-grant-camera");
const btnCapture = document.getElementById("btn-capture");
const btnSwitchCamera = document.getElementById("btn-switch-camera");
const btnRetake = document.getElementById("btn-retake");

const cameraFeed = document.getElementById("camera-feed");
const captureCanvas = document.getElementById("capture-canvas");
const capturedPreview = document.getElementById("captured-preview");

const cameraWrapper = document.querySelector(".camera-wrapper");

const resultLoading = document.getElementById("result-loading");
const resultSuccess = document.getElementById("result-success");
const resultError = document.getElementById("result-error");
const resultClass = document.getElementById("result-class");
const resultConfText = document.getElementById("result-confidence-text");
const resultConfBar = document.getElementById("result-confidence-bar");
const otherPredictions = document.getElementById("other-predictions");
const errorMessage = document.getElementById("error-message");

const stepInference = document.getElementById("step-inference");
const stepDevice = document.getElementById("step-device");
const sensorSection = document.getElementById("sensor-section");
const sensorCharge = document.getElementById("sensor-charge");
const sensorTemp = document.getElementById("sensor-temp");
const sensorHumidity = document.getElementById("sensor-humidity");
const deviceOfflineNote = document.getElementById("device-offline-note");

const deviceStatusDot = document.querySelector(".status-dot");
const lensPicker = document.getElementById("lens-picker");
const lensOptionsEl = document.getElementById("lens-options");

// --- State ---
let currentStream = null;
let facingMode = "environment";
let rearCameras = [];      // [{deviceId, label, shortLabel}]
let activeDeviceId = null;
let zoomCapability = null;    // {min, max, step} or null
let currentZoom = 1;

// ============================================================
//  Device status polling
// ============================================================
async function checkDeviceStatus() {
    try {
        const res = await fetch(`${API_URL}/device/status`, { signal: AbortSignal.timeout(5000) });
        const data = await res.json();
        if (data.online) {
            deviceStatusDot.classList.remove("offline");
            deviceStatusDot.classList.add("online");
        } else {
            deviceStatusDot.classList.remove("online");
            deviceStatusDot.classList.add("offline");
        }
    } catch {
        deviceStatusDot.classList.remove("online");
        deviceStatusDot.classList.add("offline");
    }
}

setInterval(checkDeviceStatus, 5000);
checkDeviceStatus();

// ============================================================
//  Scan-frame sizing
// ============================================================
function updateFrameLayout() {
    if (!cameraWrapper) return;
    const rect = cameraWrapper.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    const side = Math.min(w * 0.75, h * 0.75, 300);
    cameraWrapper.style.setProperty("--frame-size", side + "px");

    const dimV = ((h - side) / 2) + "px";
    const dimH = ((w - side) / 2) + "px";
    cameraWrapper.style.setProperty("--dim-v", dimV);
    cameraWrapper.style.setProperty("--dim-h", dimH);
}

window.addEventListener("resize", updateFrameLayout);

// ============================================================
//  Screen navigation
// ============================================================
function showScreen(screen) {
    [permissionScreen, cameraScreen, resultScreen].forEach(s =>
        s.classList.remove("active")
    );
    screen.classList.add("active");
    if (screen === cameraScreen) {
        requestAnimationFrame(updateFrameLayout);
    }
}

// ============================================================
//  Camera management — with lens/zoom detection
// ============================================================

/**
 * First-time init: request permission, discover rear cameras,
 * then start the first one.
 */
async function initCameras() {
    stopCamera();

    // Request permission with a temporary stream
    try {
        const tmp = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: facingMode },
            audio: false,
        });
        tmp.getTracks().forEach(t => t.stop());
    } catch (err) {
        console.error("Camera permission error:", err);
        alert("Could not access camera. Please grant permission and try again.");
        return;
    }

    // Enumerate all video devices
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(d => d.kind === "videoinput");

    // Find rear-facing cameras (or front if user toggled)
    rearCameras = [];
    const frontKW = ["front", "user", "facing front", "selfie"];

    for (const dev of videoDevices) {
        const lbl = (dev.label || "").toLowerCase();
        const isFront = frontKW.some(kw => lbl.includes(kw));

        if (facingMode === "environment" && !isFront) {
            rearCameras.push({ deviceId: dev.deviceId, label: dev.label || `Camera ${rearCameras.length + 1}` });
        } else if (facingMode === "user" && isFront) {
            rearCameras.push({ deviceId: dev.deviceId, label: dev.label || `Front ${rearCameras.length + 1}` });
        }
    }

    // Fallback: no cameras matched — use all
    if (rearCameras.length === 0) {
        rearCameras = videoDevices.map((d, i) => ({
            deviceId: d.deviceId,
            label: d.label || `Camera ${i + 1}`,
        }));
    }

    // Assign short labels
    rearCameras.forEach((cam, i) => {
        cam.shortLabel = deriveShortLabel(cam.label, i);
    });

    // Start the first camera
    activeDeviceId = rearCameras[0]?.deviceId || null;
    await startCameraWithDevice(activeDeviceId);
}

/**
 * Derive a compact label like "0.5×", "1×", "2×" from the device label.
 */
function deriveShortLabel(label, index) {
    const lbl = label.toLowerCase();
    if (lbl.includes("ultrawide") || lbl.includes("ultra-wide") || lbl.includes("ultra wide")) return "0.5×";
    if (lbl.includes("telephoto") || lbl.includes("tele")) return "2×";
    if (lbl.includes("wide") && !lbl.includes("ultra")) return "1×";
    return `${index + 1}`;
}

/**
 * Start a specific camera by deviceId and detect zoom.
 */
async function startCameraWithDevice(deviceId) {
    stopCamera();

    const constraints = {
        video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
    };

    if (deviceId) {
        constraints.video.deviceId = { exact: deviceId };
    } else {
        constraints.video.facingMode = facingMode;
    }

    try {
        currentStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch {
        // Fallback without exact deviceId
        try {
            currentStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: facingMode, width: { ideal: 1920 }, height: { ideal: 1080 } },
                audio: false,
            });
        } catch (err2) {
            console.error("Camera error:", err2);
            alert("Could not access this camera.");
            return;
        }
    }

    cameraFeed.srcObject = currentStream;

    // Detect zoom capability
    zoomCapability = null;
    currentZoom = 1;

    const track = currentStream.getVideoTracks()[0];
    if (track && typeof track.getCapabilities === "function") {
        const caps = track.getCapabilities();
        if (caps.zoom && caps.zoom.max > 1) {
            zoomCapability = {
                min: caps.zoom.min,
                max: caps.zoom.max,
                step: caps.zoom.step || 0.1,
            };
            currentZoom = track.getSettings?.().zoom || 1;
        }
    }

    buildLensPicker();
    showScreen(cameraScreen);
}

/**
 * Apply digital zoom to the active track.
 */
async function applyZoom(level) {
    if (!currentStream || !zoomCapability) return;
    const track = currentStream.getVideoTracks()[0];
    if (!track) return;

    const clamped = Math.max(zoomCapability.min, Math.min(zoomCapability.max, level));
    try {
        await track.applyConstraints({ advanced: [{ zoom: clamped }] });
        currentZoom = clamped;
    } catch (err) {
        console.warn("Zoom not supported:", err);
    }
}

/**
 * Build the lens picker buttons from detected cameras + zoom levels.
 */
function buildLensPicker() {
    lensOptionsEl.innerHTML = "";

    const multiCam = rearCameras.length > 1;
    const hasZoom = zoomCapability && zoomCapability.max > 1;

    if (!multiCam && !hasZoom) {
        lensPicker.classList.add("hidden");
        return;
    }
    lensPicker.classList.remove("hidden");

    // Camera buttons
    if (multiCam) {
        rearCameras.forEach(cam => {
            const btn = document.createElement("button");
            btn.className = "lens-btn" + (cam.deviceId === activeDeviceId ? " active" : "");
            btn.textContent = cam.shortLabel;
            btn.title = cam.label;
            btn.addEventListener("click", () => {
                activeDeviceId = cam.deviceId;
                startCameraWithDevice(cam.deviceId);
            });
            lensOptionsEl.appendChild(btn);
        });
    }

    // Zoom buttons
    if (hasZoom) {
        if (multiCam) {
            const sep = document.createElement("div");
            sep.style.cssText = "width:1px;height:20px;background:rgba(255,255,255,0.12);margin:0 4px;flex-shrink:0;";
            lensOptionsEl.appendChild(sep);
        }

        const steps = [1];
        if (zoomCapability.max >= 2) steps.push(2);
        if (zoomCapability.max >= 4) steps.push(4);
        if (zoomCapability.max >= 10) steps.push(10);

        steps.forEach(z => {
            const btn = document.createElement("button");
            btn.className = "lens-btn" + (Math.abs(currentZoom - z) < 0.3 ? " active" : "");
            btn.textContent = `${z}×`;
            btn.title = `${z}x zoom`;
            btn.addEventListener("click", async () => {
                await applyZoom(z);
                buildLensPicker();
            });
            lensOptionsEl.appendChild(btn);
        });
    }
}

/**
 * Start camera (for retake flows).
 */
async function startCamera() {
    if (rearCameras.length === 0) {
        await initCameras();
    } else {
        await startCameraWithDevice(activeDeviceId);
    }
}

function stopCamera() {
    if (currentStream) {
        currentStream.getTracks().forEach(t => t.stop());
        currentStream = null;
    }
}

// ============================================================
//  Capture — crops the visible square region
// ============================================================
function capturePhoto() {
    const video = cameraFeed;
    const canvas = captureCanvas;

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;

    const wrapperRect = cameraWrapper.getBoundingClientRect();
    const ew = wrapperRect.width;
    const eh = wrapperRect.height;

    const side = Math.min(ew * 0.75, eh * 0.75, 300);

    const scaleX = vw / ew;
    const scaleY = vh / eh;
    const coverScale = Math.min(scaleX, scaleY);

    const visW = ew * coverScale;
    const visH = eh * coverScale;

    const offX = (vw - visW) / 2;
    const offY = (vh - visH) / 2;

    const fX = (ew - side) / 2;
    const fY = (eh - side) / 2;

    const srcX = offX + fX * coverScale;
    const srcY = offY + fY * coverScale;
    const srcSize = side * coverScale;

    const outSize = Math.min(Math.round(srcSize), 640);
    canvas.width = outSize;
    canvas.height = outSize;

    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, srcX, srcY, srcSize, srcSize, 0, 0, outSize, outSize);

    const dataUrl = canvas.toDataURL("image/jpeg", 0.88);
    capturedPreview.src = dataUrl;

    stopCamera();
    showScreen(resultScreen);
    startCapturePipeline(dataUrl);
}

// ============================================================
//  Capture pipeline: POST /capture → poll /job/{id}
// ============================================================
async function startCapturePipeline(base64DataUrl) {
    resultLoading.classList.remove("hidden");
    resultSuccess.classList.add("hidden");
    resultError.classList.add("hidden");
    resultConfBar.style.width = "0%";
    sensorSection.classList.add("hidden");
    deviceOfflineNote.classList.add("hidden");

    stepInference.classList.remove("done");
    stepDevice.classList.remove("done", "skipped");

    try {
        const res = await fetch(`${API_URL}/capture`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image: base64DataUrl }),
        });

        if (!res.ok) {
            const detail = await res.text();
            throw new Error(`Server error ${res.status}: ${detail}`);
        }

        const { job_id, device_online } = await res.json();

        if (!device_online) {
            stepDevice.classList.add("skipped");
        }

        await pollJob(job_id);
    } catch (err) {
        console.error("Capture pipeline failed:", err);
        showError(err.message || "Network error — is the server running?");
    }
}

async function pollJob(jobId) {
    const MAX_POLLS = 60;
    const POLL_INTERVAL = 1000;

    for (let i = 0; i < MAX_POLLS; i++) {
        try {
            const res = await fetch(`${API_URL}/job/${jobId}`);
            if (!res.ok) throw new Error(`Poll error ${res.status}`);

            const data = await res.json();

            if (data.predictions) stepInference.classList.add("done");
            if (data.sensor_readings || data.device_offline) {
                stepDevice.classList.add(data.device_offline ? "skipped" : "done");
            }

            if (data.status === "complete") {
                showCombinedResult(data);
                return;
            }
        } catch (err) {
            console.error("Poll error:", err);
        }

        await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }

    showError("Timed out waiting for results.");
}

// ============================================================
//  Display combined results
// ============================================================
function showCombinedResult(data) {
    if (data.inference_error) {
        showError("Inference failed: " + data.inference_error);
        return;
    }

    const predictions = data.predictions;
    if (!predictions || predictions.length === 0) {
        showError("No predictions returned.");
        return;
    }

    const top = predictions[0];
    resultClass.textContent = top.class_name.replace(/_/g, " ");
    const confPercent = (top.confidence * 100).toFixed(1);
    resultConfText.textContent = `${confPercent}%`;

    requestAnimationFrame(() => {
        resultConfBar.style.width = `${confPercent}%`;
    });

    otherPredictions.innerHTML = "";
    if (predictions.length > 1) {
        const heading = document.createElement("h4");
        heading.textContent = "Other possibilities";
        otherPredictions.appendChild(heading);

        predictions.slice(1).forEach(pred => {
            const row = document.createElement("div");
            row.className = "pred-row";
            row.innerHTML = `
                <span class="name">${pred.class_name.replace(/_/g, " ")}</span>
                <span class="conf">${(pred.confidence * 100).toFixed(1)}%</span>
            `;
            otherPredictions.appendChild(row);
        });
    }

    if (data.sensor_readings) {
        const s = data.sensor_readings;
        sensorCharge.textContent = s.static_charge_v.toFixed(4);
        sensorTemp.textContent = s.temperature_c >= 0 ? s.temperature_c.toFixed(1) : "err";
        sensorHumidity.textContent = s.humidity_pct >= 0 ? s.humidity_pct.toFixed(1) : "err";
        sensorSection.classList.remove("hidden");
        deviceOfflineNote.classList.add("hidden");
    } else if (data.device_offline) {
        sensorSection.classList.add("hidden");
        deviceOfflineNote.classList.remove("hidden");
    }

    resultLoading.classList.add("hidden");
    resultSuccess.classList.remove("hidden");
}

function showError(msg) {
    errorMessage.textContent = msg;
    resultLoading.classList.add("hidden");
    resultError.classList.remove("hidden");
}

// ============================================================
//  Event listeners
// ============================================================
btnGrantCamera.addEventListener("click", () => initCameras());
btnCapture.addEventListener("click", () => capturePhoto());
btnSwitchCamera.addEventListener("click", () => {
    facingMode = facingMode === "environment" ? "user" : "environment";
    rearCameras = [];  // re-enumerate for new facing mode
    initCameras();
});
btnRetake.addEventListener("click", () => startCamera());
