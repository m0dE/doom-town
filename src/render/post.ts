// Post-processing: dual-filter bloom fed by emissive pixels (alpha channel) and HDR
// overflow, then composite with a palette-preserving tone shoulder.
import * as THREE from 'three';
import { BLOOM_DOWN_FS, BLOOM_EXTRACT_FS, BLOOM_UP_FS, COMPOSITE_FS, FULLSCREEN_VS } from './shaders';

const LEVELS = 5;

function rt(w: number, h: number, depth: boolean): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: depth, stencilBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
  });
}

function pass(fs: string, uniforms: Record<string, THREE.IUniform>): THREE.RawShaderMaterial {
  return new THREE.RawShaderMaterial({ vertexShader: FULLSCREEN_VS, fragmentShader: fs, uniforms, glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false });
}

export class PostFX {
  readonly scene: THREE.WebGLRenderTarget;
  private down: THREE.WebGLRenderTarget[] = [];
  private up: THREE.WebGLRenderTarget[] = [];
  private quad: THREE.Mesh;
  private qscene = new THREE.Scene();
  private qcam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private extract: THREE.RawShaderMaterial;
  private downM: THREE.RawShaderMaterial;
  private upM: THREE.RawShaderMaterial;
  readonly composite: THREE.RawShaderMaterial;
  private w = 0;
  private h = 0;
  bloomStrength = 0.9;
  bloom = true;

  constructor() {
    this.scene = rt(1, 1, true);
    for (let i = 0; i < LEVELS; i++) { this.down.push(rt(1, 1, false)); this.up.push(rt(1, 1, false)); }
    this.extract = pass(BLOOM_EXTRACT_FS, { uSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.downM = pass(BLOOM_DOWN_FS, { uSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.upM = pass(BLOOM_UP_FS, { uSrc: { value: null }, uBase: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.composite = pass(COMPOSITE_FS, {
      uScene: { value: this.scene.texture }, uBloom: { value: null }, uBloomStrength: { value: 0 },
      uTime: { value: 0 }, uGrain: { value: 0.012 },
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new THREE.Mesh(g, this.composite);
    this.quad.frustumCulled = false;
    this.qscene.add(this.quad);
  }

  setSize(w: number, h: number): void {
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    this.scene.setSize(w, h);
    let lw = w, lh = h;
    for (let i = 0; i < LEVELS; i++) {
      lw = Math.max(1, lw >> 1); lh = Math.max(1, lh >> 1);
      this.down[i].setSize(lw, lh);
      this.up[i].setSize(lw, lh);
    }
  }

  private run(r: THREE.WebGLRenderer, m: THREE.Material, target: THREE.WebGLRenderTarget | null): void {
    this.quad.material = m;
    r.setRenderTarget(target);
    r.render(this.qscene, this.qcam);
  }

  /** Bloom from the scene target, then composite to the canvas. */
  finish(r: THREE.WebGLRenderer, time: number): void {
    const bloom = this.bloom && this.bloomStrength > 0;
    if (bloom) {
      this.extract.uniforms.uSrc.value = this.scene.texture;
      this.extract.uniforms.uTexel.value.set(1 / this.w, 1 / this.h);
      this.run(r, this.extract, this.down[0]);
      for (let i = 1; i < LEVELS; i++) {
        const src = this.down[i - 1];
        this.downM.uniforms.uSrc.value = src.texture;
        this.downM.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
        this.run(r, this.downM, this.down[i]);
      }
      let src = this.down[LEVELS - 1];
      for (let i = LEVELS - 2; i >= 0; i--) {
        this.upM.uniforms.uSrc.value = src.texture;
        this.upM.uniforms.uBase.value = this.down[i].texture;
        this.upM.uniforms.uTexel.value.set(0.5 / src.width, 0.5 / src.height);
        this.run(r, this.upM, this.up[i]);
        src = this.up[i];
      }
      this.composite.uniforms.uBloom.value = this.up[0].texture;
    }
    this.composite.uniforms.uBloomStrength.value = bloom ? this.bloomStrength : 0;
    this.composite.uniforms.uBloom.value ??= this.scene.texture;
    this.composite.uniforms.uTime.value = time;
    this.run(r, this.composite, null);
  }

  dispose(): void {
    this.scene.dispose();
    for (const t of [...this.down, ...this.up]) t.dispose();
    for (const m of [this.extract, this.downM, this.upM, this.composite]) m.dispose();
    this.quad.geometry.dispose();
  }
}
