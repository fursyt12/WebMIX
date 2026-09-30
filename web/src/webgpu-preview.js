/*
 * WebMIX - WebGPU preview rendering.
 *
 * The preview is drawn on the GPU: JPEG frames streamed by OBS
 * (`/api/preview.mjpg`, multipart/x-mixed-replace) are decoded with
 * `createImageBitmap` and uploaded straight into a GPUTexture, then drawn as an
 * aspect-fitted quad by a WGSL shader.  Compared to assigning `img.src` this
 * keeps scaling on the GPU, avoids layout/paint work per frame and leaves room
 * for future effects (crop, colour transforms, multiview) in one place.
 *
 * Everything degrades gracefully: when WebGPU or the stream endpoint is
 * unavailable the preview panel keeps using plain screenshots.
 */

/* --------------------------------------------------------- multipart parser */

/**
 * Incremental parser for `multipart/x-mixed-replace` JPEG streams.
 *
 * Pure and synchronous so it can be unit-tested without a browser: feed it
 * chunks, collect complete JPEG payloads.
 */
export class MultipartJpegParser {
  constructor(boundary = 'webmixframe') {
    this.marker = `--${boundary}`;
    this.buffer = new Uint8Array(0);
    this.frames = 0;
  }

  #append(chunk) {
    const next = new Uint8Array(this.buffer.length + chunk.length);
    next.set(this.buffer, 0);
    next.set(chunk, this.buffer.length);
    this.buffer = next;
  }

  #indexOf(needle, from = 0) {
    const haystack = this.buffer;
    const first = needle[0];
    for (let i = from; i <= haystack.length - needle.length; i++) {
      if (haystack[i] !== first) continue;
      let match = true;
      for (let j = 1; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) {
          match = false;
          break;
        }
      }
      if (match) return i;
    }
    return -1;
  }

  /**
   * Feed bytes and get back every complete JPEG frame found so far.
   * @param {Uint8Array} chunk
   * @returns {Uint8Array[]} JPEG payloads
   */
  push(chunk) {
    this.#append(chunk);
    const out = [];
    const markerBytes = new TextEncoder().encode(this.marker);
    const headerEnd = new TextEncoder().encode('\r\n\r\n');

    for (;;) {
      const start = this.#indexOf(markerBytes, 0);
      if (start < 0) {
        // Keep the tail: a marker may straddle two chunks.
        if (this.buffer.length > markerBytes.length) {
          this.buffer = this.buffer.subarray(this.buffer.length - markerBytes.length);
        }
        break;
      }
      const headersStart = start + markerBytes.length;
      const sep = this.#indexOf(headerEnd, headersStart);
      if (sep < 0) {
        this.buffer = this.buffer.subarray(start);
        break;
      }

      const headers = new TextDecoder().decode(this.buffer.subarray(headersStart, sep));
      const match = /content-length:\s*(\d+)/i.exec(headers);
      if (!match) {
        this.buffer = this.buffer.subarray(sep + headerEnd.length);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = sep + headerEnd.length;
      if (this.buffer.length < bodyStart + length) {
        this.buffer = this.buffer.subarray(start);
        break;
      }

      out.push(this.buffer.subarray(bodyStart, bodyStart + length));
      this.frames++;
      this.buffer = this.buffer.subarray(bodyStart + length);
    }

    return out;
  }
}

/**
 * Consume an MJPEG response, invoking `onFrame(Uint8Array)` per JPEG.
 * @returns {Promise<void>} resolves when the stream ends or is aborted
 */
export async function openMjpegStream(url, { onFrame, onError, signal } = {}) {
  try {
    const response = await fetch(url, { signal, cache: 'no-store' });
    if (!response.ok || !response.body) {
      throw new Error(`preview stream responded ${response.status}`);
    }
    const reader = response.body.getReader();
    const parser = new MultipartJpegParser();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      for (const frame of parser.push(value)) onFrame?.(frame);
    }
  } catch (err) {
    if (err?.name !== 'AbortError') onError?.(err);
  }
}

/* --------------------------------------------------------------- WebGPU view */

const SHADER = /* wgsl */ `
struct Uniforms {
  scale : vec2f,
  offset : vec2f,
};

@group(0) @binding(0) var<uniform> uniforms : Uniforms;
@group(0) @binding(1) var frameSampler : sampler;
@group(0) @binding(2) var frameTexture : texture_2d<f32>;

struct VertexOut {
  @builtin(position) position : vec4f,
  @location(0) uv : vec2f,
};

@vertex
fn vertexMain(@builtin(vertex_index) index : u32) -> VertexOut {
  var positions = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0)
  );
  var uvs = array<vec2f, 6>(
    vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0),
    vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(1.0, 0.0)
  );

  var out : VertexOut;
  let corner = positions[index];
  out.position = vec4f(corner * uniforms.scale + uniforms.offset, 0.0, 1.0);
  out.uv = uvs[index];
  return out;
}

@fragment
fn fragmentMain(in : VertexOut) -> @location(0) vec4f {
  return textureSample(frameTexture, frameSampler, in.uv);
}
`;

/** True when this browser can actually give us a WebGPU device. */
export async function webgpuAvailable() {
  try {
    if (!navigator.gpu) return false;
    const adapter = (await navigator.gpu.requestAdapter()) ??
      (await navigator.gpu.requestAdapter({ forceFallbackAdapter: true }));
    return Boolean(adapter);
  } catch {
    return false;
  }
}

/**
 * A canvas that renders frames with WebGPU.
 *
 * Create with `WebGpuPreview.create(canvas)`; returns null when WebGPU is not
 * usable so callers can fall back to an <img>.
 */
export class WebGpuPreview {
  static async create(canvas, { clearColor = { r: 0.07, g: 0.08, b: 0.1, a: 1 } } = {}) {
    try {
      if (!navigator.gpu) return null;
      const adapter = (await navigator.gpu.requestAdapter()) ??
        (await navigator.gpu.requestAdapter({ forceFallbackAdapter: true }));
      if (!adapter) return null;
      const device = await adapter.requestDevice();
      const context = canvas.getContext('webgpu');
      if (!context) return null;
      const format = navigator.gpu.getPreferredCanvasFormat();
      context.configure({ device, format, alphaMode: 'opaque' });
      // Re-configuring is required whenever the canvas backing size changes,
      // otherwise the swap chain is stale and draws go nowhere.

      const module = device.createShaderModule({ code: SHADER });
      const pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertexMain' },
        fragment: { module, entryPoint: 'fragmentMain', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });

      const uniformBuffer = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const sampler = device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      });
      const bindGroupLayout = pipeline.getBindGroupLayout(0);
      const uploadPath = await WebGpuPreview.probeUploadPath(device);

      return new WebGpuPreview({
        canvas,
        device,
        context,
        pipeline,
        uniformBuffer,
        sampler,
        bindGroupLayout,
        format,
        clearColor,
        uploadPath,
      });
    } catch {
      return null;
    }
  }

  /**
   * Work out how this WebGPU implementation can get pixels into a texture.
   *
   * `copyExternalImageToTexture` is the fast path, but some backends (notably
   * software/headless ones) accept the call and upload nothing, which shows up
   * as a black preview. Probe with a known colour and fall back to
   * `writeTexture` with raw RGBA when the result is wrong.
   */
  static async probeUploadPath(device) {
    const texture = device.createTexture({
      size: { width: 2, height: 2 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    });
    const buffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    try {
      const probe = new OffscreenCanvas(2, 2);
      const ctx = probe.getContext('2d');
      ctx.fillStyle = '#ff00ff';
      ctx.fillRect(0, 0, 2, 2);

      device.queue.copyExternalImageToTexture({ source: probe }, { texture }, { width: 2, height: 2 });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 8 }, { width: 2, height: 2 });
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const pixel = new Uint8Array(buffer.getMappedRange().slice(0, 4));
      buffer.unmap();
      const ok = pixel[0] > 200 && pixel[1] < 60 && pixel[2] > 200;
      return ok ? 'external' : 'writeTexture';
    } catch {
      return 'writeTexture';
    } finally {
      texture.destroy();
      buffer.destroy();
    }
  }

  constructor({ canvas, device, context, pipeline, uniformBuffer, sampler, bindGroupLayout, format, clearColor, uploadPath = 'external' }) {
    this.uploadPath = uploadPath;
    this.scratch = null;
    this.scratchContext = null;
    this.canvas = canvas;
    this.device = device;
    this.context = context;
    this.pipeline = pipeline;
    this.uniformBuffer = uniformBuffer;
    this.sampler = sampler;
    this.bindGroupLayout = bindGroupLayout;
    this.format = format;
    this.clearColor = clearColor;
    this.textures = null;
    this.bindGroups = null;
    this.index = 0;
    this.textureWidth = 0;
    this.textureHeight = 0;
    this.frames = 0;
    this.lastFrameAt = 0;
    this.fps = 0;
  }

  /** Match the drawing buffer to the element size, honouring devicePixelRatio. */
  resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      /* Changing the canvas size invalidates the WebGPU configuration; without
       * this the swap chain keeps the old size and every draw is discarded. */
      this.context.configure({ device: this.device, format: this.format, alphaMode: 'opaque' });
      return true;
    }
    return false;
  }

  /**
   * Keep two textures and alternate between them.
   *
   * A frame is sampled by the GPU while the next one is being uploaded; writing
   * into the texture a submitted frame still reads makes
   * `copyExternalImageToTexture` fail (the copy lands in the same texture that
   * is bound as a sampled resource). Ping-ponging gives a full frame of
   * separation without stalling the queue.
   */
  #ensureTextures(width, height) {
    if (this.textures && this.textureWidth === width && this.textureHeight === height) return;

    for (const texture of this.textures ?? []) texture.destroy();
    this.textures = [0, 1].map(() =>
      this.device.createTexture({
        size: { width, height },
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      })
    );
    this.bindGroups = this.textures.map((texture) =>
      this.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: texture.createView() },
        ],
      })
    );
    this.textureWidth = width;
    this.textureHeight = height;
    this.index = 0;
  }

  /** Upload and draw one frame (ImageBitmap, VideoFrame, canvas or img). */
  draw(source) {
    const width = source.width ?? source.displayWidth ?? 0;
    const height = source.height ?? source.displayHeight ?? 0;
    if (!width || !height) return;

    this.#ensureTextures(width, height);
    this.index = this.index ? 0 : 1;
    const destination = { texture: this.textures[this.index] };

    if (this.uploadPath === 'external') {
      this.device.queue.copyExternalImageToTexture({ source }, destination, { width, height });
    } else {
      /* Software/headless backends ignore copyExternalImageToTexture; decode to
       * raw RGBA on the CPU and upload that instead. */
      if (!this.scratch || this.scratch.width !== width || this.scratch.height !== height) {
        this.scratch = new OffscreenCanvas(width, height);
        this.scratchContext = this.scratch.getContext('2d', { willReadFrequently: true });
      }
      this.scratchContext.drawImage(source, 0, 0, width, height);
      const data = this.scratchContext.getImageData(0, 0, width, height).data;
      this.device.queue.writeTexture(destination, data, { bytesPerRow: width * 4, rowsPerImage: height }, { width, height });
    }

    let scaleX = 1;
    let scaleY = 1;
    const zoom = this.zoom ?? 1;

    if (this.scaling === 'canvas' || this.scaling === 'output') {
      // Pixel-exact: one source pixel per canvas pixel.
      const base = this.baseSize ?? {};
      const width2 = base.w || width;
      const height2 = base.h || height;
      scaleX = (width2 / Math.max(1, this.canvas.clientWidth)) * zoom;
      scaleY = (height2 / Math.max(1, this.canvas.clientHeight)) * zoom;
    } else {
      // Aspect-fit: letterbox horizontally or vertically, like OBS's preview.
      const canvasAspect = this.canvas.width / this.canvas.height;
      const sourceAspect = width / height;
      if (sourceAspect > canvasAspect) scaleY = canvasAspect / sourceAspect;
      else scaleX = sourceAspect / canvasAspect;
      scaleX *= zoom;
      scaleY *= zoom;
    }

    this.device.queue.writeBuffer(this.uniformBuffer, 0, new Float32Array([scaleX, scaleY, 0, 0]));

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: this.clearColor,
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroups[this.index]);
    pass.draw(6);
    pass.end();
    this.device.queue.submit([encoder.finish()]);

    this.frames++;
    const now = performance.now();
    if (this.lastFrameAt) this.fps = 1000 / Math.max(1, now - this.lastFrameAt);
    this.lastFrameAt = now;
  }

  /**
   * End-to-end pipeline check: decode a real frame from the host, upload it,
   * render it through the same shader the preview uses and read the result
   * back. Runs in a single task with its own device, which also works on
   * headless/software implementations where a long-lived device refuses
   * `mapAsync`. Used by the automated checks and for troubleshooting.
   *
   * @param {object} [options]
   * @param {string} [options.source] scene/source name to capture
   * @param {string} [options.endpoint] frame endpoint, defaults to the live preview
   * @returns {Promise<{ok: boolean, uploadPath?: string, top?: Array, error?: string}>}
   */
  static async selfTest({ source, endpoint = 'api/preview.jpg', width = 64, height = 36 } = {}) {
    try {
      if (!navigator.gpu) return { ok: false, error: 'no WebGPU' };
      const adapter = (await navigator.gpu.requestAdapter()) ??
        (await navigator.gpu.requestAdapter({ forceFallbackAdapter: true }));
      if (!adapter) return { ok: false, error: 'no adapter' };
      const device = await adapter.requestDevice();

      const url = `${endpoint}?source=${encodeURIComponent(source ?? '')}&width=${width}&height=${height}&quality=90`;
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) return { ok: false, error: `frame fetch ${response.status}` };
      const bitmap = await createImageBitmap(await response.blob());

      const uploadPath = await WebGpuPreview.probeUploadPath(device);

      const texture = device.createTexture({
        size: { width: bitmap.width, height: bitmap.height },
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      if (uploadPath === 'external') {
        device.queue.copyExternalImageToTexture(
          { source: bitmap },
          { texture },
          { width: bitmap.width, height: bitmap.height }
        );
      } else {
        const scratch = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = scratch.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bitmap, 0, 0);
        const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
        device.queue.writeTexture(
          { texture },
          data,
          { bytesPerRow: bitmap.width * 4, rowsPerImage: bitmap.height },
          { width: bitmap.width, height: bitmap.height }
        );
      }

      const module = device.createShaderModule({ code: SHADER });
      const format = 'rgba8unorm';
      const pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertexMain' },
        fragment: { module, entryPoint: 'fragmentMain', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });
      const uniformBuffer = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(uniformBuffer, 0, new Float32Array([1, 1, 0, 0]));
      const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer } },
          { binding: 1, resource: sampler },
          { binding: 2, resource: texture.createView() },
        ],
      });

      const target = device.createTexture({
        size: { width, height },
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      /* copyTextureToBuffer requires bytesPerRow to be a multiple of 256. */
      const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
      const readBuffer = device.createBuffer({
        size: bytesPerRow * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view: target.createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(6);
      pass.end();
      encoder.copyTextureToBuffer(
        { texture: target },
        { buffer: readBuffer, bytesPerRow },
        { width, height }
      );
      device.queue.submit([encoder.finish()]);

      await readBuffer.mapAsync(GPUMapMode.READ);
      const raw = new Uint8Array(readBuffer.getMappedRange().slice(0));
      // Strip the row padding so callers get tight RGBA.
      const pixels = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++) {
        pixels.set(raw.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
      }
      readBuffer.unmap();

      const counts = new Map();
      for (let i = 0; i < pixels.length; i += 4) {
        const key = `${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
      return {
        ok: true,
        uploadPath,
        top,
        size: [width, height],
        /** Raw RGBA of the rendered frame, for visual evidence. */
        pixels: Array.from(pixels),
      };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  }

  /**
   * Render the current frame into an offscreen target and read it back.
   *
   * The compositor does not always include WebGPU canvas contents (headless
   * software rasterisation), so screenshots are not a reliable check. This
   * renders the *same* texture, pipeline and transform into a readable texture
   * instead, which is what the automated checks assert on.
   *
   * @returns {Promise<{width:number, height:number, pixels:Uint8Array}>}
   */
  async readPixels({ width = 32, height = 18 } = {}) {
    if (!this.textures || !this.bindGroups) throw new Error('no frame uploaded yet');

    const target = this.device.createTexture({
      size: { width, height },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    /* copyTextureToBuffer requires bytesPerRow to be a multiple of 256. */
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const buffer = this.device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    try {
      const encoder = this.device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: target.createView(),
            clearValue: this.clearColor,
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.bindGroups[this.index]);
      pass.draw(6);
      pass.end();
      encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow }, { width, height });
      this.device.queue.submit([encoder.finish()]);

      await buffer.mapAsync(GPUMapMode.READ);
      const raw = new Uint8Array(buffer.getMappedRange().slice(0));
      buffer.unmap();
      const pixels = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++) {
        pixels.set(raw.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
      }
      return { width, height, pixels };
    } finally {
      buffer.destroy();
      target.destroy();
    }
  }

  destroy() {
    try {
      for (const texture of this.textures ?? []) texture.destroy();
      this.device?.destroy?.();
    } catch {
      /* ignore */
    }
    this.textures = null;
  }
}
