// ============================================================
//  PTT Fabric Fiber Classifier — Native Camera & Device
// ============================================================

const API_URL = "https://hsakaletap-ptt-fabric-classifier.hf.space";

// --- DOM refs ---
const captureScreen    = document.getElementById("capture-screen");
const resultScreen     = document.getElementById("result-screen");

const nativeInput      = document.getElementById("native-camera-input");
const btnOpenCamera    = document.getElementById("btn-open-camera");

const captureCanvas    = document.getElementById("capture-canvas");
const capturedPreview  = document.getElementById("captured-preview");

const resultLoading    = document.getElementById("result-loading");
const resultSuccess    = document.getElementById("result-success");
const resultError      = document.getElementById("result-error");
const resultClass      = document.getElementById("result-class");
const resultConfText   = document.getElementById("result-confidence-text");
const resultConfBar    = document.getElementById("result-confidence-bar");
const otherPredictions = document.getElementById("other-predictions");
const errorMessage     = document.getElementById("error-message");

const stepInference    = document.getElementById("step-inference");
const stepDevice       = document.getElementById("step-device");
const sensorSection    = document.getElementById("sensor-section");
const sensorCharge     = document.getElementById("sensor-charge");
const sensorTemp       = document.getElementById("sensor-temp");
const sensorHumidity   = document.getElementById("sensor-humidity");
const deviceOfflineNote = document.getElementById("device-offline-note");

const deviceStatusDot  = document.querySelector(".status-dot");
const btnRetake        = document.getElementById("btn-retake");

// ============================================================
//  Device status polling
// ============================================================
async function checkDeviceStatus() {
    try {
        const res = await fetch(`${API_URL}/device/status`, {signal: AbortSignal.timeout(5000)});
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
//  Screen navigation
// ============================================================
function showScreen(screen) {
    captureScreen.classList.remove("active");
    resultScreen.classList.remove("active");
    screen.classList.add("active");
}

// ============================================================
//  Native Camera Handling
// ============================================================

btnOpenCamera.addEventListener("click", () => {
    // Programmatically open the file input (which triggers native camera)
    nativeInput.click();
});

btnRetake.addEventListener("click", () => {
    // Reset file input so same photo can trigger change event again if needed,
    // though usually retake means picking a new one.
    nativeInput.value = "";
    showScreen(captureScreen);
});

nativeInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // We have a photo! Now convert it, crop it safely, and process it.
    const reader = new FileReader();
    reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
            processAndSendImage(img);
        };
        img.src = event.target.result;
    };
    reader.readAsDataURL(file);
});

function processAndSendImage(img) {
    const canvas = captureCanvas;
    const ctx = canvas.getContext("2d");

    // Crop to the center square of the original image
    const side = Math.min(img.width, img.height);
    const srcX = (img.width - side) / 2;
    const srcY = (img.height - side) / 2;

    // Downscale target square to 640x640 to save bandwidth
    const outSize = Math.min(side, 640);
    canvas.width = outSize;
    canvas.height = outSize;

    // Draw cropped region onto canvas
    ctx.drawImage(img, srcX, srcY, side, side, 0, 0, outSize, outSize);

    // Get Base64 JPEG
    const dataUrl = canvas.toDataURL("image/jpeg", 0.88);

    // Show preview and start server pipeline
    capturedPreview.src = dataUrl;
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
