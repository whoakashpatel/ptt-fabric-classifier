// ============================================================
//  PTT Fabric Fiber Classifier — Camera & Classification Logic
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
const scanFrame = document.querySelector(".scan-frame");
const cameraOverlay = document.querySelector(".camera-overlay");

const resultLoading = document.getElementById("result-loading");
const resultSuccess = document.getElementById("result-success");
const resultError = document.getElementById("result-error");
const resultClass = document.getElementById("result-class");
const resultConfText = document.getElementById("result-confidence-text");
const resultConfBar = document.getElementById("result-confidence-bar");
const otherPredictions = document.getElementById("other-predictions");
const errorMessage = document.getElementById("error-message");

// --- State ---
let currentStream = null;
let facingMode = "environment";

// ============================================================
//  Scan-frame sizing — keeps the square centred and tells
//  CSS dim-overlays how big to be via custom properties
// ============================================================
function updateFrameLayout() {
    if (!cameraWrapper) return;
    const rect = cameraWrapper.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    // Square side = 75% of the shorter dimension, capped at 300px
    const side = Math.min(w * 0.75, h * 0.75, 300);

    // Set the scan-frame size
    cameraWrapper.style.setProperty("--frame-size", side + "px");

    // Dim overlay strips
    const dimV = ((h - side) / 2) + "px";
    const dimH = ((w - side) / 2) + "px";
    cameraWrapper.style.setProperty("--dim-v", dimV);
    cameraWrapper.style.setProperty("--dim-h", dimH);
}

// Re-calculate on resize / orientation change
window.addEventListener("resize", updateFrameLayout);

// ============================================================
//  Screen navigation
// ============================================================
function showScreen(screen) {
    [permissionScreen, cameraScreen, resultScreen].forEach(s =>
        s.classList.remove("active")
    );
    screen.classList.add("active");

    // Update scan-frame dimensions when camera screen appears
    if (screen === cameraScreen) {
        requestAnimationFrame(updateFrameLayout);
    }
}

// ============================================================
//  Camera management
// ============================================================
async function startCamera() {
    stopCamera();

    try {
        const constraints = {
            video: {
                facingMode: facingMode,
                width: { ideal: 1920 },
                height: { ideal: 1080 },
            },
            audio: false,
        };
        currentStream = await navigator.mediaDevices.getUserMedia(constraints);
        cameraFeed.srcObject = currentStream;
        showScreen(cameraScreen);
    } catch (err) {
        console.error("Camera error:", err);
        alert("Could not access camera. Please grant permission and try again.");
    }
}

function stopCamera() {
    if (currentStream) {
        currentStream.getTracks().forEach(t => t.stop());
        currentStream = null;
    }
}

// ============================================================
//  Capture — crops exactly the visible square region
//
//  The video uses object-fit: cover inside the wrapper.
//  We figure out which part of the raw video is visible,
//  then map the scan-frame's element-space position into
//  raw-video-pixel coordinates and crop that square.
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

    // Scan-frame size in CSS px (matches updateFrameLayout)
    const side = Math.min(ew * 0.75, eh * 0.75, 300);

    // object-fit: cover scaling ratio
    const scaleX = vw / ew;
    const scaleY = vh / eh;
    const coverScale = Math.min(scaleX, scaleY);

    // Visible portion of the video in video-px
    const visW = ew * coverScale;
    const visH = eh * coverScale;

    // Offset from video origin to visible top-left
    const offX = (vw - visW) / 2;
    const offY = (vh - visH) / 2;

    // Scan-frame top-left in element-space
    const fX = (ew - side) / 2;
    const fY = (eh - side) / 2;

    // Map to video coords
    const srcX = offX + fX * coverScale;
    const srcY = offY + fY * coverScale;
    const srcSize = side * coverScale;

    // Output square (cap at 640px for network efficiency)
    const outSize = Math.min(Math.round(srcSize), 640);
    canvas.width = outSize;
    canvas.height = outSize;

    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, srcX, srcY, srcSize, srcSize, 0, 0, outSize, outSize);

    const dataUrl = canvas.toDataURL("image/jpeg", 0.88);
    capturedPreview.src = dataUrl;

    stopCamera();
    showScreen(resultScreen);
    classify(dataUrl);
}

// ============================================================
//  Classification API call
// ============================================================
async function classify(base64DataUrl) {
    resultLoading.classList.remove("hidden");
    resultSuccess.classList.add("hidden");
    resultError.classList.add("hidden");
    resultConfBar.style.width = "0%";

    try {
        const response = await fetch(`${API_URL}/predict`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image: base64DataUrl }),
        });

        if (!response.ok) {
            const detail = await response.text();
            throw new Error(`Server error ${response.status}: ${detail}`);
        }

        const data = await response.json();
        showResult(data);
    } catch (err) {
        console.error("Classification failed:", err);
        showError(err.message || "Network error — is the inference server running?");
    }
}

// ============================================================
//  Display results
// ============================================================
function showResult(data) {
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
btnGrantCamera.addEventListener("click", () => startCamera());

btnCapture.addEventListener("click", () => capturePhoto());

btnSwitchCamera.addEventListener("click", () => {
    facingMode = facingMode === "environment" ? "user" : "environment";
    startCamera();
});

btnRetake.addEventListener("click", () => {
    startCamera();
});
