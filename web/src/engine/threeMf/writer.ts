/**
 * Writer for a 3MF package in the layout Orca Slicer and Bambu Studio use:
 * a core-spec `3D/3dmodel.model` where each bin is a component object whose
 * components are the mesh parts (body and label), plus the slicer-specific
 * `Metadata/model_settings.config` assigning one extruder per part
 * (`<part id subtype="normal_part">` with `<metadata key="extruder">`), a
 * plate section with `plater_id`, and one `model_instance` per build item.
 * The production-extension `p:UUID` attributes Bambu Studio expects are
 * written on every object, component, and build item.
 */

import { strToU8, zipSync } from 'fflate';
import type { MeshData } from '../gridfinity/types';
import { meshBounds, placementTransform } from '../plate/placement';

/** One placement of a plate item, in plate coordinates (front-left origin). */
export interface PlateInstance {
  /** Footprint centre X on the plate in millimetres. */
  xMm: number;
  /** Footprint centre Y on the plate in millimetres. */
  yMm: number;
  /** Rotation about Z in degrees, counter-clockwise. Default 0. */
  rotationDeg?: number;
}

/** One distinct bin on the plate, instanced at one or more positions. */
export interface PlateItem {
  /** The bin body mesh, printed with extruder 1. */
  body: MeshData;
  /** The label mesh, printed with extruder 2, or null for a plain bin. */
  label: MeshData | null;
  /** Object name shown in the slicer. */
  name: string;
  /** Every position this bin is placed at; at least one. */
  instances: PlateInstance[];
}

/** The extruder numbers (1-based, as slicers count them) for the two parts. */
export const BODY_EXTRUDER = 1;
export const LABEL_EXTRUDER = 2;

const MODEL_NAMESPACE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const PRODUCTION_NAMESPACE =
  'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';

/** Escape the five XML-reserved characters in attribute or text content. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Format a coordinate compactly: micrometre precision, no trailing zeros. */
function formatCoord(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  // Avoid "-0".
  return (Object.is(rounded, -0) ? 0 : rounded).toString();
}

/** Deterministic RFC 4122-shaped UUID from a running counter. */
function counterUuid(counter: number): string {
  const hex = counter.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

function meshXml(mesh: MeshData): string {
  const parts: string[] = ['<mesh><vertices>'];
  const v = mesh.vertices;
  for (let i = 0; i < v.length; i += 3) {
    parts.push(
      `<vertex x="${formatCoord(v[i])}" y="${formatCoord(v[i + 1])}" z="${formatCoord(v[i + 2])}"/>`,
    );
  }
  parts.push('</vertices><triangles>');
  const t = mesh.indices;
  for (let i = 0; i < t.length; i += 3) {
    parts.push(`<triangle v1="${t[i]}" v2="${t[i + 1]}" v3="${t[i + 2]}"/>`);
  }
  parts.push('</triangles></mesh>');
  return parts.join('');
}

/**
 * The 3MF row-major 3x4 transform string for a placement transform.
 * 3MF multiplies row vectors, so the last three values are the translation.
 */
function transformString(t: {
  cos: number;
  sin: number;
  tx: number;
  ty: number;
  tz: number;
}): string {
  return [t.cos, t.sin, 0, -t.sin, t.cos, 0, 0, 0, 1, t.tx, t.ty, t.tz]
    .map(formatCoord)
    .join(' ');
}

const CONTENT_TYPES_XML =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
  '</Types>';

const RELS_XML =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Target="/3D/3dmodel.model" Id="rel-1" ' +
  'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>' +
  '</Relationships>';

/**
 * Serialize the plate as a 3MF package. Each item becomes one object with a
 * body part on extruder 1 and, when present, a label part on extruder 2;
 * each instance becomes one build item whose transform centres the object's
 * footprint at the instance position and rests its lowest point on z = 0.
 */
export function writePlate3mf(items: PlateItem[]): Uint8Array {
  if (items.length === 0) {
    throw new Error('At least one plate item is required to write a 3MF file.');
  }
  for (const item of items) {
    if (item.instances.length === 0) {
      throw new Error(`Plate item "${item.name}" has no instances.`);
    }
  }

  let nextId = 1;
  let uuidCounter = 1;
  const objectsXml: string[] = [];
  const buildItemsXml: string[] = [];
  const settingsObjectsXml: string[] = [];
  const instancesXml: string[] = [];
  let identifyId = 100;

  for (const item of items) {
    const meshes = item.label ? [item.body, item.label] : [item.body];
    const partIds = meshes.map(() => nextId++);
    const objectId = nextId++;
    const bounds = meshBounds(meshes);

    meshes.forEach((mesh, i) => {
      objectsXml.push(
        `<object id="${partIds[i]}" p:UUID="${counterUuid(uuidCounter++)}" type="model">` +
          meshXml(mesh) +
          '</object>',
      );
    });
    const componentsXml = partIds
      .map(
        (id) =>
          `<component objectid="${id}" p:UUID="${counterUuid(uuidCounter++)}" ` +
          'transform="1 0 0 0 1 0 0 0 1 0 0 0"/>',
      )
      .join('');
    objectsXml.push(
      `<object id="${objectId}" p:UUID="${counterUuid(uuidCounter++)}" type="model">` +
        `<components>${componentsXml}</components></object>`,
    );

    const partNames = item.label ? ['Body', 'Label'] : ['Body'];
    const partExtruders = item.label
      ? [BODY_EXTRUDER, LABEL_EXTRUDER]
      : [BODY_EXTRUDER];
    settingsObjectsXml.push(
      `  <object id="${objectId}">\n` +
        `    <metadata key="name" value="${escapeXml(item.name)}"/>\n` +
        `    <metadata key="extruder" value="${BODY_EXTRUDER}"/>\n` +
        partIds
          .map(
            (id, i) =>
              `    <part id="${id}" subtype="normal_part">\n` +
              `      <metadata key="name" value="${partNames[i]}"/>\n` +
              `      <metadata key="extruder" value="${partExtruders[i]}"/>\n` +
              '    </part>\n',
          )
          .join('') +
        '  </object>',
    );

    // The object's meshes are centred wherever the generator put them; the
    // build transform moves the footprint centre to the instance position
    // and drops the lowest vertex onto the plate (z = 0).
    item.instances.forEach((instance, index) => {
      const transform = placementTransform(
        bounds,
        instance.xMm,
        instance.yMm,
        instance.rotationDeg ?? 0,
      );
      buildItemsXml.push(
        `<item objectid="${objectId}" p:UUID="${counterUuid(uuidCounter++)}" ` +
          `transform="${transformString(transform)}" printable="1"/>`,
      );
      instancesXml.push(
        '    <model_instance>\n' +
          `      <metadata key="object_id" value="${objectId}"/>\n` +
          `      <metadata key="instance_id" value="${index}"/>\n` +
          `      <metadata key="identify_id" value="${identifyId++}"/>\n` +
          '    </model_instance>',
      );
    });
  }

  const modelXml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<model unit="millimeter" xml:lang="en-US" xmlns="${MODEL_NAMESPACE}" ` +
    `xmlns:p="${PRODUCTION_NAMESPACE}" requiredextensions="p">` +
    '<metadata name="Application">StoreForge</metadata>' +
    '<metadata name="BambuStudio:3mfVersion">1</metadata>' +
    `<resources>${objectsXml.join('')}</resources>` +
    `<build p:UUID="${counterUuid(uuidCounter++)}">${buildItemsXml.join('')}</build>` +
    '</model>';

  const settingsXml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<config>\n' +
    settingsObjectsXml.join('\n') +
    '\n  <plate>\n' +
    '    <metadata key="plater_id" value="1"/>\n' +
    '    <metadata key="plater_name" value=""/>\n' +
    '    <metadata key="locked" value="false"/>\n' +
    instancesXml.join('\n') +
    '\n  </plate>\n' +
    '</config>\n';

  return zipSync({
    '[Content_Types].xml': strToU8(CONTENT_TYPES_XML),
    '_rels/.rels': strToU8(RELS_XML),
    '3D/3dmodel.model': strToU8(modelXml),
    'Metadata/model_settings.config': strToU8(settingsXml),
  });
}
