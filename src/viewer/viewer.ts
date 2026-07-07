import * as THREE from 'three';

const YAW = Math.PI / 4;
const PITCH = Math.atan(1 / Math.SQRT2); // classic isometric 35.264°

/**
 * Fixed-isometric orthographic viewer: pan + zoom only, no rotation.
 */
export class IsoViewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.OrthographicCamera;
  readonly sun: THREE.DirectionalLight;
  readonly target = new THREE.Vector3(0, 0, 0);
  private readonly container: HTMLElement;
  private frustumHalf = 20;
  private readonly camDist = 120;
  /** view rotation in 90° steps around +Y (0..3); yaw = YAW + steps·π/2 */
  private yawSteps = 0;

  private get yaw(): number {
    return YAW + (this.yawSteps * Math.PI) / 2;
  }

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xe9c9a0);
    this.scene.fog = new THREE.Fog(0xe9c9a0, 190, 420);

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 500);
    this.camera.zoom = 1;
    this.updateCamera();

    // warm desert light rig
    const hemi = new THREE.HemisphereLight(0xffe3c0, 0x8a4526, 0.85);
    this.scene.add(hemi);

    this.sun = new THREE.DirectionalLight(0xffe0b0, 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.2;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  /** size the sun's shadow frustum to the map */
  fitSunTo(halfW: number, halfD: number): void {
    const s = Math.max(halfW, halfD) * 1.5;
    this.sunRadius = s * 1.6;
    const cam = this.sun.shadow.camera;
    cam.left = -s;
    cam.right = s;
    cam.top = s;
    cam.bottom = -s;
    cam.near = 1;
    cam.far = 300;
    cam.updateProjectionMatrix();
    this.sun.target.position.set(0, 0, 0);
    this.placeSun();
  }

  /** aim the sun; azimuth/elevation in degrees (tweakable in the GUI) */
  setSun(azimuthDeg: number, elevationDeg: number): void {
    this.sunAzimuth = azimuthDeg;
    this.sunElevation = elevationDeg;
    this.placeSun();
  }

  private sunRadius = 60;
  private sunAzimuth = -57;
  private sunElevation = 45;

  private placeSun(): void {
    const az = (this.sunAzimuth * Math.PI) / 180;
    const el = (this.sunElevation * Math.PI) / 180;
    const r = this.sunRadius;
    this.sun.position.set(
      r * Math.cos(el) * Math.sin(az),
      r * Math.sin(el),
      r * Math.cos(el) * Math.cos(az),
    );
  }

  fitView(halfW: number, halfD: number): void {
    const aspect = this.aspect();
    // at odd quarter turns the map's world axes swap on screen
    if (this.yawSteps % 2 === 1) [halfW, halfD] = [halfD, halfW];
    const needed = Math.max(halfD * 1.35, halfW / aspect) * 1.12;
    this.frustumHalf = needed;
    this.camera.zoom = 1;
    this.target.set(0, 0, 0);
    this.resize();
  }

  aspect(): number {
    return this.container.clientWidth / Math.max(1, this.container.clientHeight);
  }

  /** rotate the view a quarter turn around the map (+1 or -1 step) */
  rotateStep(dir: 1 | -1): void {
    this.yawSteps = (this.yawSteps + dir + 4) % 4;
    this.updateCamera();
  }

  updateCamera(): void {
    const cp = Math.cos(PITCH);
    this.camera.position.set(
      this.target.x + this.camDist * cp * Math.sin(this.yaw),
      this.target.y + this.camDist * Math.sin(PITCH),
      this.target.z + this.camDist * cp * Math.cos(this.yaw),
    );
    this.camera.lookAt(this.target);
  }

  pan(dxPixels: number, dyPixels: number): void {
    const h = this.container.clientHeight || 1;
    const worldPerPixel = (2 * this.frustumHalf) / this.camera.zoom / h;
    // screen right in ground plane
    const rx = Math.cos(this.yaw);
    const rz = -Math.sin(this.yaw);
    // screen up projected onto ground plane
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const upScale = 1 / Math.sin(PITCH);
    this.target.x += (-dxPixels * rx + dyPixels * fx * upScale) * worldPerPixel;
    this.target.z += (-dxPixels * rz + dyPixels * fz * upScale) * worldPerPixel;
    this.updateCamera();
  }

  zoomBy(factor: number): void {
    this.camera.zoom = Math.min(10, Math.max(0.35, this.camera.zoom * factor));
    this.camera.updateProjectionMatrix();
  }

  /** center the view on a world position (dev/verification helper) */
  lookAtWorld(x: number, z: number, zoom = 3): void {
    this.target.set(x, 0, z);
    this.camera.zoom = Math.min(10, Math.max(0.35, zoom));
    this.camera.updateProjectionMatrix();
    this.updateCamera();
  }

  resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    const aspect = w / Math.max(1, h);
    this.camera.left = -this.frustumHalf * aspect;
    this.camera.right = this.frustumHalf * aspect;
    this.camera.top = this.frustumHalf;
    this.camera.bottom = -this.frustumHalf;
    this.camera.updateProjectionMatrix();
    this.updateCamera();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }
}
