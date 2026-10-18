/**
 * MAX DOESBORGH — Interactive Typography Under Pressure
 * Inspired by Schultzschultz ("Typography under pressure!")
 * 
 * Creative Coding Architecture:
 * 1. Offscreen High-Res Vector Typography (R=Stroke, G=Fill, B=Curvature Distance)
 * 2. Multi-Touch Dynamic Spring-Damper Pressure Blobs
 * 3. WebGL Volumetric 3D Extrusion & Balloon-Inflation Fragment Shader
 */

// Tunable creative coding parameters
export const PARAMS = {
  // Pressure & Balloon Physics
  maxPressure: 1.6,         // Peak inflation pressure under touch
  pressureRadius: 0.22,     // Interaction radius in normalized screen units
  bulgeStrength: 0.065,     // How strongly letters push outward (balloon bulge)
  springStiffness: 0.14,    // Elastic return stiffness (higher = snappier snapback)
  springDamping: 0.82,      // Oscillation damping (lower = more jelly wobble)

  // 3D Extrusion Stack
  extrusionSlices: 24,      // Number of depth layers marched in the shader
  extrusionDepth: 0.08,     // Vertical drop distance of the 3D extrusion block
  contourBands: 18.0,       // Frequency of stepped black/white contour stripes

  // Typography Layout
  fontFamily: '"Syne", "Space Grotesk", sans-serif',
  line1: 'MAX',
  line2: 'DOESBORGH',
  letterSpacingRatio: 0.04, // Relative tracking
  outlineWidthRatio: 0.016, // Stroke thickness relative to font size
};

class TypographyUnderPressureApp {
  constructor() {
    this.canvas = document.getElementById('pressure-canvas');
    this.gl = null;
    this.program = null;

    // Retina & Screen dimensions
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.aspect = this.height / this.width;

    // Typography Offscreen Buffer
    this.textCanvas = document.createElement('canvas');
    this.textCtx = this.textCanvas.getContext('2d', { alpha: true });
    this.textTexture = null;

    // Spring Blobs Pool (Multi-touch support)
    this.MAX_BLOBS = 16;
    this.blobs = [];
    for (let i = 0; i < this.MAX_BLOBS; i++) {
      this.blobs.push({
        active: false,
        pointerId: null,
        x: 0.5,
        y: 0.5,
        targetX: 0.5,
        targetY: 0.5,
        vx: 0,
        vy: 0,
        pressure: 0,
        targetPressure: 0,
        vp: 0, // Pressure velocity for spring bounce
        radius: PARAMS.pressureRadius,
      });
    }

    // Active pointers mapping
    this.activePointers = new Map();

    // Uniform locations cache
    this.uniforms = {};

    this.init();
  }

  init() {
    this.initWebGL();
    this.resize();
    this.setupEvents();

    // Spawn an initial gentle touch to demonstrate the effect on load
    const introBlob = this.blobs[0];
    introBlob.active = true;
    introBlob.x = 0.5;
    introBlob.y = 0.42;
    introBlob.pressure = 1.3;
    introBlob.targetPressure = 0.0;
    introBlob.radius = PARAMS.pressureRadius * 1.1;

    // Start render loop
    requestAnimationFrame((t) => this.loop(t));
  }

  initWebGL() {
    const glOpts = {
      alpha: false,
      depth: false,
      stencil: false,
      antialias: false,
      powerPreference: 'high-performance',
    };

    this.gl = this.canvas.getContext('webgl', glOpts) || this.canvas.getContext('experimental-webgl', glOpts);
    if (!this.gl) {
      console.error('WebGL is not supported on this browser.');
      return;
    }

    const gl = this.gl;

    // Vertex Shader: Fullscreen quad
    const vsSource = `
      attribute vec2 aPosition;
      varying vec2 vUv;
      void main() {
        vUv = aPosition * 0.5 + 0.5;
        gl_Position = vec4(aPosition, 0.0, 1.0);
      }
    `;

    // Fragment Shader: Inflatable Balloon & 3D Extrusion Stack
    const fsSource = `
      precision highp float;
      varying vec2 vUv;

      uniform sampler2D uTextTexture;
      uniform float uAspect;
      uniform float uBulgeStrength;
      uniform float uExtrudeDepth;
      uniform int uBlobCount;

      // Each blob: xy = position, z = radius, w = pressure
      uniform vec4 uBlobs[16];

      void main() {
        // 1. Calculate local pressure and displacement gradient
        float totalPressure = 0.0;
        vec2 totalDisplacement = vec2(0.0);

        for (int i = 0; i < 16; i++) {
          if (i >= uBlobCount) break;

          vec2 diff = vUv - uBlobs[i].xy;
          diff.y *= uAspect; // Equalize Euclidean distance for circular pressure
          float dist = length(diff);
          float r = uBlobs[i].z;

          if (dist < r * 2.2) {
            float normDist = dist / r;
            // Gaussian bell curve falloff
            float influence = exp(-normDist * normDist * 2.2) * uBlobs[i].w;
            totalPressure += influence;

            if (dist > 0.001) {
              vec2 dir = normalize(vUv - uBlobs[i].xy);
              totalDisplacement += dir * (influence * uBulgeStrength);
            }
          }
        }

        // 2. Displace texture coordinates (radial pneumatic balloon inflation)
        vec2 uvDisplaced = vUv - totalDisplacement;

        // 3. Multi-layer 3D Extrusion Marching (Schultzschultz Stepped Contour Stack)
        // If untouched, fast-path render the crisp hollow white outline
        if (totalPressure < 0.015) {
          vec4 restSample = texture2D(uTextTexture, uvDisplaced);
          // R channel = outline stroke
          vec3 restColor = vec3(restSample.r);
          gl_FragColor = vec4(restColor, 1.0);
          return;
        }

        // When under pressure: March 24 depth slices from back to front
        vec3 finalColor = vec3(0.0);
        vec2 extrudeVector = vec2(0.0, uExtrudeDepth) * min(totalPressure, 1.4);

        // March 24 slices from back (1.0) to front (0.0)
        for (int i = 24; i >= 0; i--) {
          float z = float(i) / 24.0;
          vec2 sliceUV = uvDisplaced + extrudeVector * z;

          // Out-of-bounds safety
          if (sliceUV.x < 0.0 || sliceUV.x > 1.0 || sliceUV.y < 0.0 || sliceUV.y > 1.0) {
            continue;
          }

          vec4 sampleTex = texture2D(uTextTexture, sliceUV);
          float strokeMask = sampleTex.r; // Hollow Outline
          float fillMask   = sampleTex.g; // Solid Letter Body

          // Pressure dynamically inflates stroke into solid pillowy form
          float inflateRatio = clamp(totalPressure * 1.3, 0.0, 1.0);
          float activeMask = mix(strokeMask, fillMask, inflateRatio);

          if (activeMask > 0.2) {
            if (z > 0.04) {
              // Stepped 3D extrusion sides (black & white contour stripes)
              float band = mod(z * 18.0, 2.0);
              float shade = (band > 1.0) ? 0.95 : 0.08;
              // Depth ambient occlusion
              shade *= (1.0 - z * 0.45);
              finalColor = vec3(shade);
            } else {
              // Top surface cap: Brilliant white + glossy specular curvature highlight
              vec3 topColor = vec3(1.0);
              float spec = pow(sampleTex.b, 2.2) * totalPressure * 0.45;
              finalColor = topColor + vec3(spec);
            }
          }
        }

        gl_FragColor = vec4(finalColor, 1.0);
      }
    `;

    this.program = this.createProgram(gl, vsSource, fsSource);
    gl.useProgram(this.program);

    // Geometry: Full-screen Quad
    const quad = new Float32Array([
      -1, -1,
       1, -1,
      -1,  1,
      -1,  1,
       1, -1,
       1,  1,
    ]);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

    const aPos = gl.getAttribLocation(this.program, 'aPosition');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    // Cache uniforms
    this.uniforms.uAspect = gl.getUniformLocation(this.program, 'uAspect');
    this.uniforms.uBulgeStrength = gl.getUniformLocation(this.program, 'uBulgeStrength');
    this.uniforms.uExtrudeDepth = gl.getUniformLocation(this.program, 'uExtrudeDepth');
    this.uniforms.uBlobCount = gl.getUniformLocation(this.program, 'uBlobCount');
    this.uniforms.uTextTexture = gl.getUniformLocation(this.program, 'uTextTexture');
    this.uniforms.uBlobs = gl.getUniformLocation(this.program, 'uBlobs');

    // Typography Texture
    this.textTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  createProgram(gl, vsSrc, fsSrc) {
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, vsSrc);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      console.error('VS compilation error:', gl.getShaderInfoLog(vs));
    }

    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fsSrc);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      console.error('FS compilation error:', gl.getShaderInfoLog(fs));
    }

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('Shader link error:', gl.getProgramInfoLog(prog));
    }

    return prog;
  }

  resize() {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.aspect = this.height / this.width;

    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);

    if (this.gl) {
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }

    this.renderTypographyTexture();
  }

  /**
   * Renders the crisp multi-channel typography offscreen:
   * - Red: Crisp Hollow Outline Stroke
   * - Green: Solid Letter Silhouette
   * - Blue: Soft Inward Curvature / Specular Map
   */
  renderTypographyTexture() {
    const w = this.canvas.width;
    const h = this.canvas.height;
    this.textCanvas.width = w;
    this.textCanvas.height = h;

    const ctx = this.textCtx;
    ctx.clearRect(0, 0, w, h);

    // Calculate massive, tightly stacked font size filling ~84% of width
    const targetWidth = w * 0.84;
    // Estimate initial font size
    let fontSize = Math.min(w * 0.19, h * 0.22);
    ctx.font = `800 ${fontSize}px ${PARAMS.fontFamily}`;

    // Measure to balance MAX and DOESBORGH
    const measure2 = ctx.measureText(PARAMS.line2).width;
    if (measure2 > 0) {
      fontSize = Math.round(fontSize * (targetWidth / measure2));
      // Cap height to ensure it fits comfortably centered on vertical screens
      fontSize = Math.min(fontSize, h * 0.26);
    }

    ctx.font = `800 ${fontSize}px ${PARAMS.fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const centerX = w * 0.5;
    const lineHeight = fontSize * 0.94; // Tight, modern leading
    const centerY = h * 0.5;
    const y1 = centerY - lineHeight * 0.52;
    const y2 = centerY + lineHeight * 0.48;

    const strokeWidth = Math.max(3 * this.dpr, fontSize * PARAMS.outlineWidthRatio);

    // PASS 1: Render Solid Fill into Green channel (using offscreen composition)
    // We create separate buffers for pure channels
    const fillCanvas = document.createElement('canvas');
    fillCanvas.width = w;
    fillCanvas.height = h;
    const fCtx = fillCanvas.getContext('2d');
    fCtx.font = ctx.font;
    fCtx.textAlign = 'center';
    fCtx.textBaseline = 'middle';
    fCtx.fillStyle = '#ffffff';
    fCtx.fillText(PARAMS.line1, centerX, y1);
    fCtx.fillText(PARAMS.line2, centerX, y2);

    // PASS 2: Render Crisp Outline Stroke into Red channel
    const strokeCanvas = document.createElement('canvas');
    strokeCanvas.width = w;
    strokeCanvas.height = h;
    const sCtx = strokeCanvas.getContext('2d');
    sCtx.font = ctx.font;
    sCtx.textAlign = 'center';
    sCtx.textBaseline = 'middle';
    sCtx.lineWidth = strokeWidth;
    sCtx.strokeStyle = '#ffffff';
    sCtx.lineJoin = 'round';
    sCtx.lineCap = 'round';
    sCtx.strokeText(PARAMS.line1, centerX, y1);
    sCtx.strokeText(PARAMS.line2, centerX, y2);

    // Composite into combined texture:
    // Red = Stroke, Green = Fill, Blue = Bevel Specular
    const imgData = ctx.createImageData(w, h);
    const fillData = fCtx.getImageData(0, 0, w, h).data;
    const strokeData = sCtx.getImageData(0, 0, w, h).data;
    const outData = imgData.data;
    const total = w * h;

    for (let i = 0; i < total; i++) {
      const idx = i * 4;
      const strokeVal = strokeData[idx + 3]; // Alpha of stroke
      const fillVal = fillData[idx + 3];     // Alpha of fill

      outData[idx]     = strokeVal; // Red channel: Outline
      outData[idx + 1] = fillVal;   // Green channel: Solid Body
      outData[idx + 2] = Math.min(255, strokeVal + fillVal * 0.6); // Blue channel: Specular
      outData[idx + 3] = Math.max(strokeVal, fillVal);             // Alpha
    }

    ctx.putImageData(imgData, 0, 0);

    // Upload to WebGL Texture
    if (this.gl) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.textTexture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.textCanvas);
    }
  }

  setupEvents() {
    // Prevent iOS Safari gestures, pull-to-refresh, zoom
    const prevent = (e) => e.preventDefault();
    window.addEventListener('touchmove', prevent, { passive: false });
    window.addEventListener('gesturestart', prevent, { passive: false });
    window.addEventListener('gesturechange', prevent, { passive: false });
    window.addEventListener('gestureend', prevent, { passive: false });

    // Pointer Interaction Handlers
    const onDown = (e) => {
      e.preventDefault();
      const normX = e.clientX / window.innerWidth;
      const normY = 1.0 - (e.clientY / window.innerHeight); // WebGL coordinates

      // Find or allocate blob for this pointer
      let blob = this.blobs.find((b) => !b.active);
      if (!blob) blob = this.blobs[0];

      blob.active = true;
      blob.pointerId = e.pointerId;
      blob.x = normX;
      blob.y = normY;
      blob.targetX = normX;
      blob.targetY = normY;
      blob.targetPressure = PARAMS.maxPressure * (e.pressure > 0 ? Math.max(0.7, e.pressure * 1.5) : 1.0);
      blob.pressure = 0.4;
      blob.vp = 0.3; // Initial pop velocity

      this.activePointers.set(e.pointerId, blob);
    };

    const onMove = (e) => {
      const blob = this.activePointers.get(e.pointerId);
      if (blob) {
        const normX = e.clientX / window.innerWidth;
        const normY = 1.0 - (e.clientY / window.innerHeight);

        blob.targetX = normX;
        blob.targetY = normY;
        blob.targetPressure = PARAMS.maxPressure * (e.pressure > 0 ? Math.max(0.7, e.pressure * 1.5) : 1.0);

        // When dragging rapidly, deposit a wake blob for continuous fluid extrusion
        const dist = Math.hypot(normX - blob.x, normY - blob.y);
        if (dist > 0.04) {
          const wakeBlob = this.blobs.find((b) => !b.active);
          if (wakeBlob) {
            wakeBlob.active = true;
            wakeBlob.pointerId = null;
            wakeBlob.x = (blob.x + normX) * 0.5;
            wakeBlob.y = (blob.y + normY) * 0.5;
            wakeBlob.targetX = wakeBlob.x;
            wakeBlob.targetY = wakeBlob.y;
            wakeBlob.pressure = blob.pressure * 0.85;
            wakeBlob.targetPressure = 0.0;
            wakeBlob.radius = blob.radius * 0.9;
          }
        }
      }
    };

    const onUp = (e) => {
      const blob = this.activePointers.get(e.pointerId);
      if (blob) {
        blob.targetPressure = 0.0;
        this.activePointers.delete(e.pointerId);
      }
    };

    this.canvas.addEventListener('pointerdown', onDown, { passive: false });
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerup', onUp, { passive: true });
    window.addEventListener('pointercancel', onUp, { passive: true });

    // Window resize
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => this.resize(), 100);
    });

    // Ensure fonts are fully rasterized
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => this.renderTypographyTexture());
    }
  }

  /**
   * Physics Simulation Step: Spring-damper elasticity on all active pressure blobs
   */
  updatePhysics() {
    const k = PARAMS.springStiffness;
    const damp = PARAMS.springDamping;

    for (let i = 0; i < this.MAX_BLOBS; i++) {
      const b = this.blobs[i];
      if (!b.active) continue;

      // Position smooth pursuit (fluid drag inertia)
      b.vx = (b.targetX - b.x) * 0.35 + b.vx * 0.55;
      b.vy = (b.targetY - b.y) * 0.35 + b.vy * 0.55;
      b.x += b.vx;
      b.y += b.vy;

      // Spring-Damper pressure oscillation (rubber bounce)
      const force = (b.targetPressure - b.pressure) * k;
      b.vp = (b.vp + force) * damp;
      b.pressure += b.vp;

      // Deactivate when pressure has fully settled to zero
      if (b.targetPressure <= 0.001 && Math.abs(b.pressure) < 0.004 && Math.abs(b.vp) < 0.002) {
        b.active = false;
        b.pressure = 0;
        b.vp = 0;
      }
    }
  }

  loop() {
    this.updatePhysics();

    const gl = this.gl;
    if (gl && this.program) {
      gl.useProgram(this.program);

      // Pack active blobs into uniform array
      const blobData = new Float32Array(this.MAX_BLOBS * 4);
      let count = 0;

      for (let i = 0; i < this.MAX_BLOBS; i++) {
        const b = this.blobs[i];
        if (b.active || b.pressure > 0.001) {
          const idx = count * 4;
          blobData[idx]     = b.x;
          blobData[idx + 1] = b.y;
          blobData[idx + 2] = b.radius;
          blobData[idx + 3] = Math.max(0, b.pressure);
          count++;
        }
      }

      // Update uniforms
      gl.uniform1f(this.uniforms.uAspect, this.aspect);
      gl.uniform1f(this.uniforms.uBulgeStrength, PARAMS.bulgeStrength);
      gl.uniform1f(this.uniforms.uExtrudeDepth, PARAMS.extrusionDepth);
      gl.uniform1i(this.uniforms.uBlobCount, count);
      gl.uniform4fv(this.uniforms.uBlobs, blobData);

      // Bind text texture to unit 0
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.textTexture);
      gl.uniform1i(this.uniforms.uTextTexture, 0);

      // Draw quad
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    requestAnimationFrame(() => this.loop());
  }
}

// Launch app once DOM is ready
window.addEventListener('DOMContentLoaded', () => {
  new TypographyUnderPressureApp();
});
