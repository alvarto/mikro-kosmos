const video = document.querySelector("#camera");
const analysisCanvas = document.querySelector("#analysisCanvas");
const analysisContext = analysisCanvas.getContext("2d", { willReadFrequently: true });
const cameraCard = document.querySelector(".camera-card");
const statusText = document.querySelector("#cameraStatus");
const soundDot = document.querySelector("#soundDot");
const brightnessValue = document.querySelector("#brightnessValue");
const motionValue = document.querySelector("#motionValue");
const panValue = document.querySelector("#panValue");
const depthValue = document.querySelector("#depthValue");
const startButton = document.querySelector("#startButton");
const muteButton = document.querySelector("#muteButton");

const sampleWidth = analysisCanvas.width;
const sampleHeight = analysisCanvas.height;
const motionFloor = 5;

let stream;
let audioContext;
let masterGain;
let panner;
let oscillator;
let lfo;
let lfoGain;
let previousFrame;
let animationId;
let isRunning = false;
let isMuted = false;

let fieldState = {
  x: 0,
  y: 0,
  motion: 0,
  brightness: 0,
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const lerp = (from, to, amount) => from + (to - from) * amount;
const toPercent = (value) => `${Math.round(clamp(value, 0, 1) * 100)}%`;

const setStatus = (message) => {
  statusText.textContent = message;
};

const describePan = (x) => {
  if (x < -0.28) {
    return "偏左";
  }

  if (x > 0.28) {
    return "偏右";
  }

  return "中间";
};

const describeDepth = (y) => {
  if (y < -0.24) {
    return "远 / 上";
  }

  if (y > 0.24) {
    return "近 / 下";
  }

  return "中景";
};

const ensureAudio = async () => {
  if (!audioContext) {
    audioContext = new AudioContext();
    masterGain = audioContext.createGain();
    panner = new StereoPannerNode(audioContext, { pan: 0 });
    oscillator = new OscillatorNode(audioContext, { frequency: 180, type: "sine" });
    lfo = new OscillatorNode(audioContext, { frequency: 2.5, type: "sine" });
    lfoGain = audioContext.createGain();

    masterGain.gain.value = 0;
    lfoGain.gain.value = 24;

    lfo.connect(lfoGain).connect(oscillator.frequency);
    oscillator.connect(panner).connect(masterGain).connect(audioContext.destination);
    oscillator.start();
    lfo.start();
  }

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }
};

const setMuted = (muted) => {
  isMuted = muted;
  muteButton.textContent = muted ? "恢复声音" : "暂停声音";

  if (masterGain && audioContext) {
    const targetGain = muted ? 0 : calculateGain(fieldState);
    masterGain.gain.setTargetAtTime(targetGain, audioContext.currentTime, 0.05);
  }
};

const calculateGain = ({ motion, brightness }) => {
  const motionEnergy = clamp(motion / 70, 0, 1);
  const brightnessEnergy = clamp(brightness / 255, 0, 1);
  return clamp(0.018 + motionEnergy * 0.13 + brightnessEnergy * 0.05, 0, 0.2);
};

const updateAudio = ({ x, y, motion, brightness }) => {
  if (!audioContext || isMuted) {
    return;
  }

  const now = audioContext.currentTime;
  const motionEnergy = clamp(motion / 70, 0, 1);
  const brightnessEnergy = clamp(brightness / 255, 0, 1);
  const distanceEnergy = clamp((y + 1) / 2, 0, 1);
  const frequency = 140 + brightnessEnergy * 560 + motionEnergy * 180;
  const tremoloRate = 1.6 + motionEnergy * 9;

  panner.pan.setTargetAtTime(clamp(x, -1, 1), now, 0.08);
  oscillator.frequency.setTargetAtTime(frequency, now, 0.08);
  lfo.frequency.setTargetAtTime(tremoloRate, now, 0.1);
  lfoGain.gain.setTargetAtTime(10 + distanceEnergy * 42, now, 0.12);
  masterGain.gain.setTargetAtTime(calculateGain({ motion, brightness }), now, 0.08);
};

const updateInterface = ({ x, y, motion, brightness }) => {
  const focusX = clamp((x + 1) / 2, 0, 1);
  const focusY = clamp((y + 1) / 2, 0, 1);
  const motionEnergy = clamp(motion / 70, 0, 1);
  const brightnessEnergy = clamp(brightness / 255, 0, 1);

  cameraCard.style.setProperty("--focus-x", toPercent(focusX));
  cameraCard.style.setProperty("--focus-y", toPercent(focusY));
  cameraCard.style.setProperty("--motion-scale", (1 + motionEnergy * 0.55).toFixed(2));
  cameraCard.style.setProperty("--left-glow", x < 0 ? Math.abs(x).toFixed(2) : "0.08");
  cameraCard.style.setProperty("--right-glow", x > 0 ? Math.abs(x).toFixed(2) : "0.08");
  soundDot.style.left = toPercent(focusX);
  soundDot.style.top = toPercent(focusY);
  soundDot.style.transform = `translate(-50%, -50%) scale(${1 + motionEnergy * 0.65})`;
  soundDot.style.opacity = `${0.52 + brightnessEnergy * 0.42}`;
  brightnessValue.textContent = Math.round(brightnessEnergy * 100);
  motionValue.textContent = Math.round(motionEnergy * 100);
  panValue.textContent = describePan(x);
  depthValue.textContent = describeDepth(y);
};

const analyzeFrame = () => {
  if (!isRunning) {
    return;
  }

  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    animationId = requestAnimationFrame(analyzeFrame);
    return;
  }

  analysisContext.drawImage(video, 0, 0, sampleWidth, sampleHeight);
  const { data } = analysisContext.getImageData(0, 0, sampleWidth, sampleHeight);

  if (!previousFrame) {
    previousFrame = new Float32Array(sampleWidth * sampleHeight);
  }

  let totalDiff = 0;
  let totalBrightness = 0;
  let weightedX = 0;
  let weightedY = 0;
  let totalWeight = 0;

  for (let pixel = 0; pixel < sampleWidth * sampleHeight; pixel += 1) {
    const dataIndex = pixel * 4;
    const x = pixel % sampleWidth;
    const y = Math.floor(pixel / sampleWidth);
    const brightness = (data[dataIndex] + data[dataIndex + 1] + data[dataIndex + 2]) / 3;
    const previousBrightness = previousFrame[pixel] || brightness;
    const diff = Math.abs(brightness - previousBrightness);
    const brightnessWeight = Math.max(0, brightness - 150) * 0.12;
    const motionWeight = diff > motionFloor ? diff : 0;
    const weight = motionWeight + brightnessWeight;

    totalDiff += diff;
    totalBrightness += brightness;
    weightedX += x * weight;
    weightedY += y * weight;
    totalWeight += weight;
    previousFrame[pixel] = brightness;
  }

  const pixelCount = sampleWidth * sampleHeight;
  const centerX = totalWeight ? weightedX / totalWeight / (sampleWidth - 1) : 0.5;
  const centerY = totalWeight ? weightedY / totalWeight / (sampleHeight - 1) : 0.5;
  const targetState = {
    x: centerX * 2 - 1,
    y: centerY * 2 - 1,
    motion: totalDiff / pixelCount,
    brightness: totalBrightness / pixelCount,
  };

  fieldState = {
    x: lerp(fieldState.x, targetState.x, 0.18),
    y: lerp(fieldState.y, targetState.y, 0.18),
    motion: lerp(fieldState.motion, targetState.motion, 0.22),
    brightness: lerp(fieldState.brightness, targetState.brightness, 0.16),
  };

  updateInterface(fieldState);
  updateAudio(fieldState);
  animationId = requestAnimationFrame(analyzeFrame);
};

const stop = () => {
  isRunning = false;
  cancelAnimationFrame(animationId);
  stream?.getTracks().forEach((track) => track.stop());
  stream = undefined;
  video.srcObject = null;
  previousFrame = undefined;
  startButton.disabled = false;
  muteButton.disabled = true;

  if (masterGain && audioContext) {
    masterGain.gain.setTargetAtTime(0, audioContext.currentTime, 0.05);
  }

  setStatus("已停止，点击按钮可重新启动。");
};

const start = async () => {
  if (isRunning) {
    stop();
    return;
  }

  try {
    startButton.disabled = true;
    setStatus("正在请求手机摄像头与音频权限...");
    await ensureAudio();

    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });

    video.srcObject = stream;
    await video.play();

    isRunning = true;
    setMuted(false);
    startButton.disabled = false;
    startButton.textContent = "停止反馈";
    muteButton.disabled = false;
    previousFrame = undefined;
    setStatus("运行中：画面亮度、运动和位置正在驱动声场。");
    analyzeFrame();
  } catch (error) {
    console.error(error);
    startButton.disabled = false;
    muteButton.disabled = true;
    startButton.textContent = "启动声场反馈";
    setStatus("无法启动。请确认使用 HTTPS/localhost，并允许摄像头权限。");
  }
};

if (!("mediaDevices" in navigator) || !("getUserMedia" in navigator.mediaDevices)) {
  startButton.disabled = true;
  setStatus("当前浏览器不支持摄像头输入，请使用最新版 Safari、Chrome 或 Edge。");
}

startButton.addEventListener("click", () => {
  if (isRunning) {
    stop();
    startButton.textContent = "启动声场反馈";
    return;
  }

  start();
});

muteButton.addEventListener("click", () => {
  setMuted(!isMuted);
});
