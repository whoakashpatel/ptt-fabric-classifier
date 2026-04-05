// ============================================================
//  PTT Fabric Fiber Classifier — script.js
//  Modes: Classify (inference + sensor) | Train (label + Drive upload)
// ============================================================

// ─── CONFIG ────────────────────────────────────────────────
const API_URL = "https://hsakaletap-ptt-fabric-classifier.hf.space";

// Credentials — loaded at runtime from Netlify /config edge function
// so they never appear in source code.
let GOOGLE_CLIENT_ID = "";
let DRIVE_FOLDER_IDS = {};

async function fetchConfig() {
    try {
        const res = await fetch("/config", { cache: "no-store" });
        if (!res.ok) throw new Error(`/config ${res.status}`);
        const cfg = await res.json();
        GOOGLE_CLIENT_ID = cfg.googleClientId ?? "";
        DRIVE_FOLDER_IDS = cfg.driveFolderIds ?? {};
    } catch (err) {
        console.warn("Could not load /config (local dev?):", err);
    }
}
// ───────────────────────────────────────────────────────────

// ─── DOM REFS ───────────────────────────────────────────────
const captureScreen = document.getElementById("capture-screen");
const resultScreen = document.getElementById("result-screen");
const trainCaptureScreen = document.getElementById("train-capture-screen");
const trainLabelScreen = document.getElementById("train-label-screen");
const allScreens = [captureScreen, resultScreen, trainCaptureScreen, trainLabelScreen];

// Classify mode
const nativeInput        = document.getElementById("native-camera-input");
const galleryInput       = document.getElementById("gallery-input");
const btnOpenCamera      = document.getElementById("btn-open-camera");
const btnOpenGallery     = document.getElementById("btn-open-gallery");
const captureCanvas      = document.getElementById("capture-canvas");
const capturedPreview    = document.getElementById("captured-preview");
const btnRetake          = document.getElementById("btn-retake");

// Result UI
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

// Training mode
const trainCameraInput   = document.getElementById("train-camera-input");
const trainGalleryInput  = document.getElementById("train-gallery-input");
const btnTrainPhoto      = document.getElementById("btn-train-photo");
const btnTrainGallery    = document.getElementById("btn-train-gallery");
const trainCanvas        = document.getElementById("train-canvas");
const trainPreview       = document.getElementById("train-preview");
const classGrid          = document.getElementById("class-grid");
const btnUploadDrive     = document.getElementById("btn-upload-drive");
const uploadStatus       = document.getElementById("upload-status");
const driveAuthRow       = document.getElementById("drive-auth-row");
const btnTrainRetake     = document.getElementById("btn-train-retake");

// Mode toggle
const modeBanner = document.querySelector(".mode-banner");
const modeLabel = document.getElementById("mode-label");
const btnModeToggle = document.getElementById("btn-mode-toggle");
const modeToggleText = document.getElementById("mode-toggle-text");

// Device status
const deviceStatusDot = document.querySelector(".status-dot");

// ─── MODE STATE ─────────────────────────────────────────────
let isTrainingMode = false;
let selectedClass = null;
let driveAccessToken = null;  // set after OAuth
let trainImageBlob = null;  // the raw JPEG blob for Drive upload

// ─── FABRIC CLASSES ─────────────────────────────────────────
let FABRIC_CLASSES = [];

// ============================================================
//  Device status polling
// ============================================================
async function checkDeviceStatus() {
    try {
        const res = await fetch(`${API_URL}/device/status`, { signal: AbortSignal.timeout(5000) });
        const data = await res.json();
        deviceStatusDot.classList.toggle("online", data.online);
        deviceStatusDot.classList.toggle("offline", !data.online);
    } catch {
        deviceStatusDot.classList.remove("online");
        deviceStatusDot.classList.add("offline");
    }
}
setInterval(checkDeviceStatus, 5000);
checkDeviceStatus();

// ============================================================
//  Screen navigation
// ============================================================
function showScreen(screen) {
    allScreens.forEach(s => s.classList.remove("active"));
    screen.classList.add("active");
}

// ============================================================
//  Mode toggle
// ============================================================
btnModeToggle.addEventListener("click", () => {
    isTrainingMode = !isTrainingMode;
    if (isTrainingMode) {
        modeLabel.textContent = "Training Mode";
        modeToggleText.textContent = "Switch to Classify";
        modeBanner.classList.add("training");
        showScreen(trainCaptureScreen);
    } else {
        modeLabel.textContent = "Classify Mode";
        modeToggleText.textContent = "Switch to Training";
        modeBanner.classList.remove("training");
        showScreen(captureScreen);
    }
});

// ============================================================
//  CLASSIFY MODE — Image capture + inference pipeline
// ============================================================
btnOpenCamera.addEventListener("click", () => nativeInput.click());
btnOpenGallery.addEventListener("click", () => galleryInput.click());

function handleClassifyChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    // Clear both inputs so same file can trigger change again
    nativeInput.value = "";
    galleryInput.value = "";
    
    readAndProcess(file, captureCanvas, capturedPreview, (dataUrl) => {
        showScreen(resultScreen);
        startCapturePipeline(dataUrl);
    });
}

nativeInput.addEventListener("change", handleClassifyChange);
galleryInput.addEventListener("change", handleClassifyChange);

btnRetake.addEventListener("click", () => showScreen(captureScreen));

function readAndProcess(file, canvas, previewEl, onReady) {
    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
            const blob = scaleDown(img, canvas, 640);
            const dataUrl = canvas.toDataURL("image/jpeg", 0.88);
            if (previewEl) previewEl.src = dataUrl;
            onReady(dataUrl, blob);
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

/** Scales an <img> down to maxSize proportionally, draws onto canvas, returns Blob */
function scaleDown(img, canvas, maxSize) {
    let w = img.width;
    let h = img.height;
    if (w > maxSize || h > maxSize) {
        if (w > h) {
            h = Math.round((h * maxSize) / w);
            w = maxSize;
        } else {
            w = Math.round((w * maxSize) / h);
            h = maxSize;
        }
    }
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(img, 0, 0, w, h);
    return canvas;
}

// ─── Capture pipeline ───────────────────────────────────────
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
        if (!res.ok) throw new Error(`Server error ${res.status}: ${await res.text()}`);

        const { job_id, device_online } = await res.json();
        if (!device_online) stepDevice.classList.add("skipped");
        await pollJob(job_id);
    } catch (err) {
        showClassifyError(err.message || "Network error");
    }
}

async function pollJob(jobId) {
    for (let i = 0; i < 60; i++) {
        try {
            const res = await fetch(`${API_URL}/job/${jobId}`);
            if (!res.ok) throw new Error(`Poll error ${res.status}`);
            const data = await res.json();
            if (data.predictions) stepInference.classList.add("done");
            if (data.sensor_readings || data.device_offline)
                stepDevice.classList.add(data.device_offline ? "skipped" : "done");
            if (data.status === "complete") { showResult(data); return; }
        } catch (e) { console.error("Poll:", e); }
        await sleep(1000);
    }
    showClassifyError("Timed out waiting for results.");
}

function showResult(data) {
    if (data.inference_error) { showClassifyError("Inference failed: " + data.inference_error); return; }
    const preds = data.predictions;
    if (!preds?.length) { showClassifyError("No predictions returned."); return; }

    const top = preds[0];
    resultClass.textContent = top.class_name.replace(/_/g, " ");
    const pct = (top.confidence * 100).toFixed(1);
    resultConfText.textContent = `${pct}%`;
    requestAnimationFrame(() => resultConfBar.style.width = `${pct}%`);

    otherPredictions.innerHTML = "";
    if (preds.length > 1) {
        const h = document.createElement("h4");
        h.textContent = "Other possibilities";
        otherPredictions.appendChild(h);
        preds.slice(1).forEach(p => {
            const row = document.createElement("div");
            row.className = "pred-row";
            row.innerHTML = `<span class="name">${p.class_name.replace(/_/g, " ")}</span><span class="conf">${(p.confidence * 100).toFixed(1)}%</span>`;
            otherPredictions.appendChild(row);
        });
    }

    if (data.sensor_readings) {
        const s = data.sensor_readings;
        sensorCharge.textContent = s.static_charge_v.toFixed(4);
        sensorTemp.textContent = s.temperature_c >= 0 ? s.temperature_c.toFixed(1) : "err";
        sensorHumidity.textContent = s.humidity_pct >= 0 ? s.humidity_pct.toFixed(1) : "err";
        sensorSection.classList.remove("hidden");
    } else if (data.device_offline) {
        deviceOfflineNote.classList.remove("hidden");
    }

    resultLoading.classList.add("hidden");
    resultSuccess.classList.remove("hidden");
}

function showClassifyError(msg) {
    errorMessage.textContent = msg;
    resultLoading.classList.add("hidden");
    resultError.classList.remove("hidden");
}

// ============================================================
//  TRAINING MODE — Photo → label → upload to Drive
// ============================================================

// Startup: fetch credentials first, then build the class grid
async function init() {
    await fetchConfig();
    
    FABRIC_CLASSES = Object.keys(DRIVE_FOLDER_IDS);
    // Local dev fallback if Netlify /config edge function is unavailable
    if (FABRIC_CLASSES.length === 0) {
        FABRIC_CLASSES = ["Cotton", "Polyester", "Denim", "Wool", "Silk", "Nylon", "Acrylic", "Mixed (Cotton+)", "Mixed (Polyester+)"];
    }
    
    buildClassGrid();
}
init();

btnTrainPhoto.addEventListener("click", () => trainCameraInput.click());
btnTrainGallery.addEventListener("click", () => trainGalleryInput.click());

function handleTrainingChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    // Clear inputs
    trainCameraInput.value = "";
    trainGalleryInput.value = "";
    
    readAndProcess(file, trainCanvas, trainPreview, (_dataUrl, canvas) => {
        // Store blob for Drive upload
        canvas.toBlob((blob) => { trainImageBlob = blob; }, "image/jpeg", 0.88);
        resetTrainUploadUI();
        showScreen(trainLabelScreen);
    });
}

trainCameraInput.addEventListener("change", handleTrainingChange);
trainGalleryInput.addEventListener("change", handleTrainingChange);

btnTrainRetake.addEventListener("click", () => {
    trainImageBlob = null;
    showScreen(trainCaptureScreen);
});

function buildClassGrid() {
    classGrid.innerHTML = "";
    FABRIC_CLASSES.forEach(cls => {
        const btn = document.createElement("button");
        btn.className = "class-btn";
        btn.textContent = cls;
        btn.dataset.cls = cls;
        btn.addEventListener("click", () => selectClass(cls));
        classGrid.appendChild(btn);
    });
}

function selectClass(cls) {
    selectedClass = cls;
    classGrid.querySelectorAll(".class-btn").forEach(b =>
        b.classList.toggle("selected", b.dataset.cls === cls)
    );
    // Enable upload button only if we have a class AND either already signed in or need to sign in
    btnUploadDrive.disabled = false;
    setUploadStatus("");
}

function resetTrainUploadUI() {
    selectedClass = null;
    classGrid.querySelectorAll(".class-btn").forEach(b => b.classList.remove("selected"));
    btnUploadDrive.disabled = true;
    uploadStatus.className = "upload-status hidden";
    uploadStatus.textContent = "";
    driveAuthRow.classList.add("hidden");
}

// ─── Google Drive Upload ─────────────────────────────────────
btnUploadDrive.addEventListener("click", async () => {
    if (!selectedClass) return;
    if (!trainImageBlob) { setUploadStatus("No image captured.", "error"); return; }

    if (!driveAccessToken) {
        // Trigger Google OAuth
        initGoogleAuth();
        return;
    }
    await doUpload();
});

function initGoogleAuth() {
    if (typeof google === "undefined") {
        setUploadStatus("Google SDK not loaded yet — try again.", "error");
        return;
    }
    const client = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: "https://www.googleapis.com/auth/drive.file",
        callback: async (response) => {
            if (response.error) {
                setUploadStatus("Sign-in cancelled or failed.", "error");
                return;
            }
            driveAccessToken = response.access_token;
            driveAuthRow.classList.add("hidden");
            await doUpload();
        },
    });
    client.requestAccessToken();
}

async function doUpload() {
    if (!selectedClass || !trainImageBlob || !driveAccessToken) return;

    const folderId = DRIVE_FOLDER_IDS[selectedClass];
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${timestamp}_${selectedClass.replace(/[^a-zA-Z0-9]/g, "_")}.jpg`;

    setUploadStatus("Uploading…", "uploading");
    btnUploadDrive.disabled = true;

    // Drive API multipart upload
    const meta = JSON.stringify({ name: filename, parents: [folderId] });
    const boundary = "ptt_boundary_xyz";

    const body = [
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
        `--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`,
    ];
    const bodyBlob = new Blob([
        body[0], body[1], trainImageBlob, `\r\n--${boundary}--`
    ], { type: `multipart/related; boundary=${boundary}` });

    try {
        const res = await fetch(
            "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${driveAccessToken}`,
                    "Content-Type": `multipart/related; boundary=${boundary}`,
                },
                body: bodyBlob,
            }
        );

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            // Token may have expired — clear it
            if (res.status === 401) {
                driveAccessToken = null;
                setUploadStatus("Session expired — click Upload to sign in again.", "error");
            } else {
                setUploadStatus(`Upload failed: ${err.error?.message || res.status}`, "error");
            }
            btnUploadDrive.disabled = false;
            return;
        }

        setUploadStatus(`✓ Saved to Drive → ${selectedClass}`, "success");
        btnUploadDrive.disabled = false;
    } catch (err) {
        setUploadStatus("Network error during upload.", "error");
        btnUploadDrive.disabled = false;
    }
}

function setUploadStatus(msg, type) {
    uploadStatus.textContent = msg;
    uploadStatus.className = `upload-status${msg ? "" : " hidden"}${type ? ` ${type}` : ""}`;
}

// ─── Utility ─────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
