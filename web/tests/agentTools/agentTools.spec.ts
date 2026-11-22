import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia, type Pinia } from 'pinia';

// The queue store's persist path fans out to IndexedDB-backed stores and the
// geometry worker, none of which exist in the node test environment. They are
// mocked to no-ops so the tests exercise only the plan mutations themselves.
vi.mock('../../src/workerClient', () => ({ releaseCutoutModels: () => Promise.resolve() }));
vi.mock('../../src/photoStore', () => ({
  listPhotoIds: () => Promise.resolve([]),
  deletePhoto: () => Promise.resolve(),
}));
vi.mock('../../src/modelStore', () => ({
  listModelIds: () => Promise.resolve([]),
  deleteModel: () => Promise.resolve(),
}));
vi.mock('../../src/solidStore', () => ({
  listSolidRecordKeys: () => Promise.resolve([]),
  deleteSolidRecord: () => Promise.resolve(),
}));

// A minimal in-memory localStorage so the stores read and persist in node.
const memoryStore = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => memoryStore.get(k) ?? null,
  setItem: (k: string, v: string) => void memoryStore.set(k, v),
  removeItem: (k: string) => void memoryStore.delete(k),
  clear: () => memoryStore.clear(),
});

import { registerAgentTools } from '../../src/agentTools/registerAgentTools';
import {
  loadModelContext,
  type AgentTool,
  type JsonSchema,
  type ModelContextLike,
} from '../../src/agentTools/modelContext';
import { useBinQueue } from '../../src/stores/binQueue';
import { useBinDesigner } from '../../src/stores/binDesigner';
import { manualProduct } from '../../src/engine/plan/manualProduct';

/** A model context that records every registration, refusing duplicate names like the spec. */
function fakeModelContext(): ModelContextLike & { tools: Map<string, AgentTool> } {
  const tools = new Map<string, AgentTool>();
  return {
    tools,
    registerTool(tool: AgentTool) {
      if (tools.has(tool.name)) return Promise.reject(new Error(`duplicate ${tool.name}`));
      tools.set(tool.name, tool);
      return Promise.resolve();
    },
  };
}

let pinia: Pinia;
let context: ReturnType<typeof fakeModelContext>;

beforeEach(() => {
  memoryStore.clear();
  pinia = createPinia();
  setActivePinia(pinia);
  context = fakeModelContext();
  registerAgentTools({ modelContext: context, pinia });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Calls a registered tool and decodes its MCP text result. */
async function call(
  name: string,
  input: unknown = {},
): Promise<{ isError: boolean; body: Record<string, any> }> {
  const tool = context.tools.get(name);
  if (tool === undefined) throw new Error(`No tool named ${name} was registered.`);
  const result = await tool.execute(input);
  return { isError: result.isError === true, body: JSON.parse(result.content[0].text) };
}

/** Every description in a schema tree, with the path that leads to it. */
function nestedDescriptions(schema: JsonSchema, path: string): [string, string][] {
  const found: [string, string][] = [];
  if (typeof schema.description === 'string') found.push([path, schema.description]);
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  for (const [key, child] of Object.entries(properties)) {
    found.push(...nestedDescriptions(child, `${path}.${key}`));
  }
  const variants = (schema.oneOf ?? []) as JsonSchema[];
  variants.forEach((child, i) => found.push(...nestedDescriptions(child, `${path}.oneOf${i}`)));
  return found;
}

describe('agent tool registration', () => {
  it('registers every tool once', () => {
    expect([...context.tools.keys()].sort()).toEqual([
      'add_bin',
      'add_drawer_baseplates',
      'add_screws',
      'duplicate_entry',
      'list_icons',
      'list_queue',
      'remove_drawer',
      'remove_entry',
      'update_entry',
    ]);
  });

  it('gives every tool an object schema whose required fields exist', () => {
    for (const tool of context.tools.values()) {
      expect(tool.inputSchema.type, tool.name).toBe('object');
      const keys = Object.keys(tool.inputSchema.properties);
      for (const required of tool.inputSchema.required ?? []) {
        expect(keys, `${tool.name} requires ${required}`).toContain(required);
      }
    }
  });

  it('keeps names, descriptions and parameter descriptions within their budgets', () => {
    for (const tool of context.tools.values()) {
      expect(tool.name.length, tool.name).toBeLessThanOrEqual(30);
      expect(tool.description.length, tool.name).toBeLessThanOrEqual(500);
      for (const [path, text] of nestedDescriptions(
        tool.inputSchema as unknown as JsonSchema,
        tool.name,
      ).filter(([path]) => path !== tool.name)) {
        expect(text.length, path).toBeLessThanOrEqual(150);
      }
    }
  });

  it('never uses an em-dash in tool text', () => {
    for (const tool of context.tools.values()) {
      const texts = [tool.title, tool.description, JSON.stringify(tool.inputSchema)];
      for (const text of texts) expect(text, tool.name).not.toContain(String.fromCharCode(0x2014));
    }
  });

  it('reports a refused registration on the console with the tool name', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const refusing: ModelContextLike = {
      registerTool: (tool) =>
        tool.name === 'add_bin' ? Promise.reject(new Error('refused')) : Promise.resolve(),
    };

    registerAgentTools({ modelContext: refusing, pinia });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0][0]).toBe('Registering the agent tool add_bin failed.');
  });
});

describe('loadModelContext', () => {
  it('uses the native context without loading the polyfill', async () => {
    const native = fakeModelContext();
    const loadPolyfill = vi.fn(() => Promise.resolve());

    const resolved = await loadModelContext({ modelContext: native }, loadPolyfill);

    expect(resolved).toBe(native);
    expect(loadPolyfill).not.toHaveBeenCalled();
  });

  it('loads the polyfill when the context is missing and returns what it installs', async () => {
    const host: { modelContext?: ModelContextLike } = {};
    const installed = fakeModelContext();

    const resolved = await loadModelContext(host, () => {
      host.modelContext = installed;
      return Promise.resolve();
    });

    expect(resolved).toBe(installed);
  });

  it('rejects when the polyfill installs nothing', async () => {
    await expect(loadModelContext({}, () => Promise.resolve())).rejects.toThrow(
      'did not install document.modelContext',
    );
  });
});

describe('add_bin', () => {
  it('queues the product built from the given fields', async () => {
    const { isError, body } = await call('add_bin', {
      gridX: 2,
      gridY: 3,
      heightUnits: 4,
      magnetHoles: true,
      labelText: 'M3',
      labelText2: 'spare',
      labelIcon: 'hex nut',
      quantity: 2,
      notes: '  top drawer  ',
      unknownField: 'ignored',
    });

    expect(isError).toBe(false);
    const entry = useBinQueue().entryById(body.id)!;
    expect(entry.quantity).toBe(2);
    expect(entry.notes).toBe('top drawer');
    expect(entry.product).toEqual({
      kind: 'binWithInsert',
      bin: {
        origin: 'manual',
        gridX: 2,
        gridY: 3,
        heightUnits: 4,
        magnetHoles: true,
        walls: [],
      },
      insert: { text: 'M3', text2: 'spare', icon: 'hex nut' },
    });
  });

  it('queues what a fresh designer form would queue when no field is given', async () => {
    const designer = useBinDesigner();
    const formProduct = manualProduct({
      productChoice: designer.productChoice,
      gridX: designer.gridX,
      gridY: designer.gridY,
      heightUnits: designer.heightUnits,
      magnetHoles: designer.magnetHoles,
      walls: designer.walls,
      content: designer.content,
      fused: designer.fused,
    });

    const { body } = await call('add_bin', {});

    const entry = useBinQueue().entryById(body.id)!;
    expect(entry.product).toEqual(formProduct);
    expect(entry.quantity).toBe(1);
  });

  it('refuses an unknown icon, pointing to list_icons, and queues nothing', async () => {
    const { isError, body } = await call('add_bin', { labelIcon: 'no such icon' });

    expect(isError).toBe(true);
    expect(body.problem).toBe(
      'There is no label icon named "no such icon". Call list_icons for the available icon names.',
    );
    expect(useBinQueue().entries).toEqual([]);
  });

  it('refuses label text on a bin without a label slot', async () => {
    const { isError } = await call('add_bin', { productChoice: 'plainBin', labelText: 'M3' });

    expect(isError).toBe(true);
    expect(useBinQueue().entries).toEqual([]);
  });

  it('returns the queue refusal of an out-of-range size', async () => {
    const { isError, body } = await call('add_bin', { gridX: 0 });

    expect(isError).toBe(true);
    expect(body.problem).toMatch(/^This design/);
    expect(useBinQueue().entries).toEqual([]);
  });

  it('refuses a field of the wrong type by name', async () => {
    const { isError, body } = await call('add_bin', { gridX: '2' });

    expect(isError).toBe(true);
    expect(body.problem).toBe('gridX must be a number.');
  });
});

describe('add_screws', () => {
  it('adds the complete screws and reports the incomplete one as skipped', async () => {
    const { isError, body } = await call('add_screws', {
      list: 'm3x20 fhcs, m5x12 bhcs x4, m4 fhcs',
    });

    expect(isError).toBe(false);
    expect(body.added.map((a: { label: string; quantity: number }) => [a.label, a.quantity])).toEqual([
      ['M3 x 20', 1],
      ['M5 x 12', 4],
    ]);
    expect(body.skipped).toEqual(['Entry 3 (M4, countersunk screw) has no length.']);
    const products = useBinQueue().entries.map((e) => e.product);
    expect(products.map((p) => (p.kind === 'binWithInsert' ? p.insert.icon : null))).toEqual([
      'countersunk screw',
      'pan head screw',
    ]);
  });

  it('applies the size override to every screw', async () => {
    await call('add_screws', { list: 'm3x20 fhcs, m5x12 bhcs', sizeOverride: { width: 3, depth: 2 } });

    const sizes = useBinQueue().entries.map((e) =>
      e.product.kind === 'binWithInsert' ? [e.product.bin.gridX, e.product.bin.gridY] : null,
    );
    expect(sizes).toEqual([
      [3, 2],
      [3, 2],
    ]);
  });

  it('refuses a bin-alone product choice, which a screw entry does not offer', async () => {
    const { isError, body } = await call('add_screws', { list: 'm3x20 fhcs', productChoice: 'plainBin' });

    expect(isError).toBe(true);
    expect(body.problem).toBe('productChoice must be one of: binWithInsert, insert.');
    expect(useBinQueue().entries).toEqual([]);
  });

  it('adds nothing and says so when no screw is complete', async () => {
    const { isError, body } = await call('add_screws', { list: 'm4 fhcs' });

    expect(isError).toBe(true);
    expect(body.problem).toBe('There is nothing to add to the queue.');
    expect(body.skipped).toEqual(['Entry 1 (M4, countersunk screw) has no length.']);
  });
});

describe('add_drawer_baseplates', () => {
  it('creates a drawer group with its plates queued and connectable by default', async () => {
    const { isError, body } = await call('add_drawer_baseplates', {
      drawerWidthMm: 470,
      drawerDepthMm: 300,
      plateWidthMm: 470,
      plateDepthMm: 300,
    });

    expect(isError).toBe(false);
    expect(body.name).toBe('Drawer 470 × 300 mm');
    expect(body.plates.map((p: { count: number; gridUnits: string }) => [p.count, p.gridUnits])).toEqual([
      [1, '11×7'],
    ]);
    const queue = useBinQueue();
    expect(queue.groups.map((g) => g.id)).toEqual([body.id]);
    const plate = queue.entries[0].product;
    expect(plate.kind === 'baseplate' && plate.connectable).toBe(true);
  });

  it('returns the planner refusal of a drawer smaller than one cell', async () => {
    const { isError, body } = await call('add_drawer_baseplates', {
      drawerWidthMm: 30,
      drawerDepthMm: 300,
      plateWidthMm: 250,
      plateDepthMm: 250,
    });

    expect(isError).toBe(true);
    expect(body.problem).toBe(
      'The drawer must be at least 42 mm in both width and depth to fit one grid cell.',
    );
    expect(useBinQueue().groups).toEqual([]);
  });
});

describe('list_queue', () => {
  it('lists entries with their size and label, and drawers with their plate count', async () => {
    const bin = await call('add_bin', { gridX: 2, labelText: 'Bits' });
    const drawer = await call('add_drawer_baseplates', {
      drawerWidthMm: 470,
      drawerDepthMm: 300,
      plateWidthMm: 470,
      plateDepthMm: 300,
    });

    const { body } = await call('list_queue');

    const binRow = body.entries.find((e: { id: string }) => e.id === bin.body.id);
    expect([binRow.gridX, binRow.gridY, binRow.heightUnits, binRow.label.text]).toEqual([2, 1, 6, 'Bits']);
    const plateRow = body.entries.find((e: { kind: string }) => e.kind === 'baseplate');
    expect(plateRow.drawer).toEqual({ groupId: drawer.body.id, name: 'Drawer 470 × 300 mm' });
    expect(body.drawers).toEqual([
      { id: drawer.body.id, name: 'Drawer 470 × 300 mm', drawerWidthMm: 470, drawerDepthMm: 300, plateCount: 1 },
    ]);
  });
});

describe('update_entry', () => {
  it('changes the size and label of a manual bin and keeps the rest', async () => {
    const added = await call('add_bin', { gridX: 2, magnetHoles: true, labelText: 'Old', quantity: 3 });

    const { isError } = await call('update_entry', { id: added.body.id, gridY: 4, labelText: 'New' });

    expect(isError).toBe(false);
    const entry = useBinQueue().entryById(added.body.id)!;
    expect(entry.quantity).toBe(3);
    expect(entry.product).toEqual({
      kind: 'binWithInsert',
      bin: { origin: 'manual', gridX: 2, gridY: 4, heightUnits: 6, magnetHoles: true, walls: [] },
      insert: { text: 'New', text2: '', icon: null },
    });
  });

  it('changes the height of a screw bin and keeps its screw and composed label', async () => {
    const added = await call('add_screws', { list: 'm3x20 fhcs' });
    const id = added.body.added[0].id;

    const { isError } = await call('update_entry', { id, heightUnits: 3 });

    expect(isError).toBe(false);
    expect(useBinQueue().entryById(id)!.product).toMatchObject({
      kind: 'binWithInsert',
      bin: {
        origin: 'screw',
        heightUnits: 3,
        screw: { thread: 'M3', lengthMm: 20, head: 'countersunk screw', enteredLengthText: null },
      },
      insert: { text: 'M3 x 20' },
    });
  });

  it('refuses a label change on a screw entry', async () => {
    const added = await call('add_screws', { list: 'm3x20 fhcs' });

    const { isError } = await call('update_entry', { id: added.body.added[0].id, labelText: 'X' });

    expect(isError).toBe(true);
  });

  it('refuses a drawer row and leaves it unchanged', async () => {
    await call('add_drawer_baseplates', {
      drawerWidthMm: 470,
      drawerDepthMm: 300,
      plateWidthMm: 470,
      plateDepthMm: 300,
    });
    const row = useBinQueue().entries[0];
    const before = JSON.stringify(row);

    const { isError, body } = await call('update_entry', { id: row.id, quantity: 1, notes: 'x' });

    expect(isError).toBe(true);
    expect(body.problem).toContain('remove_drawer');
    expect(JSON.stringify(useBinQueue().entries[0])).toBe(before);
  });

  it('refuses an unknown id', async () => {
    const { isError, body } = await call('update_entry', { id: 'missing', quantity: 2 });

    expect(isError).toBe(true);
    expect(body.problem).toBe(
      'This queue entry no longer exists. It may have been removed or moved onto a build plate.',
    );
  });
});

describe('duplicate_entry, remove_entry and remove_drawer', () => {
  it('duplicates an entry as a new id with the same product', async () => {
    const added = await call('add_bin', { gridX: 3 });

    const { body } = await call('duplicate_entry', { id: added.body.id });

    const queue = useBinQueue();
    expect(body.id).not.toBe(added.body.id);
    expect(queue.entryById(body.id)!.product).toEqual(queue.entryById(added.body.id)!.product);
  });

  it('removes an entry', async () => {
    const added = await call('add_bin', {});

    const { isError } = await call('remove_entry', { id: added.body.id });

    expect(isError).toBe(false);
    expect(useBinQueue().entries).toEqual([]);
  });

  it('refuses to remove an unknown entry id', async () => {
    const { isError, body } = await call('remove_entry', { id: 'missing' });

    expect(isError).toBe(true);
    expect(body.problem).toBe(
      'This queue entry no longer exists. It may have been removed or moved onto a build plate.',
    );
  });

  it('refuses to remove a drawer row on its own, pointing to remove_drawer', async () => {
    await call('add_drawer_baseplates', {
      drawerWidthMm: 470,
      drawerDepthMm: 300,
      plateWidthMm: 470,
      plateDepthMm: 300,
    });

    const { isError, body } = await call('remove_entry', { id: useBinQueue().entries[0].id });

    expect(isError).toBe(true);
    expect(body.problem).toContain('remove_drawer');
    expect(useBinQueue().entries.length).toBe(1);
  });

  it('removes a drawer with its queued rows', async () => {
    const drawer = await call('add_drawer_baseplates', {
      drawerWidthMm: 470,
      drawerDepthMm: 300,
      plateWidthMm: 470,
      plateDepthMm: 300,
    });

    const { isError } = await call('remove_drawer', { id: drawer.body.id });

    expect(isError).toBe(false);
    expect(useBinQueue().groups).toEqual([]);
    expect(useBinQueue().entries).toEqual([]);
  });

  it('refuses to remove an unknown drawer id', async () => {
    const { isError, body } = await call('remove_drawer', { id: 'missing' });

    expect(isError).toBe(true);
    expect(body.problem).toBe('This drawer no longer exists. It may have been removed.');
  });
});
