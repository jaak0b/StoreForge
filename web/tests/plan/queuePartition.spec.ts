import { describe, expect, it } from 'vitest';
import { partitionQueue } from '../../src/engine/plan/queuePartition';
import type { Group, Product, QueueEntry } from '../../src/engine/plan/types';

const BRIM = { leftMm: 0, rightMm: 0, frontMm: 0, backMm: 0 };

function entry(id: string, product: Product): QueueEntry {
  return { id, quantity: 1, createdAt: '2026-01-01T00:00:00.000Z', product };
}

function plateProduct(groupId: string, plateId: string): Product {
  return {
    kind: 'baseplate',
    unitsX: 2,
    unitsY: 2,
    magnets: null,
    screwHoles: false,
    connectable: false,
    brim: { ...BRIM },
    group: { groupId, plateId },
  };
}

function looseBaseplate(): Product {
  return { kind: 'baseplate', unitsX: 3, unitsY: 3, magnets: null, screwHoles: false, connectable: false };
}

function group(id: string): Group {
  return {
    id,
    name: `Drawer ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    payload: {
      kind: 'drawer',
      input: { drawerWidthMm: 400, drawerDepthMm: 300, plateWidthMm: 400, plateDepthMm: 300 },
      options: { magnets: null, screwHoles: false, connectable: false },
      plates: [{ id: 'p1', unitsX: 2, unitsY: 2, brim: { ...BRIM }, column: 0, row: 0 }],
      donePlateIds: [],
    },
  };
}

describe('partitionQueue', () => {
  it('sorts linked plate entries under their group and leaves other entries loose', () => {
    const g = group('g1');
    const entries = [
      entry('a', plateProduct('g1', 'p1')),
      entry('b', looseBaseplate()),
    ];
    const result = partitionQueue(entries, [g]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].group.id).toBe('g1');
    expect(result.groups[0].entries.map((e) => e.id)).toEqual(['a']);
    expect(result.loose.map((e) => e.id)).toEqual(['b']);
  });

  it('keeps a group section even when it has no queued plate', () => {
    const result = partitionQueue([], [group('g1')]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].entries).toEqual([]);
    expect(result.loose).toEqual([]);
  });

  it('renders a plate loose when its group is gone', () => {
    const entries = [entry('a', plateProduct('missing', 'p1'))];
    const result = partitionQueue(entries, []);
    expect(result.groups).toEqual([]);
    expect(result.loose.map((e) => e.id)).toEqual(['a']);
  });
});
