import { describe, expect, it } from 'vitest';
import {
  mergeGroups,
  parsePlanFile,
  pickGroup,
  repairGroupLinks,
  serializePlanFile,
  validateGroup,
} from '../../src/engine/plan/planFile';
import { describeGroup } from '../../src/engine/plan/rowDescriptor';
import type {
  BaseplateProduct,
  DrawerPlate,
  Group,
  PrintBatch,
  QueueEntry,
} from '../../src/engine/plan/types';
import { PLAN_FILE_VERSION } from '../../src/engine/plan/types';

function plate(overrides: Partial<DrawerPlate> = {}): DrawerPlate {
  return {
    id: 'p1',
    unitsX: 3,
    unitsY: 2,
    brim: { leftMm: 4, rightMm: 0, frontMm: 0, backMm: 6 },
    column: 0,
    row: 0,
    ...overrides,
  };
}

function drawerGroup(overrides: Partial<Group> = {}): Group {
  return {
    id: 'g1',
    name: 'Top drawer',
    createdAt: '2026-07-21T10:00:00.000Z',
    payload: {
      kind: 'drawer',
      input: { drawerWidthMm: 470, drawerDepthMm: 300, plateWidthMm: 470, plateDepthMm: 300 },
      options: { magnets: null, screwHoles: false, connectable: false },
      plates: [plate({ id: 'p1' }), plate({ id: 'p2', column: 1 })],
      donePlateIds: [],
    },
    ...overrides,
  };
}

/** A baseplate product linked to a group's plates, as they are queued or batched. */
function linkedPlateProduct(groupId: string, ...plateIds: string[]): BaseplateProduct {
  return {
    kind: 'baseplate',
    unitsX: 3,
    unitsY: 2,
    magnets: null,
    screwHoles: false,
    connectable: false,
    brim: { leftMm: 4, rightMm: 0, frontMm: 0, backMm: 6 },
    group: { groupId, plateIds },
  };
}

function entry(id: string, product: BaseplateProduct): QueueEntry {
  return { id, quantity: 1, createdAt: '2026-07-21T10:00:00.000Z', product };
}

function batchOf(items: { id: string; product: BaseplateProduct }[]): PrintBatch {
  return {
    id: 'b1',
    name: 'Printer',
    createdAt: '2026-07-21T10:00:00.000Z',
    items: items.map((i) => ({ id: i.id, product: i.product, count: 1 })),
  };
}

describe('validateGroup', () => {
  it('accepts a well-formed drawer group', () => {
    expect(validateGroup(drawerGroup(), 'group g1')).toBeNull();
  });

  it('rejects a missing id', () => {
    const g = drawerGroup();
    delete (g as unknown as Record<string, unknown>).id;
    expect(validateGroup(g, 'group undefined')).toBe('A group is missing its id.');
  });

  it('rejects a non-string name', () => {
    const g = { ...drawerGroup(), name: 5 } as unknown;
    expect(validateGroup(g, 'group g1')).toMatch(/group name must be text/);
  });

  it('rejects a bad creation time', () => {
    const g = { ...drawerGroup(), createdAt: 'not-a-date' } as unknown;
    expect(validateGroup(g, 'group g1')).toMatch(/ISO 8601/);
  });

  it('rejects an unknown payload kind', () => {
    const g = { ...drawerGroup(), payload: { kind: 'mystery' } } as unknown;
    expect(validateGroup(g, 'group g1')).toMatch(/payload kind must be drawer/);
  });

  it('rejects a non-positive mm input', () => {
    const g = drawerGroup();
    g.payload.input.drawerWidthMm = 0;
    expect(validateGroup(g, 'group g1')).toMatch(/drawer width must be a positive number/);
  });

  it('rejects a bad option boolean', () => {
    const g = drawerGroup();
    (g.payload.options as unknown as Record<string, unknown>).connectable = 'yes';
    expect(validateGroup(g, 'group g1')).toMatch(/connectable must be true or false/);
  });

  it('rejects an empty plate list', () => {
    const g = drawerGroup();
    g.payload.plates = [];
    expect(validateGroup(g, 'group g1')).toMatch(/at least one plate/);
  });

  it('rejects a plate outside the unit bounds', () => {
    const g = drawerGroup();
    g.payload.plates[0].unitsX = 0;
    expect(validateGroup(g, 'group g1')).toMatch(/unitsX must be an integer/);
  });

  it('rejects a missing plate brim', () => {
    const g = drawerGroup();
    delete (g.payload.plates[0] as unknown as Record<string, unknown>).brim;
    expect(validateGroup(g, 'group g1')).toMatch(/brim must be an object/);
  });

  it('rejects duplicate plate ids', () => {
    const g = drawerGroup();
    g.payload.plates[1].id = 'p1';
    expect(validateGroup(g, 'group g1')).toMatch(/plate id p1 appears twice/);
  });

  it('rejects a done id that is not one of the plates', () => {
    const g = drawerGroup();
    g.payload.donePlateIds = ['ghost'];
    expect(validateGroup(g, 'group g1')).toMatch(/done plate id ghost is not one of/);
  });
});

describe('pickGroup', () => {
  it('filters a done id that does not match a plate', () => {
    // A done id can only reach pick after validation, but pick is defensive:
    // it drops any done id that is not a real plate.
    const raw = JSON.parse(JSON.stringify(drawerGroup())) as Record<string, unknown>;
    (raw.payload as Record<string, unknown>).donePlateIds = ['p1', 'ghost'];
    const picked = pickGroup(raw);
    expect(picked.payload.donePlateIds).toEqual(['p1']);
  });
});

describe('mergeGroups', () => {
  it('replaces a same-id group wholesale and appends the rest', () => {
    const existing = [drawerGroup({ id: 'g1', name: 'Old' })];
    const imported = [
      drawerGroup({ id: 'g1', name: 'New' }),
      drawerGroup({ id: 'g2', name: 'Second' }),
    ];
    const merged = mergeGroups(existing, imported);
    expect(merged.map((g) => `${g.id}:${g.name}`)).toEqual(['g1:New', 'g2:Second']);
  });
});

describe('repairGroupLinks', () => {
  it('strips a queue entry link that resolves to no group', () => {
    const entries = [entry('e1', linkedPlateProduct('ghost', 'p1'))];
    const warnings: string[] = [];
    repairGroupLinks(entries, [], [drawerGroup()], warnings);
    expect((entries[0].product as BaseplateProduct).group).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Entry e1 was linked to a drawer group/);
  });

  it('strips a batch item link that resolves to no plate but keeps a valid one', () => {
    const batch = batchOf([
      { id: 'i1', product: linkedPlateProduct('g1', 'ghost') },
      { id: 'i2', product: linkedPlateProduct('g1', 'p1') },
    ]);
    const warnings: string[] = [];
    repairGroupLinks([], [batch], [drawerGroup()], warnings);
    expect((batch.items[0].product as BaseplateProduct).group).toBeUndefined();
    expect((batch.items[1].product as BaseplateProduct).group).toEqual({
      groupId: 'g1',
      plateIds: ['p1'],
    });
    expect(warnings).toHaveLength(1);
  });

  it('drops only the unresolvable plate ids and reduces the quantity to match', () => {
    // A merged entry carries two plate ids; one no longer resolves, so it is
    // trimmed to the surviving id and the quantity follows.
    const merged = entry('e1', linkedPlateProduct('g1', 'p1', 'ghost'));
    merged.quantity = 2;
    const warnings: string[] = [];
    repairGroupLinks([merged], [], [drawerGroup()], warnings);
    expect((merged.product as BaseplateProduct).group).toEqual({ groupId: 'g1', plateIds: ['p1'] });
    expect(merged.quantity).toBe(1);
    expect(warnings).toHaveLength(1);
  });
});

describe('plan file v10 groups', () => {
  it('round-trips a partially-done group and its linked entries', () => {
    const group = drawerGroup({
      payload: {
        kind: 'drawer',
        input: { drawerWidthMm: 470, drawerDepthMm: 300, plateWidthMm: 470, plateDepthMm: 300 },
        options: { magnets: { diameterMm: 6, heightMm: 2 }, screwHoles: true, connectable: true },
        plates: [plate({ id: 'p1' }), plate({ id: 'p2', column: 1 })],
        donePlateIds: ['p1'],
      },
    });
    const entries = [entry('e1', linkedPlateProduct('g1', 'p2'))];
    const result = parsePlanFile(serializePlanFile(entries, [], [group]));
    if (!result.ok) throw new Error(result.error);
    expect(result.warnings).toEqual([]);
    expect(result.plan.version).toBe(PLAN_FILE_VERSION);
    expect(result.plan.groups).toEqual([group]);
    expect((result.plan.entries[0].product as BaseplateProduct).group).toEqual({
      groupId: 'g1',
      plateIds: ['p2'],
    });
  });

  it('loads a version 9 plan with no groups as an empty group list', () => {
    const v9 = JSON.stringify({ version: 9, entries: [], batches: [] });
    const result = parsePlanFile(v9);
    if (!result.ok) throw new Error(result.error);
    expect(result.plan.groups).toEqual([]);
  });

  it('repairs a dangling link on load rather than rejecting the plan', () => {
    const entries = [entry('e1', linkedPlateProduct('ghost', 'p1'))];
    const text = serializePlanFile(entries, [], []);
    const result = parsePlanFile(text);
    if (!result.ok) throw new Error(result.error);
    expect((result.plan.entries[0].product as BaseplateProduct).group).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
  });
});

describe('describeGroup', () => {
  it('derives all four plate statuses in precedence', () => {
    const group = drawerGroup({
      payload: {
        kind: 'drawer',
        input: { drawerWidthMm: 470, drawerDepthMm: 300, plateWidthMm: 470, plateDepthMm: 300 },
        options: { magnets: null, screwHoles: false, connectable: false },
        plates: [
          plate({ id: 'done' }),
          plate({ id: 'printing' }),
          plate({ id: 'queued' }),
          plate({ id: 'planned' }),
        ],
        donePlateIds: ['done'],
      },
    });
    const entries = [entry('e1', linkedPlateProduct('g1', 'queued'))];
    const batches = [batchOf([{ id: 'i1', product: linkedPlateProduct('g1', 'printing') }])];
    const described = describeGroup(group, entries, batches);
    expect(described.plates.map((p) => `${p.plate.id}:${p.status}`)).toEqual([
      'done:done',
      'printing:printing',
      'queued:queued',
      'planned:planned',
    ]);
    expect(described.counts).toEqual({ done: 1, printing: 1, queued: 1, planned: 1, total: 4 });
  });

  it('gives a done plate precedence over a still-queued link', () => {
    const group = drawerGroup({
      payload: {
        kind: 'drawer',
        input: { drawerWidthMm: 470, drawerDepthMm: 300, plateWidthMm: 470, plateDepthMm: 300 },
        options: { magnets: null, screwHoles: false, connectable: false },
        plates: [plate({ id: 'p1' })],
        donePlateIds: ['p1'],
      },
    });
    const entries = [entry('e1', linkedPlateProduct('g1', 'p1'))];
    expect(describeGroup(group, entries, []).plates[0].status).toBe('done');
  });
});
