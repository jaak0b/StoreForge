import { describe, expect, it } from 'vitest';
import {
  parseTemplateFile,
  serializeTemplateFile,
  validateTemplate,
} from '../../src/engine/plan/templateFile';
import type { BinTemplate } from '../../src/engine/plan/types';

function makeTemplate(overrides: Partial<BinTemplate> = {}): BinTemplate {
  return {
    id: 'template-1',
    name: 'Screws M3',
    params: {
      gridX: 2,
      gridY: 1,
      heightUnits: 3,
      stackingLip: true,
      magnetHoles: false,
      dividerCountX: 0,
      dividerCountY: 0,
      perforatedBase: false,
      labelText: 'M3 x 20',
      labelText2: '',
      labelIcon: 'screw',
    },
    createdAt: '2026-07-15T10:00:00.000Z',
    ...overrides,
  };
}

describe('serializeTemplateFile / parseTemplateFile', () => {
  it('round-trips templates through JSON', () => {
    const templates = [makeTemplate(), makeTemplate({ id: 'template-2', name: 'Small parts' })];
    const result = parseTemplateFile(serializeTemplateFile(templates));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.templates).toEqual(templates);
  });

  it('serializes the version-1 envelope', () => {
    const parsed = JSON.parse(serializeTemplateFile([makeTemplate()]));
    expect(parsed.version).toBe(1);
    expect(parsed.templates).toHaveLength(1);
  });

  it('rejects text that is not JSON', () => {
    const result = parseTemplateFile('not json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not valid JSON');
  });

  it('rejects a non-object root', () => {
    expect(parseTemplateFile('[]').ok).toBe(false);
    expect(parseTemplateFile('42').ok).toBe(false);
  });

  it('rejects an unknown envelope version', () => {
    const result = parseTemplateFile(JSON.stringify({ version: 2, templates: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('version 2');
  });

  it('rejects a missing templates list', () => {
    expect(parseTemplateFile(JSON.stringify({ version: 1 })).ok).toBe(false);
  });

  it('rejects duplicate template ids', () => {
    const text = serializeTemplateFile([makeTemplate(), makeTemplate()]);
    const result = parseTemplateFile(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('appears twice');
  });

  it('defaults divider counts and perforated base missing from older templates', () => {
    const template = makeTemplate() as unknown as Record<string, unknown>;
    const params = { ...(template.params as Record<string, unknown>) };
    delete params.dividerCountX;
    delete params.dividerCountY;
    delete params.perforatedBase;
    const text = JSON.stringify({ version: 1, templates: [{ ...template, params }] });
    const result = parseTemplateFile(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.templates[0].params.dividerCountX).toBe(0);
      expect(result.templates[0].params.dividerCountY).toBe(0);
      expect(result.templates[0].params.perforatedBase).toBe(false);
    }
  });

  it('drops unknown extra fields on parse', () => {
    const raw = { ...makeTemplate(), extra: 'ignored' };
    const result = parseTemplateFile(JSON.stringify({ version: 1, templates: [raw] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect('extra' in result.templates[0]).toBe(false);
  });
});

describe('validateTemplate', () => {
  it('accepts a valid template', () => {
    expect(validateTemplate(makeTemplate())).toBeNull();
  });

  it('rejects a non-object', () => {
    expect(validateTemplate(null)).toContain('not an object');
    expect(validateTemplate([])).toContain('not an object');
  });

  it('rejects a missing or empty id', () => {
    expect(validateTemplate({ ...makeTemplate(), id: '' })).toContain('missing its id');
  });

  it('rejects an empty or blank name', () => {
    expect(validateTemplate(makeTemplate({ name: '' }))).toContain('name');
    expect(validateTemplate(makeTemplate({ name: '   ' }))).toContain('name');
  });

  it('rejects missing params', () => {
    const template = { ...makeTemplate(), params: null };
    expect(validateTemplate(template)).toContain('params must be an object');
  });

  it('rejects invalid bin parameters inside params', () => {
    const template = makeTemplate();
    const broken = { ...template, params: { ...template.params, gridX: 0 } };
    expect(validateTemplate(broken)).toContain('gridX');
  });

  it('rejects a bad createdAt timestamp', () => {
    expect(validateTemplate(makeTemplate({ createdAt: 'yesterday' }))).toContain('createdAt');
  });
});
