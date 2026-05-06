const video = document.querySelector("#camera");
const poseCanvas = document.querySelector("#poseCanvas");
const poseContext = poseCanvas.getContext("2d");
const analysisCanvas = document.querySelector("#analysisCanvas");
const analysisContext = analysisCanvas.getContext("2d", { willReadFrequently: true });
const stage = document.querySelector(".immersive-stage");
const statusText = document.querySelector("#cameraStatus");
const modelValue = document.querySelector("#modelValue");
const poseValue = document.querySelector("#poseValue");
const brightnessValue = document.querySelector("#brightnessValue");
const motionValue = document.querySelector("#motionValue");
const spreadValue = document.querySelector("#spreadValue");
const rhythmValue = document.querySelector("#rhythmValue");
const panValue = document.querySelector("#panValue");
const depthValue = document.querySelector("#depthValue");
const frequencyValue = document.querySelector("#frequencyValue");
const pulseValue = document.querySelector("#pulseValue");
const gainValue = document.querySelector("#gainValue");
const startButton = document.querySelector("#startButton");
const muteButton = document.querySelector("#muteButton");

const sampleWidth = analysisCanvas.width;
const sampleHeight = analysisCanvas.height;
const motionFloor = 5;
const minKeypointScore = 0.28;
const skeletonPairs = [
  ["left_shoulder", "right_shoulder"],
  ["left_shoulder", "left_elbow"],
  ["left_elbow", "left_wrist"],
  ["right_shoulder", "right_elbow"],
  ["right_elbow", "right_wrist"],
  ["left_shoulder", "left_hip"],
  ["right_shoulder", "right_hip"],
  ["left_hip", "right_hip"],
  ["left_hip", "left_knee"],
  ["left_knee", "left_ankle"],
  ["right_hip", "right_knee"],
  ["right_knee", "right_ankle"],
];

let stream;
let audioContext;
let masterGain;
let panner;
let oscillator;
let lfo;
let lfoGain;
let previousFrame;
let previousPoseCenter;
let previousExpressivePoints;
let previousBeatEnergy = 0;
let detector;
let detectorPromise;
let animationId;
let isRunning = false;
let isMuted = false;
let usePoseModel = false;

let fieldState = {
  x: 0,
  y: 0,
  motion: 0,
  brightness: 0,
  poseScore: 0,
  spread: 0,
  rhythm: 0,
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const lerp = (from, to, amount) => from + (to - from) * amount;
const toPercent = (value) => `${Math.round(clamp(value, 0, 1) * 100)}%`;

const setStatus = (message) => {
  statusText.textContent = message;
};

const setModelStatus = (status) => {
  modelValue.textContent = status;
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

const setRunningChrome = (running) => {
  document.body.classList.toggle("is-running", running);
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

const waitForPoseLibraries = async () => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (globalThis.tf && globalThis.poseDetection) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }

  throw new Error("Pose libraries are not available.");
};

const loadPoseDetector = async () => {
  if (detector) {
    return detector;
  }

  if (!detectorPromise) {
    detectorPromise = (async () => {
      await waitForPoseLibraries();

      try {
        await globalThis.tf.setBackend("webgl");
      } catch (error) {
        console.info("WebGL backend unavailable, using TensorFlow.js fallback.", error);
      }

      await globalThis.tf.ready();

      const { poseDetection } = globalThis;
      return poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, {
        modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
        enableSmoothing: true,
      });
    })();
  }

  detector = await detectorPromise;
  return detector;
};

const setMuted = (muted) => {
  isMuted = muted;
  muteButton.textContent = muted ? "恢复" : "静音";

  if (masterGain && audioContext) {
    const targetGain = muted ? 0 : calculateGain(fieldState);
    masterGain.gain.setTargetAtTime(targetGain, audioContext.currentTime, 0.05);
  }
};

const calculateGain = ({ motion, brightness, poseScore, spread }) => {
  const motionEnergy = clamp(motion, 0, 1);
  const brightnessEnergy = clamp(brightness / 255, 0, 1);
  const poseEnergy = clamp(poseScore, 0, 1);
  const spreadEnergy = clamp(spread, 0, 1);
  return clamp(0.018 + motionEnergy * 0.11 + brightnessEnergy * 0.035 + poseEnergy * spreadEnergy * 0.05, 0, 0.22);
};

const calculateAudioParams = (state) => {
  const motionEnergy = clamp(state.motion, 0, 1);
  const brightnessEnergy = clamp(state.brightness / 255, 0, 1);
  const distanceEnergy = clamp((state.y + 1) / 2, 0, 1);
  const spreadEnergy = clamp(state.spread, 0, 1);
  const rhythmEnergy = clamp(state.rhythm, 0, 1);
  const frequency = 120 + brightnessEnergy * 360 + spreadEnergy * 220 + rhythmEnergy * 180;
  const tremoloRate = 1.2 + motionEnergy * 7.5 + rhythmEnergy * 5;
  const gain = calculateGain(state);

  return {
    frequency,
    tremoloRate,
    gain,
    modulationDepth: 10 + distanceEnergy * 34 + spreadEnergy * 18,
  };
};

const updateAudio = (state) => {
  const params = calculateAudioParams(state);

  if (audioContext && !isMuted) {
    const now = audioContext.currentTime;
    panner.pan.setTargetAtTime(clamp(state.x, -1, 1), now, 0.08);
    oscillator.frequency.setTargetAtTime(params.frequency, now, 0.08);
    lfo.frequency.setTargetAtTime(params.tremoloRate, now, 0.1);
    lfoGain.gain.setTargetAtTime(params.modulationDepth, now, 0.12);
    masterGain.gain.setTargetAtTime(params.gain, now, 0.08);
  }

  frequencyValue.textContent = Math.round(params.frequency);
  pulseValue.textContent = params.tremoloRate.toFixed(1);
  gainValue.textContent = Math.round((isMuted ? 0 : params.gain / 0.22) * 100);
};

const updateInterface = (state) => {
  const focusX = clamp((state.x + 1) / 2, 0, 1);
  const focusY = clamp((state.y + 1) / 2, 0, 1);
  const motionEnergy = clamp(state.motion, 0, 1);
  const brightnessEnergy = clamp(state.brightness / 255, 0, 1);

  stage.style.setProperty("--focus-x", toPercent(focusX));
  stage.style.setProperty("--focus-y", toPercent(focusY));
  stage.style.setProperty("--motion-scale", (1 + motionEnergy * 0.45).toFixed(2));
  stage.style.setProperty("--left-glow", state.x < 0 ? Math.abs(state.x).toFixed(2) : "0.08");
  stage.style.setProperty("--right-glow", state.x > 0 ? Math.abs(state.x).toFixed(2) : "0.08");
  brightnessValue.textContent = Math.round(brightnessEnergy * 100);
  motionValue.textContent = Math.round(motionEnergy * 100);
  poseValue.textContent = `${Math.round(clamp(state.poseScore, 0, 1) * 100)}%`;
  spreadValue.textContent = Math.round(clamp(state.spread, 0, 1) * 100);
  rhythmValue.textContent = Math.round(clamp(state.rhythm, 0, 1) * 100);
  panValue.textContent = describePan(state.x);
  depthValue.textContent = describeDepth(state.y);
  updateAudio(state);
};

const readBrightnessAndMotion = () => {
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

  return {
    x: centerX * 2 - 1,
    y: centerY * 2 - 1,
    motion: clamp(totalDiff / pixelCount / 70, 0, 1),
    brightness: totalBrightness / pixelCount,
  };
};

const getKeypoint = (pose, name) => pose.keypoints.find((keypoint) => keypoint.name === name || keypoint.part === name);

const getConfidentKeypoints = (pose) =>
  pose.keypoints.filter((keypoint) => (keypoint.score ?? 0) >= minKeypointScore);

const distanceBetween = (pointA, pointB) => Math.hypot(pointA.x - pointB.x, pointA.y - pointB.y);

const calculateTorsoSize = (keypoints) => {
  const leftShoulder = keypoints.left_shoulder;
  const rightShoulder = keypoints.right_shoulder;
  const leftHip = keypoints.left_hip;
  const rightHip = keypoints.right_hip;
  const shoulderWidth = leftShoulder && rightShoulder ? distanceBetween(leftShoulder, rightShoulder) : 0;
  const hipWidth = leftHip && rightHip ? distanceBetween(leftHip, rightHip) : 0;
  const torsoHeight =
    leftShoulder && rightShoulder && leftHip && rightHip
      ? distanceBetween(
          {
            x: (leftShoulder.x + rightShoulder.x) / 2,
            y: (leftShoulder.y + rightShoulder.y) / 2,
          },
          {
            x: (leftHip.x + rightHip.x) / 2,
            y: (leftHip.y + rightHip.y) / 2,
          },
        )
      : 0;

  return Math.max(shoulderWidth, hipWidth, torsoHeight, video.videoHeight * 0.18);
};

const decodePose = (pose, fallbackMetrics) => {
  const confidentKeypoints = getConfidentKeypoints(pose);

  if (confidentKeypoints.length < 5) {
    previousPoseCenter = undefined;
    previousExpressivePoints = undefined;
    return {
      ...fallbackMetrics,
      poseScore: 0,
      spread: 0,
      rhythm: lerp(fieldState.rhythm, 0, 0.08),
    };
  }

  const keyed = Object.fromEntries(
    pose.keypoints
      .filter((keypoint) => (keypoint.score ?? 0) >= minKeypointScore)
      .map((keypoint) => [keypoint.name || keypoint.part, keypoint]),
  );
  const center = confidentKeypoints.reduce(
    (accumulator, keypoint) => ({
      x: accumulator.x + keypoint.x / confidentKeypoints.length,
      y: accumulator.y + keypoint.y / confidentKeypoints.length,
    }),
    { x: 0, y: 0 },
  );
  const poseScore =
    confidentKeypoints.reduce((total, keypoint) => total + (keypoint.score ?? 0), 0) / confidentKeypoints.length;
  const torsoSize = calculateTorsoSize(keyed);
  const expressivePoints = ["left_wrist", "right_wrist", "left_ankle", "right_ankle"]
    .map((name) => keyed[name])
    .filter(Boolean);
  const averageReach = expressivePoints.length
    ? expressivePoints.reduce((total, keypoint) => total + distanceBetween(center, keypoint), 0) /
      expressivePoints.length
    : torsoSize;
  const spread = clamp((averageReach / torsoSize - 0.8) / 1.55, 0, 1);
  const centerVelocity = previousPoseCenter ? distanceBetween(center, previousPoseCenter) / torsoSize : 0;
  const limbVelocity =
    expressivePoints.length && previousExpressivePoints
      ? expressivePoints.reduce((total, keypoint) => {
          const previousKeypoint = previousExpressivePoints[keypoint.name || keypoint.part];
          return total + (previousKeypoint ? distanceBetween(keypoint, previousKeypoint) : 0);
        }, 0) /
        expressivePoints.length /
        torsoSize
      : 0;
  const poseMotion = clamp(centerVelocity * 1.55 + Math.abs(spread - fieldState.spread) * 1.35 + limbVelocity * 0.08, 0, 1);
  const beatEnergy = clamp(poseMotion * 0.7 + spread * 0.3, 0, 1);
  const rhythm = clamp(lerp(fieldState.rhythm, Math.max(beatEnergy - previousBeatEnergy, 0) * 3.5, 0.45), 0, 1);

  previousPoseCenter = center;
  previousExpressivePoints = Object.fromEntries(
    expressivePoints.map((keypoint) => [keypoint.name || keypoint.part, { x: keypoint.x, y: keypoint.y }]),
  );
  previousBeatEnergy = beatEnergy;

  return {
    x: video.videoWidth ? center.x / video.videoWidth * 2 - 1 : fallbackMetrics.x,
    y: video.videoHeight ? center.y / video.videoHeight * 2 - 1 : fallbackMetrics.y,
    motion: clamp(fallbackMetrics.motion * 0.35 + poseMotion * 0.65, 0, 1),
    brightness: fallbackMetrics.brightness,
    poseScore,
    spread,
    rhythm,
  };
};

const sizePoseCanvas = () => {
  const pixelRatio = window.devicePixelRatio || 1;
  const width = Math.round((poseCanvas.clientWidth || window.innerWidth) * pixelRatio);
  const height = Math.round((poseCanvas.clientHeight || window.innerHeight) * pixelRatio);

  if (poseCanvas.width !== width || poseCanvas.height !== height) {
    poseCanvas.width = width;
    poseCanvas.height = height;
  }
};

const mapVideoPointToCanvas = (keypoint) => {
  const videoWidth = video.videoWidth || poseCanvas.width;
  const videoHeight = video.videoHeight || poseCanvas.height;
  const scale = Math.max(poseCanvas.width / videoWidth, poseCanvas.height / videoHeight);
  const offsetX = (poseCanvas.width - videoWidth * scale) / 2;
  const offsetY = (poseCanvas.height - videoHeight * scale) / 2;

  return {
    x: keypoint.x * scale + offsetX,
    y: keypoint.y * scale + offsetY,
  };
};

const drawPose = (pose) => {
  sizePoseCanvas();
  poseContext.clearRect(0, 0, poseCanvas.width, poseCanvas.height);

  if (!pose || getConfidentKeypoints(pose).length < 5) {
    return;
  }

  poseContext.save();
  poseContext.lineCap = "round";
  poseContext.lineJoin = "round";
  poseContext.shadowColor = "rgba(85, 241, 200, 0.72)";
  poseContext.shadowBlur = 14;

  skeletonPairs.forEach(([fromName, toName]) => {
    const from = getKeypoint(pose, fromName);
    const to = getKeypoint(pose, toName);

    if (!from || !to || (from.score ?? 0) < minKeypointScore || (to.score ?? 0) < minKeypointScore) {
      return;
    }

    poseContext.strokeStyle = "rgba(85, 241, 200, 0.78)";
    poseContext.lineWidth = 4;
    poseContext.beginPath();
    const fromPoint = mapVideoPointToCanvas(from);
    const toPoint = mapVideoPointToCanvas(to);

    poseContext.moveTo(fromPoint.x, fromPoint.y);
    poseContext.lineTo(toPoint.x, toPoint.y);
    poseContext.stroke();
  });

  getConfidentKeypoints(pose).forEach((keypoint) => {
    const point = mapVideoPointToCanvas(keypoint);

    poseContext.fillStyle = "rgba(237, 247, 251, 0.92)";
    poseContext.beginPath();
    poseContext.arc(point.x, point.y, 5 * (window.devicePixelRatio || 1), 0, Math.PI * 2);
    poseContext.fill();
  });

  poseContext.restore();
};

const blendState = (targetState) => {
  fieldState = {
    x: lerp(fieldState.x, targetState.x, 0.18),
    y: lerp(fieldState.y, targetState.y, 0.18),
    motion: lerp(fieldState.motion, targetState.motion, 0.22),
    brightness: lerp(fieldState.brightness, targetState.brightness, 0.16),
    poseScore: lerp(fieldState.poseScore, targetState.poseScore, 0.2),
    spread: lerp(fieldState.spread, targetState.spread, 0.2),
    rhythm: lerp(fieldState.rhythm, targetState.rhythm, 0.2),
  };
};

const analyzeFrame = async () => {
  if (!isRunning) {
    return;
  }

  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    animationId = requestAnimationFrame(() => {
      analyzeFrame();
    });
    return;
  }

  const fallbackMetrics = readBrightnessAndMotion();
  let pose;
  let targetState = {
    ...fallbackMetrics,
    poseScore: 0,
    spread: 0,
    rhythm: lerp(fieldState.rhythm, 0, 0.08),
  };

  if (usePoseModel && detector) {
    try {
      [pose] = await detector.estimatePoses(video, {
        flipHorizontal: false,
        maxPoses: 1,
      });

      if (pose) {
        targetState = decodePose(pose, fallbackMetrics);
        setModelStatus("MoveNet");
      } else {
        previousPoseCenter = undefined;
        setModelStatus("搜寻中");
      }
    } catch (error) {
      console.error(error);
      usePoseModel = false;
      setModelStatus("回退");
      setStatus("姿态模型暂停，正在使用像素运动回退。");
    }
  }

  drawPose(pose);
  blendState(targetState);
  updateInterface(fieldState);
  animationId = requestAnimationFrame(() => {
    analyzeFrame();
  });
};

const resetRuntimeState = () => {
  previousFrame = undefined;
  previousPoseCenter = undefined;
  previousExpressivePoints = undefined;
  previousBeatEnergy = 0;
  fieldState = {
    x: 0,
    y: 0,
    motion: 0,
    brightness: 0,
    poseScore: 0,
    spread: 0,
    rhythm: 0,
  };
  poseContext.clearRect(0, 0, poseCanvas.width, poseCanvas.height);
  updateInterface(fieldState);
};

const stop = () => {
  isRunning = false;
  cancelAnimationFrame(animationId);
  stream?.getTracks().forEach((track) => track.stop());
  stream = undefined;
  video.srcObject = null;
  startButton.disabled = false;
  muteButton.disabled = true;
  startButton.textContent = "进入声场";
  setRunningChrome(false);

  if (masterGain && audioContext) {
    masterGain.gain.setTargetAtTime(0, audioContext.currentTime, 0.05);
  }

  resetRuntimeState();
  setModelStatus(usePoseModel ? "MoveNet" : "回退");
  setStatus("已停止，点击按钮可重新进入。");
};

const start = async () => {
  if (isRunning) {
    stop();
    return;
  }

  try {
    startButton.disabled = true;
    setStatus("正在请求摄像头与音频权限...");
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
    sizePoseCanvas();
    resetRuntimeState();

    try {
      setStatus("正在加载端侧 MoveNet 姿态模型...");
      setModelStatus("加载中");
      await loadPoseDetector();
      usePoseModel = true;
      setStatus("运行中：MoveNet 正在本地解码舞蹈姿态。");
      setModelStatus("MoveNet");
    } catch (error) {
      console.error(error);
      usePoseModel = false;
      setStatus("运行中：姿态模型不可用，已切换像素运动回退。");
      setModelStatus("回退");
    }

    isRunning = true;
    setMuted(false);
    setRunningChrome(true);
    startButton.disabled = false;
    startButton.textContent = "退出";
    muteButton.disabled = false;
    analyzeFrame();
  } catch (error) {
    console.error(error);
    startButton.disabled = false;
    muteButton.disabled = true;
    startButton.textContent = "进入声场";
    setModelStatus("待机");
    setRunningChrome(false);
    setStatus("无法启动。请确认使用 HTTPS/localhost，并允许摄像头权限。");
  }
};

if (!("mediaDevices" in navigator) || !("getUserMedia" in navigator.mediaDevices)) {
  startButton.disabled = true;
  setStatus("当前浏览器不支持摄像头输入，请使用最新版 Safari、Chrome 或 Edge。");
}

window.addEventListener("resize", sizePoseCanvas);

startButton.addEventListener("click", () => {
  if (isRunning) {
    stop();
    return;
  }

  start();
});

muteButton.addEventListener("click", () => {
  setMuted(!isMuted);
});
