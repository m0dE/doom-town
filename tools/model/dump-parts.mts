// Writes the marine's parts (name, bone, bounds) for the Blender modelling script.
import { writeFileSync } from 'node:fs';
import { defineBoxes, BONES } from '../../src/model/rig.ts';
const parts = defineBoxes().map((b) => ({ name: b.name, bone: BONES[b.bone], min: b.min, max: b.max }));
writeFileSync(new URL('./parts.json', import.meta.url), JSON.stringify(parts, null, 1));
console.log(parts.map((p) => `${p.name} ${p.min.join(',')} .. ${p.max.join(',')}`).join('\n'));
