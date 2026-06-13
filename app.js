import * as THREE from "three";
import { GLTFLoader } from "./vendor/three/addons/loaders/GLTFLoader.js";

(() => {
  "use strict";

  const waterCanvas = document.querySelector("#water");
  const sceneCanvas = document.querySelector("#scene");
  const waterGL =
    waterCanvas.getContext("webgl", { alpha: false, antialias: false, preserveDrawingBuffer: false }) ||
    waterCanvas.getContext("experimental-webgl", { alpha: false, antialias: false, preserveDrawingBuffer: false });
  const sceneGL =
    sceneCanvas.getContext("webgl2", { alpha: true, antialias: true, preserveDrawingBuffer: false });
  const water = waterGL ? null : waterCanvas.getContext("2d", { alpha: true });
  const scene = sceneGL ? null : sceneCanvas.getContext("2d", { alpha: true });
  const work = document.querySelector(".work");
  const startButton = document.querySelector("#start");
  const soundButton = document.querySelector("#sound");
  const resetButton = document.querySelector("#reset");

  const TAU = Math.PI * 2;
  const DPR = Math.min(window.devicePixelRatio || 1, 1);
  const SIM_NX = 144;
  const MAX_WATER_SHADOWS = 48;
  const pointer = { x: 0, y: 0, px: 0, py: 0, down: false, active: false };
  const ripples = [];
  const bowls = [];
  const AUDIO_SRC = "./assets/clinamen-loop-64k.mp3";
  const modelChoice = new URLSearchParams(window.location.search).get("model");
  const BOWL_MODEL_OPTIONS = {
    base2: {
      src: "./assets/base2.glb",
      contactYOffset: 0.08,
      contactNearYOffset: 0.07,
      contactWidth: 0.98,
      contactHeight: 0.40,
      contactNearHeight: 0.24,
      contactAlpha: 0.15,
      contactNearAlpha: 0.07,
    },
    base3: {
      src: "./assets/base3.glb",
      contactYOffset: 0.08,
      contactNearYOffset: 0.07,
      contactWidth: 0.98,
      contactHeight: 0.40,
      contactNearHeight: 0.24,
      contactAlpha: 0.15,
      contactNearAlpha: 0.07,
    },
    base4: {
      src: "./assets/base4.glb",
      contactYOffset: -0.025,
      contactNearYOffset: 0.065,
      contactWidth: 1.00,
      contactHeight: 0.40,
      contactNearHeight: 0.22,
      contactAlpha: 0.15,
      contactNearAlpha: 0.065,
    },
  };
  const activeBowlModel = BOWL_MODEL_OPTIONS[modelChoice] || BOWL_MODEL_OPTIONS.base4;
  const BOWL_MODEL_SRCS = [activeBowlModel.src];
  const projectedBowl = new THREE.Vector3();

  let width = 1;
  let height = 1;
  let simNY = 168;
  let waterU = new Float32Array(SIM_NX * simNY);
  let waterPrev = new Float32Array(SIM_NX * simNY);
  let simBytes = new Uint8Array(SIM_NX * simNY);
  let waterProgram = null;
  let simTexture = null;
  let waterUniforms = {};
  const waterShadowData = new Float32Array(MAX_WATER_SHADOWS * 4);
  const waterShadowAlpha = new Float32Array(MAX_WATER_SHADOWS);
  const waterSurfaceShadowData = new Float32Array(MAX_WATER_SHADOWS * 4);
  const waterSurfaceShadowAlpha = new Float32Array(MAX_WATER_SHADOWS);
  let bowlProgram = null;
  let bowlBuffer = null;
  let bowlUniforms = {};
  let threeRenderer = null;
  let threeScene = null;
  let threeCamera = null;
  let bowlModelVariants = [];
  let bowlModelsReady = false;
  let breathT = 0;
  let lastTime = performance.now();
  let started = false;
  let muted = false;
  let audioTrack = null;
  let seed = 42;
  let lastSceneRender = 0;

  function rand() {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function smoothstep(min, max, value) {
    const t = clamp((value - min) / (max - min), 0, 1);
    return t * t * (3 - 2 * t);
  }

  function depthForY(y) {
    return smoothstep(height * 0.06, height * 0.96, y);
  }

  function perspectiveScaleForY(y) {
    const depthT = depthForY(y);
    return 0.60 + Math.pow(depthT, 1.16) * 1.16;
  }

  function updateBowlScreenSize(b) {
    if (!b.baseR) b.baseR = b.r / Math.max(0.001, perspectiveScaleForY(b.y));
    b.r = b.baseR * perspectiveScaleForY(b.y);
    b.mass = b.r * b.r * 0.012;
  }

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    for (const canvas of [waterCanvas, sceneCanvas]) {
      canvas.width = Math.floor(width * DPR);
      canvas.height = Math.floor(height * DPR);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    if (water) water.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (waterGL) waterGL.viewport(0, 0, waterCanvas.width, waterCanvas.height);
    if (scene) scene.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (sceneGL) sceneGL.viewport(0, 0, sceneCanvas.width, sceneCanvas.height);
    resizeThreeScene();
    allocWaterSim();
    setupSimTexture();
    createBowls();
  }

  function allocWaterSim() {
    simNY = clamp(Math.round((SIM_NX * height) / width), 96, 292);
    waterU = new Float32Array(SIM_NX * simNY);
    waterPrev = new Float32Array(SIM_NX * simNY);
    simBytes = new Uint8Array(SIM_NX * simNY);
    simBytes.fill(128);
  }

  function simDrop(gx, gy, radiusX, radiusY, strength) {
    if (!waterU.length) return;
    const rx = Math.max(1.2, radiusX);
    const ry = Math.max(1.2, radiusY);
    const x0 = Math.max(1, Math.floor(gx - rx));
    const x1 = Math.min(SIM_NX - 2, Math.ceil(gx + rx));
    const y0 = Math.max(1, Math.floor(gy - ry));
    const y1 = Math.min(simNY - 2, Math.ceil(gy + ry));

    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const dx = (x - gx) / rx;
        const dy = (y - gy) / ry;
        const d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          const k = Math.cos(Math.sqrt(d2) * Math.PI * 0.5);
          waterU[y * SIM_NX + x] += strength * k * k;
        }
      }
    }
  }

  function waterDrop(x, y, radiusPx, strength) {
    const gx = (x / width) * SIM_NX;
    const gy = (y / height) * simNY;
    const depthT = depthForY(y);
    const radius = Math.max(1.4, (radiusPx / Math.max(width, 1)) * SIM_NX);
    const rx = radius * (0.74 + depthT * 0.32);
    const ry = radius * (0.34 + depthT * 0.42);
    simDrop(gx, gy, rx, ry, strength * (0.70 + depthT * 0.36));
  }

  function stepWaterSim() {
    const damp = 0.981;
    for (let y = 1; y < simNY - 1; y += 1) {
      const row = y * SIM_NX;
      for (let x = 1; x < SIM_NX - 1; x += 1) {
        const i = row + x;
        const v = (waterU[i - 1] + waterU[i + 1] + waterU[i - SIM_NX] + waterU[i + SIM_NX]) * 0.5 - waterPrev[i];
        waterPrev[i] = v * damp;
      }
    }
    const tmp = waterU;
    waterU = waterPrev;
    waterPrev = tmp;
  }

  function waterGradAtPx(x, y) {
    const gx = clamp(Math.floor((x / width) * SIM_NX), 1, SIM_NX - 2);
    const gy = clamp(Math.floor((y / height) * simNY), 1, simNY - 2);
    const i = gy * SIM_NX + gx;
    return {
      x: waterU[i + 1] - waterU[i - 1],
      y: waterU[i + SIM_NX] - waterU[i - SIM_NX],
      h: waterU[i],
    };
  }

  function packWaterSim() {
    for (let i = 0; i < waterU.length; i += 1) {
      const v = 128 + waterU[i] * 24;
      simBytes[i] = v < 1 ? 1 : v > 254 ? 254 : v;
    }
  }

  function makeShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader));
    }
    return shader;
  }

  function initWaterGL() {
    if (!waterGL) return;

    const vertexSource = `
      attribute vec2 aPos;
      varying vec2 vUv;
      void main() {
        vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
        gl_Position = vec4(aPos, 0.0, 1.0);
      }
    `;

    const fragmentSource = `
      precision mediump float;
      varying vec2 vUv;
      uniform sampler2D uSim;
      uniform vec2 uTexel;
      uniform float uTime;
      uniform float uRefr;
      uniform int uBowlCount;
      uniform vec4 uBowls[48];
      uniform float uBowlOpacity[48];
      uniform vec4 uSurfaceBowls[48];
      uniform float uSurfaceOpacity[48];

      float h(vec2 p) {
        return texture2D(uSim, clamp(p, 0.002, 0.998)).r - 0.5019608;
      }

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }

      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
          mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
          u.y
        );
      }

      float lineMask(float value, float width) {
        float d = abs(fract(value) - 0.5);
        return 1.0 - smoothstep(width, width + 0.012, d);
      }

      void main() {
        vec2 e = uTexel;
        float hl = h(vUv - vec2(e.x, 0.0));
        float hr = h(vUv + vec2(e.x, 0.0));
        float ht = h(vUv - vec2(0.0, e.y));
        float hb = h(vUv + vec2(0.0, e.y));
        vec2 grad = vec2(hr - hl, hb - ht);
        float waveHeight = h(vUv);
        float waveSlope = grad.x * 0.78 + grad.y * 1.05;
        float rippleEnergy = clamp(length(grad) * 7.5 + abs(waveHeight) * 4.0, 0.0, 1.0);

        vec2 drift = vec2(
          sin(vUv.y * 6.2 + uTime * 0.055) * 0.004,
          cos(vUv.x * 4.8 - uTime * 0.047) * 0.003
        );
        vec2 puv = clamp(vUv + drift + grad * uRefr, 0.001, 0.999);
        vec3 shallow = vec3(0.25, 0.78, 0.88);
        vec3 middle = vec3(0.04, 0.66, 0.83);
        vec3 deep = vec3(0.0, 0.48, 0.68);
        vec3 col = mix(shallow, middle, smoothstep(0.02, 0.56, puv.y));
        col = mix(col, deep, smoothstep(0.45, 1.0, puv.y) * 0.58);
        float farPlane = 1.0 - smoothstep(0.20, 0.62, vUv.y);
        col = mix(col, col * vec3(0.54, 0.76, 0.88), farPlane * 0.62);

        float softField = noise(puv * vec2(3.2, 4.4) + vec2(uTime * 0.018, -uTime * 0.012));
        softField += noise(puv * vec2(7.8, 6.6) + vec2(-uTime * 0.026, uTime * 0.014)) * 0.42;
        col += (softField - 0.52) * vec3(0.010, 0.016, 0.018);

        vec2 rippleSlip = vec2(
          sin((vUv.y + waveHeight) * 18.0 + uTime * 0.23),
          cos((vUv.x - waveHeight) * 16.0 - uTime * 0.19)
        ) * (0.0018 + rippleEnergy * 0.0048);
        vec2 domeUv = clamp(vUv + drift * 1.35 + grad * (uRefr * 1.85) + rippleSlip, 0.001, 0.999);
        float domeDepth = smoothstep(0.42, 1.0, domeUv.y);
        vec2 domeCenter = vec2(0.50, 1.025);
        vec2 domePerspective = vec2(0.84 + domeDepth * 0.08, 0.68 + domeDepth * 0.11);
        vec2 domeP = (domeUv - domeCenter) / domePerspective;
        float domeR = length(domeP);
        float halfDome = 1.0 - smoothstep(-0.035, 0.075, domeP.y);
        float domeTheta = atan(domeP.y, domeP.x);
        float domeAngle = domeTheta / 6.2831853 + 0.5;
        float scallop = noise(vec2(domeAngle, domeR) * vec2(7.0, 3.0) + uTime * 0.012);
        float domeEdge = domeR + (scallop - 0.5) * 0.030 + sin(domeTheta * 9.0 + waveHeight * 22.0) * 0.010;
        float domeFade = smoothstep(1.04, 0.74, domeEdge) * smoothstep(0.18, 0.36, domeUv.y) * halfDome;
        float radialWarp = sin(domeR * 14.0 + waveHeight * 24.0) * 0.010 + grad.x * 0.055;
        float ringWarp = sin(domeAngle * 24.0 + waveHeight * 20.0) * 0.012 + grad.y * 0.055;
        float majorRibs = lineMask(domeAngle * 34.0 + radialWarp, 0.024 + rippleEnergy * 0.006);
        float minorRibs = lineMask(domeAngle * 104.0 + radialWarp * 1.55, 0.008 + rippleEnergy * 0.003);
        float ringA = lineMask(domeR * 10.5 + ringWarp, 0.022 + rippleEnergy * 0.006);
        float ringB = lineMask(domeR * 21.0 + ringWarp * 1.35, 0.008 + rippleEnergy * 0.003);
        float innerOculus = 1.0 - smoothstep(0.012, 0.046, abs(domeR - 0.19));
        float oculusRibs = (1.0 - smoothstep(0.0, 0.24, domeR)) * lineMask(domeAngle * 24.0 + radialWarp, 0.016);
        float outerRim = 1.0 - smoothstep(0.018, 0.070, abs(domeR - 0.93));
        float skylightPool = domeFade * (1.0 - smoothstep(0.08, 0.96, domeR)) * 0.88;
        float skylightBreath = noise(domeUv * vec2(2.2, 2.8) + vec2(uTime * 0.012, uTime * -0.01));
        float surfaceFacet = smoothstep(0.010, 0.060, abs(waveSlope)) * (0.72 + rippleEnergy * 0.58);
        float skylightBreakup = noise(domeUv * vec2(18.0, 12.0) + grad * 24.0 + vec2(uTime * 0.028, -uTime * 0.022));
        float skylightStructure = domeFade * clamp(
          majorRibs * 0.86
          + minorRibs * 0.36
          + ringA * 0.76
          + ringB * 0.34
          + innerOculus * 0.70
          + oculusRibs * 0.42
          + outerRim * 0.58,
          0.0,
          1.0
        );
        skylightStructure *= 0.96 + surfaceFacet * 0.86 + skylightBreakup * 0.16;
        float skylightSurface = (skylightPool * 0.44 + skylightStructure * 0.48) * (0.76 + skylightBreath * 0.08 + surfaceFacet * 1.16);

        float light = waveSlope;
        col += max(light, 0.0) * vec3(0.78, 1.0, 1.08) * 1.35;
        col -= max(-light, 0.0) * vec3(0.003, 0.007, 0.009);

        float spec = smoothstep(0.036, 0.095, light);
        col += spec * vec3(0.9, 1.0, 0.96) * 0.16;
        float crest = abs(h(vUv));
        float crestLine = smoothstep(0.008, 0.03, crest) * (1.0 - smoothstep(0.035, 0.09, crest));
        col += crestLine * vec3(0.72, 0.98, 1.0) * 0.045;

        float bottomShadow = 0.0;
        float contactReflection = 0.0;
        vec2 warpedUv = vUv + grad * 0.18;
        for (int i = 0; i < 48; i += 1) {
          if (i >= uBowlCount) break;
          vec4 ns = uSurfaceBowls[i];
          vec2 nq = (warpedUv - ns.xy) / max(ns.zw, vec2(0.0001));
          float dReflection = dot(nq, nq);
          float reflectionBody = 1.0 - smoothstep(0.64, 1.04, dReflection);
          float softEdge = 1.0 - smoothstep(0.92, 1.12, dReflection);
          float reflectionShape = reflectionBody * softEdge;
          float surfaceBreak = 0.74 + 0.26 * noise((warpedUv + nq * 0.035) * vec2(28.0, 18.0) + grad * 18.0 + uTime * 0.018);
          contactReflection += reflectionShape * surfaceBreak * uSurfaceOpacity[i];

          vec4 s = uBowls[i];
          vec2 q = (warpedUv - s.xy) / max(s.zw, vec2(0.0001));
          float d = dot(q, q);
          float core = 1.0 - smoothstep(0.0, 0.54, d);
          float penumbra = 1.0 - smoothstep(0.10, 1.72, d);
          bottomShadow += (core * 0.18 + penumbra * 0.82) * uBowlOpacity[i];
        }
        bottomShadow = clamp(bottomShadow, 0.0, 0.78);
        contactReflection = clamp(contactReflection, 0.0, 0.30);
        col = mix(col, col * vec3(0.40, 0.66, 0.73), bottomShadow);
        col = mix(col, vec3(0.64, 0.98, 1.0), contactReflection);
        vec2 poolCenter = vec2(0.42 + 0.2 * cos(uTime * 0.045), 0.36 + 0.16 * sin(uTime * 0.063));
        float pool = 1.0 - smoothstep(0.0, 0.58, distance(vUv * vec2(1.0, 1.25), poolCenter * vec2(1.0, 1.25)));
        col += pool * vec3(0.045, 0.075, 0.082);

        float vignette = smoothstep(0.34, 0.86, distance(vUv, vec2(0.5)));
        col = mix(col, col * vec3(0.78, 0.9, 0.96), vignette * 0.34);
        col = mix(col, col * vec3(0.64, 0.80, 0.90), farPlane * 0.36);

        col = mix(col, vec3(0.66, 0.96, 1.0), skylightPool * (0.30 + surfaceFacet * 0.10));
        col += skylightSurface * vec3(0.15, 0.40, 0.42);
        col = mix(col, vec3(0.0, 0.34, 0.50), skylightStructure * (0.54 + surfaceFacet * 0.18));
        col += skylightStructure * max(light, 0.0) * vec3(0.18, 0.68, 0.76) * 0.16;

        gl_FragColor = vec4(col, 1.0);
      }
    `;

    waterProgram = waterGL.createProgram();
    waterGL.attachShader(waterProgram, makeShader(waterGL, waterGL.VERTEX_SHADER, vertexSource));
    waterGL.attachShader(waterProgram, makeShader(waterGL, waterGL.FRAGMENT_SHADER, fragmentSource));
    waterGL.linkProgram(waterProgram);
    if (!waterGL.getProgramParameter(waterProgram, waterGL.LINK_STATUS)) {
      throw new Error(waterGL.getProgramInfoLog(waterProgram));
    }

    waterGL.useProgram(waterProgram);
    const buffer = waterGL.createBuffer();
    waterGL.bindBuffer(waterGL.ARRAY_BUFFER, buffer);
    waterGL.bufferData(waterGL.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), waterGL.STATIC_DRAW);
    const pos = waterGL.getAttribLocation(waterProgram, "aPos");
    waterGL.enableVertexAttribArray(pos);
    waterGL.vertexAttribPointer(pos, 2, waterGL.FLOAT, false, 0, 0);

    for (const name of ["uSim", "uTexel", "uTime", "uRefr", "uBowlCount"]) {
      waterUniforms[name] = waterGL.getUniformLocation(waterProgram, name);
    }
    waterUniforms.uBowls = waterGL.getUniformLocation(waterProgram, "uBowls[0]");
    waterUniforms.uBowlOpacity = waterGL.getUniformLocation(waterProgram, "uBowlOpacity[0]");
    waterUniforms.uSurfaceBowls = waterGL.getUniformLocation(waterProgram, "uSurfaceBowls[0]");
    waterUniforms.uSurfaceOpacity = waterGL.getUniformLocation(waterProgram, "uSurfaceOpacity[0]");
    waterGL.uniform1i(waterUniforms.uSim, 1);
    waterGL.pixelStorei(waterGL.UNPACK_ALIGNMENT, 1);
  }

  function setupSimTexture() {
    if (!waterGL || !waterProgram) return;
    if (simTexture) waterGL.deleteTexture(simTexture);
    simTexture = waterGL.createTexture();
    waterGL.activeTexture(waterGL.TEXTURE1);
    waterGL.bindTexture(waterGL.TEXTURE_2D, simTexture);
    waterGL.texImage2D(waterGL.TEXTURE_2D, 0, waterGL.LUMINANCE, SIM_NX, simNY, 0, waterGL.LUMINANCE, waterGL.UNSIGNED_BYTE, simBytes);
    waterGL.texParameteri(waterGL.TEXTURE_2D, waterGL.TEXTURE_WRAP_S, waterGL.CLAMP_TO_EDGE);
    waterGL.texParameteri(waterGL.TEXTURE_2D, waterGL.TEXTURE_WRAP_T, waterGL.CLAMP_TO_EDGE);
    waterGL.texParameteri(waterGL.TEXTURE_2D, waterGL.TEXTURE_MIN_FILTER, waterGL.LINEAR);
    waterGL.texParameteri(waterGL.TEXTURE_2D, waterGL.TEXTURE_MAG_FILTER, waterGL.LINEAR);
  }

  function drawWaterGL(now) {
    packWaterSim();
    let count = 0;
    const shadowBowls = bowls.slice().sort((a, b) => b.y - a.y || b.r - a.r);
    for (const b of shadowBowls) {
      if (count >= MAX_WATER_SHADOWS) break;
      let screenX = b.x;
      let screenY = b.y;
      if (bowlModelsReady && b.model) {
        updateBowlModel(b, now);
        b.model.updateMatrixWorld(true);
        projectedBowl.setFromMatrixPosition(b.model.matrixWorld).project(threeCamera);
        screenX = (projectedBowl.x * 0.5 + 0.5) * width;
        screenY = (0.5 - projectedBowl.y * 0.5) * height;
        const anchorDepthT = smoothstep(-b.r * 0.2, height + b.r * 0.55, b.y);
        screenY += b.r * (0.10 + (1 - anchorDepthT) * 0.24);
      }
      if (screenX < b.r * 0.35 || screenX > width - b.r * 0.35 || screenY < Math.max(height * 0.14, b.r * 0.85) || screenY > height - b.r * 0.2) continue;
      const depthT = smoothstep(height * 0.16, height - b.r * 0.18, screenY);
      const nearT = depthT;
      const farT = 1 - depthT;
      const base = count * 4;
      const bottomOffsetY = b.r * (0.92 + farT * 0.72);
      const reflectionOffsetY = b.r * (0.28 + nearT * 0.13 + farT * 0.06);
      waterSurfaceShadowData[base] = screenX / width;
      waterSurfaceShadowData[base + 1] = (screenY + reflectionOffsetY) / height;
      waterSurfaceShadowData[base + 2] = (b.r * (1.02 + nearT * 0.10 + farT * 0.02)) / width;
      waterSurfaceShadowData[base + 3] = (b.r * (0.36 + nearT * 0.72 - farT * 0.02)) / height;
      const visibleFade = smoothstep(height * 0.20, height * 0.36, screenY);
      waterSurfaceShadowAlpha[count] = 0.25 * visibleFade * (0.52 + nearT * 0.48);
      waterShadowData[base] = screenX / width;
      waterShadowData[base + 1] = (screenY + bottomOffsetY) / height;
      waterShadowData[base + 2] = (b.r * (1.02 + farT * 0.18)) / width;
      waterShadowData[base + 3] = (b.r * (1.04 - farT * 0.46)) / height;
      waterShadowAlpha[count] = (0.18 + nearT * 0.32 + farT * 0.10) * visibleFade;
      count += 1;
    }
    waterGL.useProgram(waterProgram);
    waterGL.activeTexture(waterGL.TEXTURE1);
    waterGL.bindTexture(waterGL.TEXTURE_2D, simTexture);
    waterGL.texSubImage2D(waterGL.TEXTURE_2D, 0, 0, 0, SIM_NX, simNY, waterGL.LUMINANCE, waterGL.UNSIGNED_BYTE, simBytes);
    waterGL.uniform2f(waterUniforms.uTexel, 1 / SIM_NX, 1 / simNY);
    waterGL.uniform1f(waterUniforms.uTime, now / 1000);
    waterGL.uniform1f(waterUniforms.uRefr, 0.58);
    waterGL.uniform1i(waterUniforms.uBowlCount, count);
    waterGL.uniform4fv(waterUniforms.uBowls, waterShadowData);
    waterGL.uniform1fv(waterUniforms.uBowlOpacity, waterShadowAlpha);
    waterGL.uniform4fv(waterUniforms.uSurfaceBowls, waterSurfaceShadowData);
    waterGL.uniform1fv(waterUniforms.uSurfaceOpacity, waterSurfaceShadowAlpha);
    waterGL.drawArrays(waterGL.TRIANGLE_STRIP, 0, 4);
  }

  function resizeThreeScene() {
    if (!threeRenderer || !threeCamera) return;
    threeRenderer.setPixelRatio(DPR);
    threeRenderer.setSize(width, height, false);
    threeCamera.left = -width * 0.5;
    threeCamera.right = width * 0.5;
    threeCamera.top = height * 0.5;
    threeCamera.bottom = -height * 0.5;
    threeCamera.position.set(0, height * 0.78, height * 0.92);
    threeCamera.lookAt(0, 0, 0);
    threeCamera.updateProjectionMatrix();
  }

  function initThreeScene() {
    if (!sceneGL || threeRenderer) return;

    threeRenderer = new THREE.WebGLRenderer({
      canvas: sceneCanvas,
      context: sceneGL,
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      powerPreference: "high-performance",
    });
    threeRenderer.setClearColor(0x000000, 0);
    threeRenderer.outputColorSpace = THREE.SRGBColorSpace;
    threeRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    threeRenderer.toneMappingExposure = 1.13;

    threeScene = new THREE.Scene();
    threeCamera = new THREE.OrthographicCamera(-width * 0.5, width * 0.5, height * 0.5, -height * 0.5, -3000, 3000);
    resizeThreeScene();

    threeScene.add(new THREE.AmbientLight(0xffffff, 1.25));
    const hemi = new THREE.HemisphereLight(0xffffff, 0x13a6c7, 1.15);
    threeScene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 4.6);
    key.position.set(-0.02, 2.25, 0.06);
    threeScene.add(key);
    const fill = new THREE.DirectionalLight(0xd7fbff, 0.55);
    fill.position.set(0.45, 0.32, 0.26);
    threeScene.add(fill);

    const loader = new GLTFLoader();
    Promise.all(
      BOWL_MODEL_SRCS.map(
        (src, style) =>
          new Promise((resolve, reject) => {
            loader.load(
              src,
              (gltf) => resolve(prepareBowlModel(gltf.scene, src, style)),
              undefined,
              reject,
            );
          }),
      ),
    )
      .then((variants) => {
        bowlModelVariants = variants;
        bowlModelsReady = true;
        syncBowlModels();
      })
      .catch((error) => {
        console.error("Failed to load bowl models", error);
      });
  }

  function prepareBowlModel(root, src, style) {
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    root.position.sub(center);
    root.traverse((child) => {
      if (!child.isMesh) return;
      child.geometry.computeVertexNormals();
      const source = Array.isArray(child.material) ? child.material[0] : child.material;
      child.material = makeBowlMaterial(size, source);
      child.castShadow = false;
      child.receiveShadow = false;
    });

    const group = new THREE.Group();
    group.add(root);
    return { root: group, bounds: size, src, style };
  }

  function makeBowlMaterial(size, source) {
    return new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      uniforms: {
        low: { value: -size.y * 0.5 },
        high: { value: size.y * 0.5 },
        tint: { value: source?.color ? source.color.clone().lerp(new THREE.Color(0xffffff), 0.72) : new THREE.Color(0xf8f6ef) },
      },
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vWorld;
        varying vec3 vLocal;
        varying vec3 vLocalNormal;
        void main() {
          vLocal = position;
          vLocalNormal = normalize(normal);
          vNormal = normalize(mat3(modelMatrix) * normal);
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: `
        precision mediump float;
        varying vec3 vNormal;
        varying vec3 vWorld;
        varying vec3 vLocal;
        varying vec3 vLocalNormal;
        uniform float low;
        uniform float high;
        uniform vec3 tint;

        void main() {
          vec3 n = normalize(vNormal);
          vec3 light = normalize(vec3(-0.012, 0.996, 0.055));
          vec3 viewDir = normalize(cameraPosition - vWorld);
          float h = clamp((vLocal.y - low) / max(0.001, high - low), 0.0, 1.0);
          float lambert = max(dot(n, light), 0.0);
          float backLambert = max(dot(-n, light), 0.0);
          float wrap = max(lambert, backLambert * 0.46);
          vec3 halfDir = normalize(light + viewDir);
          float specA = pow(max(dot(n, halfDir), 0.0), 8.0);
          float specB = pow(max(dot(-n, halfDir), 0.0), 12.0) * 0.40;

          vec3 sideCol = vec3(0.88, 0.87, 0.82);
          vec3 innerCol = tint;
          vec3 col = mix(sideCol, innerCol, smoothstep(0.20, 0.88, h));
          col = mix(col, vec3(0.995, 0.99, 0.955), smoothstep(0.34, 0.94, h) * 0.42);
          col *= 0.97 + wrap * 0.30;
          col += vec3(1.0, 0.985, 0.92) * (specA + specB) * 0.12;

          float glowDistance = distance(vLocal.xz / max(high - low, 0.001), vec2(0.08, -0.04));
          float broadGlow = 1.0 - smoothstep(0.0, 0.76, glowDistance);
          float coreGlow = 1.0 - smoothstep(0.0, 0.30, glowDistance);
          col += (broadGlow * 0.11 + coreGlow * 0.018) * smoothstep(0.16, 0.74, h) * vec3(1.0, 0.93, 0.62);

          float submerged = 1.0 - smoothstep(0.46, 0.78, h);
          float sideFacing = smoothstep(0.16, 0.86, 1.0 - abs(n.y));
          vec3 blueLight = normalize(vec3(0.0, 0.12, 1.0));
          float frontLambert = max(dot(n, blueLight), 0.0) * sideFacing;
          float sideBlueWrap = sideFacing * (0.34 + 0.34 * smoothstep(0.0, 0.58, n.z + 0.18));
          float lowBody = smoothstep(0.02, 0.12, h) * (1.0 - smoothstep(0.72, 0.96, h));
          float blueBounce = clamp((frontLambert * 0.82 + sideBlueWrap) * lowBody * (0.66 + submerged * 0.28), 0.0, 0.92);
          vec3 waterBounceCol = vec3(0.00, 0.24, 0.44);
          col = mix(col, waterBounceCol, blueBounce * 0.72);
          col += blueBounce * vec3(0.00, 0.05, 0.08) * (0.08 + specA * 0.05);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
  }

  function bowlVariantFor(b) {
    if (!bowlModelVariants.length) return null;
    return bowlModelVariants[b.style % bowlModelVariants.length] || bowlModelVariants[0];
  }

  function cloneBowlModel(style = 0) {
    const variant = bowlModelVariants[style % bowlModelVariants.length] || bowlModelVariants[0];
    const group = variant.root.clone(true);
    return group;
  }

  function syncBowlModels() {
    if (!threeScene || !bowlModelsReady) return;

    for (const b of bowls) {
      if (!b.model) {
        b.model = cloneBowlModel(b.style);
        b.model.renderOrder = 2;
        threeScene.add(b.model);
      }
    }
  }

  function updateBowlModel(b, now) {
    const variant = bowlVariantFor(b);
    if (!b.model || !variant) return;
    if (b.syncedAt === now) return;
    updateBowlScreenSize(b);
    const surface = waterGradAtPx(b.x, b.y);
    const waveBob = clamp(surface.h * 0.9, -0.32, 0.32);
    const bob = Math.sin(now * 0.0008 + b.phase) * 0.34 + b.lift * 0.85 + waveBob;
    const depthT = smoothstep(-b.r * 0.2, height + b.r * 0.55, b.y);
    const farT = 1 - depthT;
    const targetDiameter = b.r * 2.08;
    const modelDiameter = Math.max(variant.bounds.x, variant.bounds.y, 0.001);
    const scale = targetDiameter / modelDiameter;
    const worldX = b.x - width * 0.5;
    const worldZ = b.y - height * 0.5;
    const yaw = b.angle * 0.018;
    const perspectivePitch = -0.34 + depthT * 0.46;
    const bobPitch = Math.sin(b.phase + now * 0.00032) * 0.006 + clamp(surface.y * 0.055, -0.0045, 0.0045);
    const bobRoll = Math.cos(b.phase + now * 0.00028) * 0.005 - clamp(surface.x * 0.055, -0.0045, 0.0045);

    b.model.position.set(worldX, -b.r * (0.12 + farT * 0.024) + bob * 0.07, worldZ);
    b.model.scale.setScalar(scale);
    b.model.rotation.set(perspectivePitch + bobPitch, yaw, bobRoll);
    b.syncedAt = now;
  }

  function drawThreeScene(now) {
    if (!threeRenderer || !threeScene || !threeCamera || !bowlModelsReady) return false;
    syncBowlModels();
    bowls.sort((a, b) => a.y - b.y);
    for (const b of bowls) updateBowlModel(b, now);
    threeRenderer.render(threeScene, threeCamera);
    return true;
  }

  function initSceneGL() {
    if (!sceneGL) return;

    const vertexSource = `
      attribute vec2 aCorner;
      uniform vec2 uCenter;
      uniform vec2 uHalf;
      uniform vec2 uViewport;
      varying vec2 vLocal;

      void main() {
        vec2 pixel = uCenter + aCorner * uHalf;
        vec2 clip = vec2(pixel.x / uViewport.x * 2.0 - 1.0, 1.0 - pixel.y / uViewport.y * 2.0);
        vLocal = aCorner * uHalf;
        gl_Position = vec4(clip, 0.0, 1.0);
      }
    `;

    const fragmentSource = `
      precision mediump float;
      varying vec2 vLocal;
      uniform float uRadius;
      uniform float uView;
      uniform float uDepth;
      uniform float uAngle;
      uniform float uLift;
      uniform float uTime;

      float ellipseSdf(vec2 p, vec2 r) {
        return (length(p / r) - 1.0) * min(r.x, r.y);
      }

      float insideEllipse(vec2 p, vec2 r, float edge) {
        return 1.0 - smoothstep(-edge, edge, ellipseSdf(p, r));
      }

      float ringMask(vec2 p, vec2 outerR, vec2 innerR) {
        float outer = insideEllipse(p, outerR, 1.15);
        float inner = insideEllipse(p, innerR, 1.05);
        return clamp(outer - inner, 0.0, 1.0);
      }

      void main() {
        float cs = cos(uAngle);
        float sn = sin(uAngle);
        vec2 p = vec2(vLocal.x * cs - vLocal.y * sn, vLocal.x * sn + vLocal.y * cs);

        float r = uRadius;
        float rx = r * 1.06;
        float ry = r * uView;
        float side = r * (0.50 - uView * 0.10 + (1.0 - uDepth) * 0.12);
        float edge = max(1.0, r * 0.012);
        vec4 outColor = vec4(0.0);

        vec2 shadowP = p - vec2(r * (0.22 + uDepth * 0.12), side * (1.0 + uDepth * 0.28) + r * (0.18 + uDepth * 0.1));
        float shadow = insideEllipse(shadowP, vec2(r * (1.65 - uDepth * 0.16), r * (0.25 + uDepth * 0.26)), 10.0);
        shadow *= 1.0 - smoothstep(0.0, 1.0, length(shadowP / vec2(r * 1.68, r * 0.44)));
        outColor = mix(outColor, vec4(0.0, 0.18, 0.24, 0.30 + uDepth * 0.12), shadow * 0.72);

        vec2 bodyCenter = vec2(0.0, side * 0.34);
        vec2 bodyR = vec2(rx * 0.98, side * 1.02 + ry * 0.10);
        float body = insideEllipse(p - bodyCenter, bodyR, edge);
        body *= smoothstep(-ry * 0.20, -ry * 0.03, p.y);
        body *= 1.0 - smoothstep(side * 1.2, side * 1.34, p.y);

        float sideLight = clamp(0.58 - p.x / (rx * 2.8) - p.y / (r * 2.7), 0.0, 1.0);
        vec3 bodyCol = mix(vec3(0.30, 0.54, 0.58), vec3(0.93, 0.93, 0.87), sideLight);
        bodyCol = mix(bodyCol, vec3(0.04, 0.43, 0.56), smoothstep(side * 0.35, side * 1.05, p.y) * 0.42);
        outColor = mix(outColor, vec4(bodyCol, 1.0), body);

        float submerge = body * smoothstep(side * 0.08, side * 0.9, p.y);
        outColor.rgb = mix(outColor.rgb, vec3(0.02, 0.58, 0.72), submerge * (0.20 + uDepth * 0.14));
        outColor.a = max(outColor.a, body * (0.9 - submerge * 0.18));

        float frontWall = body * smoothstep(ry * 0.10, side * 0.50, p.y) * (1.0 - smoothstep(side * 1.02, side * 1.28, p.y));
        outColor.rgb = mix(outColor.rgb, vec3(0.18, 0.39, 0.43), frontWall * (0.28 + (1.0 - uDepth) * 0.16));

        float waterline = body * (1.0 - smoothstep(0.0, max(2.2, r * 0.018), abs(p.y - side * 0.54)));
        waterline *= smoothstep(-rx * 0.94, -rx * 0.70, p.x) * (1.0 - smoothstep(rx * 0.70, rx * 0.94, p.x));
        outColor.rgb = mix(outColor.rgb, vec3(0.42, 0.92, 0.98), waterline * 0.22);
        outColor.a = max(outColor.a, waterline * 0.28);

        vec2 outerR = vec2(rx, ry);
        vec2 innerR = vec2(rx * 0.93, ry * 0.82);
        float rim = ringMask(p, outerR, innerR);
        float rimShade = clamp(0.66 + p.x / (rx * 3.0) - p.y / (max(ry, 1.0) * 2.6), 0.0, 1.0);
        vec3 rimCol = mix(vec3(0.70, 0.74, 0.72), vec3(1.0, 1.0, 0.96), rimShade);
        outColor = mix(outColor, vec4(rimCol, 1.0), rim);

        vec2 innerP = p - vec2(0.0, -ry * 0.03);
        float inner = insideEllipse(innerP, innerR, edge);
        float innerNorm = clamp(length(innerP / innerR), 0.0, 1.0);
        float bowlDepth = smoothstep(0.05, 0.96, innerNorm);
        vec3 innerCol = mix(vec3(0.98, 0.97, 0.92), vec3(0.62, 0.64, 0.62), bowlDepth);
        innerCol = mix(innerCol, vec3(0.94, 0.93, 0.88), smoothstep(-ry * 0.48, ry * 0.38, p.y) * 0.34);
        float ceramicGlow = 1.0 - smoothstep(0.0, 0.38, distance(innerP / innerR, vec2(0.10, 0.24)));
        innerCol += ceramicGlow * vec3(0.09, 0.08, 0.05);
        outColor = mix(outColor, vec4(innerCol, 1.0), inner * (1.0 - rim * 0.5));

        float highlight = insideEllipse(p - vec2(-rx * 0.24, ry * 0.18), vec2(rx * 0.22, max(ry * 0.16, 5.0)), 2.0);
        highlight *= 1.0 - insideEllipse(p - vec2(-rx * 0.20, ry * 0.14), vec2(rx * 0.15, max(ry * 0.10, 3.5)), 2.0);
        outColor.rgb += vec3(1.0, 1.0, 0.95) * highlight * 0.08;
        outColor.a = max(outColor.a, highlight * 0.18);

        float frontLip = rim * smoothstep(-ry * 0.05, ry * 0.65, p.y);
        outColor.rgb = mix(outColor.rgb, vec3(0.98, 0.98, 0.94), frontLip * 0.24);

        float waterCut = smoothstep(side * 0.48, side * 1.05, p.y) * body * (1.0 - inner * 0.9);
        outColor.rgb = mix(outColor.rgb, vec3(0.0, 0.54, 0.68), waterCut * 0.34);
        outColor.a *= 1.0 - waterCut * 0.20;

        if (outColor.a < 0.01) discard;
        gl_FragColor = outColor;
      }
    `;

    bowlProgram = sceneGL.createProgram();
    sceneGL.attachShader(bowlProgram, makeShader(sceneGL, sceneGL.VERTEX_SHADER, vertexSource));
    sceneGL.attachShader(bowlProgram, makeShader(sceneGL, sceneGL.FRAGMENT_SHADER, fragmentSource));
    sceneGL.linkProgram(bowlProgram);
    if (!sceneGL.getProgramParameter(bowlProgram, sceneGL.LINK_STATUS)) {
      throw new Error(sceneGL.getProgramInfoLog(bowlProgram));
    }

    sceneGL.useProgram(bowlProgram);
    bowlBuffer = sceneGL.createBuffer();
    sceneGL.bindBuffer(sceneGL.ARRAY_BUFFER, bowlBuffer);
    sceneGL.bufferData(sceneGL.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), sceneGL.STATIC_DRAW);
    const corner = sceneGL.getAttribLocation(bowlProgram, "aCorner");
    sceneGL.enableVertexAttribArray(corner);
    sceneGL.vertexAttribPointer(corner, 2, sceneGL.FLOAT, false, 0, 0);

    for (const name of ["uCenter", "uHalf", "uViewport", "uRadius", "uView", "uDepth", "uAngle", "uLift", "uTime"]) {
      bowlUniforms[name] = sceneGL.getUniformLocation(bowlProgram, name);
    }
    sceneGL.clearColor(0, 0, 0, 0);
    sceneGL.enable(sceneGL.BLEND);
    sceneGL.blendFunc(sceneGL.SRC_ALPHA, sceneGL.ONE_MINUS_SRC_ALPHA);
  }

  function drawBowlGL(b, now) {
    const bob = Math.sin(now * 0.001 + b.phase) * 1.05 + b.lift * 2.6;
    const depthT = smoothstep(-b.r * 0.2, height + b.r * 0.55, b.y);
    const view = 0.46 + depthT * 0.42;
    const side = b.r * (0.50 - view * 0.10 + (1 - depthT) * 0.12);
    const centerY = b.y - bob;
    const halfX = b.r * 2.05;
    const halfY = b.r * (view + 1.0) + side + 18;

    sceneGL.uniform2f(bowlUniforms.uCenter, b.x, centerY);
    sceneGL.uniform2f(bowlUniforms.uHalf, halfX, halfY);
    sceneGL.uniform2f(bowlUniforms.uViewport, width, height);
    sceneGL.uniform1f(bowlUniforms.uRadius, b.r);
    sceneGL.uniform1f(bowlUniforms.uView, view);
    sceneGL.uniform1f(bowlUniforms.uDepth, depthT);
    sceneGL.uniform1f(bowlUniforms.uAngle, Math.sin(b.angle) * 0.018);
    sceneGL.uniform1f(bowlUniforms.uLift, b.lift);
    sceneGL.uniform1f(bowlUniforms.uTime, now / 1000);
    sceneGL.drawArrays(sceneGL.TRIANGLE_STRIP, 0, 4);
  }

  function drawSceneGL(now) {
    sceneGL.useProgram(bowlProgram);
    sceneGL.viewport(0, 0, sceneCanvas.width, sceneCanvas.height);
    sceneGL.clear(sceneGL.COLOR_BUFFER_BIT);
    sceneGL.bindBuffer(sceneGL.ARRAY_BUFFER, bowlBuffer);
    bowls.sort((a, b) => a.y - b.y);
    for (const b of bowls) drawBowlGL(b, now);
  }

  function bowlCount() {
    const area = width * height;
    return clamp(Math.round(area / 36000), width < 700 ? 18 : 25, width < 700 ? 26 : 34);
  }

  function bowlHorizontalBounds(r, y) {
    const depthT = depthForY(y);
    return {
      minX: r * (0.92 + depthT * 0.20),
      maxX: width - r * (0.86 + depthT * 0.18),
    };
  }

  function bowlBounds(b) {
    const xBounds = bowlHorizontalBounds(b.r, b.y);
    return {
      minX: xBounds.minX,
      maxX: xBounds.maxX,
      minY: Math.max(height * 0.08, b.r * 0.72),
      maxY: height - b.r * 0.18,
    };
  }

  function createBowls() {
    seed = 1902;
    if (threeScene) {
      for (const b of bowls) {
        if (b.model) threeScene.remove(b.model);
        if (b.shadow) threeScene.remove(b.shadow);
      }
    }
    bowls.length = 0;
    const count = bowlCount();
    const farQuota = Math.round(count * 0.42);

    for (let slot = 0; bowls.length < count && slot < count * 6; slot += 1) {
      const placedIndex = bowls.length;
      let x = 0;
      let y = 0;
      let r = 0;
      let baseR = 0;
      let placed = false;

      for (let attempt = 0; attempt < 900 && !placed; attempt += 1) {
        const farBand = placedIndex < farQuota;
        const groupIndex = farBand
          ? placedIndex / Math.max(1, farQuota)
          : (placedIndex - farQuota) / Math.max(1, count - farQuota);
        const yNorm = farBand
          ? clamp(0.07 + rand() * 0.30 + groupIndex * 0.05, 0.055, 0.42)
          : clamp(0.30 + Math.pow(groupIndex, 1.14) * 0.64 + (rand() - 0.5) * 0.08, 0.26, 0.94);
        baseR = (width < 700 ? 29 : 34) + rand() * (width < 700 ? 14 : 18);
        if (farBand) baseR *= 0.72 + rand() * 0.26;
        else if (yNorm > 0.70 && rand() > 0.55) baseR *= 1.05 + rand() * 0.18;
        else if (rand() > 0.82) baseR *= 0.72 + rand() * 0.18;
        const laneCount = farBand ? 9 : 8;
        const rowIndex = Math.floor(placedIndex / laneCount);
        const lane = (placedIndex * 3 + rowIndex * 2 + attempt) % laneCount;
        const laneJitter = (rand() - 0.5) * (farBand ? 0.68 : 0.56);
        x = ((lane + 0.5 + laneJitter) / laneCount) * width;
        y = (0.055 + yNorm * 0.88 + (rand() - 0.5) * 0.095) * height;
        r = baseR * perspectiveScaleForY(y);

        if (rand() > 0.95) x += (rand() > 0.5 ? 1 : -1) * width * 0.045;
        const xBounds = bowlHorizontalBounds(r, y);
        x = clamp(x, xBounds.minX, xBounds.maxX);
        y = clamp(y, Math.max(height * 0.08, r * 0.72), height - r * 0.18);
        r = baseR * perspectiveScaleForY(y);

        placed = bowls.every((b) => {
          const dy = Math.abs(b.y - y);
          const perspectiveGap = dy < (b.r + r) * 1.12 ? 1.05 : 0.72;
          return Math.hypot(b.x - x, b.y - y) > (b.r + r) * perspectiveGap;
        });

        if (!placed && attempt > 620) {
          baseR *= 0.88;
          r = baseR * perspectiveScaleForY(y);
          placed = bowls.every((b) => Math.hypot(b.x - x, b.y - y) > (b.r + r) * 0.62);
        }
      }

      if (!placed) continue;

      const mass = r * r * 0.012;
      const style = 0;
      bowls.push({
        x,
        y,
        homeX: x,
        homeY: y,
        baseR,
        r,
        style,
        mass,
        vx: (rand() - 0.5) * 0.16,
        vy: (rand() - 0.5) * 0.12,
        angle: rand() * TAU,
        spin: (rand() - 0.5) * 0.002,
        phase: rand() * TAU,
        tone: clamp(1120 - r * 10 + rand() * 160, 430, 980),
        lastHit: 0,
        lastWake: 0,
        lift: 0,
      });
    }
    spreadBowlBands(0.16);
    settleBowlSpacing();
    spreadBowlBands(0.06);
    settleBowlSpacing();
    syncBowlModels();
  }

  function spreadBowlBands(strength) {
    const bands = Array.from({ length: 6 }, () => []);
    for (const b of bowls) {
      const band = clamp(Math.floor(depthForY(b.y) * bands.length), 0, bands.length - 1);
      bands[band].push(b);
    }

    for (const bandBowls of bands) {
      if (bandBowls.length < 3) continue;
      bandBowls.sort((a, b) => a.x - b.x);
      const avgDepth = bandBowls.reduce((sum, b) => sum + depthForY(b.y), 0) / bandBowls.length;
      const left = width * (0.055 + avgDepth * 0.045);
      const right = width * (0.945 - avgDepth * 0.055);
      const span = Math.max(width * 0.4, right - left);

      for (let i = 0; i < bandBowls.length; i += 1) {
        const b = bandBowls[i];
        const jitter = Math.sin(b.phase * 1.7 + i * 2.31) * span * 0.018;
        const targetX = left + span * ((i + 0.5) / bandBowls.length) + jitter;
        b.x += (targetX - b.x) * strength;
        updateBowlScreenSize(b);
        const bounds = bowlBounds(b);
        b.x = clamp(b.x, bounds.minX, bounds.maxX);
        b.homeX = b.x;
      }
    }
  }

  function settleBowlSpacing() {
    for (let pass = 0; pass < 72; pass += 1) {
      for (let i = 0; i < bowls.length; i += 1) {
        for (let j = i + 1; j < bowls.length; j += 1) {
          const a = bowls[i];
          const b = bowls[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.hypot(dx, dy) || 1;
          const sameDepth = 1 - clamp(Math.abs(dy) / Math.max(height * 0.22, 1), 0, 0.42);
          const target = (a.r + b.r) * (1.05 + sameDepth * 0.58);
          if (dist >= target) continue;

          const nx = dx / dist;
          const ny = dy / dist;
          const push = (target - dist) * 0.66;
          const total = a.mass + b.mass;
          const ax = nx * push * (b.mass / total);
          const ay = ny * push * (b.mass / total) * 0.58;
          const bx = nx * push * (a.mass / total);
          const by = ny * push * (a.mass / total) * 0.58;
          a.x -= ax;
          a.y -= ay;
          b.x += bx;
          b.y += by;
        }
      }

      for (const b of bowls) {
        updateBowlScreenSize(b);
        const bounds = bowlBounds(b);
        b.x = clamp(b.x, bounds.minX, bounds.maxX);
        b.y = clamp(b.y, bounds.minY, bounds.maxY);
      }
    }

    for (const b of bowls) {
      updateBowlScreenSize(b);
      b.homeX = b.x;
      b.homeY = b.y;
    }
  }

  function initAudioTrack() {
    if (audioTrack) return;
    audioTrack = new Audio(AUDIO_SRC);
    audioTrack.loop = true;
    audioTrack.preload = "auto";
    audioTrack.volume = 0.88;
    audioTrack.muted = muted;
  }

  function playAudioTrack() {
    initAudioTrack();
    audioTrack.muted = muted;
    if (!muted) {
      audioTrack.play().catch(() => {
        // Playback can still be blocked until the next direct user gesture.
      });
    }
  }

  function startExperience() {
    if (started) return;
    started = true;
    work.classList.add("started");
    playAudioTrack();
    pushRipple(width * 0.5, height * 0.56, 10, false);
    waterDrop(width * 0.5, height * 0.56, 80, 1.8);
  }

  function pushRipple(x, y, force = 18, disturbBowls = true) {
    const simForce = clamp(force * 0.045, 0.08, 1.15);
    waterDrop(x, y, clamp(force * 2.0, 10, 58), simForce);
    ripples.push({ x, y, age: 0, force, life: 1.45 + force * 0.012 });
    if (ripples.length > 38) ripples.shift();
    if (!disturbBowls) return;

    for (const b of bowls) {
      const dx = b.x - x;
      const dy = b.y - y;
      const dist = Math.hypot(dx, dy) || 1;
      const depthT = depthForY(y);
      const reach = (58 + force * 1.9) * (0.68 + depthT * 0.52);
      if (dist < reach) {
        const push = ((1 - dist / reach) ** 2) * force * 0.011;
        b.vx += (dx / dist) * push;
        b.vy += (dy / dist) * push;
        b.lift = Math.min(0.7, b.lift + push * 0.18);
      }
    }
  }

  function currentAt(x, y, time) {
    const cx = x / width - 0.5;
    const cy = y / height - 0.5;
    const swirl = Math.sin(time * 0.00008 + cx * 4.2 - cy * 2.8);
    const drift = Math.cos(time * 0.00012 + y * 0.008) * 0.007;
    return {
      x: Math.sin(y * 0.007 + time * 0.0002) * 0.008 + -cy * 0.005 * swirl + drift,
      y: Math.cos(x * 0.006 - time * 0.00018) * 0.007 + cx * 0.005 * swirl,
    };
  }

  function simulate(now) {
    const elapsed = now - lastTime;
    const dt = clamp(elapsed / 16.67, 0.35, 2.2);
    lastTime = now;

    breathT -= elapsed / 1000;
    if (breathT <= 0) {
      breathT = 0.58 + rand() * 1.65;
      waterDrop(width * (0.04 + rand() * 0.92), height * (0.04 + rand() * 0.92), 12 + rand() * 18, 0.05 + rand() * 0.06);
    }
    const simSteps = dt > 1.35 ? 2 : 1;
    for (let i = 0; i < simSteps; i += 1) stepWaterSim();

    for (const r of ripples) r.age += elapsed / 1000;
    for (let i = ripples.length - 1; i >= 0; i -= 1) {
      if (ripples[i].age > ripples[i].life) ripples.splice(i, 1);
    }

    for (const b of bowls) {
      updateBowlScreenSize(b);
      const c = currentAt(b.x, b.y, now);
      b.vx += c.x * 0.72 * dt;
      b.vy += c.y * 0.72 * dt;
      b.vx += Math.sin(now * 0.00035 + b.phase * 2.7) * 0.00105 * dt;
      b.vy += Math.cos(now * 0.0003 + b.phase * 2.1) * 0.00086 * dt;
      b.vx += (b.homeX - b.x) * 0.000012 * dt;
      b.vy += (b.homeY - b.y) * 0.000011 * dt;
      b.vx *= 0.982;
      b.vy *= 0.982;
      const speed = Math.hypot(b.vx, b.vy);
      if (speed > 0.46) {
        b.vx = (b.vx / speed) * 0.46;
        b.vy = (b.vy / speed) * 0.46;
      }
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      updateBowlScreenSize(b);
      b.angle += (b.spin + (b.vx - b.vy) * 0.00035) * dt;
      b.lift *= 0.90;

      if (started && speed > 0.045 && now - b.lastWake > 260) {
        waterDrop(b.x - b.vx * 36, b.y - b.vy * 36, clamp(b.r * 0.38, 14, 44), clamp(speed * 0.8, 0.04, 0.28));
        b.lastWake = now;
      }

      const bounds = bowlBounds(b);
      if (b.x < bounds.minX || b.x > bounds.maxX) {
        b.x = clamp(b.x, bounds.minX, bounds.maxX);
        b.vx *= -0.48;
      }
      if (b.y < bounds.minY || b.y > bounds.maxY) {
        b.y = clamp(b.y, bounds.minY, bounds.maxY);
        b.vy *= -0.48;
      }
    }

    for (let i = 0; i < bowls.length; i += 1) {
      for (let j = i + 1; j < bowls.length; j += 1) {
        const a = bowls[i];
        const b = bowls[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 1;
        const minDist = (a.r + b.r) * 1.02;
        const nearDist = minDist * 1.16;

        if (dist > minDist && dist < nearDist) {
          const nx = dx / dist;
          const ny = dy / dist;
          const pull = (1 - (dist - minDist) / (nearDist - minDist)) * 0.00008 * dt;
          a.vx += nx * pull * (b.mass / (a.mass + b.mass));
          a.vy += ny * pull * (b.mass / (a.mass + b.mass)) * 0.62;
          b.vx -= nx * pull * (a.mass / (a.mass + b.mass));
          b.vy -= ny * pull * (a.mass / (a.mass + b.mass)) * 0.62;
        }

        if (dist < minDist) {
          const nx = dx / dist;
          const ny = dy / dist;
          const overlap = minDist - dist;
          const total = a.mass + b.mass;
          a.x -= nx * overlap * (b.mass / total);
          a.y -= ny * overlap * (b.mass / total);
          b.x += nx * overlap * (a.mass / total);
          b.y += ny * overlap * (a.mass / total);

          const rvx = b.vx - a.vx;
          const rvy = b.vy - a.vy;
          const velocityAlongNormal = rvx * nx + rvy * ny;
          let contactForce = Math.max(overlap * 0.12, Math.abs(velocityAlongNormal) * 1.8, 0.45);
          if (velocityAlongNormal < 0) {
            const restitution = 0.46;
            const impulse = (-(1 + restitution) * velocityAlongNormal) / (1 / a.mass + 1 / b.mass);
            const ix = impulse * nx;
            const iy = impulse * ny;
            a.vx -= ix / a.mass;
            a.vy -= iy / a.mass;
            b.vx += ix / b.mass;
            b.vy += iy / b.mass;
            a.spin -= impulse * 0.000006;
            b.spin += impulse * 0.000006;
            a.lift = Math.min(0.7, a.lift + impulse * 0.00035);
            b.lift = Math.min(0.7, b.lift + impulse * 0.00035);
            contactForce = Math.max(contactForce, Math.abs(velocityAlongNormal) + impulse * 0.025);
          }

          if (started && contactForce > 0.18 && now - a.lastHit > 480 && now - b.lastHit > 480) {
            pushRipple((a.x + b.x) * 0.5, (a.y + b.y) * 0.5, clamp(contactForce * 3.6, 3, 14));
            a.lastHit = now;
            b.lastHit = now;
          }
        }
      }
    }
    for (const b of bowls) updateBowlScreenSize(b);
  }

  function drawWater(now) {
    if (waterGL && waterProgram && simTexture) {
      drawWaterGL(now);
      return;
    }
    if (!water) return;

    water.clearRect(0, 0, width, height);

    const bg = water.createLinearGradient(0, 0, width, height);
    bg.addColorStop(0, "#55c4e3");
    bg.addColorStop(0.38, "#20aed7");
    bg.addColorStop(0.76, "#0798ca");
    bg.addColorStop(1, "#087eae");
    water.fillStyle = bg;
    water.fillRect(0, 0, width, height);

    water.save();
    water.globalCompositeOperation = "multiply";
    for (let i = 0; i < 8; i += 1) {
      const x = ((i * 0.173 + 0.09) % 1) * width;
      const y = (0.18 + ((i * 0.219 + 0.31) % 0.72)) * height;
      const rx = width * (0.12 + (i % 3) * 0.03);
      const ry = height * (0.045 + (i % 2) * 0.025);
      const g = water.createRadialGradient(x, y, 4, x, y, rx);
      g.addColorStop(0, "rgba(0, 68, 92, 0.12)");
      g.addColorStop(0.46, "rgba(0, 75, 103, 0.06)");
      g.addColorStop(1, "rgba(0, 85, 110, 0)");
      water.save();
      water.translate(x, y);
      water.rotate(Math.sin(now * 0.00012 + i) * 0.28);
      water.scale(1, ry / rx);
      water.fillStyle = g;
      water.beginPath();
      water.arc(0, 0, rx, 0, TAU);
      water.fill();
      water.restore();
    }
    water.restore();

    water.save();
    water.globalCompositeOperation = "screen";
    water.globalAlpha = 0.16;
    for (let i = 0; i < 7; i += 1) {
      const y = height * (0.12 + i * 0.13) + Math.sin(now * 0.00018 + i) * 18;
      water.beginPath();
      for (let x = -80; x <= width + 90; x += 28) {
        const yy = y
          + Math.sin(x * 0.009 + now * 0.00022 + i * 1.7) * (10 + i * 1.2)
          + Math.sin(x * 0.025 - now * 0.00017 + i) * 3.2;
        if (x === -80) water.moveTo(x, yy);
        else water.lineTo(x, yy);
      }
      water.strokeStyle = "rgba(225, 255, 255, 0.2)";
      water.lineWidth = 7 + (i % 3) * 3;
      water.lineCap = "round";
      water.stroke();
    }
    water.restore();

    water.save();
    water.globalCompositeOperation = "multiply";
    water.globalAlpha = 0.2;
    for (let i = 0; i < 6; i += 1) {
      const y = height * (0.18 + i * 0.15) + Math.cos(now * 0.00013 + i) * 16;
      water.beginPath();
      for (let x = -80; x <= width + 90; x += 32) {
        const yy = y + Math.sin(x * 0.011 - now * 0.00016 + i * 1.1) * 12;
        if (x === -80) water.moveTo(x, yy);
        else water.lineTo(x, yy);
      }
      water.strokeStyle = "rgba(0, 91, 124, 0.13)";
      water.lineWidth = 9;
      water.lineCap = "round";
      water.stroke();
    }
    water.restore();

    water.save();
    water.globalAlpha = 0.11;
    water.lineWidth = 1;
    for (let i = -20; i < height + 60; i += 38) {
      water.beginPath();
      for (let x = -30; x <= width + 30; x += 22) {
        const y = i
          + Math.sin(x * 0.01 + now * 0.00034 + i * 0.018) * 4.4
          + Math.sin(x * 0.027 - now * 0.0002) * 1.6;
        if (x === -30) water.moveTo(x, y);
        else water.lineTo(x, y);
      }
      water.strokeStyle = "rgba(255,255,255,0.2)";
      water.stroke();
    }
    water.restore();

    water.save();
    water.globalCompositeOperation = "screen";
    water.globalAlpha = 0.24;
    for (let i = 0; i < 18; i += 1) {
      const x = ((i * 0.618 + 0.17) % 1) * width;
      const y = ((i * 0.414 + 0.09) % 1) * height;
      const len = 18 + (i % 5) * 14;
      water.beginPath();
      water.ellipse(
        x + Math.sin(now * 0.0003 + i) * 18,
        y + Math.cos(now * 0.00022 + i) * 12,
        len,
        1.4 + (i % 3) * 0.5,
        Math.sin(i) * 0.18,
        0,
        TAU,
      );
      water.fillStyle = "rgba(240, 255, 255, 0.22)";
      water.fill();
    }
    water.restore();

    water.save();
    water.globalCompositeOperation = "screen";
    const sample = width < 700 ? 20 : 18;
    for (let y = sample * 0.5; y < height; y += sample) {
      for (let x = sample * 0.5; x < width; x += sample) {
        const g = waterGradAtPx(x, y);
        const slope = Math.hypot(g.x, g.y);
        const light = g.x * 0.72 + g.y * 0.9 + g.h * 0.34;
        if (slope > 0.014 || light > 0.026) {
          const alpha = clamp(light * 1.35 + slope * 0.92, 0, 0.12);
          if (alpha > 0.026) {
            const angle = Math.atan2(g.y, g.x) + Math.PI * 0.5;
            const len = clamp(9 + slope * 72, 9, width < 700 ? 22 : 30);
            water.globalAlpha = alpha;
            water.strokeStyle = "rgba(244, 255, 255, 0.48)";
            water.lineWidth = clamp(0.45 + slope * 4.2, 0.45, 1.35);
            water.beginPath();
            water.moveTo(x - Math.cos(angle) * len * 0.5, y - Math.sin(angle) * len * 0.5);
            water.lineTo(x + Math.cos(angle) * len * 0.5, y + Math.sin(angle) * len * 0.5);
            water.stroke();
          }
        }
      }
    }
    water.restore();

    water.save();
    water.globalCompositeOperation = "screen";
    for (const r of ripples) {
      const p = r.age / r.life;
      const radius = 14 + p * (108 + r.force * 4.8);
      const alpha = (1 - p) * 0.12;
      water.beginPath();
      water.ellipse(r.x, r.y, radius * 1.08, radius * 0.42, 0, 0, TAU);
      water.strokeStyle = `rgba(235, 255, 255, ${alpha})`;
      water.lineWidth = 0.8 + r.force * 0.014;
      water.stroke();

      water.beginPath();
      water.ellipse(r.x, r.y, radius * 0.58, radius * 0.22, 0, 0, TAU);
      water.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.45})`;
      water.lineWidth = 1;
      water.stroke();

      water.beginPath();
      water.ellipse(r.x, r.y, radius * 0.86, radius * 0.34, 0, Math.PI * 0.05, Math.PI * 0.82);
      water.strokeStyle = `rgba(0, 105, 140, ${alpha * 0.3})`;
      water.lineWidth = 1.4;
      water.stroke();
    }
    water.restore();

    const shade = water.createRadialGradient(width * 0.5, height * 0.48, 0, width * 0.5, height * 0.52, Math.max(width, height) * 0.76);
    shade.addColorStop(0, "rgba(255,255,255,0.08)");
    shade.addColorStop(0.68, "rgba(0,105,150,0)");
    shade.addColorStop(1, "rgba(0,50,82,0.28)");
    water.fillStyle = shade;
    water.fillRect(0, 0, width, height);
  }

  function drawBowl(b, now) {
    const bob = Math.sin(now * 0.001 + b.phase) * 1.05 + b.lift * 2.6;
    const depthT = smoothstep(-b.r * 0.2, height + b.r * 0.55, b.y);
    const view = 0.5 + depthT * 0.42;
    const rx = b.r * (1.03 + Math.sin(b.angle) * 0.008);
    const rimRy = b.r * view;
    const sideDepth = b.r * (0.72 - view * 0.36);
    const waterline = sideDepth * 0.54;
    const x = b.x;
    const y = b.y - bob;

    scene.save();
    scene.translate(x + b.r * 0.24, y + sideDepth * (1.08 + depthT * 0.22));
    scene.rotate(-0.05 + b.angle * 0.018);
    scene.globalCompositeOperation = "screen";
    scene.globalAlpha = 0.22;
    const reflection = scene.createRadialGradient(0, 0, 2, 0, 0, b.r * 2.1);
    reflection.addColorStop(0, "rgba(230, 255, 255, 0.24)");
    reflection.addColorStop(0.38, "rgba(180, 235, 245, 0.12)");
    reflection.addColorStop(1, "rgba(255, 255, 255, 0)");
    scene.scale(1.1 - depthT * 0.06, 0.34 + depthT * 0.3);
    scene.fillStyle = reflection;
    scene.beginPath();
    scene.arc(0, 0, b.r * 2.05, 0, TAU);
    scene.fill();
    scene.restore();

    scene.save();
    scene.translate(
      x + b.r * (0.18 + depthT * 0.22),
      y + sideDepth * (1.35 + depthT * 0.46) + b.r * (0.12 + depthT * 0.12) + bob,
    );
    scene.rotate(-0.08 + b.angle * 0.026);
    const shadow = scene.createRadialGradient(0, 0, 2, 0, 0, b.r * 1.82);
    shadow.addColorStop(0, `rgba(0,33,48,${0.28 + depthT * 0.18})`);
    shadow.addColorStop(0.44, `rgba(0,50,70,${0.16 + depthT * 0.12})`);
    shadow.addColorStop(0.78, "rgba(0,58,78,0.08)");
    shadow.addColorStop(1, "rgba(0,60,80,0)");
    scene.scale(1.5 - depthT * 0.22, 0.24 + depthT * 0.44);
    scene.fillStyle = shadow;
    scene.beginPath();
    scene.arc(0, 0, b.r * 1.72, 0, TAU);
    scene.fill();
    scene.restore();

    scene.save();
    scene.translate(x, y);
    scene.rotate(Math.sin(b.angle) * 0.018);

    const bodyPath = new Path2D();
    bodyPath.moveTo(-rx * 0.98, -rimRy * 0.04);
    bodyPath.bezierCurveTo(-rx * 0.98, sideDepth * 0.16, -rx * 0.88, sideDepth * 0.72, -rx * 0.74, sideDepth);
    bodyPath.quadraticCurveTo(0, sideDepth * 1.12, rx * 0.74, sideDepth);
    bodyPath.bezierCurveTo(rx * 0.88, sideDepth * 0.72, rx * 0.98, sideDepth * 0.16, rx * 0.98, -rimRy * 0.04);
    bodyPath.quadraticCurveTo(0, rimRy * 0.18, -rx * 0.98, -rimRy * 0.04);

    const body = scene.createLinearGradient(0, -rimRy * 0.45, 0, sideDepth * 1.18);
    body.addColorStop(0, "#f9fbf7");
    body.addColorStop(0.22, "#d7ddda");
    body.addColorStop(0.56, "#829da4");
    body.addColorStop(1, "#336978");
    scene.fillStyle = body;
    scene.fill(bodyPath);

    const lateralShade = scene.createLinearGradient(-rx, 0, rx, sideDepth);
    lateralShade.addColorStop(0, "rgba(255,255,255,0.28)");
    lateralShade.addColorStop(0.42, "rgba(255,255,255,0)");
    lateralShade.addColorStop(1, "rgba(16, 52, 64, 0.22)");
    scene.fillStyle = lateralShade;
    scene.fill(bodyPath);

    scene.save();
    scene.clip(bodyPath);
    const submerge = scene.createLinearGradient(0, waterline, 0, sideDepth * 1.2);
    submerge.addColorStop(0, "rgba(40, 190, 222, 0.04)");
    submerge.addColorStop(0.34, "rgba(4, 156, 201, 0.18)");
    submerge.addColorStop(1, "rgba(0, 118, 166, 0.48)");
    scene.fillStyle = submerge;
    scene.fillRect(-rx * 1.15, waterline, rx * 2.3, sideDepth * 1.35);
    scene.restore();

    const rim = scene.createLinearGradient(-rx * 0.8, -rimRy, rx * 0.9, rimRy * 0.18);
    rim.addColorStop(0, "#fdfdf8");
    rim.addColorStop(0.48, "#eeeee6");
    rim.addColorStop(0.82, "#c8ccc7");
    rim.addColorStop(1, "#9eacad");
    scene.fillStyle = rim;
    scene.beginPath();
    scene.ellipse(0, 0, rx, rimRy, 0, 0, TAU);
    scene.fill();

    const inner = scene.createRadialGradient(rx * 0.08, rimRy * 0.42, 1, 0, 0, rx * 0.96);
    inner.addColorStop(0, "#fbf8f1");
    inner.addColorStop(0.2, "#f2eee6");
    inner.addColorStop(0.48, "#d7d4cc");
    inner.addColorStop(0.78, "#b3b5b1");
    inner.addColorStop(1, "#7d8e91");
    scene.fillStyle = inner;
    scene.beginPath();
    scene.ellipse(0, 0, rx * 0.94, rimRy * 0.88, 0, 0, TAU);
    scene.fill();

    scene.strokeStyle = "rgba(92,112,116,0.22)";
    scene.lineWidth = Math.max(0.6, b.r * 0.012);
    scene.beginPath();
    scene.ellipse(0, 0, rx * 0.94, rimRy * 0.88, 0, 0, TAU);
    scene.stroke();

    const well = scene.createRadialGradient(rx * 0.08, rimRy * 0.48, 1, 0, rimRy * 0.26, rx * 0.52);
    well.addColorStop(0, "rgba(255,255,255,0.82)");
    well.addColorStop(0.4, "rgba(250,248,242,0.38)");
    well.addColorStop(1, "rgba(180,180,174,0)");
    scene.fillStyle = well;
    scene.beginPath();
    scene.ellipse(rx * 0.08, rimRy * 0.34, rx * 0.44, rimRy * 0.3, 0, 0, TAU);
    scene.fill();

    scene.strokeStyle = "rgba(255,255,255,0.94)";
    scene.lineWidth = Math.max(0.8, b.r * 0.016);
    scene.beginPath();
    scene.ellipse(0, 0, rx * 0.995, rimRy * 0.995, 0, Math.PI * 1.01, Math.PI * 1.94);
    scene.stroke();

    scene.strokeStyle = "rgba(52,76,82,0.42)";
    scene.lineWidth = Math.max(0.6, b.r * 0.014);
    scene.beginPath();
    scene.ellipse(0, 0, rx * 0.995, rimRy * 0.995, 0, Math.PI * 0.08, Math.PI * 0.98);
    scene.stroke();

    scene.globalAlpha = 0.72;
    scene.strokeStyle = "rgba(255,255,255,0.5)";
    scene.lineWidth = Math.max(0.7, b.r * 0.017);
    scene.beginPath();
    scene.ellipse(-rx * 0.28, -rimRy * 0.12, rx * 0.14, rimRy * 0.4, -0.45, Math.PI * 0.08, Math.PI * 0.82);
    scene.stroke();
    scene.restore();
  }

  function drawScene(now) {
    if (threeRenderer && bowlModelsReady && now - lastSceneRender < 32) return;
    lastSceneRender = now;

    if (drawThreeScene(now)) return;

    if (sceneGL && bowlProgram) {
      drawSceneGL(now);
      return;
    }
    if (!scene) return;

    scene.clearRect(0, 0, width, height);

    bowls.sort((a, b) => a.y - b.y);
    for (const b of bowls) drawBowl(b, now);
  }

  function frame(now) {
    simulate(now);
    drawWater(now);
    drawScene(now);
    requestAnimationFrame(frame);
  }

  function handlePointer(event) {
    const x = event.clientX;
    const y = event.clientY;
    const dx = x - pointer.px;
    const dy = y - pointer.py;
    pointer.x = x;
    pointer.y = y;

    if (pointer.down && Math.hypot(dx, dy) > 10) {
      pushRipple(x, y, clamp(Math.hypot(dx, dy) * 0.72, 5, 18));
    }

    pointer.px = x;
    pointer.py = y;
  }

  function pointerDown(event) {
    if (event.target?.closest?.("button")) return;
    if (!started) startExperience();
    pointer.down = true;
    pointer.active = true;
    pointer.px = event.clientX;
    pointer.py = event.clientY;
    pushRipple(event.clientX, event.clientY, 10);
  }

  function pointerUp() {
    pointer.down = false;
  }

  startButton.addEventListener("click", (event) => {
    event.stopPropagation();
    startExperience();
  });

  soundButton.addEventListener("click", (event) => {
    event.stopPropagation();
    muted = !muted;
    soundButton.setAttribute("aria-pressed", String(!muted));
    if (audioTrack) audioTrack.muted = muted;
    if (!muted) {
      if (!started) startExperience();
      else playAudioTrack();
    }
  });

  resetButton.addEventListener("click", (event) => {
    event.stopPropagation();
    createBowls();
    waterU.fill(0);
    waterPrev.fill(0);
    breathT = 0;
    pushRipple(width * 0.5, height * 0.5, 30);
  });

  window.addEventListener("resize", resize);
  window.addEventListener("pointermove", handlePointer, { passive: true });
  window.addEventListener("pointerdown", pointerDown);
  window.addEventListener("pointerup", pointerUp);
  window.addEventListener("pointercancel", pointerUp);

  initWaterGL();
  initThreeScene();
  resize();
  requestAnimationFrame(frame);
})();
