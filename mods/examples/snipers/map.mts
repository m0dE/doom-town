// The snipers remix plays BR01's map unchanged: this file only points the pack tool at
// the map script of mods/br01 (which itself re-exports tools/maps/br01.mts). Everything
// that makes this mod different is in MODINFO.json "rules".
export { build, report, NAME, TITLE } from '../../br01/map.mts';
