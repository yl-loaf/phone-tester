(() => {
  "use strict";

  // ---------- Power estimation (rough) ----------
  const POWER = {
    torch: 1.2,
    camera: 1.8,
    vibrate: 0.9,
    download: 1.5,
    gpu: 2.5,
    tone: 0.4,
  };

  const active = {
    torch: false,
    camera: false,
    vibrate: false,
    download: false,
    gpu: false,
    tone: false,
  };

  function updatePower() {
    let total = 0.3;
    for (const k of Object.keys(POWER)) {
      if (active[k]) total += POWER[k];
    }
    document.getElementById("powerWatts").textContent = total.toFixed(1);
  }

  // ---------- Torch ----------
  let torchStream = null;
  let torchTrack = null;

  async function setTorch(on) {
    const status = document.getElementById("torchStatus");
    try {
      if (on) {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        torchStream = stream;
        torchTrack = stream.getVideoTracks()[0];

        const capabilities = torchTrack.getCapabilities?.() || {};
        if (capabilities.torch) {
          await torchTrack.applyConstraints({
            advanced: [{ torch: true }],
          });
          if (capabilities.brightness) {
            try {
              await torchTrack.applyConstraints({
                advanced: [{ brightness: capabilities.brightness.max }],
              });
            } catch (_) {}
          }
          status.textContent = "On (max brightness)";
          status.className = "status on";
          active.torch = true;
        } else {
          status.textContent = "Camera open — torch not supported on this device/browser";
          status.className = "status warn";
          active.torch = true;
        }
      } else {
        if (torchTrack) {
          try {
            await torchTrack.applyConstraints({ advanced: [{ torch: false }] });
          } catch (_) {}
          torchTrack.stop();
        }
        if (torchStream) {
          torchStream.getTracks().forEach((t) => t.stop());
        }
        torchStream = null;
        torchTrack = null;
        status.textContent = "Off";
        status.className = "status";
        active.torch = false;
      }
    } catch (err) {
      status.textContent = "Error: " + (err.message || err.name);
      status.className = "status warn";
      document.getElementById("torchToggle").checked = false;
      active.torch = false;
    }
    updatePower();
  }

  document.getElementById("torchToggle").addEventListener("change", (e) => {
    setTorch(e.target.checked);
  });

  // ---------- Camera (rear) ----------
  let cameraStream = null;

  async function setCamera(on) {
    const video = document.getElementById("cameraPreview");
    const wrap = document.querySelector(".camera-wrap");
    const status = document.getElementById("cameraStatus");

    try {
      if (on) {
        cameraStream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
        video.srcObject = cameraStream;
        wrap.classList.add("active");
        status.textContent = "Rear camera active";
        status.className = "status on";
        active.camera = true;
      } else {
        if (cameraStream) {
          cameraStream.getTracks().forEach((t) => t.stop());
          cameraStream = null;
        }
        video.srcObject = null;
        wrap.classList.remove("active");
        status.textContent = "Off";
        status.className = "status";
        active.camera = false;
      }
    } catch (err) {
      status.textContent = "Error: " + (err.message || err.name);
      status.className = "status warn";
      document.getElementById("cameraToggle").checked = false;
      active.camera = false;
    }
    updatePower();
  }

  document.getElementById("cameraToggle").addEventListener("change", (e) => {
    setCamera(e.target.checked);
  });

  // ---------- Vibration ----------
  let vibrateTimer = null;

  function setVibrate(on) {
    const status = document.getElementById("vibrateStatus");
    if (on) {
      if (!navigator.vibrate) {
        status.textContent = "Vibration not supported";
        status.className = "status warn";
        document.getElementById("vibrateToggle").checked = false;
        return;
      }
      const pattern = [200, 50];
      navigator.vibrate(pattern);
      vibrateTimer = setInterval(() => {
        navigator.vibrate(pattern);
      }, 250);
      status.textContent = "Vibrating…";
      status.className = "status on";
      active.vibrate = true;
    } else {
      if (vibrateTimer) {
        clearInterval(vibrateTimer);
        vibrateTimer = null;
      }
      if (navigator.vibrate) navigator.vibrate(0);
      status.textContent = "Off";
      status.className = "status";
      active.vibrate = false;
    }
    updatePower();
  }

  document.getElementById("vibrateToggle").addEventListener("change", (e) => {
    setVibrate(e.target.checked);
  });

  // ---------- Network download stress ----------
  const DOWNLOAD_URLS = [
    "https://speed.cloudflare.com/__down?bytes=25000000",
    "https://proof.ovh.net/files/10Mb.dat",
    "https://ash-speed.hetzner.com/100MB.bin",
  ];

  let downloadAbort = null;
  let downloadBytes = 0;
  let downloadStart = 0;

  function formatMB(bytes) {
    return (bytes / (1024 * 1024)).toFixed(1);
  }

  async function runDownloadLoop(durationSec) {
    const status = document.getElementById("downloadStatus");
    downloadAbort = new AbortController();
    downloadBytes = 0;
    downloadStart = performance.now();
    active.download = true;
    updatePower();

    const endAt = durationSec > 0 ? downloadStart + durationSec * 1000 : Infinity;

    const updateStatus = () => {
      const elapsed = ((performance.now() - downloadStart) / 1000).toFixed(0);
      status.textContent = `Downloading… ${formatMB(downloadBytes)} MB · ${elapsed}s`;
      status.className = "status on";
    };

    let urlIndex = 0;

    try {
      while (performance.now() < endAt && !downloadAbort.signal.aborted) {
        const url = DOWNLOAD_URLS[urlIndex % DOWNLOAD_URLS.length] + "&t=" + Date.now();
        urlIndex++;

        try {
          const res = await fetch(url, {
            signal: downloadAbort.signal,
            cache: "no-store",
            mode: "cors",
          });
          if (!res.ok && res.status !== 0) continue;

          const reader = res.body?.getReader();
          if (reader) {
            while (true) {
              if (performance.now() >= endAt || downloadAbort.signal.aborted) break;
              const { done, value } = await reader.read();
              if (done) break;
              downloadBytes += value.byteLength;
              updateStatus();
            }
            try { reader.cancel(); } catch (_) {}
          } else {
            const buf = await res.arrayBuffer();
            downloadBytes += buf.byteLength;
            updateStatus();
          }
        } catch (err) {
          if (err.name === "AbortError") break;
          // Fallback: local memory traffic
          const size = 8 * 1024 * 1024;
          const buffer = new ArrayBuffer(size);
          const view = new Uint8Array(buffer);
          for (let i = 0; i < size; i += 4096) view[i] = i & 0xff;
          downloadBytes += size;
          updateStatus();
          const blob = new Blob([buffer]);
          const objUrl = URL.createObjectURL(blob);
          try {
            await fetch(objUrl, { signal: downloadAbort.signal });
          } catch (_) {}
          URL.revokeObjectURL(objUrl);
          await new Promise((r) => setTimeout(r, 50));
        }
      }
    } finally {
      active.download = false;
      updatePower();
      const elapsed = ((performance.now() - downloadStart) / 1000).toFixed(0);
      status.textContent = `Stopped — ${formatMB(downloadBytes)} MB in ${elapsed}s`;
      status.className = "status";
      document.getElementById("downloadToggle").checked = false;
      downloadAbort = null;
    }
  }

  function stopDownload() {
    if (downloadAbort) downloadAbort.abort();
  }

  document.getElementById("downloadToggle").addEventListener("change", (e) => {
    if (e.target.checked) {
      const dur = parseInt(document.getElementById("downloadDuration").value, 10) || 0;
      runDownloadLoop(dur);
    } else {
      stopDownload();
    }
  });

  // ---------- GPU Fractal (Julia set) with FPS ----------
  const canvas = document.getElementById("fractalCanvas");
  const ctx = canvas.getContext("2d", { alpha: false });
  let gpuAnimId = null;
  let lastFpsTime = 0;
  let frameCount = 0;
  let fps = 0;
  let time = 0;

  const W = 320;
  const H = 320;
  canvas.width = W;
  canvas.height = H;

  const imageData = ctx.createImageData(W, H);
  const data = imageData.data;

  function renderFractal(t) {
    const cx = Math.sin(t * 0.7) * 0.6;
    const cy = Math.cos(t * 0.5) * 0.5;
    const maxIter = 48;
    const scale = 2.6 / W;

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let zx = (x - W / 2) * scale;
        let zy = (y - H / 2) * scale;
        let i = 0;
        while (zx * zx + zy * zy < 4 && i < maxIter) {
          const tmp = zx * zx - zy * zy + cx;
          zy = 2 * zx * zy + cy;
          zx = tmp;
          i++;
        }
        const idx = (y * W + x) * 4;
        if (i === maxIter) {
          data[idx] = 0;
          data[idx + 1] = 0;
          data[idx + 2] = 0;
        } else {
          const v = i / maxIter;
          data[idx] = Math.floor(20 + v * 180);
          data[idx + 1] = Math.floor(40 + Math.sin(v * 12 + t) * 80 + 80);
          data[idx + 2] = Math.floor(120 + v * 135);
        }
        data[idx + 3] = 255;
      }
    }
    ctx.putImageData(imageData, 0, 0);
  }

  function gpuLoop(now) {
    time += 0.016;
    renderFractal(time);

    frameCount++;
    if (now - lastFpsTime >= 1000) {
      fps = Math.round((frameCount * 1000) / (now - lastFpsTime));
      document.getElementById("fpsCounter").textContent = fps;
      frameCount = 0;
      lastFpsTime = now;
    }

    gpuAnimId = requestAnimationFrame(gpuLoop);
  }

  function setGpu(on) {
    if (on) {
      lastFpsTime = performance.now();
      frameCount = 0;
      time = 0;
      active.gpu = true;
      updatePower();
      gpuAnimId = requestAnimationFrame(gpuLoop);
    } else {
      if (gpuAnimId) {
        cancelAnimationFrame(gpuAnimId);
        gpuAnimId = null;
      }
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
      document.getElementById("fpsCounter").textContent = "0";
      active.gpu = false;
      updatePower();
    }
  }

  document.getElementById("gpuToggle").addEventListener("change", (e) => {
    setGpu(e.target.checked);
  });

  // ---------- Tone generator ----------
  let audioCtx = null;
  let oscillator = null;
  let gainNode = null;

  function ensureAudio() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }
  }

  function setTone(on) {
    const status = document.getElementById("toneStatus");
    const freq = parseFloat(document.getElementById("freqSlider").value);
    const vol = parseFloat(document.getElementById("volSlider").value) / 100;

    if (on) {
      ensureAudio();
      if (oscillator) {
        try { oscillator.stop(); } catch (_) {}
        oscillator.disconnect();
      }
      oscillator = audioCtx.createOscillator();
      gainNode = audioCtx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = freq;
      gainNode.gain.value = vol * 0.5;
      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      oscillator.start();
      status.textContent = `Playing ${freq} Hz`;
      status.className = "status on";
      active.tone = true;
    } else {
      if (oscillator) {
        try { oscillator.stop(); } catch (_) {}
        oscillator.disconnect();
        oscillator = null;
      }
      if (gainNode) {
        gainNode.disconnect();
        gainNode = null;
      }
      status.textContent = "Off";
      status.className = "status";
      active.tone = false;
    }
    updatePower();
  }

  document.getElementById("toneToggle").addEventListener("change", (e) => {
    setTone(e.target.checked);
  });

  document.getElementById("freqSlider").addEventListener("input", (e) => {
    const v = e.target.value;
    document.getElementById("freqValue").textContent = v;
    if (oscillator && active.tone) {
      oscillator.frequency.setValueAtTime(parseFloat(v), audioCtx.currentTime);
      document.getElementById("toneStatus").textContent = `Playing ${v} Hz`;
    }
  });

  document.getElementById("volSlider").addEventListener("input", (e) => {
    const v = e.target.value;
    document.getElementById("volValue").textContent = v;
    if (gainNode && active.tone) {
      gainNode.gain.setValueAtTime((parseFloat(v) / 100) * 0.5, audioCtx.currentTime);
    }
  });

  // ---------- Cleanup ----------
  window.addEventListener("pagehide", () => {
    stopDownload();
    setVibrate(false);
    setTorch(false);
    setCamera(false);
    setGpu(false);
    setTone(false);
  });

  updatePower();
})();
