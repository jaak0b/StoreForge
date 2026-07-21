import { onBeforeUnmount, onMounted, shallowRef, type Ref, type ShallowRef } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { MeshData } from '../engine/gridfinity/types';

/**
 * The scene scaffolding every 3D preview in the app shares: renderer, scene,
 * camera, orbit controls, lights, floor grid, the resize observer, the
 * animation loop, the Z-up-millimetre to Y-up conversion, mesh building from
 * MeshData, and the disposal path.
 *
 * It lives in composables rather than in the engine because it is Vue and DOM
 * bound by nature; the engine stays framework-agnostic and this is the layer
 * that is allowed to know about both.
 *
 * A component owns what it draws and this owns everything around it, so the
 * camera framing, the lighting and the teardown cannot drift apart between two
 * viewports that are alive at the same time.
 */

/** Field of view of the preview camera, in degrees. */
const CAMERA_FOV_DEG = 45;

/** Near and far planes in mm: close enough to inspect a fillet, far enough for a whole build plate. */
const CAMERA_NEAR_MM = 0.1;
const CAMERA_FAR_MM = 2000;

/**
 * Where the camera sits and what it looks at, in mm. Three quarters view from
 * above, aimed a little up from the bed so a bin sits in the middle of the
 * frame rather than in the lower half.
 */
const CAMERA_POSITION_MM: readonly [number, number, number] = [90, 80, 110];
const CAMERA_TARGET_MM: readonly [number, number, number] = [0, 15, 0];

/** Floor grid: 420 mm across in 42 mm cells, one cell per Gridfinity grid unit. */
const GRID_SIZE_MM = 420;
const GRID_DIVISIONS = 42;

/** What a mounted scene hands back to the component that owns the contents. */
export interface ThreeSceneContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  /** The canvas the renderer draws into, for pointer listeners. */
  canvas: HTMLCanvasElement;
  /**
   * Group holding everything expressed in model space: Z-up millimetres, the
   * frame the whole geometry layer uses. Three's world is Y-up, so this group
   * carries the single rotation that converts between them. Add generated
   * meshes here, never to the scene directly, and a child's local position and
   * rotation are then bin-local millimetres and radians with no conversion.
   */
  modelRoot: THREE.Group;
}

export interface ThreeSceneOptions {
  /** Runs once the scene exists, before the first frame is drawn. */
  onReady?: (context: ThreeSceneContext) => void;
  /** Runs every animation frame, after the orbit controls update and before the render. */
  onFrame?: (context: ThreeSceneContext) => void;
  /**
   * Runs on unmount before the shared scaffolding is torn down, so the
   * component can dispose the geometries, materials and controls it created
   * while the scene it added them to is still intact.
   */
  onTeardown?: (context: ThreeSceneContext) => void;
}

/**
 * The bin body material. Instance scope, never module scope: two viewports can
 * be alive at once and a material disposed by the first unmount would leave
 * the second drawing with freed GPU resources.
 *
 * CSG output is welded: every face is planar and every shared edge is a
 * genuinely hard edge, so averaged vertex normals smear across them. Flat
 * shading uses the face normal instead.
 */
export function createBodyMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xa8a8a8,
    metalness: 0.05,
    roughness: 0.65,
    flatShading: true,
  });
}

/**
 * The second-filament material. A light near-neutral so the raised label face
 * reads clearly against the darker grey body.
 */
export function createLabelMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xe0dcd5,
    metalness: 0.05,
    roughness: 0.55,
    flatShading: true,
  });
}

/**
 * A translucent preview material in one of the theme's accent colours. Used for
 * the model ghosts and the gizmo tones, and for the paint cursor and stroke
 * previews: every non-solid overlay the editors draw takes its look from here,
 * so one factory settles the opacity and depth behaviour they all share.
 *
 * Drawn translucent so a model sunk into the bin still reads, and with depth
 * writing off so two overlapping overlays do not punch holes in each other.
 * Depth testing stays on: a shape hidden behind a bin wall is genuinely not
 * clickable in the viewport.
 */
export function createGhostMaterial(color: string): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    metalness: 0.05,
    roughness: 0.5,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  });
}

/**
 * A renderable mesh from generated geometry. The returned mesh carries no
 * rotation of its own: it belongs under the context's modelRoot, which holds
 * the Z-up to Y-up conversion for everything in the scene.
 */
export function buildMeshObject(mesh: MeshData, material: THREE.Material): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.vertices, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

/**
 * Mount a preview scene into an element for the lifetime of the calling
 * component. The container is passed in rather than returned so the component
 * owns the template ref, which is where it has to be declared for the template
 * to bind it.
 */
export function useThreeScene(
  container: Ref<HTMLElement | null>,
  options: ThreeSceneOptions = {},
): {
  /** The mounted scene, or null before mount and after unmount. */
  context: ShallowRef<ThreeSceneContext | null>;
} {
  const context = shallowRef<ThreeSceneContext | null>(null);

  let resizeObserver: ResizeObserver | null = null;
  let intersectionObserver: IntersectionObserver | null = null;
  let animationHandle = 0;
  // The loop runs only while the container is on screen. A viewport in a hidden
  // tab (display:none) has nothing to show yet keeps costing a full render at
  // frame rate, so a second tab drags the whole app down; watching real
  // visibility stops the cost the moment the tab goes away.
  let running = false;
  let visible = false;

  /** One frame: advance the controls, let the owner draw, render. */
  function renderFrame(ctx: ThreeSceneContext): void {
    ctx.controls.update();
    options.onFrame?.(ctx);
    ctx.renderer.render(ctx.scene, ctx.camera);
  }

  function startLoop(): void {
    if (running) return;
    const ctx = context.value;
    if (!ctx) return;
    running = true;
    const animate = (): void => {
      animationHandle = requestAnimationFrame(animate);
      renderFrame(ctx);
    };
    // animate() renders synchronously before scheduling the next frame, so the
    // canvas is current the instant the loop resumes and a tab switch never
    // shows the frame the loop was paused on.
    animate();
  }

  function stopLoop(): void {
    if (!running) return;
    cancelAnimationFrame(animationHandle);
    animationHandle = 0;
    running = false;
  }

  function resize(): void {
    const ctx = context.value;
    if (!ctx || !container.value) return;
    const { clientWidth, clientHeight } = container.value;
    if (clientWidth === 0 || clientHeight === 0) return;
    ctx.renderer.setSize(clientWidth, clientHeight, false);
    ctx.camera.aspect = clientWidth / clientHeight;
    ctx.camera.updateProjectionMatrix();
  }

  onMounted(() => {
    const el = container.value;
    if (!el) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    el.appendChild(renderer.domElement);
    // The canvas is absolutely positioned so its pixel buffer size never feeds
    // back into the container's layout height at fractional device pixel ratios.
    renderer.domElement.style.position = 'absolute';
    renderer.domElement.style.inset = '0';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x121212);

    const camera = new THREE.PerspectiveCamera(
      CAMERA_FOV_DEG,
      1,
      CAMERA_NEAR_MM,
      CAMERA_FAR_MM,
    );
    camera.position.set(...CAMERA_POSITION_MM);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(...CAMERA_TARGET_MM);
    controls.enableDamping = true;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x4a4a4a, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(80, 120, 60);
    scene.add(key);

    scene.add(new THREE.GridHelper(GRID_SIZE_MM, GRID_DIVISIONS, 0x3a3a3a, 0x242424));

    // Model space is Z-up millimetres; three.js scenes are Y-up.
    const modelRoot = new THREE.Group();
    modelRoot.rotation.x = -Math.PI / 2;
    scene.add(modelRoot);

    const ctx: ThreeSceneContext = {
      renderer,
      scene,
      camera,
      controls,
      canvas: renderer.domElement,
      modelRoot,
    };
    context.value = ctx;

    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(el);
    resize();

    options.onReady?.(ctx);

    // IntersectionObserver reports a display:none subtree as not intersecting
    // and fires again when the tab is shown, which is exactly the signal the
    // loop needs. It also carries the first frame: the loop starts here only
    // once the container is actually on screen.
    intersectionObserver = new IntersectionObserver((entries) => {
      const nowVisible = entries.some((entry) => entry.isIntersecting);
      if (nowVisible === visible) return;
      visible = nowVisible;
      if (visible) {
        // Dimensions can have changed while the tab was hidden, so the canvas
        // is resized before the first frame is drawn.
        resize();
        startLoop();
      } else {
        stopLoop();
      }
    });
    intersectionObserver.observe(el);
  });

  onBeforeUnmount(() => {
    stopLoop();
    intersectionObserver?.disconnect();
    intersectionObserver = null;
    resizeObserver?.disconnect();
    resizeObserver = null;
    const ctx = context.value;
    if (!ctx) return;
    options.onTeardown?.(ctx);
    ctx.controls.dispose();
    ctx.renderer.dispose();
    context.value = null;
  });

  return { context };
}
