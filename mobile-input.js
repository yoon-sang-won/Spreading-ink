/* ============================================================
   mobile-input.js — Spreading-ink 모바일 센서 인터랙션
   - Tilt : 폰 기울기 → velocity global force
   - Shake: 폰 흔들기 → velocity impulse
   - Blow : 마이크 바람 → velocity gust
   전부 velocity-only. 새 잉크(dye)는 만들지 않는다.
   권한 거부/미지원 시 기존 터치 작품은 그대로 동작.
   ============================================================ */
(() => {
  'use strict';

  /* ---------- config ---------- */
  const CONFIG = {
    motion: {
      gravityAlpha: 0.12,        // low-pass filter 계수 (낮을수록 부드러움)
      calibrationMs: 600,        // 중립 자세 보정 시간
      tiltDeadZone: 0.05,        // 데드존 (normalized)
      tiltMax: 0.35,             // 최대 입력 (normalized)
      tiltForce: 900,            // global force 배율
      tiltUpdateHz: 20,          // GPU 적용 주기
      shakeThreshold: 13,        // m/s² (linear acceleration)
      shakeStrongThreshold: 20,
      shakeCooldownMs: 750,
      shakeDecay: 0.88,          // shake 직후 tilt 감쇠
      shakeImpulseForce: 950,
    },
    blow: {
      fftSize: 1024,
      smoothing: 0.72,
      calibrationMs: 1000,       // ambient baseline 측정 시간
      minDurationMs: 150,        // 후~ 지속 최소 시간
      releaseMs: 300,            // blow 종료 후 서서히 내려감
      rmsMultiplier: 2.2,        // baseline 대비 RMS 배수
      minRms: 0.02,              // 절대 최소 RMS
      attack: 0.25,              // blowStrength 상승률
      decay: 0.92,               // blowStrength 감쇠
      gustForce: 950,            // gust strength 배율
      gpuUpdateHz: 20,           // GPU 적용 주기
      lowHz: 80, midHz: 300, noiseHz: 1200, highHz: 6000,
    },
  };

  /* ---------- state ---------- */
  const state = {
    motion: 'unsupported',   // unsupported|idle|requesting|calibrating|active|denied|error
    blow: 'unsupported',     // unsupported|idle|requesting|calibrating|active|error
    gravity: { x: 0, y: 0, z: 0 },
    neutral: { x: 0, y: 0 },
    tilt: { x: 0, y: 0 },
    shakePending: 0,
    shakeDir: { x: 0, y: 0 },
    shakeCooldownUntil: 0,
    blowStrength: 0,
    blowCandidate: 0,
    blowStart: 0,
    reducedMotion: false,
  };

  let motionHandler = null;
  let motionListening = false;
  let stream = null;
  let audioCtx = null;
  let analyser = null;
  let sourceNode = null;
  let timeData = null;
  let freqData = null;
  let micToken = 0;          // mic race 방지용 generation token
  let rafId = 0;
  let lastMotionUpdate = 0;
  let lastGpuUpdate = 0;
  let lastBlowGpu = 0;
  let baselineRms = 0.001;
  let baselineNoise = 0.001;
  let blowCalibUntil = 0;
  let blowActiveUntil = 0;
  let bandBins = null;
  let btnMotion = null;
  let btnBlow = null;

  const bridge = () => (window.FluidBridge || null);
  const hintEl = () => document.getElementById('hint');

  /* ---------- helpers ---------- */
  function setHint(text, ms) {
    const el = hintEl();
    if (!el) return;
    el.textContent = text;
    if (ms) {
      clearTimeout(setHint._t);
      setHint._t = setTimeout(() => {
        const h = hintEl();
        if (h) h.textContent = '드래그하면 잉크가 흘러요 · 탭하면 잉크 방울';
      }, ms);
    }
  }

  function setMotionState(s) {
    state.motion = s;
    if (!btnMotion) return;
    btnMotion.classList.toggle('on', s === 'active' || s === 'calibrating');
    if (s === 'active') btnMotion.textContent = '◉ 움직임';
    else if (s === 'calibrating') btnMotion.textContent = '움직임 보정…';
    else if (s === 'denied') btnMotion.textContent = '움직임 꺼짐';
    else if (s === 'error') btnMotion.textContent = '움직임 오류';
    else btnMotion.textContent = '○ 움직임';
  }

  function setBlowState(s) {
    state.blow = s;
    if (!btnBlow) return;
    btnBlow.classList.toggle('on', s === 'active' || s === 'calibrating');
    if (s === 'active') btnBlow.textContent = '● 바람';
    else if (s === 'calibrating') btnBlow.textContent = '바람 보정…';
    else if (s === 'error') btnBlow.textContent = '바람 오류';
    else btnBlow.textContent = '○ 바람';
  }

  function rotateDeviceToScreen(x, y) {
    let angle = 0;
    try { angle = (screen.orientation && screen.orientation.angle) || window.orientation || 0; } catch (e) { /* ignore */ }
    const a = ((angle % 360) + 360) % 360;
    if (a === 90) return { x: -y, y: x };
    if (a === 180) return { x: -x, y: -y };
    if (a === 270) return { x: y, y: -x };
    return { x, y };
  }

  function smoothstep(edge0, edge1, x) {
    const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }

  /* ============================================================
     MOTION — DeviceMotion (tilt + shake)
     ============================================================ */
  function handleMotion(e) {
    const acc = e.accelerationIncludingGravity;
    const lin = e.acceleration;
    if (!acc) return;

    // gravity low-pass
    state.gravity.x = state.gravity.x * (1 - CONFIG.motion.gravityAlpha) + acc.x * CONFIG.motion.gravityAlpha;
    state.gravity.y = state.gravity.y * (1 - CONFIG.motion.gravityAlpha) + acc.y * CONFIG.motion.gravityAlpha;
    state.gravity.z = state.gravity.z * (1 - CONFIG.motion.gravityAlpha) + acc.z * CONFIG.motion.gravityAlpha;

    // calibration
    if (state.motion === 'calibrating') {
      if (performance.now() >= state.calibUntil) {
        const scr = rotateDeviceToScreen(state.gravity.x, state.gravity.y);
        state.neutral.x = scr.x;
        state.neutral.y = scr.y;
        state.tilt.x = 0;
        state.tilt.y = 0;
        state.motion = 'active';
        setMotionState('active');
        setHint('기울이고 · 흔들어보세요', 3000);
      }
      return;
    }

    // shake detection (linear acceleration 우선, 없으면 high-pass)
    let linX = 0, linY = 0, linZ = 0;
    if (lin) { linX = lin.x; linY = lin.y; linZ = lin.z; }
    else {
      linX = acc.x - state.gravity.x;
      linY = acc.y - state.gravity.y;
      linZ = acc.z - state.gravity.z;
    }
    const mag = Math.hypot(linX, linY, linZ);
    const now = performance.now();
    if (mag > CONFIG.motion.shakeThreshold && now > state.shakeCooldownUntil) {
      const scr = rotateDeviceToScreen(linX, linY);
      state.shakePending = Math.min(1, (mag - CONFIG.motion.shakeThreshold) / (CONFIG.motion.shakeStrongThreshold - CONFIG.motion.shakeThreshold) + 0.4);
      state.shakeDir.x = scr.x / (mag || 1);
      state.shakeDir.y = scr.y / (mag || 1);
      state.shakeCooldownUntil = now + CONFIG.motion.shakeCooldownMs;
    }

    // tilt (neutral 기준)
    if (state.motion === 'active') {
      const scr = rotateDeviceToScreen(state.gravity.x, state.gravity.y);
      let tx = scr.x - state.neutral.x;
      let ty = scr.y - state.neutral.y;
      // magnitude normalize (gravity ~9.8)
      tx /= 9.8; ty /= 9.8;
      const dead = CONFIG.motion.tiltDeadZone;
      const mag = Math.hypot(tx, ty);
      if (mag < dead) { tx = 0; ty = 0; }
      else {
        const scale = smoothstep(dead, CONFIG.motion.tiltMax, mag) / (mag || 1);
        tx *= scale; ty *= scale;
        const max = 1;
        tx = Math.max(-max, Math.min(max, tx));
        ty = Math.max(-max, Math.min(max, ty));
      }
      // shake 직후 잠깐 tilt 감쇠
      const shakeT = Math.max(0, 1 - (now - state.shakeCooldownUntil + CONFIG.motion.shakeCooldownMs) / 300);
      const damp = 1 - shakeT * 0.6;
      state.tilt.x = tx * damp;
      state.tilt.y = ty * damp;
    }
  }

  function enableMotion() {
    const b = bridge();
    if (!b) { setMotionState('error'); return; }
    if (state.motion === 'requesting' || state.motion === 'calibrating' || state.motion === 'active') return;

    const startListening = () => {
      if (motionListening) return;
      motionHandler = handleMotion;
      window.addEventListener('devicemotion', motionHandler);
      motionListening = true;
      state.motion = 'calibrating';
      state.calibUntil = performance.now() + CONFIG.motion.calibrationMs;
      setMotionState('calibrating');
      setHint('움직임 보정 중…', 1500);
    };

    const req = () => {
      state.motion = 'requesting';
      setMotionState('requesting');
      if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        DeviceMotionEvent.requestPermission()
          .then(result => {
            if (result === 'granted') startListening();
            else { state.motion = 'denied'; setMotionState('denied'); setHint('움직임 권한이 없어 터치 모드로 사용합니다', 2500); }
          })
          .catch(() => { state.motion = 'error'; setMotionState('error'); setHint('움직임 센서를 사용할 수 없어요', 2500); });
      } else {
        startListening();
      }
    };

    if (typeof DeviceMotionEvent !== 'undefined') req();
    else { state.motion = 'unsupported'; setMotionState('unsupported'); setHint('이 기기에서는 움직임을 지원하지 않아요', 2500); }
  }

  function disableMotion() {
    if (motionListening) {
      window.removeEventListener('devicemotion', motionHandler);
      motionListening = false;
    }
    state.motion = 'idle';
    state.tilt.x = 0; state.tilt.y = 0;
    state.shakePending = 0;
    setMotionState('idle');
  }

  function toggleMotion() {
    if (state.motion === 'active' || state.motion === 'calibrating' || state.motion === 'requesting') disableMotion();
    else enableMotion();
  }

  /* ============================================================
     BLOW — microphone airflow heuristic
     ============================================================ */
  function computeBands() {
    const sr = audioCtx.sampleRate;
    const n = analyser.frequencyBinCount;
    const bin = hz => Math.min(n - 1, Math.round(hz * n / (sr / 2)));
    bandBins = {
      low: [bin(CONFIG.blow.lowHz), bin(CONFIG.blow.midHz)],
      mid: [bin(CONFIG.blow.midHz), bin(CONFIG.blow.noiseHz)],
      noise: [bin(CONFIG.blow.noiseHz), bin(CONFIG.blow.highHz)],
    };
  }

  function bandEnergy(freqData, bins) {
    let sum = 0, count = 0;
    for (let i = bins[0]; i < bins[1] && i < freqData.length; i++) { sum += freqData[i]; count++; }
    return count ? sum / count / 255 : 0;
  }

  function analyseAudio() {
    if (!analyser) return;
    analyser.getByteTimeDomainData(timeData);
    analyser.getByteFrequencyData(freqData);

    // RMS
    let sum = 0;
    for (let i = 0; i < timeData.length; i++) {
      const v = (timeData[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / timeData.length);

    // spectral bands
    const low = bandEnergy(freqData, bandBins.low);
    const mid = bandEnergy(freqData, bandBins.mid);
    const noise = bandEnergy(freqData, bandBins.noise);

    // spectral flatness (noise-like = flat)
    let geom = 0, arith = 0, cnt = 0;
    for (let i = bandBins.noise[0]; i < bandBins.noise[1]; i++) {
      const v = freqData[i] + 1e-6;
      geom += Math.log(v);
      arith += v;
      cnt++;
    }
    const flatness = cnt ? Math.exp(geom / cnt) / (arith / cnt) : 0.5;

    const now = performance.now();

    // ambient calibration
    if (state.blow === 'calibrating') {
      baselineRms = baselineRms * 0.9 + rms * 0.1;
      baselineNoise = baselineNoise * 0.9 + noise * 0.1;
      if (now >= blowCalibUntil) {
        baselineRms = Math.max(0.001, baselineRms);
        baselineNoise = Math.max(0.001, baselineNoise);
        state.blow = 'active';
        setBlowState('active');
        setHint('마이크 입력 분석 중 · 녹음하지 않음', 2500);
      }
      return;
    }

    // baseline-relative scores
    const rmsScore = (rms - baselineRms) / Math.max(baselineRms, 1e-4);
    const noiseScore = (noise - baselineNoise) / Math.max(baselineNoise, 1e-4);
    const minRms = Math.max(CONFIG.blow.minRms, baselineRms * CONFIG.blow.rmsMultiplier);

    // "후~~~" 특징: broadband + noise-like + 일정 지속
    const isBlow =
      rms > minRms &&
      rmsScore > 1.2 &&
      noiseScore > 0.8 &&
      flatness > 0.25 &&
      low < 0.5;

    if (isBlow) {
      if (state.blowCandidate === 0) state.blowCandidate = now;
      if (now - state.blowCandidate >= CONFIG.blow.minDurationMs) {
        state.blowStrength = Math.min(1, state.blowStrength + CONFIG.blow.attack * (0.6 + flatness * 0.8));
        blowActiveUntil = now + CONFIG.blow.releaseMs;
      }
    } else {
      state.blowCandidate = 0;
      if (now > blowActiveUntil) {
        state.blowStrength *= CONFIG.blow.decay;
        if (state.blowStrength < 0.01) state.blowStrength = 0;
      }
    }
  }

  async function enableBlow() {
    if (!window.isSecureContext) {
      setBlowState('error');
      setHint('이 기능은 HTTPS에서 사용할 수 있습니다', 2500);
      return;
    }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      setBlowState('unsupported');
      return;
    }
    if (state.blow === 'requesting' || state.blow === 'calibrating' || state.blow === 'active') return;

    const token = ++micToken;
    state.blow = 'requesting';
    setBlowState('requesting');

    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { setBlowState('error'); return; }

    try {
      let st;
      try {
        st = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        });
      } catch (e) {
        if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) throw e;
        // constraint fallback
        st = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      if (token !== micToken) { st.getTracks().forEach(t => t.stop()); return; } // race: turned off meanwhile
      stream = st;

      audioCtx = new AC();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = CONFIG.blow.fftSize;
      analyser.smoothingTimeConstant = CONFIG.blow.smoothing;
      sourceNode = audioCtx.createMediaStreamSource(stream);
      sourceNode.connect(analyser);   // destination 연결 안 함 (피드백 방지)
      timeData = new Float32Array(analyser.fftSize);
      freqData = new Uint8Array(analyser.frequencyBinCount);
      computeBands();

      state.blow = 'calibrating';
      blowCalibUntil = performance.now() + CONFIG.blow.calibrationMs;
      baselineRms = 0.001;
      baselineNoise = 0.001;
      setBlowState('calibrating');
      setHint('바람 보정 중… 조용히 해주세요', 1800);
    } catch (e) {
      console.debug('[mobile-input] mic error:', e && e.name, e && e.message);
      state.blow = 'error';
      setBlowState('error');
      setHint('마이크를 사용할 수 없어요', 2500);
    }
  }

  function disableBlow() {
    micToken++;
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    if (sourceNode) { try { sourceNode.disconnect(); } catch (e) { /* ignore */ } sourceNode = null; }
    if (analyser) { try { analyser.disconnect(); } catch (e) { /* ignore */ } analyser = null; }
    if (audioCtx) { try { audioCtx.close(); } catch (e) { /* ignore */ } audioCtx = null; }
    timeData = null; freqData = null; bandBins = null;
    state.blow = 'idle';
    state.blowStrength = 0;
    state.blowCandidate = 0;
    setBlowState('idle');
  }

  function toggleBlow() {
    if (state.blow === 'active' || state.blow === 'calibrating' || state.blow === 'requesting') disableBlow();
    else enableBlow();
  }

  /* ============================================================
     INPUT SCHEDULER — GPU write는 throttled
     ============================================================ */
  function tick(now) {
    rafId = requestAnimationFrame(tick);
    const b = bridge();
    if (!b || b.isPaused()) return;

    const reduced = state.reducedMotion ? 0.5 : 1;

    // Tilt → global force (1 pass, throttled)
    if (state.motion === 'active' && (now - lastGpuUpdate) >= (1000 / CONFIG.motion.tiltUpdateHz)) {
      lastGpuUpdate = now;
      const fx = state.tilt.x * CONFIG.motion.tiltForce * reduced;
      const fy = state.tilt.y * CONFIG.motion.tiltForce * reduced;
      if (Math.hypot(fx, fy) > 1) b.applyUniformVelocityForce(fx, fy);
    }

    // Shake → 소수 velocity impulse
    if (state.shakePending > 0) {
      const s = state.shakePending;
      state.shakePending = 0;
      const dir = state.shakeDir;
      const spread = 0.22;
      for (let i = 0; i < 5; i++) {
        const x = 0.3 + Math.random() * 0.4;
        const y = 0.3 + Math.random() * 0.4;
        const dx = dir.x * CONFIG.motion.shakeImpulseForce * s * (0.7 + Math.random() * 0.6) * reduced;
        const dy = dir.y * CONFIG.motion.shakeImpulseForce * s * (0.7 + Math.random() * 0.6) * reduced;
        b.addVelocityImpulse(x, y, dx, dy, 1.3);
      }
      // 반대 방향 turbulence 소량
      for (let i = 0; i < 2; i++) {
        b.addVelocityImpulse(Math.random(), Math.random(),
          -dir.x * CONFIG.motion.shakeImpulseForce * s * 0.35,
          -dir.y * CONFIG.motion.shakeImpulseForce * s * 0.35, 1.0);
      }
      void spread;
    }

    // Blow → gust (throttled)
    if (state.blow === 'active' && state.blowStrength > 0.03 &&
        (now - lastBlowGpu) >= (1000 / CONFIG.blow.gpuUpdateHz)) {
      lastBlowGpu = now;
      b.applyGust(state.blowStrength * CONFIG.blow.gustForce / 1000 * reduced);
    }

    // Blow DSP (audio analysis는 별도 rate, tick에서 처리)
    if (state.blow === 'active' || state.blow === 'calibrating') {
      analyseAudio();
    }
  }

  /* ============================================================
     LIFECYCLE
     ============================================================ */
  function onVisibility() {
    if (document.hidden) {
      // background: GPU force 중지, audio suspend
      if (audioCtx && audioCtx.state === 'running') { try { audioCtx.suspend(); } catch (e) { /* ignore */ } }
    } else {
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {
          setHint('바람을 다시 탭해 활성화', 2500);
          disableBlow();
        });
      }
    }
  }

  function onPageHide() {
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    if (audioCtx) { try { audioCtx.close(); } catch (e) { /* ignore */ } audioCtx = null; }
  }

  function onOrientationChange() {
    // orientation 바뀌면 tilt 잠시 0 후 재보정
    state.tilt.x = 0; state.tilt.y = 0;
    if (state.motion === 'active') {
      state.motion = 'calibrating';
      state.calibUntil = performance.now() + CONFIG.motion.calibrationMs;
      setMotionState('calibrating');
      setHint('움직임 보정 중…', 1500);
    }
  }

  function init() {
    state.reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    btnMotion = document.getElementById('btnMotion');
    btnBlow = document.getElementById('btnBlow');

    if (!btnMotion || !btnBlow) return;

    // feature detection
    const motionSupported = 'DeviceMotionEvent' in window;
    const micSupported = !!(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') &&
                         !!(window.AudioContext || window.webkitAudioContext) &&
                         window.isSecureContext;

    if (!motionSupported) {
      btnMotion.disabled = true;
      btnMotion.style.opacity = '0.35';
      btnMotion.title = '이 기기에서 지원 안 됨';
      state.motion = 'unsupported';
      setMotionState('unsupported');
    } else {
      state.motion = 'idle';
      btnMotion.addEventListener('click', toggleMotion);
    }

    if (!micSupported) {
      btnBlow.disabled = true;
      btnBlow.style.opacity = '0.35';
      btnBlow.title = '이 환경에서 지원 안 됨 (HTTPS 필요)';
      state.blow = 'unsupported';
      setBlowState('unsupported');
    } else {
      state.blow = 'idle';
      btnBlow.addEventListener('click', toggleBlow);
    }

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    if (screen.orientation) screen.orientation.addEventListener('change', onOrientationChange);
    else window.addEventListener('orientationchange', onOrientationChange);

    rafId = requestAnimationFrame(tick);

    /* ---------- debug API (?debugInputs=1) ---------- */
    if (new URLSearchParams(location.search).get('debugInputs') === '1') {
      window.MobileInkDebug = {
        setTilt: (x, y) => { state.tilt.x = x; state.tilt.y = y; },
        simulateShake: (s) => { state.shakePending = s || 1; state.shakeDir = { x: 1, y: 0 }; },
        setBlow: (s) => { state.blowStrength = Math.max(0, Math.min(1, s)); state.blow = 'active'; },
        getState: () => JSON.parse(JSON.stringify({
          motion: state.motion, blow: state.blow,
          tilt: state.tilt, blowStrength: state.blowStrength,
          shakePending: state.shakePending,
        })),
      };
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
