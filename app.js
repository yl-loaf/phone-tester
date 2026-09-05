(() => {
  "use strict";

  // ---------- Power estimation (rough) ----------
  // Approximate incremental draw in watts when each feature is active.
  // These are educated guesses for a typical modern phone.
  const POWER = {
    torch: 1.2,      // LED flashlight
    camera: 1.8,     // camera pipeline + ISP
    vibrate: 0.9,    // haptic motor continuous
    download: 1.5,   // radio + modem under load
    gpu: 3.5,        // heavy GPU (canvas or WebGL volume)
    tone: 0.4,       // speaker / audio amp
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
    let total = 0.3; // baseline idle-ish browser
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
        // Prefer a dedicated stream for torch so it can stay on independently
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            // Some browsers accept torch in constraints
          },
          audio: false,
        });
        torchStream = stream;
        torchTrack = stream.getVideoTracks()[0];

        const capabilities = torchTrack.getCapabilities?.() || {};
        if (capabilities.torch) {
          await torchTrack.applyConstraints({
            advanced: [{ torch: true }],
          });
          // Try to push brightness if supported (rare)
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
          // Fallback: keep stream alive; torch may not be controllable
          status.textContent = "Camera open — torch not supported on this device/browser";
          status.className = "status warn";
          active.torch = true; // still costs camera power
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
      // Continuous-ish: vibrate pattern that restarts
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
  // Public large-ish files that support range / repeated fetch.
  // We use multiple sources and also generate dummy downloads via blob URLs.
  const DOWNLOAD_URLS = [
    // Cloudflare / common CDNs often allow CORS or at least partial
    "https://speed.cloudflare.com/__down?bytes=25000000", // 25 MB
    "https://proof.ovh.net/files/10Mb.dat",
    "https://ash-speed.hetzner.com/100MB.bin",
  ];

  let downloadAbort = null;
  let downloadBytes = 0;
  let downloadStart = 0;
  let downloadTimeout = null;
  // Rolling window for instantaneous-ish speed
  let speedWindowBytes = 0;
  let speedWindowStart = 0;

  function formatMB(bytes) {
    return (bytes / (1024 * 1024)).toFixed(1);
  }

  function formatMbPerSec(bytesPerSec) {
    // Mb/s = megabits per second
    return ((bytesPerSec * 8) / 1e6).toFixed(1);
  }

  async function runDownloadLoop(durationSec) {
    const status = document.getElementById("downloadStatus");
    downloadAbort = new AbortController();
    downloadBytes = 0;
    downloadStart = performance.now();
    speedWindowBytes = 0;
    speedWindowStart = downloadStart;
    active.download = true;
    updatePower();

    const endAt = durationSec > 0 ? downloadStart + durationSec * 1000 : Infinity;

    const updateStatus = () => {
      const now = performance.now();
      const elapsedSec = (now - downloadStart) / 1000;
      const windowSec = (now - speedWindowStart) / 1000;

      // Reset rolling window every ~1.5s for responsive speed
      if (windowSec >= 1.5) {
        speedWindowBytes = 0;
        speedWindowStart = now;
      }

      const avgBytesPerSec = elapsedSec > 0.05 ? downloadBytes / elapsedSec : 0;
      const instBytesPerSec = windowSec > 0.05 ? speedWindowBytes / windowSec : avgBytesPerSec;
      const speed = formatMbPerSec(instBytesPerSec || avgBytesPerSec);

      status.textContent =
        `Downloading… ${formatMB(downloadBytes)} MB · ${speed} Mb/s · ${elapsedSec.toFixed(0)}s`;
      status.className = "status on";
    };

    let urlIndex = 0;
    // Keep multiple downloads in flight so traffic never pauses between requests
    const CONCURRENCY = 4;

    async function oneDownload() {
      while (performance.now() < endAt && !downloadAbort.signal.aborted) {
        const url = DOWNLOAD_URLS[urlIndex % DOWNLOAD_URLS.length] + "&t=" + Date.now() + "&r=" + Math.random();
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
              if (performance.now() >= endAt || downloadAbort.signal.aborted) {
                try { reader.cancel(); } catch (_) {}
                break;
              }
              const { done, value } = await reader.read();
              if (done) break;
              downloadBytes += value.byteLength;
              speedWindowBytes += value.byteLength;
              updateStatus();
            }
          } else {
            const buf = await res.arrayBuffer();
            downloadBytes += buf.byteLength;
            speedWindowBytes += buf.byteLength;
            updateStatus();
          }
        } catch (err) {
          if (err.name === "AbortError") return;
          // Fallback: local memory churn — no delay, loop immediately
          const size = 16 * 1024 * 1024;
          const buffer = new ArrayBuffer(size);
          const view = new Uint8Array(buffer);
          for (let i = 0; i < size; i += 2048) view[i] = i & 0xff;
          downloadBytes += size;
          speedWindowBytes += size;
          updateStatus();
          const blob = new Blob([buffer]);
          const objUrl = URL.createObjectURL(blob);
          try {
            await fetch(objUrl, { signal: downloadAbort.signal, cache: "no-store" });
          } catch (_) {}
          URL.revokeObjectURL(objUrl);
          // no sleep — immediately start next chunk
        }
      }
    }

    try {
      // Launch concurrent workers so bandwidth stays saturated
      await Promise.all(
        Array.from({ length: CONCURRENCY }, () => oneDownload())
      );
    } finally {
      active.download = false;
      updatePower();
      const elapsedSec = (performance.now() - downloadStart) / 1000;
      const avgSpeed = elapsedSec > 0 ? formatMbPerSec(downloadBytes / elapsedSec) : "0.0";
      status.textContent =
        `Stopped — ${formatMB(downloadBytes)} MB · avg ${avgSpeed} Mb/s · ${elapsedSec.toFixed(0)}s`;
      status.className = "status";
      document.getElementById("downloadToggle").checked = false;
      downloadAbort = null;
    }
  }

  function stopDownload() {
    if (downloadAbort) {
      downloadAbort.abort();
    }
    if (downloadTimeout) {
      clearTimeout(downloadTimeout);
      downloadTimeout = null;
    }
  }

  document.getElementById("downloadToggle").addEventListener("change", (e) => {
    if (e.target.checked) {
      const dur = parseInt(document.getElementById("downloadDuration").value, 10) || 0;
      runDownloadLoop(dur);
    } else {
      stopDownload();
    }
  });

  // ---------- GPU stress: Canvas Julia OR WebGL volume raymarch (lag mode) ----------
  let canvas = document.getElementById("fractalCanvas");
  let ctx2d = null;
  let gl = null;
  let gpuAnimId = null;
  let lastFpsTime = 0;
  let frameCount = 0;
  let fps = 0;
  let time = 0;
  let gpuMode = "canvas"; // "canvas" | "webgl"

  // Canvas dynamic load
  let loadLevel = 40;
  let goalFps = 30;
  let currentW = 160;
  let currentH = 160;
  let maxIter = 32;
  let imageData = null;
  let data = null;

  // WebGL state — adaptive load toward goal FPS
  let glProgram = null;
  let glTimeLoc = null;
  let glResLoc = null;
  let glStepsLoc = null;
  let glBuf = null;
  let webglLoad = 70; // 0–100, drives resolution scale + ray steps + passes
  let webglSteps = 160;
  let webglScale = 1.2;
  let webglPasses = 2; // extra full-screen draws per frame to saturate GPU

  function resetCanvasElement() {
    // Replace canvas so we can switch between 2d and webgl contexts cleanly
    const parent = canvas.parentNode;
    const next = canvas.cloneNode(false);
    next.width = 400;
    next.height = 400;
    parent.replaceChild(next, canvas);
    canvas = next;
    ctx2d = null;
    gl = null;
    glProgram = null;
  }

  function applyLoadLevel(level) {
    loadLevel = Math.max(5, Math.min(100, level));
    const side = Math.round(160 + (loadLevel / 100) * 800);
    currentW = side;
    currentH = side;
    maxIter = Math.round(32 + (loadLevel / 100) * 288);

    if (!ctx2d) ctx2d = canvas.getContext("2d", { alpha: false });
    canvas.width = currentW;
    canvas.height = currentH;
    imageData = ctx2d.createImageData(currentW, currentH);
    data = imageData.data;

    document.getElementById("loadCounter").textContent =
      Math.round(loadLevel) + "% (" + currentW + "px · " + maxIter + " iter)";
  }

  function renderFractal(t) {
    const cx = Math.sin(t * 0.7) * 0.6;
    const cy = Math.cos(t * 0.5) * 0.5;
    const scale = 2.6 / currentW;
    const W = currentW;
    const H = currentH;
    const iters = maxIter;

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let zx = (x - W / 2) * scale;
        let zy = (y - H / 2) * scale;
        let i = 0;
        while (zx * zx + zy * zy < 4 && i < iters) {
          const tmp = zx * zx - zy * zy + cx;
          zy = 2 * zx * zy + cy;
          zx = tmp;
          i++;
        }
        const idx = (y * W + x) * 4;
        if (i === iters) {
          data[idx] = 0;
          data[idx + 1] = 0;
          data[idx + 2] = 0;
        } else {
          const v = i / iters;
          data[idx] = Math.floor(20 + v * 180);
          data[idx + 1] = Math.floor(40 + Math.sin(v * 12 + t) * 80 + 80);
          data[idx + 2] = Math.floor(120 + v * 135);
        }
        data[idx + 3] = 255;
      }
    }
    ctx2d.putImageData(imageData, 0, 0);
  }

  function adjustLoadTowardGoal() {
    if (fps <= 0) return;
    const error = goalFps - fps;
    if (Math.abs(error) < 2) return;
    const step = Math.max(1, Math.min(8, Math.abs(error) * 0.6));
    if (error < 0) applyLoadLevel(loadLevel + step);
    else applyLoadLevel(loadLevel - step);
  }

  // ---- WebGL volume raymarch — heavy GPU load, adaptive to goal FPS ----
  const VERT_SRC = `
    attribute vec2 a_pos;
    void main() {
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  `;

  // Very heavy fragment: high-iter Mandelbulb DE + soft shadow + AO
  const FRAG_SRC = `
    precision highp float;
    uniform float u_time;
    uniform vec2 u_res;
    uniform float u_steps;

    float mandelbulb(vec3 pos) {
      vec3 z = pos;
      float dr = 1.0;
      float r = 0.0;
      const float power = 8.0;
      // 24 DE iterations — expensive trig per step
      for (int i = 0; i < 24; i++) {
        r = length(z);
        if (r > 2.0) break;
        float theta = acos(clamp(z.z / r, -1.0, 1.0));
        float phi = atan(z.y, z.x);
        dr = pow(r, power - 1.0) * power * dr + 1.0;
        float zr = pow(r, power);
        theta *= power;
        phi *= power;
        z = zr * vec3(sin(theta) * cos(phi), sin(theta) * sin(phi), cos(theta));
        z += pos;
      }
      return 0.5 * log(r) * r / max(dr, 1e-6);
    }

    float map(vec3 p) {
      float a = u_time * 0.3;
      float c = cos(a), s = sin(a);
      p.xz = mat2(c, -s, s, c) * p.xz;
      float b = u_time * 0.17;
      float cb = cos(b), sb = sin(b);
      p.xy = mat2(cb, -sb, sb, cb) * p.xy;
      return mandelbulb(p);
    }

    vec3 calcNormal(vec3 p) {
      const float e = 0.0008;
      return normalize(vec3(
        map(p + vec3(e, 0.0, 0.0)) - map(p - vec3(e, 0.0, 0.0)),
        map(p + vec3(0.0, e, 0.0)) - map(p - vec3(0.0, e, 0.0)),
        map(p + vec3(0.0, 0.0, e)) - map(p - vec3(0.0, 0.0, e))
      ));
    }

    // Soft shadow = more map() calls
    float softShadow(vec3 ro, vec3 rd) {
      float res = 1.0;
      float t = 0.02;
      for (int i = 0; i < 16; i++) {
        float h = map(ro + rd * t);
        res = min(res, 8.0 * h / t);
        t += clamp(h, 0.02, 0.2);
        if (res < 0.01 || t > 4.0) break;
      }
      return clamp(res, 0.0, 1.0);
    }

    float ao(vec3 p, vec3 n) {
      float occ = 0.0;
      float sca = 1.0;
      for (int i = 0; i < 5; i++) {
        float hr = 0.01 + 0.12 * float(i);
        float dd = map(p + n * hr);
        occ += (hr - dd) * sca;
        sca *= 0.85;
      }
      return clamp(1.0 - 2.0 * occ, 0.0, 1.0);
    }

    void main() {
      vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / min(u_res.x, u_res.y);
      vec3 ro = vec3(0.0, 0.0, 3.0);
      vec3 rd = normalize(vec3(uv, -1.35));

      float t = 0.0;
      float d;
      int hit = 0;
      // Hard upper bound 400; runtime steps from uniform
      for (int i = 0; i < 400; i++) {
        if (float(i) >= u_steps) break;
        vec3 p = ro + rd * t;
        d = map(p);
        if (d < 0.0015) { hit = 1; break; }
        t += d * 0.85;
        if (t > 14.0) break;
      }

      vec3 col = vec3(0.015, 0.015, 0.04);
      if (hit == 1) {
        vec3 p = ro + rd * t;
        vec3 n = calcNormal(p);
        vec3 light = normalize(vec3(0.55, 0.85, 0.35));
        float diff = max(dot(n, light), 0.0);
        float sh = softShadow(p + n * 0.01, light);
        float occ = ao(p, n);
        float fre = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
        vec3 base = 0.5 + 0.5 * cos(vec3(0.0, 2.1, 4.2) + length(p) * 2.2 + u_time);
        col = base * (0.12 + 0.88 * diff * sh) * occ + fre * 0.45;
      } else {
        col += 0.05 * vec3(0.15, 0.25, 0.55) * (1.0 - length(uv));
      }
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  function compileShader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn(gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  }

  function applyWebglLoad(level) {
    webglLoad = Math.max(10, Math.min(100, level));
    // scale: 0.7 → 2.0 (pixel count grows fast)
    webglScale = 0.7 + (webglLoad / 100) * 1.3;
    // ray steps: 64 → 320
    webglSteps = Math.round(64 + (webglLoad / 100) * 256);
    // extra full-screen passes: 1 → 4
    webglPasses = Math.max(1, Math.round(1 + (webglLoad / 100) * 3));

    if (!gl) return;

    const cssW = Math.min(window.innerWidth - 28, 480);
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.round(cssW * dpr * webglScale);
    const h = Math.round(cssW * dpr * webglScale);
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = cssW + "px";
    canvas.style.height = cssW + "px";
    gl.viewport(0, 0, w, h);
    if (glResLoc) gl.uniform2f(glResLoc, w, h);
    if (glStepsLoc) gl.uniform1f(glStepsLoc, webglSteps);

    document.getElementById("loadCounter").textContent =
      Math.round(webglLoad) + "% (" + w + "px · " + webglSteps + " steps · ×" + webglPasses + ")";
  }

  function adjustWebglTowardGoal() {
    if (fps <= 0) return;
    const error = goalFps - fps;
    // Tighter dead zone for low goal FPS
    if (Math.abs(error) < 1.5) return;
    const step = Math.max(2, Math.min(12, Math.abs(error) * 1.2));
    if (error < 0) applyWebglLoad(webglLoad + step); // too fast → heavier
    else applyWebglLoad(webglLoad - step);
  }

  function initWebGL() {
    resetCanvasElement();
    gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
    }) || canvas.getContext("experimental-webgl");
    if (!gl) return false;

    const vs = compileShader(gl.VERTEX_SHADER, VERT_SRC);
    const fs = compileShader(gl.FRAGMENT_SHADER, FRAG_SRC);
    if (!vs || !fs) return false;

    glProgram = gl.createProgram();
    gl.attachShader(glProgram, vs);
    gl.attachShader(glProgram, fs);
    gl.linkProgram(glProgram);
    if (!gl.getProgramParameter(glProgram, gl.LINK_STATUS)) {
      console.warn(gl.getProgramInfoLog(glProgram));
      return false;
    }
    gl.useProgram(glProgram);

    glTimeLoc = gl.getUniformLocation(glProgram, "u_time");
    glResLoc = gl.getUniformLocation(glProgram, "u_res");
    glStepsLoc = gl.getUniformLocation(glProgram, "u_steps");

    const posLoc = gl.getAttribLocation(glProgram, "a_pos");
    glBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, glBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1
    ]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    // Start aggressive so low goal FPS is reachable
    applyWebglLoad(goalFps <= 10 ? 90 : goalFps <= 20 ? 75 : 55);
    return true;
  }

  function renderWebGL(t) {
    if (!gl || !glProgram) return;
    gl.uniform1f(glTimeLoc, t);
    // Multiple passes = more GPU time per displayed frame
    for (let i = 0; i < webglPasses; i++) {
      gl.uniform1f(glTimeLoc, t + i * 0.01);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
  }

  function gpuLoop(now) {
    time += 0.016;
    if (gpuMode === "webgl") {
      renderWebGL(time);
    } else {
      renderFractal(time);
    }

    frameCount++;
    if (now - lastFpsTime >= 500) {
      fps = Math.round((frameCount * 1000) / (now - lastFpsTime));
      document.getElementById("fpsCounter").textContent = fps;
      frameCount = 0;
      lastFpsTime = now;
      if (gpuMode === "canvas") adjustLoadTowardGoal();
      else adjustWebglTowardGoal();
    }

    gpuAnimId = requestAnimationFrame(gpuLoop);
  }

  function updateModeUI() {
    const mode = document.getElementById("gpuMode").value;
    document.getElementById("goalFpsLabel").textContent = String(goalFps);
    document.getElementById("gpuHint").textContent = mode === "webgl"
      ? "WebGL volume raymarch. Load auto-scales to goal FPS — lower goal = harder lag. Close tab to stop."
      : "Canvas Julia set. Load auto-adjusts toward goal FPS.";
  }

  function setGpu(on) {
    if (on) {
      gpuMode = document.getElementById("gpuMode").value || "canvas";
      goalFps = parseInt(document.getElementById("goalFpsSlider").value, 10) || 15;
      updateModeUI();

      if (gpuMode === "webgl") {
        if (!initWebGL()) {
          document.getElementById("loadCounter").textContent = "WebGL not supported";
          document.getElementById("gpuToggle").checked = false;
          return;
        }
      } else {
        resetCanvasElement();
        applyLoadLevel(40);
      }

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
      if (gl) {
        const lose = gl.getExtension("WEBGL_lose_context");
        if (lose) lose.loseContext();
        gl = null;
      }
      resetCanvasElement();
      document.getElementById("fpsCounter").textContent = "0";
      document.getElementById("loadCounter").textContent = "—";
      active.gpu = false;
      updatePower();
    }
  }

  document.getElementById("gpuToggle").addEventListener("change", (e) => {
    setGpu(e.target.checked);
  });

  document.getElementById("goalFpsSlider").addEventListener("input", (e) => {
    const v = parseInt(e.target.value, 10);
    goalFps = v;
    document.getElementById("goalFpsValue").textContent = v;
    document.getElementById("goalFpsLabel").textContent = v;
  });

  document.getElementById("gpuMode").addEventListener("change", () => {
    updateModeUI();
    if (document.getElementById("gpuToggle").checked) {
      setGpu(false);
      setGpu(true);
    }
  });

  window.addEventListener("resize", () => {
    if (active.gpu && gpuMode === "webgl") applyWebglLoad(webglLoad);
  });

  goalFps = 15;
  updateModeUI();

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
      gainNode.gain.value = vol * 0.5; // keep headroom
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

  // ---------- Cleanup on page hide ----------
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      // Optional: you can leave stressors running intentionally
    }
  });

  window.addEventListener("pagehide", () => {
    stopDownload();
    setVibrate(false);
    setTorch(false);
    setCamera(false);
    setGpu(false);
    setTone(false);
  });

  // Initial power
  updatePower();

  // ---------- Auto-update (detect new deploy without hard refresh) ----------
  // Bump BUILD_ID whenever you push a new version to GitHub Pages.
  const BUILD_ID = "5";
  const CHECK_EVERY_MS = 45_000;

  async function checkForUpdate() {
    try {
      // Fetch index.html with cache-bust so we always see the latest deploy
      const res = await fetch("index.html?_=" + Date.now(), { cache: "no-store" });
      if (!res.ok) return;
      const html = await res.text();
      // Look for styles.css?v=N or app.js?v=N or buildTag text
      const match = html.match(/[?&]v=(\d+)/) || html.match(/build-tag[^>]*>v?(\d+)/i);
      if (match && match[1] !== BUILD_ID) {
        // Soft reload to pick up new assets
        location.reload();
      }
    } catch (_) {
      // offline / CORS — ignore
    }
  }

  setInterval(checkForUpdate, CHECK_EVERY_MS);
  // Also check when tab becomes visible again
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) checkForUpdate();
  });
})();
